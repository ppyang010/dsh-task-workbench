import { DOMAIN_NAME, commandSchema, initialState, stateSchema, type BoardState, type Command } from '../shared/model.ts'

export class WorkbenchError extends Error {
  constructor(public code: string, message: string) { super(message) }
}
export interface StateMedium {
  get(): unknown
  set(state: BoardState): Promise<void>
}
export interface DomainFacility {
  open(spec: unknown): Promise<{ global: StateMedium; close(): Promise<void> }>
}

/** 关注记录只有一个串行写入口；持久化成功以后才发布新状态。 */
export class WatchStore {
  private state: BoardState
  private tail: Promise<unknown> = Promise.resolve()
  private closing = false
  constructor(private medium: StateMedium, private clock: () => number = Date.now) {
    this.state = stateSchema.parse(medium.get())
  }
  snapshot(): BoardState { return structuredClone(this.state) }
  private enqueue(job: (draft: BoardState) => void): Promise<BoardState> {
    if (this.closing) return Promise.reject(new WorkbenchError('closed', '关注存储已关闭'))
    const run = this.tail.then(async () => {
      const draft = structuredClone(this.state)
      job(draft)
      if (JSON.stringify(draft) === JSON.stringify(this.state)) return this.snapshot()
      draft.revision = this.state.revision + 1
      const next = stateSchema.parse(draft)
      await this.medium.set(structuredClone(next))
      this.state = next
      return this.snapshot()
    })
    this.tail = run.catch(() => undefined)
    return run
  }
  async command(raw: unknown, allowedIds?: ReadonlySet<string>): Promise<BoardState> {
    const parsed = commandSchema.safeParse(raw)
    if (!parsed.success) throw new WorkbenchError('invalid_input', '操作参数无效，请检查分类、会话 ID 或备注长度')
    const request = parsed.data
    return this.enqueue(draft => this.apply(draft, request, allowedIds))
  }
  private apply(draft: BoardState, request: Command, allowedIds?: ReadonlySet<string>): void {
    const now = this.clock()
    if (request.type === 'settings') { draft.settings.autoCollect = request.autoCollect; return }
    if (request.type === 'add') {
      const ids = [...new Set(request.sessionIds)]
      if (!allowedIds || ids.some(id => !allowedIds.has(id))) throw new WorkbenchError('session_unavailable', '部分会话已归档、已删除、属于子代理或暂不可用，请刷新后重新选择')
      draft.excludedSessionIds = draft.excludedSessionIds.filter(id => !ids.includes(id))
      for (const sessionId of ids) {
        if (draft.entries.some(entry => entry.sessionId === sessionId)) continue
        draft.entries.push({ sessionId, columnId: request.columnId, note: '', source: 'manual', addedAt: now, updatedAt: now, version: 1 })
      }
      return
    }
    if (request.type === 'unfollow') {
      draft.entries = draft.entries.filter(entry => entry.sessionId !== request.sessionId)
      if (!draft.excludedSessionIds.includes(request.sessionId)) draft.excludedSessionIds.push(request.sessionId)
      return
    }
    const entry = draft.entries.find(entry => entry.sessionId === request.sessionId)
    if (!entry) throw new WorkbenchError('not_followed', '此会话已取消关注，请刷新看板')
    if (request.type === 'note') {
      if (entry.version !== request.expectedVersion) throw new WorkbenchError('version_conflict', '此卡片已在其他窗口更新。已保留当前输入，请检查最新卡片后再次保存')
      if (entry.note === request.note) return
      entry.note = request.note
      entry.version += 1
      entry.updatedAt = now
      return
    }
    if (request.beforeSessionId === request.sessionId) return
    const anchor = request.beforeSessionId ? draft.entries.find(entry => entry.sessionId === request.beforeSessionId) : undefined
    if (request.beforeSessionId && (!anchor || anchor.columnId !== request.columnId)) throw new WorkbenchError('position_conflict', '目标卡片的位置已变更，请刷新后重新移动')
    draft.entries = draft.entries.filter(item => item !== entry)
    if (entry.columnId !== request.columnId) { entry.columnId = request.columnId; entry.version += 1; entry.updatedAt = now }
    const at = anchor ? draft.entries.findIndex(item => item.sessionId === anchor.sessionId) : -1
    if (at < 0) draft.entries.push(entry)
    else draft.entries.splice(at, 0, entry)
  }
  /** 自动纳入只新增关注，既不重排已有卡片，也不复活手动排除项。 */
  autoCollect(sessionId: string): Promise<BoardState> {
    return this.enqueue(draft => {
      if (!draft.settings.autoCollect || draft.excludedSessionIds.includes(sessionId) || draft.entries.some(entry => entry.sessionId === sessionId)) return
      const now = this.clock()
      draft.entries.push({ sessionId, columnId: 'focus', note: '', source: 'auto', addedAt: now, updatedAt: now, version: 1 })
    })
  }
  async drain(): Promise<void> { this.closing = true; await this.tail }
}

export async function openWatchStore(facility: DomainFacility) {
  const domain = await facility.open({
    name: DOMAIN_NAME, version: 1, layout: 'single', tables: {},
    global: { schema: stateSchema, initial: initialState() },
  })
  try {
    const store = new WatchStore(domain.global)
    return { store, close: async () => { await store.drain(); await domain.close() } }
  } catch (error) { await domain.close(); throw error }
}

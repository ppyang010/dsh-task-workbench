import { GROUP_ORDER_DOMAIN, groupOrderCommandSchema, groupOrderStateSchema, initialGroupOrder, type GroupOrderState } from '../shared/group-order.ts'
import type { BoardState } from '../shared/model.ts'
import { WorkbenchError } from './store.ts'

export interface GroupOrderMedium { get(): unknown; set(state: GroupOrderState): Promise<void> }
export interface GroupOrderFacility { open(spec: unknown): Promise<{ global: GroupOrderMedium; close(): Promise<void> }> }
export interface GroupOrderSources { board(): BoardState; members(workspaceId: string): readonly string[] | undefined }

/** 顺序存在独立域，绝不修改关注记录、会话分类或原生工作区。 */
export class GroupOrderStore {
  private state: GroupOrderState
  private tail: Promise<unknown> = Promise.resolve()
  private closing = false
  constructor(private medium: GroupOrderMedium) { this.state = groupOrderStateSchema.parse(medium.get()) }
  snapshot(): GroupOrderState { return structuredClone(this.state) }
  async reorder(raw: unknown, sources: GroupOrderSources): Promise<GroupOrderState> {
    const parsed = groupOrderCommandSchema.safeParse(raw)
    if (!parsed.success) throw new WorkbenchError('invalid_input', '分组排序参数无效，请刷新后重试')
    if (this.closing) throw new WorkbenchError('closed', '分组排序存储已关闭')
    const request = parsed.data
    const run = this.tail.then(async () => {
      if (this.state.revision !== request.expectedOrderRevision) throw new WorkbenchError('version_conflict', '分组顺序已在其他窗口改变，请刷新后重试')
      const board = sources.board()
      if (board.revision !== request.expectedBoardRevision) throw new WorkbenchError('version_conflict', '关注列表已变化，请刷新后重试')
      const followed = new Set(board.entries.map(entry => entry.sessionId))
      for (const id of request.workspaceIds) {
        const members = sources.members(id)
        if (!members || !members.some(sessionId => followed.has(sessionId))) throw new WorkbenchError('workspace_changed', '工作区分组已变化，请刷新后重试')
      }
      if (request.beforeId === request.sourceId) return this.snapshot()
      const without = request.workspaceIds.filter(id => id !== request.sourceId)
      const at = request.beforeId === undefined ? without.length : without.indexOf(request.beforeId)
      if (at < 0) throw new WorkbenchError('position_conflict', '目标分组已变化，请刷新后重试')
      const desired = [...without.slice(0, at), request.sourceId, ...without.slice(at)]
      if (desired.every((id, index) => id === request.workspaceIds[index])) return this.snapshot()
      const old = this.state.columns[request.columnId]
      const oldSet = new Set(old); const active = new Set(request.workspaceIds)
      const merged = [...old, ...request.workspaceIds.filter(id => !oldSet.has(id))]
      if (merged.length > 20000) throw new WorkbenchError('limit', '分组顺序记录已达上限，原有顺序未改变')
      const current = merged.filter(id => active.has(id))
      if (!current.every((id, index) => id === request.workspaceIds[index])) throw new WorkbenchError('version_conflict', '分组顺序已变化，请刷新后重试')
      let index = 0
      const next: GroupOrderState = structuredClone(this.state)
      // 保留暂时不显示的工作区在原来的槽位，避免状态变化后顺序无故丢失。
      next.columns[request.columnId] = merged.map(id => active.has(id) ? desired[index++] : id)
      next.revision += 1
      const checked = groupOrderStateSchema.parse(next)
      await this.medium.set(structuredClone(checked))
      this.state = checked
      return this.snapshot()
    })
    this.tail = run.catch(() => undefined)
    return run
  }
  async drain(): Promise<void> { this.closing = true; await this.tail }
}

export async function openGroupOrderStore(facility: GroupOrderFacility) {
  const domain = await facility.open({ name: GROUP_ORDER_DOMAIN, version: 1, layout: 'single', tables: {}, global: { schema: groupOrderStateSchema, initial: initialGroupOrder() } })
  try { const store = new GroupOrderStore(domain.global); return { store, close: async () => { await store.drain(); await domain.close() } } }
  catch (error) { await domain.close(); throw error }
}

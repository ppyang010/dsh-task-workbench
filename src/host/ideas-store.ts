import { IDEAS_DOMAIN, ideaCommandSchema, ideasStateSchema, initialIdeasState, type IdeaCommand, type IdeaValues, type IdeasState } from '../shared/ideas.ts'
import { WorkbenchError } from './store.ts'

export interface IdeasMedium { get(): unknown; set(state: IdeasState): Promise<void> }
export interface IdeasDomainFacility { open(spec: unknown): Promise<{ global: IdeasMedium; close(): Promise<void> }> }

/** 独立数据域，所有点子/文件夹变更串行写入；成功落盘后才对外发布。 */
export class IdeasStore {
  private state: IdeasState
  private tail: Promise<unknown> = Promise.resolve()
  private closing = false
  constructor(private medium: IdeasMedium, private clock: () => number = Date.now) {
    this.state = ideasStateSchema.parse(medium.get())
  }
  snapshot(): IdeasState { return structuredClone(this.state) }
  async command(raw: unknown, signal?: AbortSignal): Promise<IdeasState> {
    signal?.throwIfAborted()
    const parsed = ideaCommandSchema.safeParse(raw)
    if (!parsed.success) throw new WorkbenchError('invalid_input', '点子操作参数无效，请检查标题、标签、字数和关联数量')
    if (this.closing) throw new WorkbenchError('closed', '点子存储已关闭')
    const request = parsed.data
    const run = this.tail.then(async () => {
      // 等待串行队列期间可能已被用户取消；未开始写盘时不得再提交。
      signal?.throwIfAborted()
      const draft = structuredClone(this.state)
      this.apply(draft, request)
      if (JSON.stringify(draft) === JSON.stringify(this.state)) return this.snapshot()
      draft.revision = this.state.revision + 1
      const next = ideasStateSchema.parse(draft)
      signal?.throwIfAborted()
      await this.medium.set(structuredClone(next))
      this.state = next
      return this.snapshot()
    })
    this.tail = run.catch(() => undefined)
    return run
  }
  private checkFolders(state: IdeasState, value: IdeaValues) {
    const ids = new Set(state.folders.map(folder => folder.id))
    if (value.folderIds.some(id => !ids.has(id))) throw new WorkbenchError('folder_missing', '所选文件夹已被删除，请刷新后重新选择')
  }
  private apply(state: IdeasState, request: IdeaCommand): void {
    const now = this.clock()
    if (request.type === 'createIdea') {
      const existing = state.ideas.find(idea => idea.id === request.id)
      if (existing) {
        const { title, content, kind, tags, folderIds, sessionIds } = existing
        if (existing.trashedAt === null && JSON.stringify({ title, content, kind, tags, folderIds, sessionIds }) === JSON.stringify(request.value)) return
        throw new WorkbenchError('id_conflict', '此点子编号已存在，请刷新确认后重试')
      }
      if (state.ideas.length >= 10000) throw new WorkbenchError('limit', '点子已达 10000 条上限，数据没有修改')
      this.checkFolders(state, request.value)
      state.ideas.push({ id: request.id, ...request.value, createdAt: now, updatedAt: now, trashedAt: null, version: 1 })
      return
    }
    if (request.type === 'createFolder') {
      const existing = state.folders.find(folder => folder.id === request.id)
      if (existing) {
        if (existing.title === request.value.title && existing.summary === request.value.summary) return
        throw new WorkbenchError('id_conflict', '此文件夹编号已存在，请刷新确认后重试')
      }
      if (state.folders.length >= 1000) throw new WorkbenchError('limit', '文件夹已达 1000 个上限，数据没有修改')
      state.folders.push({ id: request.id, ...request.value, createdAt: now, updatedAt: now, version: 1 })
      return
    }
    if (request.type === 'mergeFolder') {
      if (request.sourceId === request.targetId) throw new WorkbenchError('invalid_input', '不能将文件夹合并到自身')
      const source = state.folders.find(item => item.id === request.sourceId)
      const target = state.folders.find(item => item.id === request.targetId)
      if (!source || !target) throw new WorkbenchError('folder_missing', '源文件夹或目标文件夹已不存在，请刷新后重试')
      if (source.version !== request.expectedSourceVersion || target.version !== request.expectedTargetVersion) throw new WorkbenchError('version_conflict', '文件夹已在其他窗口更新，请刷新核对后重试')
      // 原子移动成员（含回收站），保留目标文件夹标题和摘要；重复成员去重。
      for (const idea of state.ideas) if (idea.folderIds.includes(source.id)) {
        idea.folderIds = [...new Set(idea.folderIds.map(id => id === source.id ? target.id : id))]
        idea.version += 1; idea.updatedAt = now
      }
      state.folders = state.folders.filter(item => item.id !== source.id)
      return
    }
    if (request.type === 'updateFolder' || request.type === 'deleteFolder') {
      const folder = state.folders.find(item => item.id === request.id)
      if (!folder) throw new WorkbenchError('folder_missing', '文件夹已不存在，请刷新后重试')
      if (folder.version !== request.expectedVersion) throw new WorkbenchError('version_conflict', '文件夹已在其他窗口更新，请刷新核对后重试')
      if (request.type === 'updateFolder') {
        if (folder.title === request.value.title && folder.summary === request.value.summary) return
        Object.assign(folder, request.value, { version: folder.version + 1, updatedAt: now })
      } else {
        state.folders = state.folders.filter(item => item.id !== request.id)
        // 回收站中的点子也移除已删除文件夹；只改变归类，不删除点子。
        for (const idea of state.ideas) if (idea.folderIds.includes(request.id)) {
          idea.folderIds = idea.folderIds.filter(id => id !== request.id)
          idea.version += 1; idea.updatedAt = now
        }
      }
      return
    }
    const idea = state.ideas.find(item => item.id === request.id)
    if (!idea) throw new WorkbenchError('idea_missing', '点子已不存在，请刷新后重试')
    if (idea.version !== request.expectedVersion) throw new WorkbenchError('version_conflict', '点子已在其他窗口更新，已保留当前输入，请刷新核对后重试')
    if (request.type === 'trashIdea' || request.type === 'restoreIdea') {
      if ((request.type === 'trashIdea') === (idea.trashedAt !== null)) return
      idea.trashedAt = request.type === 'trashIdea' ? now : null
      idea.version += 1; idea.updatedAt = now
      return
    }
    if (idea.trashedAt !== null) throw new WorkbenchError('in_trash', '点子已在回收站，请先恢复再编辑')
    this.checkFolders(state, request.value)
    const { title, content, kind, tags, folderIds, sessionIds } = idea
    if (JSON.stringify({ title, content, kind, tags, folderIds, sessionIds }) === JSON.stringify(request.value)) return
    Object.assign(idea, request.value, { version: idea.version + 1, updatedAt: now })
  }
  async drain(): Promise<void> { this.closing = true; await this.tail }
}

export async function openIdeasStore(facility: IdeasDomainFacility) {
  const domain = await facility.open({ name: IDEAS_DOMAIN, version: 1, layout: 'single', tables: {}, global: { schema: ideasStateSchema, initial: initialIdeasState() } })
  try {
    const store = new IdeasStore(domain.global)
    return { store, close: async () => { await store.drain(); await domain.close() } }
  } catch (error) { await domain.close(); throw error }
}

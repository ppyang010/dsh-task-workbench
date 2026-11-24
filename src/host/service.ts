import { commandSchema, sessionIdSchema, type BoardState, type ModelSelection } from '../shared/model.ts'
import { WatchStore, WorkbenchError } from './store.ts'
import { isSidechat } from '../shared/sidechat.ts'

export interface SessionHeader { id: string; origin?: string; delegationDepth?: number; parentSession?: string; isSeeded?: boolean }
export interface HostServices {
  sessionQuery: {
    listSessions(signal?: AbortSignal): Promise<Array<{ header: SessionHeader; formatStatus?: string }>>
    readTitle?(id: string): Promise<{ title: string; source: { kind: string } } | undefined>
  }
  workspaceRegistry: { archivedSessionIds: readonly string[] }
  validateDefaultModel?(selection: ModelSelection): Promise<void>
}
export function isChildSession(header: SessionHeader): boolean {
  // 普通 fork 也有 parentSession，必须看 origin/delegationDepth，不能仅凭父会话排除。
  return header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
}
export class WorkbenchService {
  constructor(private store: WatchStore, private services: HostServices) {}
  read(): BoardState { return this.store.snapshot() }
  async reconcileArchived(): Promise<void> {
    await this.store.reconcileArchived(() => this.services.workspaceRegistry.archivedSessionIds)
  }
  async mutate(raw: unknown): Promise<BoardState> {
    const result = commandSchema.safeParse(raw)
    if (!result.success) throw new WorkbenchError('invalid_input', '操作参数无效，请刷新后重试')
    await this.reconcileArchived()
    const request = result.data
    if (request.type === 'defaultModelLock' || request.type === 'defaultModelSelection') {
      return this.store.configureDefaultModel(request, async selection => {
        if (!this.services.validateDefaultModel) throw new WorkbenchError('unavailable', '当前 DSH 未提供默认模型锁定所需的服务')
        await this.services.validateDefaultModel(selection)
      })
    }
    if (request.type !== 'add' && request.type !== 'restore') return this.store.command(request)
    // 已关注的重复恢复直接交由串行存储判定，不要求目录此刻仍可用。
    if (request.type === 'restore' && this.store.snapshot().entries.some(entry => entry.sessionId === request.sessionId)) return this.store.command(request)
    // 仅读取统一目录中的 header，不恢复 Agent、不读取聊天日志正文。
    const records = await this.services.sessionQuery.listSessions()
    const archived = new Set(this.services.workspaceRegistry.archivedSessionIds)
    const savedSidechat = request.type === 'restore' && this.read().removedEntries.some(({ entry }) => entry.sessionId === request.sessionId && entry.source === 'sidechat') ? request.sessionId : undefined
    const available = new Set(records.filter(record => (!isChildSession(record.header) || record.header.id === savedSidechat) && !archived.has(record.header.id) && (record.formatStatus === undefined || record.formatStatus === 'current')).map(record => record.header.id))
    return this.store.command(result.data, available)
  }
  async onSessionEvent(session: { id: string; header: SessionHeader }, event: { type: string }): Promise<void> {
    if (event.type !== 'turn/start' || !sessionIdSchema.safeParse(session.id).success) return
    if (this.services.workspaceRegistry.archivedSessionIds.includes(session.id)) return
    if (!isChildSession(session.header)) {
      await this.store.autoCollect(session.id)
      return
    }
    const { settings, entries, excludedSessionIds } = this.read()
    if (!settings.autoCollectSidechat || session.header.origin !== 'subagent' || !session.header.parentSession) return
    if (excludedSessionIds.includes(session.id) || entries.some(entry => entry.sessionId === session.id)) return
    const title = await this.services.sessionQuery.readTitle?.(session.id)
    if (title?.source.kind !== 'user' || !isSidechat(session.header.origin, session.header.parentSession, title.title)) return
    if (!this.services.workspaceRegistry.archivedSessionIds.includes(session.id)) await this.store.autoCollect(session.id, 'sidechat')
  }
}

import { commandSchema, sessionIdSchema, type BoardState } from '../shared/model.ts'
import { WatchStore, WorkbenchError } from './store.ts'

export interface SessionHeader { id: string; origin?: string; delegationDepth?: number; parentSession?: string; isSeeded?: boolean }
export interface HostServices {
  sessionQuery: { listSessions(signal?: AbortSignal): Promise<Array<{ header: SessionHeader; formatStatus?: string }>> }
  workspaceRegistry: { archivedSessionIds: readonly string[] }
}
export function isChildSession(header: SessionHeader): boolean {
  // 普通 fork 也有 parentSession，必须看 origin/delegationDepth，不能仅凭父会话排除。
  return header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
}
export class WorkbenchService {
  constructor(private store: WatchStore, private services: HostServices) {}
  read(): BoardState { return this.store.snapshot() }
  async mutate(raw: unknown): Promise<BoardState> {
    const result = commandSchema.safeParse(raw)
    if (!result.success) throw new WorkbenchError('invalid_input', '操作参数无效，请刷新后重试')
    if (result.data.type !== 'add') return this.store.command(result.data)
    // 仅读取统一目录中的 header，不恢复 Agent、不读取聊天日志正文。
    const records = await this.services.sessionQuery.listSessions()
    const archived = new Set(this.services.workspaceRegistry.archivedSessionIds)
    const available = new Set(records.filter(record => !isChildSession(record.header) && !archived.has(record.header.id) && (record.formatStatus === undefined || record.formatStatus === 'current')).map(record => record.header.id))
    return this.store.command(result.data, available)
  }
  async onSessionEvent(session: { id: string; header: SessionHeader }, event: { type: string }): Promise<void> {
    if (event.type !== 'turn/start' || !sessionIdSchema.safeParse(session.id).success || isChildSession(session.header)) return
    if (this.services.workspaceRegistry.archivedSessionIds.includes(session.id)) return
    await this.store.autoCollect(session.id)
  }
}

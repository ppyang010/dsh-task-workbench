import type { RuntimeSnapshot, RuntimeStatus, SessionView } from '../shared/model.ts'

export interface Source<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
export interface SessionRow {
  id: string; displayTitle?: string; title?: string; running?: boolean; updatedAt?: number
  origin?: string; parentId?: string; formatStatus?: string
}
export interface SessionList { phase: string; byId: Record<string, SessionRow> }
export interface WorkspaceRow { workspaceId: string; title?: string; path?: string; sessionIds: readonly string[] }
export interface WorkspaceList { items: readonly WorkspaceRow[]; archivedSessionIds: readonly string[]; phase: string }
export interface UiStatus { running?: boolean; pendingInteraction?: { kind?: string }; completionUnread?: boolean }
export interface RuntimeContext { get(name: string): any }
export interface RuntimeFace {
  snapshot(): RuntimeSnapshot
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  open(sessionId: string): Promise<void>
}
const pendingLabels: Record<string, string> = { approval: '等待审批', 'plan-review': '等待方案确认', question: '等待回答' }

/** 从宿主已经维护的摘要与状态派生；不加载每条会话正文、不创建 Agent。 */
export function deriveSessions(list: SessionList, workspaces: WorkspaceList, statuses: ReadonlyMap<string, UiStatus>, connected: boolean): RuntimeSnapshot {
  const owners = new Map<string, WorkspaceRow>()
  for (const ws of workspaces.items) for (const id of ws.sessionIds) if (!owners.has(id)) owners.set(id, ws)
  const archivedIds = new Set(workspaces.archivedSessionIds)
  const ready = list.phase === 'ready' && workspaces.phase === 'ready'
  const sessions: SessionView[] = Object.values(list.byId).map(row => {
    const ws = owners.get(row.id)
    const native = statuses.get(row.id)
    const waitingLabel = pendingLabels[native?.pendingInteraction?.kind ?? '']
    const running = native?.running ?? row.running
    const status: RuntimeStatus = !connected ? 'unknown' : waitingLabel ? 'waiting' : running === true ? 'running' : native?.completionUnread === true ? 'unread' : running === false ? 'idle' : 'unknown'
    const subagent = row.origin === 'subagent'
    return {
      id: row.id, title: row.title || row.displayTitle || `会话 ${row.id.slice(-8)}`,
      workspaceId: ws?.workspaceId ?? '',
      workspaceTitle: ws?.title || ws?.path?.split(/[\\/]/).filter(Boolean).at(-1) || '未分组',
      updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt! : 0,
      status, archived: archivedIds.has(row.id), missing: false, subagent,
      openable: ready && connected && !subagent && !archivedIds.has(row.id) && (row.formatStatus === undefined || row.formatStatus === 'current'),
      ...(waitingLabel ? { waitingLabel } : {}),
    }
  })
  return { sessions, ready, connected }
}
export function createRuntime(ctx: RuntimeContext): RuntimeFace {
  const sessions = ctx.get('sessions') as { list: Source<SessionList>; refresh(): Promise<void> }
  const workspaces = ctx.get('workspaces') as { list: Source<WorkspaceList> }
  const ui = ctx.get('uiSession') as { sessionStatus: Source<Map<string, UiStatus>> }
  const connection = ctx.get('connection') as { state: Source<string | undefined> }
  const navigation = ctx.get('uiWorkspace') as { openSession(id: string): Promise<void> | void }
  return {
    snapshot: () => deriveSessions(sessions.list.getSnapshot(), workspaces.list.getSnapshot(), ui.sessionStatus.getSnapshot(), connection.state.getSnapshot() === 'connected'),
    subscribe: listener => {
      const disposers = [sessions.list, workspaces.list, ui.sessionStatus, connection.state].map(source => source.subscribe(listener))
      return () => { for (const dispose of disposers) dispose() }
    },
    refresh: async () => { await sessions.refresh() },
    open: async id => { await navigation.openSession(id) },
  }
}

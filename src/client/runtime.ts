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
  rename(sessionId: string, title: string): Promise<void>
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
/** 优先沿用筛选工作区，其次当前会话工作区；不自动发送消息。 */
export async function openNewSessionPage(ctx: RuntimeContext, preferredWorkspaceId?: string): Promise<void> {
  const navigation = ctx.get('uiWorkspace') as {
    selection: Source<{ sessionId?: string }>
    openWorkspace(id: string): Promise<void>
    clearMain(): void
  }
  const catalog = (ctx.get('workspaces') as { list: Source<WorkspaceList> }).list.getSnapshot()
  if (catalog.phase !== 'ready') throw new Error('工作区目录尚未就绪，请稍后重试')
  const preferred = catalog.items.find(item => item.workspaceId === preferredWorkspaceId)
  const currentId = navigation.selection.getSnapshot().sessionId
  const current = currentId ? catalog.items.find(item => item.sessionIds.includes(currentId)) : undefined
  const target = preferred ?? current
  if (target) {
    // 原生接口复用或准备空白会话，保留已有草稿，并负责主面板切换。
    await navigation.openWorkspace(target.workspaceId)
  } else navigation.clearMain()
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
    rename: async (id, title) => {
      // 沿用宿主侧边栏重命名调用链，由 using 负责引用的取得与释放。
      const result = await ctx.get('sessions').using(id, { source: 'workspaceOperation' }, (reference: { binding: { session: { rename(title: string): Promise<{ ok: boolean; error?: { message: string } }> } } }) => reference.binding.session.rename(title))
      if (!result.ok) throw new Error(result.error?.message || '会话名未保存，请稍后重试')
    },
  }
}

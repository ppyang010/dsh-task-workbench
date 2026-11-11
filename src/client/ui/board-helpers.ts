import { STATUS_LABELS, type ClientState, type RuntimeStatus, type SessionView, type WatchEntry } from '../../shared/model.js'

export interface BoardRow {
  entry: WatchEntry
  session?: SessionView
  title: string
  workspaceTitle: string
  status: RuntimeStatus
  unavailableReason: string
}

/** 目录尚未就绪时保留关注记录，避免把同步过程误判为会话丢失。 */
export function getBoardRows(state: ClientState): BoardRow[] {
  const directory = new Map(uniqueSessions(state.sessions).map(session => [session.id, session]))
  return state.board.entries.map(entry => {
    const session = directory.get(entry.sessionId)
    const unavailableReason = !state.runtimeReady
      ? '会话目录正在同步，请稍后打开'
      : session ? getUnavailableReason(session) : '暂时找不到原会话；关注记录已保留，可刷新重试'
    return {
      entry,
      session,
      title: session ? session.title.trim() || '未命名会话' : state.runtimeReady ? '暂时无法找到的会话' : '会话资料待同步',
      workspaceTitle: session?.workspaceTitle.trim() || '工作区待确认',
      status: state.runtimeReady ? session?.status ?? 'unknown' : 'unknown',
      unavailableReason,
    }
  })
}

export function getUnavailableReason(session: SessionView): string {
  if (session.missing) return '暂时找不到原会话；关注记录已保留，可刷新重试'
  if (session.archived) return '原会话已归档，当前无法打开；关注记录仍保留'
  if (session.subagent) return '子代理会话暂不支持从关注看板打开'
  if (!session.openable) return '当前无法打开原会话，请检查所属工作区是否可用'
  return ''
}

export function getAddDisabledReason(session: SessionView, watchedIds: ReadonlySet<string>): string {
  if (watchedIds.has(session.id)) return '已关注，无需重复添加'
  if (session.subagent) return '子代理会话暂不支持添加'
  if (session.archived) return '已归档会话暂不支持添加'
  if (session.missing) return '原会话暂不可用，无法添加'
  if (!session.openable) return '当前无法打开原会话，暂不支持添加'
  return ''
}

export function matchesRow(row: BoardRow, query: string, workspaceId = '', status = ''): boolean {
  if (workspaceId && row.session?.workspaceId !== workspaceId) return false
  if (status && row.status !== status) return false
  const text = [row.title, row.workspaceTitle, row.entry.note, row.status, STATUS_LABELS[row.status], row.session?.waitingLabel ?? '', row.unavailableReason].join(' ').toLocaleLowerCase('zh-CN')
  return query.trim().toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean).every(term => text.includes(term))
}

export function matchesSession(session: SessionView, query: string, workspaceId = ''): boolean {
  if (workspaceId && session.workspaceId !== workspaceId) return false
  const text = [session.id, session.title, session.workspaceTitle, session.status, STATUS_LABELS[session.status], session.waitingLabel ?? ''].join(' ').toLocaleLowerCase('zh-CN')
  return query.trim().toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean).every(term => text.includes(term))
}

export function uniqueSessions(sessions: SessionView[]): SessionView[] {
  const result = new Map<string, SessionView>()
  for (const session of sessions) {
    if (!result.has(session.id) || (result.get(session.id)?.updatedAt ?? 0) <= session.updatedAt) result.set(session.id, session)
  }
  return [...result.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
}

export function workspaceOptions(sessions: SessionView[]): Array<{ id: string; title: string }> {
  const result = new Map<string, string>()
  for (const session of sessions) result.set(session.workspaceId, session.workspaceTitle.trim() || '未命名工作区')
  return [...result].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
}

/** 返回排到指定卡片后面所需的相对锚点，包含被筛选隐藏的卡片。 */
export function afterSessionId(rows: BoardRow[], targetSessionId: string, draggedSessionId: string): string | undefined {
  const remaining = rows.filter(row => row.entry.sessionId !== draggedSessionId)
  const index = remaining.findIndex(row => row.entry.sessionId === targetSessionId)
  return index < 0 ? undefined : remaining[index + 1]?.entry.sessionId
}

export function formatUpdatedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(new Date(timestamp).valueOf())) return '更新时间未知'
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp))
}

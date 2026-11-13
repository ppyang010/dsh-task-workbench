import { type ClientState, type WatchEntry } from '../../shared/model.js'
import { getUnavailableReason, uniqueSessions } from './board-helpers.js'

/** 排除名单是权威列表，旧版本只有 ID 的记录也必须可见。 */
export function getRemovedRows(state: ClientState) {
  const sessions = new Map(uniqueSessions(state.sessions).map(session => [session.id, session]))
  const snapshots = new Map(state.board.removedEntries.map(item => [item.entry.sessionId, item]))
  return state.board.excludedSessionIds.map(sessionId => {
    const saved = snapshots.get(sessionId)
    const session = sessions.get(sessionId)
    const reason = !state.connected ? '连接已断开，重新连接后可恢复关注'
      : !state.runtimeReady ? '会话目录正在同步，请稍后重试'
      : !session ? '暂时找不到原会话，取消关注记录仍保留'
      : getUnavailableReason(session).replaceAll('关注记录', '取消关注记录')
    return {
      sessionId, session, entry: saved?.entry as WatchEntry | undefined, removedAt: saved?.removedAt,
      title: session?.title.trim() || (state.runtimeReady ? '暂时无法找到的会话' : '会话资料待同步'),
      workspaceTitle: session?.workspaceTitle.trim() || '工作区待确认', reason,
    }
  }).sort((a, b) => (b.removedAt ?? -1) - (a.removedAt ?? -1) || a.sessionId.localeCompare(b.sessionId))
}

export type RemovedRow = ReturnType<typeof getRemovedRows>[number]
export function matchesRemovedRow(row: RemovedRow, query: string, workspaceId: string): boolean {
  if (workspaceId && row.session?.workspaceId !== workspaceId) return false
  const text = [row.sessionId, row.title, row.workspaceTitle, row.entry?.note ?? ''].join(' ').toLocaleLowerCase('zh-CN')
  return query.trim().toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean).every(term => text.includes(term))
}

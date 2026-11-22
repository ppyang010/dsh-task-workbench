import { STATUS_LABELS, type ClientState, type ColumnId, type RuntimeStatus, type SessionView, type WatchEntry } from '../../shared/model.js'
import type { GroupDragSnapshot, GroupOrderState } from '../../shared/group-order.ts'

export interface BoardRow {
  entry: WatchEntry
  displayColumnId: ColumnId
  mirrored: boolean
  session?: SessionView
  title: string
  workspaceTitle: string
  status: RuntimeStatus
  unavailableReason: string
}

export const workspaceKey = (row: BoardRow): string => JSON.stringify(row.session?.workspaceId ?? null)

export interface WorkspaceGroup { key: string; title: string; rows: BoardRow[] }
/** 按真实工作区 ID 分组；默认按名称排序，组内保留人工排序和筛选隐藏记录。 */
export function groupWorkspaces(rows: BoardRow[]): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>()
  for (const row of rows) {
    const key = workspaceKey(row)
    const group = groups.get(key) ?? { key, title: row.workspaceTitle, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN') || a.key.localeCompare(b.key))
}

/** 只有工作区已明确且组内一致时才允许保存顺序。 */
export function groupWorkspaceId(group: WorkspaceGroup): string | undefined {
  const id = group.rows[0]?.session?.workspaceId
  if (!id || id.length > 300 || id.trim() !== id || /[\u0000-\u001f\u007f]/.test(id) || group.rows.some(row => row.session?.workspaceId !== id)) return undefined
  return id
}

/** 保存过的分组排在前面；新分组沿用名称顺序，未知工作区保持原槽位。 */
export function orderWorkspaceGroups(groups: WorkspaceGroup[], order: readonly string[]): WorkspaceGroup[] {
  const rank = new Map(order.map((id, index) => [id, index]))
  const sortable = groups.filter(group => groupWorkspaceId(group) !== undefined)
  sortable.sort((a, b) => (rank.get(groupWorkspaceId(a)!) ?? Number.MAX_SAFE_INTEGER) - (rank.get(groupWorkspaceId(b)!) ?? Number.MAX_SAFE_INTEGER))
  let index = 0
  return groups.map(group => groupWorkspaceId(group) === undefined ? group : sortable[index++])
}

/** 排序只针对拖动时看到的同一分类；分组、关注版本或已保存顺序改变后需重试。 */
export function groupOrderStillCurrent(state: ClientState, order: GroupOrderState, snapshot: GroupDragSnapshot): boolean {
  if (!state.connected || !state.runtimeReady || state.board.revision !== snapshot.expectedBoardRevision || order.revision !== snapshot.expectedOrderRevision) return false
  const groups = groupWorkspaces(getBoardRows(state).filter(row => snapshot.columnId === 'waiting' ? isWaitingPaneRow(row) : row.displayColumnId === snapshot.columnId && !row.mirrored))
  const ids = orderWorkspaceGroups(groups, order.columns[snapshot.columnId]).map(groupWorkspaceId).filter((id): id is string => !!id)
  return ids.length === snapshot.workspaceIds.length && ids.every((id, index) => id === snapshot.workspaceIds[index])
}

const ACTIVITY_STATUSES: ReadonlySet<RuntimeStatus> = new Set(['running', 'waiting', 'unread'])

/** 目录尚未就绪时保留关注记录，避免把同步过程误判为会话丢失。 */
export function getBoardRows(state: ClientState): BoardRow[] {
  const directory = new Map(uniqueSessions(state.sessions).map(session => [session.id, session]))
  const rows: BoardRow[] = []
  for (const entry of state.board.entries) {
    const session = directory.get(entry.sessionId)
    const unavailableReason = !state.runtimeReady
      ? '会话目录正在同步，请稍后打开'
      : session ? getUnavailableReason(session) : '暂时找不到原会话；关注记录已保留，可刷新重试'
    const home: BoardRow = {
      entry,
      displayColumnId: entry.columnId,
      mirrored: false,
      session,
      title: session ? session.title.trim() || '未命名会话' : state.runtimeReady ? '暂时无法找到的会话' : '会话资料待同步',
      workspaceTitle: session?.workspaceTitle.trim() || '工作区待确认',
      status: state.runtimeReady ? session?.status ?? 'unknown' : 'unknown',
      unavailableReason,
    }
    rows.push(home)
    if (state.board.settings.mirrorActivity && entry.columnId === 'focus' && state.connected && state.runtimeReady && !unavailableReason && session && ACTIVITY_STATUSES.has(session.status)) {
      rows.push({ ...home, displayColumnId: 'waiting', mirrored: true })
    }
  }
  return rows
}

export function isRunningMirror(row: BoardRow): boolean {
  return row.mirrored && row.status === 'running'
}

export function isWaitingPaneRow(row: BoardRow): boolean {
  return row.displayColumnId === 'waiting' && !isRunningMirror(row)
}

export function activityPane(row: BoardRow): 'running' | 'waiting' | 'home' {
  if (isRunningMirror(row)) return 'running'
  if (row.displayColumnId === 'waiting') return 'waiting'
  return 'home'
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

/** 同步展示卡片仍属于原分类，不能作为另一分类的持久化排序锚点。 */
export function moveAnchor(rows: BoardRow[], targetId: string, edge: 'before' | 'after', columnId: ColumnId, draggedId: string): string | undefined {
  const index = rows.findIndex(row => row.entry.sessionId === targetId)
  if (index < 0) return undefined
  return rows.slice(index + (edge === 'after' ? 1 : 0)).find(row => row.entry.sessionId !== draggedId && row.entry.columnId === columnId)?.entry.sessionId
}

export interface CardBox {
  sessionId: string
  left: number
  top: number
  right: number
  bottom: number
}

/** 按屏幕中的行和横向位置定位；不依赖卡片等高，也不改变原始排序。 */
export function locateDropTarget(boxes: readonly CardBox[], x: number, y: number, layout: 'list' | 'grid' = 'list'): { sessionId: string; edge: 'before' | 'after' } | undefined {
  const valid = boxes.filter(box => box.right > box.left && box.bottom > box.top).sort((a, b) => a.top - b.top || a.left - b.left)
  if (!valid.length) return undefined
  const rows: Array<{ top: number; bottom: number; boxes: CardBox[] }> = []
  for (const box of valid) {
    const previous = rows.at(-1)
    if (previous && Math.abs(previous.top - box.top) < 4) {
      previous.boxes.push(box)
      previous.bottom = Math.max(previous.bottom, box.bottom)
    } else rows.push({ top: box.top, bottom: box.bottom, boxes: [box] })
  }
  for (const row of rows) row.boxes.sort((a, b) => a.left - b.left)
  const first = rows[0], last = rows.at(-1)!
  if (y < first.top) return { sessionId: first.boxes[0].sessionId, edge: 'before' }
  if (y > last.bottom) return { sessionId: last.boxes.at(-1)!.sessionId, edge: 'after' }
  const distance = (point: number, min: number, max: number) => Math.max(min - point, 0, point - max)
  const row = rows.reduce((best, candidate) => distance(y, candidate.top, candidate.bottom) < distance(y, best.top, best.bottom) ? candidate : best)
  const target = row.boxes.reduce((best, candidate) => distance(x, candidate.left, candidate.right) < distance(x, best.left, best.right) ? candidate : best)
  const before = layout === 'grid' ? x < (target.left + target.right) / 2 : y < (target.top + target.bottom) / 2
  return { sessionId: target.sessionId, edge: before ? 'before' : 'after' }
}

export function formatUpdatedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(new Date(timestamp).valueOf())) return '更新时间未知'
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp))
}

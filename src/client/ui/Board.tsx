import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react'
import { DefaultModelSettings } from './DefaultModelSettings.tsx'
import { COLUMNS, STATUS_LABELS, type ArchiveBatchResult, type BoardControllerFace, type ColumnId, type Command, type SessionView, type WatchEntry } from '../../shared/model.js'
import { Icon } from './Icons.js'
import { activityPane, isRunningMirror, isWaitingPaneRow, moveAnchor, formatUpdatedAt, getAddDisabledReason, getBoardRows, groupWorkspaces, groupWorkspaceId, orderWorkspaceGroups, groupOrderStillCurrent, workspaceKey, locateDropTarget, matchesRow, matchesSession, uniqueSessions, workspaceOptions, type BoardRow } from './board-helpers.js'
import { SessionCard, StatusBadge, type NoteDraft } from './SessionCard.js'
import { RemovedList } from './RemovedList.js'
import { ChatBackgroundSettings } from './ChatBackgroundSettings.tsx'
import { initialGroupOrder, type GroupDragSnapshot, type GroupOrderClientState, type GroupOrderControllerFace } from '../../shared/group-order.ts'

interface UndoEntry { entry: WatchEntry }
interface DropPosition { columnId: ColumnId; beforeSessionId?: string; targetSessionId?: string; edge?: 'before' | 'after' }
type Modal = { type: 'settings' } | { type: 'archive'; targets: Array<{ id: string; title: string }>; result?: ArchiveBatchResult } | { type: 'bulk-unfollow'; ids: string[] } | { type: 'add'; columnId: ColumnId } | { type: 'removed' } | { type: 'rename'; sessionId: string; title: string }
const MAX_SELECTION = 500
const PAGE_SIZE = 80
const EMPTY_GROUP_ORDER: GroupOrderClientState = { data: initialGroupOrder(), loaded: false, loading: false, saving: false }

export function Dialog({ title, description, children, onClose, busy, className = '' }: { title: string; description: string; children: ReactNode; onClose: () => void; busy: boolean; className?: string }) {
  const id = useId()
  const dialog = useRef<HTMLElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const document = element.ownerDocument
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const scope = element.closest<HTMLElement>('.dtw-root')
    const background = scope?.querySelector<HTMLElement>('.dtw-main')
    const wasInert = background?.inert ?? false
    if (background) background.inert = true
    const focusable = () => [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')].filter(item => item.getClientRects().length > 0)
    const focusFirst = () => (focusable()[0] ?? element).focus()
    const initial = element.querySelector<HTMLElement>('[data-dtw-initial-focus]:not(:disabled)')
    if (initial) initial.focus(); else focusFirst()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close.current()
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) { event.preventDefault(); element.focus(); return }
      if (!element.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus() }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    const focusin = (event: FocusEvent) => { if (event.target instanceof Node && !element.contains(event.target)) focusFirst() }
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('focusin', focusin)
    return () => {
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('focusin', focusin)
      if (background) background.inert = wasInert
      if (previous?.isConnected) previous.focus(); else scope?.focus()
    }
  }, [])

  return <div className="dtw-overlay" onClick={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section ref={dialog} className={`dtw-dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} tabIndex={-1}>
      <header className="dtw-dialog-head">
        <div><h2 id={`${id}-title`}>{title}</h2><p id={`${id}-description`}>{description}</p></div>
        <button type="button" className="dtw-icon-button" onClick={onClose} disabled={busy} aria-label={`关闭${title}`}><Icon name="close" /></button>
      </header>
      {children}
    </section>
  </div>
}

function AddDialog({ sessions, watchedIds, initialColumn, busy, offline, runtimeReady, error, onClose, onRefresh, onAdd }: {
  sessions: SessionView[]; watchedIds: ReadonlySet<string>; initialColumn: ColumnId; busy: boolean; offline: boolean; runtimeReady: boolean; error?: string
  onClose: () => void; onRefresh: () => void; onAdd: (ids: string[], columnId: ColumnId) => Promise<boolean>
}) {
  const [query, setQuery] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [targetColumn, setTargetColumn] = useState(initialColumn)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const searchId = useId()
  const workspaceId = useId()
  const targetId = useId()
  const options = useMemo(() => uniqueSessions(sessions), [sessions])
  const workspaces = useMemo(() => workspaceOptions(options), [options])
  const filtered = useMemo(() => options.filter(session => matchesSession(session, query, workspace)), [options, query, workspace])
  const availableSelected = useMemo(() => options.filter(session => selected.has(session.id) && !getAddDisabledReason(session, watchedIds)).map(session => session.id), [options, selected, watchedIds])
  const staleSelection = selected.size - availableSelected.length
  const toggle = (sessionId: string) => setSelected(previous => { const next = new Set(previous); if (next.has(sessionId)) next.delete(sessionId); else if (next.size < MAX_SELECTION) next.add(sessionId); return next })

  return <Dialog title="添加已有会话" description="跨工作区选择需要跟进的原对话，添加后可随时调整分类。" busy={busy} onClose={onClose} className="dtw-dialog-add">
    <div className="dtw-dialog-tools"><div className="dtw-search"><Icon name="search" /><label className="dtw-sr-only" htmlFor={searchId}>搜索已有会话</label><input id={searchId} data-dtw-initial-focus type="search" value={query} onChange={event => { setQuery(event.target.value); setVisibleCount(PAGE_SIZE) }} placeholder="搜索会话标题、工作区、运行状态…" /></div><label className="dtw-sr-only" htmlFor={workspaceId}>按工作区筛选待添加会话</label><select id={workspaceId} value={workspace} onChange={event => { setWorkspace(event.target.value); setVisibleCount(PAGE_SIZE) }}><option value="">全部工作区</option>{workspaces.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
    {error && <div className="dtw-dialog-error" role="alert"><Icon name="warning" /><span>{error}</span></div>}
    {offline && <div className="dtw-dialog-error" role="status"><Icon name="info" /><span>连接已断开。当前选择已保留，重新连接后可继续添加。</span><button type="button" className="dtw-text-button" disabled={busy} onClick={onRefresh}>重新连接</button></div>}
    <div className="dtw-session-options" aria-label="已有会话列表" aria-busy={!runtimeReady}>
      {!runtimeReady ? <div className="dtw-empty"><Icon name="refresh" /><strong>正在同步会话目录</strong><p>目录就绪后即可选择已有会话。</p></div> : filtered.length === 0 ? <div className="dtw-empty"><Icon name="search" /><strong>{options.length ? '没有找到匹配的会话' : '暂无可用会话'}</strong><p>{options.length ? '试试调整搜索词或工作区筛选。' : '可以刷新目录后重试。'}</p><button type="button" className="dtw-button dtw-button-small" disabled={busy} onClick={onRefresh}>刷新目录</button></div> : filtered.slice(0, visibleCount).map(session => {
        const reason = getAddDisabledReason(session, watchedIds)
        const selectedHere = selected.has(session.id)
        const atLimit = !selectedHere && selected.size >= MAX_SELECTION
        return <label className={`dtw-session-option ${reason ? 'dtw-session-option-disabled' : ''}`} key={session.id}>
          <input type="checkbox" disabled={busy || !!reason || atLimit} checked={watchedIds.has(session.id) || selectedHere} onChange={() => toggle(session.id)} aria-label={`关注：${session.title || '未命名会话'}`} />
          <span className="dtw-option-main"><span className="dtw-option-title">{session.title.trim() || '未命名会话'}</span><span className="dtw-option-meta"><Icon name="folder" />{session.workspaceTitle.trim() || '未命名工作区'}<span>·</span>{formatUpdatedAt(session.updatedAt)}</span>{(reason || atLimit) && <span className="dtw-option-reason">{reason || '一次最多选择 500 条会话'}</span>}</span><StatusBadge status={session.status} waitingLabel={session.waitingLabel} />
        </label>
      })}
      {runtimeReady && filtered.length > visibleCount && <button type="button" className="dtw-load-more" onClick={() => setVisibleCount(count => count + PAGE_SIZE)}>再显示 {Math.min(PAGE_SIZE, filtered.length - visibleCount)} 条（共 {filtered.length} 条）</button>}
    </div>
    <div className="dtw-dialog-note"><Icon name="info" /><span>已关注会话会自动去重。已归档、子代理与不可打开会话会显示原因。</span></div>
    {staleSelection > 0 && <p className="dtw-selection-warning" role="status">有 {staleSelection} 条已选会话的状态发生变化，提交时会跳过；其余选择仍保留。<button type="button" className="dtw-text-button" disabled={busy} onClick={() => setSelected(new Set(availableSelected))}>清除不可添加的选择</button></p>}
    <footer className="dtw-dialog-footer"><span className="dtw-selection-summary" role="status">已选择 <strong>{availableSelected.length}</strong> 条</span><label htmlFor={targetId}>加入</label><select id={targetId} value={targetColumn} disabled={busy} onChange={event => setTargetColumn(event.target.value as ColumnId)}>{COLUMNS.map(column => <option key={column.id} value={column.id}>{column.title}</option>)}</select><button type="button" className="dtw-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="dtw-button dtw-button-primary" disabled={busy || offline || !runtimeReady || !availableSelected.length} onClick={() => { void onAdd(availableSelected, targetColumn) }}>{busy ? '正在保存…' : '关注选中会话'}</button></footer>
  </Dialog>
}

export function MyFocusBoard({ controller, groupOrder, onNewSession }: { controller: BoardControllerFace; groupOrder?: GroupOrderControllerFace; onNewSession?: (workspaceId?: string) => void | Promise<void> }) {
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller])
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const subscribeGroupOrder = useCallback((listener: () => void) => groupOrder?.subscribe(listener) ?? (() => {}), [groupOrder])
  const getGroupOrder = useCallback(() => groupOrder?.getSnapshot() ?? EMPTY_GROUP_ORDER, [groupOrder])
  const groupState = useSyncExternalStore(subscribeGroupOrder, getGroupOrder, getGroupOrder)
  // 状态变化可能让卡片跨列重挂载，草稿在看板层保存以免丢失输入。
  const [noteDrafts, setNoteDrafts] = useState<Record<string, NoteDraft>>({})
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [status, setStatus] = useState('')
  const [modal, setModal] = useState<Modal | null>(null)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | undefined>()
  const [notice, setNotice] = useState('')
  const [undo, setUndo] = useState<UndoEntry | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const draggingRef = useRef<string | null>(null)
  const groupDragRef = useRef<GroupDragSnapshot | null>(null)
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null)
  const [groupDrop, setGroupDrop] = useState<{ columnId: ColumnId; workspaceId: string; edge: 'before' | 'after' } | null>(null)
  const [drop, setDrop] = useState<DropPosition | null>(null)
  const [collapsedColumns, setCollapsedColumns] = useState<Set<ColumnId>>(() => new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const root = useRef<HTMLDivElement>(null)
  const searchId = useId()
  const autoId = useId()
  const mirrorId = useId()
  const rows = useMemo(() => getBoardRows(state), [state])
  const homeRows = useMemo(() => rows.filter(row => !row.mirrored), [rows])
  const workspaces = useMemo(() => workspaceOptions(state.sessions), [state.sessions])
  const watchedIds = useMemo(() => new Set(state.board.entries.map(entry => entry.sessionId)), [state.board.entries])
  const grouped = useMemo(() => Object.fromEntries(COLUMNS.map(column => [column.id, rows.filter(row => row.displayColumnId === column.id)])) as Record<ColumnId, BoardRow[]>, [rows])
  const visible = useMemo(() => homeRows.filter(row => matchesRow(row, query, workspace, status)), [homeRows, query, workspace, status])
  const visibleIds = useMemo(() => new Set(visible.map(row => row.entry.sessionId)), [visible])
  const busy = state.loading || state.saving || pending || groupState.saving
  const disabled = busy || !state.connected
  const error = localError || state.error || groupState.error
  const filtered = !!query.trim() || !!workspace || !!status
  const selectedIds = [...selected].filter(id => watchedIds.has(id))
  const selectableIds = visible.map(row => row.entry.sessionId)
  useEffect(() => { setSelected(new Set()) }, [query, workspace, status])
  const toggleSelected = (id: string) => setSelected(previous => {
    const next = new Set([...previous].filter(value => watchedIds.has(value)))
    if (next.has(id)) next.delete(id)
    else if (next.size < MAX_SELECTION) next.add(id)
    return next
  })

  const perform = async (operation: () => Promise<boolean>): Promise<boolean> => {
    if (pendingRef.current || controller.getSnapshot().loading || controller.getSnapshot().saving || !controller.getSnapshot().connected) return false
    pendingRef.current = true
    setPending(true)
    setLocalError(undefined)
    try {
      const success = await operation()
      if (!success && !controller.getSnapshot().error) setLocalError('操作未保存，请重试。当前输入已保留。')
      return success
    } catch {
      setLocalError('操作失败，请稍后重试。当前输入已保留。')
      return false
    } finally { pendingRef.current = false; setPending(false) }
  }
  const command = (value: Command) => perform(() => controller.command(value))
  const closeModal = () => { if (!busy) setModal(null) }
  const requestArchive = (ids: string[]) => {
    controller.clearError(); setLocalError(undefined)
    setModal({ type: 'archive', targets: ids.map(id => ({ id, title: rows.find(row => row.entry.sessionId === id)?.title ?? id })) })
  }
  const submitArchive = async () => {
    if (modal?.type !== 'archive' || !controller.archiveSessions) return
    const current = modal
    const ids = current.result ? current.result.items.filter(item => !item.ok).map(item => item.sessionId) : current.targets.map(target => target.id)
    if (!ids.length) return
    await perform(async () => {
      const result = await controller.archiveSessions!(ids)
      const latest = new Map(result.items.map(item => [item.sessionId, item]))
      const items = current.result ? current.result.items.map(item => latest.get(item.sessionId) ?? item) : result.items
      setModal({ ...current, result: { ...result, items } })
      const succeeded = new Set(items.filter(item => item.ok).map(item => item.sessionId))
      setSelected(previous => new Set([...previous].filter(id => !succeeded.has(id))))
      setUndo(null)
      return true
    })
  }
  const refresh = async () => {
    if (pendingRef.current || busy) return
    pendingRef.current = true
    setPending(true)
    setLocalError(undefined)
    try { await Promise.all([controller.refresh(), groupOrder?.refresh()]) } catch { setLocalError('刷新失败，请稍后重试。现有关注记录仍保留。') }
    finally { pendingRef.current = false; setPending(false) }
  }
  const openSession = async (sessionId: string) => {
    if (openingId || disabled) return
    setOpeningId(sessionId)
    setLocalError(undefined)
    try { if (!await controller.openSession(sessionId) && !controller.getSnapshot().error) setLocalError('暂时无法打开原对话，请刷新后重试。') }
    catch { setLocalError('打开原对话失败，请稍后重试。') }
    finally { setOpeningId(null) }
  }
  const revealColumn = (columnId: ColumnId) => setCollapsedColumns(previous => {
    if (!previous.has(columnId)) return previous
    const next = new Set(previous)
    next.delete(columnId)
    return next
  })
  const revealGroup = (_columnId: ColumnId, sessionId: string) => {
    const matches = getBoardRows(controller.getSnapshot()).filter(item => item.entry.sessionId === sessionId)
    for (const row of matches) revealColumn(row.displayColumnId)
    setCollapsedGroups(previous => {
      const next = new Set(previous)
      for (const row of matches) next.delete(JSON.stringify([row.displayColumnId, activityPane(row), workspaceKey(row)]))
      return next
    })
  }
  const toggleColumn = (columnId: ColumnId) => setCollapsedColumns(previous => {
    const next = new Set(previous)
    if (next.has(columnId)) next.delete(columnId)
    else if (next.size < COLUMNS.length - 1) next.add(columnId)
    return next
  })
  const move = async (sessionId: string, columnId: ColumnId, beforeSessionId?: string) => {
    if (await command({ type: 'move', sessionId, columnId, ...(beforeSessionId ? { beforeSessionId } : {}) })) {
      revealColumn(columnId)
      revealGroup(columnId, sessionId)
      setNotice(`已调整至「${COLUMNS.find(column => column.id === columnId)?.title}」中的指定位置。`)
    }
  }
  const unfollow = async (sessionId: string) => {
    const entries = controller.getSnapshot().board.entries
    const current = entries.find(entry => entry.sessionId === sessionId)
    if (!current) { setModal(null); setNotice('这条会话已取消关注。'); return }
    if (await command({ type: 'unfollow', sessionId })) {
      setUndo({ entry: { ...current } })
      setNotice('已移入「已取消关注」，可随时恢复。自动纳入会跳过这条会话，原对话仍保留。')
      setModal(null)
    }
  }
  const clearDrag = () => { draggingRef.current = null; groupDragRef.current = null; setDraggingId(null); setDraggingGroup(null); setDrop(null); setGroupDrop(null) }
  const reorderGroup = async (snapshot: GroupDragSnapshot, beforeId?: string) => {
    if (!groupOrder || disabled || selecting || !groupOrder.getSnapshot().loaded || snapshot.sourceId === beforeId) return
    if (!groupOrderStillCurrent(controller.getSnapshot(), groupOrder.getSnapshot().data, snapshot)) { setLocalError('分组或顺序已变化，请刷新后重新排序。'); return }
    setLocalError(undefined); controller.clearError(); groupOrder.clearError()
    const ok = await groupOrder.reorder({ ...snapshot, ...(beforeId ? { beforeId } : {}) })
    if (ok) setNotice(filtered ? '分组顺序已保存；排序包含当前筛选隐藏的分组。' : '分组顺序已保存，所属分类与会话不变。')
  }
  const groupDropAnchor = (event: DragEvent<HTMLElement>, snapshot: GroupDragSnapshot): string | undefined => {
    for (const node of event.currentTarget.querySelectorAll<HTMLElement>('.dtw-workspace-group')) {
      if (!node.getClientRects().length) continue
      let id: unknown
      try { id = JSON.parse(node.dataset.dtwWorkspace ?? 'null') } catch { continue }
      if (typeof id !== 'string' || id === snapshot.sourceId || !snapshot.workspaceIds.includes(id) || node.closest('[data-dtw-pane="running"]')) continue
      const rect = node.getBoundingClientRect()
      if (event.clientY < (rect.top + rect.bottom) / 2) return id
    }
    return undefined
  }
  const dropPosition = (event: DragEvent<HTMLElement>, columnId: ColumnId): DropPosition => {
    const pane = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-dtw-pane]')?.dataset.dtwPane : undefined
    if (pane === 'running') return { columnId, beforeSessionId: draggingRef.current ?? undefined }
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-dtw-session]') : null
    if (element?.dataset.dtwSession === draggingRef.current) return { columnId, beforeSessionId: draggingRef.current ?? undefined }
    const source = rows.find(row => !row.mirrored && row.entry.sessionId === draggingRef.current)
    const paneRows = columnId === 'waiting' ? grouped.waiting.filter(isWaitingPaneRow) : grouped[columnId].filter(row => !row.mirrored)
    const ownRows = paneRows.filter(row => source && workspaceKey(row) === workspaceKey(source))
    const ownIds = new Set(ownRows.map(row => row.entry.sessionId))
    const groupElement = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-dtw-workspace]')].find(node => node.dataset.dtwWorkspace === (source && workspaceKey(source)))
    const hoveredGroup = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-dtw-workspace]') : null
    // 拖入其他工作区的区域只改变分类，不能改变会话所属工作区。
    if (hoveredGroup && hoveredGroup !== groupElement) return { columnId }
    const nodes = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-dtw-session]')].filter(node => ownIds.has(node.dataset.dtwSession ?? ''))
    const boxes = nodes.filter(node => node.dataset.dtwSession !== draggingRef.current && node.getClientRects().length > 0).map(node => {
      const rect = node.getBoundingClientRect()
      return { sessionId: node.dataset.dtwSession!, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    })
    const grid = groupElement?.querySelector('.dtw-cards')
    const tracks = grid ? getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length : 1
    const target = locateDropTarget(boxes, event.clientX, event.clientY, tracks > 1 ? 'grid' : 'list')
    if (!target) return { columnId }
    return { columnId, targetSessionId: target.sessionId, edge: target.edge, beforeSessionId: moveAnchor(ownRows, target.sessionId, target.edge, columnId, draggingRef.current ?? '') }
  }
  const updateDrop = (position: DropPosition) => setDrop(previous => previous?.columnId === position.columnId && previous.beforeSessionId === position.beforeSessionId && previous.targetSessionId === position.targetSessionId && previous.edge === position.edge ? previous : position)
  const restoreRemoved = async (sessionId: string): Promise<boolean> => {
    if (!await command({ type: 'restore', sessionId })) return false
    const entry = controller.getSnapshot().board.entries.find(item => item.sessionId === sessionId)
    if (entry) { revealColumn(entry.columnId); revealGroup(entry.columnId, sessionId) }
    if (undo?.entry.sessionId === sessionId) setUndo(null)
    setNotice('已恢复关注、已保存的备注与可恢复的列内位置。')
    return true
  }
  const restore = async () => { if (undo) await restoreRemoved(undo.entry.sessionId) }

  return <div className="dtw-root dtw-compact" ref={root} tabIndex={-1} aria-label="我的任务工作台">
    <main className="dtw-main" aria-busy={busy}>
      <header className="dtw-header">
        <div className="dtw-topbar">
          <div className="dtw-heading-group">
            <h1>我的关注</h1>
            <div className="dtw-stats" aria-label="已关注会话统计">
              <button type="button" className="dtw-stat-filter" aria-label="显示全部状态的已关注会话" aria-pressed={!status} title="清除状态筛选，保留搜索和工作区筛选" onClick={() => setStatus('')}><strong>{homeRows.length}</strong>已关注</button>
              {(['running', 'waiting', 'unread', 'idle'] as const).map(item => <button type="button" className="dtw-stat-filter" key={item} aria-label={`筛选${STATUS_LABELS[item]}会话`} aria-pressed={status === item} title={status === item ? '再次点击取消状态筛选' : `仅显示${STATUS_LABELS[item]}，保留搜索和工作区筛选`} onClick={() => setStatus(previous => previous === item ? '' : item)}><i className={`dtw-dot dtw-dot-${item}`} aria-hidden="true" /><strong>{homeRows.filter(row => row.status === item).length}</strong>{STATUS_LABELS[item]}</button>)}
            </div>
          </div>
          <div className="dtw-header-actions">
            <button type="button" className="dtw-button" disabled={disabled || !!openingId || Object.keys(noteDrafts).length > 0} aria-pressed={selecting} onClick={() => { clearDrag(); setSelected(new Set()); setSelecting(value => !value) }}>{selecting ? '退出多选' : '多选'}</button>
            <button type="button" className="dtw-button" disabled={state.loading} onClick={() => { setLocalError(undefined); controller.clearError(); setModal({ type: 'removed' }) }}>已取消关注{state.board.excludedSessionIds.length > 0 ? `（${state.board.excludedSessionIds.length}）` : ''}</button>
            <span className={`dtw-connection ${state.connected ? 'dtw-connected' : ''}`} title={state.connected ? state.runtimeReady ? '已连接' : '同步中' : '连接已断开'}><i aria-hidden="true" /><span className="dtw-sr-only">{state.connected ? '已连接' : '连接已断开'}</span></span>
            <button type="button" className="dtw-button" disabled={state.loading} aria-label="打开工作台设置" title="自动纳入、中间列同步展示、聊天背景与使用帮助" onClick={() => { controller.clearError(); setLocalError(undefined); setModal({ type: 'settings' }) }}>设置</button>
            <button type="button" className="dtw-button" disabled={disabled || !state.runtimeReady || !onNewSession} title={workspace ? `在「${workspaces.find(item => item.id === workspace)?.title ?? '所选工作区'}」新建会话` : '沿用当前工作区新建会话；无有效工作区时进入选择页'} onClick={() => { void perform(async () => { await onNewSession?.(workspace || undefined); return true }) }}><Icon name="plus" />新建会话</button>
            <button type="button" className="dtw-button dtw-button-primary" disabled={disabled || !state.runtimeReady} onClick={() => setModal({ type: 'add', columnId: 'focus' })}><Icon name="plus" />添加已有会话</button>
          </div>
        </div>
        <div className="dtw-toolbar">
          <div className="dtw-search"><Icon name="search" /><label className="dtw-sr-only" htmlFor={searchId}>搜索已关注会话、工作区、备注或运行状态</label><input id={searchId} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索会话、工作区、备注或运行状态…" /></div>
          <select value={workspace} onChange={event => setWorkspace(event.target.value)} aria-label="按工作区筛选已关注会话"><option value="">全部工作区</option>{workspaces.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
          <select value={status} onChange={event => setStatus(event.target.value)} aria-label="按运行状态筛选已关注会话"><option value="">全部运行状态</option>{Object.entries(STATUS_LABELS).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select>
          <button type="button" className="dtw-icon-button dtw-refresh" disabled={busy} onClick={() => { void refresh() }} title="刷新关注与会话目录" aria-label="刷新看板"><Icon name="refresh" /></button>
        </div>
        {selecting && <div className="dtw-bulk-toolbar" role="region" aria-label="批量管理关注">
          <span role="status">已选 {selectedIds.length} 条（最多 {MAX_SELECTION} 条）{selectedIds.some(id => !visibleIds.has(id)) && `，其中 ${selectedIds.filter(id => !visibleIds.has(id)).length} 条当前不可见`}</span>
          <button type="button" className="dtw-button dtw-button-small" disabled={disabled || !selectableIds.length} onClick={() => setSelected(new Set(selectableIds.slice(0, MAX_SELECTION)))}>全选筛选结果{selectableIds.length > MAX_SELECTION ? '（前500条）' : ''}</button>
          <button type="button" className="dtw-button dtw-button-small" disabled={disabled || !selectedIds.length} onClick={() => setSelected(new Set())}>清空选择</button>
          <button type="button" className="dtw-button dtw-button-danger dtw-button-small" disabled={disabled || !selectedIds.length} onClick={() => { controller.clearError(); setLocalError(undefined); setModal({ type: 'bulk-unfollow', ids: selectedIds }) }}>取消关注所选</button>
          <button type="button" className="dtw-button dtw-button-small" disabled={disabled || !!openingId || !state.runtimeReady || !selectedIds.length || !controller.archiveSessions} onClick={() => requestArchive(selectedIds)}>归档所选</button>
          <span className="dtw-bulk-hint">全选包含折叠分组；更改筛选会清空选择。</span>
        </div>}
      </header>
      {!state.connected && <div className="dtw-banner dtw-banner-warning" role="status"><Icon name="warning" /><p>与 DSH 的连接已断开。现有关注仍保留，重新连接后可继续整理。</p><button type="button" className="dtw-text-button" disabled={busy} onClick={() => { void refresh() }}>重新连接</button></div>}
      {state.connected && !state.runtimeReady && <div className="dtw-banner" role="status"><Icon name="refresh" /><p>会话目录正在同步，已有关注记录会继续保留。</p></div>}
      {error && <div className="dtw-banner dtw-banner-error" role="alert"><Icon name="warning" /><p>{error}</p><button type="button" className="dtw-icon-button" aria-label="关闭错误提示" onClick={() => { setLocalError(undefined); controller.clearError(); groupOrder?.clearError() }}><Icon name="close" /></button></div>}
      {(filtered || busy) && <div className="dtw-results" role="status"><span>{filtered ? `显示 ${visible.length} / ${homeRows.length} 条关注` : '正在同步保存…'}</span>{filtered && <button type="button" className="dtw-text-button" onClick={() => { setQuery(''); setWorkspace(''); setStatus('') }}>清除筛选</button>}</div>}
      <section className="dtw-board" aria-label="关注会话分类看板" style={{ gridTemplateColumns: COLUMNS.map(column => collapsedColumns.has(column.id) ? '44px' : 'minmax(0, 1fr)').join(' ') }}>
        {COLUMNS.map(column => {
          const columnRows = grouped[column.id]
          const runningRows = column.id === 'waiting' ? columnRows.filter(isRunningMirror) : []
          const paneRows = column.id === 'waiting' ? columnRows.filter(isWaitingPaneRow) : columnRows.filter(row => !row.mirrored)
          const visibleColumnRows = columnRows.filter(row => visibleIds.has(row.entry.sessionId))
          const collapsed = collapsedColumns.has(column.id)
          const canCollapse = collapsed || collapsedColumns.size < COLUMNS.length - 1
          const headingId = `${searchId}-${column.id}`
          const bodyId = `${headingId}-body`
          const renderGroups = (sourceRows: BoardRow[], pane: 'home' | 'running' | 'waiting') => {
            const columnGroups = orderWorkspaceGroups(groupWorkspaces(sourceRows), groupState.data.columns[column.id])
            const sortableGroupIds = pane === 'running' ? [] : columnGroups.map(groupWorkspaceId).filter((id): id is string => !!id)
            const visibleRows = sourceRows.filter(row => visibleIds.has(row.entry.sessionId))
            const sortable = pane !== 'running'
            if (state.loading && !homeRows.length) return <div className="dtw-empty"><Icon name="refresh" /><strong>正在载入关注…</strong></div>
            if (!visibleRows.length) return <div className="dtw-empty"><Icon name={filtered ? 'search' : 'plus'} /><strong>{filtered ? '没有符合筛选的会话' : pane === 'running' ? '当前没有运行中的关注' : pane === 'waiting' ? '暂无需要处理的会话' : '暂无关注'}</strong><p>{filtered ? '调整筛选即可重新显示。' : pane === 'running' ? '运行中的关注会同步出现在这里，原卡片仍留在我的关注。' : '点击上方 ＋ 添加，或拖入卡片。'}</p></div>
            return columnGroups.filter(group => group.rows.some(row => visibleIds.has(row.entry.sessionId))).map(group => {
              const matched = group.rows.filter(row => visibleIds.has(row.entry.sessionId))
              const key = JSON.stringify([column.id, pane, group.key])
              const folded = collapsedGroups.has(key)
              const groupBodyId = `${bodyId}-${pane}-${encodeURIComponent(group.key)}`
              const workspaceId = groupWorkspaceId(group)
              const index = workspaceId ? sortableGroupIds.indexOf(workspaceId) : -1
              const hasDraft = Object.keys(noteDrafts).length > 0
              const sortDisabled = !sortable || disabled || selecting || !!openingId || !state.runtimeReady || !workspaceId || hasDraft || !groupOrder || !groupState.loaded || groupState.loading || sortableGroupIds.length < 2
              const sortReason = pane === 'running' ? '运行中为同步展示，请在我的关注中调整分组顺序' : hasDraft ? '请先保存或取消备注草稿' : !workspaceId ? '工作区尚未确认，暂不支持排序' : !groupState.loaded ? '分组顺序尚未加载，请刷新' : !state.runtimeReady ? '会话目录尚未就绪' : selecting ? '请先退出多选模式' : sortableGroupIds.length < 2 ? '当前分类只有一个工作区分组' : '调整同一分类内的分组顺序'
              const snapshot = (): GroupDragSnapshot => ({ columnId: column.id, sourceId: workspaceId!, workspaceIds: [...sortableGroupIds], expectedOrderRevision: groupState.data.revision, expectedBoardRevision: state.board.revision })
              const dropEdge = groupDrop?.columnId === column.id && groupDrop.workspaceId === workspaceId ? groupDrop.edge : undefined
              return <section className={`dtw-workspace-group ${draggingGroup === key ? 'dtw-workspace-group-dragging' : ''} ${dropEdge ? `dtw-group-drop-${dropEdge}` : ''}`} key={key} data-dtw-workspace={group.key} aria-label={group.title}
                onDragOver={event => {
                  const drag = groupDragRef.current
                  if (!drag || drag.columnId !== column.id || disabled || selecting || pane === 'running') return
                  event.preventDefault(); event.stopPropagation()
                  if (!workspaceId || workspaceId === drag.sourceId) { event.dataTransfer.dropEffect = 'none'; setGroupDrop(null); return }
                  event.dataTransfer.dropEffect = 'move'
                  const rect = event.currentTarget.getBoundingClientRect(); const edge = event.clientY < (rect.top + rect.bottom) / 2 ? 'before' : 'after'
                  setGroupDrop(previous => previous?.columnId === column.id && previous.workspaceId === workspaceId && previous.edge === edge ? previous : { columnId: column.id, workspaceId, edge })
                }}
                onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setGroupDrop(null) }}
                onDrop={event => {
                  const drag = groupDragRef.current
                  if (!drag || drag.columnId !== column.id || disabled || selecting || pane === 'running') return
                  event.preventDefault(); event.stopPropagation()
                  if (!workspaceId || workspaceId === drag.sourceId) { clearDrag(); return }
                  const targetIndex = drag.workspaceIds.indexOf(workspaceId)
                  const rect = event.currentTarget.getBoundingClientRect(); const before = event.clientY < (rect.top + rect.bottom) / 2
                  const anchor = before ? workspaceId : drag.workspaceIds[targetIndex + 1]
                  clearDrag(); if (targetIndex >= 0) void reorderGroup(drag, anchor)
                }}>
                <div className="dtw-workspace-group-head">
                  <button type="button" className="dtw-workspace-heading" aria-expanded={!folded} aria-controls={groupBodyId} draggable={!sortDisabled} title={`${group.title}；${sortDisabled ? sortReason : '拖动组头可在本分类内排序'}`} onDragStart={event => {
                    if (sortDisabled) { event.preventDefault(); return }
                    event.stopPropagation(); draggingRef.current = null; groupDragRef.current = snapshot(); setDraggingGroup(key)
                    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-dtw-workspace-group', 'group')
                  }} onDragEnd={clearDrag} onClick={() => setCollapsedGroups(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next })}>
                    <Icon name={folded ? 'expand' : 'down'} /><Icon name="folder" /><span className="dtw-workspace-name">{group.title}</span><span className="dtw-workspace-count">{filtered ? `${matched.length} / ${group.rows.length}` : group.rows.length}</span>
                  </button>
                  {sortable && <>
                    <button type="button" className="dtw-icon-button dtw-workspace-sort" aria-label={`上移「${column.title}」中的「${group.title}」分组`} title={sortDisabled ? sortReason : '上移分组'} disabled={sortDisabled || index <= 0} onClick={() => { void reorderGroup(snapshot(), sortableGroupIds[index - 1]) }}><Icon name="up" /></button>
                    <button type="button" className="dtw-icon-button dtw-workspace-sort" aria-label={`下移「${column.title}」中的「${group.title}」分组`} title={sortDisabled ? sortReason : '下移分组'} disabled={sortDisabled || index < 0 || index >= sortableGroupIds.length - 1} onClick={() => { void reorderGroup(snapshot(), sortableGroupIds[index + 2]) }}><Icon name="down" /></button>
                  </>}
                </div>
                <div className="dtw-cards" id={groupBodyId} hidden={folded}>
                  {matched.map(row => <SessionCard
                    selecting={selecting} selected={selected.has(row.entry.sessionId)} onSelect={() => toggleSelected(row.entry.sessionId)}
                    draft={noteDrafts[row.entry.sessionId] ?? null} setDraft={draft => setNoteDrafts(previous => { const next = { ...previous }; if (draft) next[row.entry.sessionId] = draft; else delete next[row.entry.sessionId]; return next })}
                    key={`${pane}-${row.entry.sessionId}`} row={row} columnRows={group.rows} busy={disabled} opening={openingId === row.entry.sessionId} dragging={draggingId === row.entry.sessionId && !row.mirrored}
                    dropBefore={!row.mirrored && drop?.columnId === column.id && drop.targetSessionId === row.entry.sessionId && drop.edge === 'before'}
                    dropAfter={!row.mirrored && drop?.columnId === column.id && drop.targetSessionId === row.entry.sessionId && drop.edge === 'after'}
                    onOpen={() => { void openSession(row.entry.sessionId) }} onUnfollow={() => { void unfollow(row.entry.sessionId) }}
                    onMove={(columnId, beforeSessionId) => { void move(row.entry.sessionId, columnId, beforeSessionId) }}
                    onArchive={controller.archiveSessions ? () => requestArchive([row.entry.sessionId]) : undefined}
                    onRename={() => { controller.clearError(); setLocalError(undefined); setModal({ type: 'rename', sessionId: row.entry.sessionId, title: row.title }) }}
                    onNote={(note, expectedVersion) => command({ type: 'note', sessionId: row.entry.sessionId, note, expectedVersion })}
                    onNotice={message => { setNotice(message); setUndo(null) }}
                    onDragStart={event => {
                      if (row.mirrored || disabled || (event.target instanceof Element && event.target.closest('button, input, select, textarea, summary, details'))) { event.preventDefault(); return }
                      draggingRef.current = row.entry.sessionId; setDraggingId(row.entry.sessionId)
                      event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-dtw-session', row.entry.sessionId)
                    }} onDragEnd={clearDrag}
                  />)}</div></section>
            })
          }
          const uniqueCount = (items: BoardRow[]) => new Set(items.map(row => row.entry.sessionId)).size
          const columnHandlers = {
            onDragOver: (event: DragEvent<HTMLElement>) => {
              if (disabled || selecting) return
              if (event.target instanceof Element && event.target.closest('[data-dtw-pane="running"]')) {
                event.preventDefault(); event.dataTransfer.dropEffect = 'none'; setDrop(null); setGroupDrop(null); return
              }
              if (groupDragRef.current) {
                if (groupDragRef.current.columnId === column.id) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setGroupDrop(null); updateDrop({ columnId: column.id }) }
                return
              }
              if (!draggingRef.current) return
              event.preventDefault(); event.dataTransfer.dropEffect = 'move'; updateDrop(dropPosition(event, column.id))
            },
            onDragLeave: (event: DragEvent<HTMLElement>) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDrop(null) },
            onDrop: (event: DragEvent<HTMLElement>) => {
              if (disabled || selecting) return
              if (event.target instanceof Element && event.target.closest('[data-dtw-pane="running"]')) { event.preventDefault(); clearDrag(); return }
              const group = groupDragRef.current
              if (group) { if (group.columnId === column.id) { event.preventDefault(); const anchor = groupDropAnchor(event, group); clearDrag(); void reorderGroup(group, anchor) }; return }
              if (!draggingRef.current) return
              event.preventDefault(); const sessionId = draggingRef.current; const position = dropPosition(event, column.id); clearDrag(); if (sessionId !== position.beforeSessionId) void move(sessionId, position.columnId, position.beforeSessionId)
            },
          }
          if (column.id === 'waiting' && state.board.settings.mirrorActivity) {
            const runningHeadingId = `${headingId}-running`
            const runningVisible = runningRows.filter(row => visibleIds.has(row.entry.sessionId))
            const waitingVisible = paneRows.filter(row => visibleIds.has(row.entry.sessionId))
            return <section key={column.id} data-dtw-column={column.id} data-collapsed={collapsed} className={`dtw-column-stack ${collapsed ? 'dtw-column dtw-column-collapsed' : ''} ${drop?.columnId === column.id ? 'dtw-column-dropping' : ''}`} aria-labelledby={headingId} {...columnHandlers}>
              {collapsed ? <header className="dtw-column-head">
                <h2 id={headingId} title={column.description}>{column.title}</h2>
                <span className="dtw-column-count" aria-label={`共 ${uniqueCount(visibleColumnRows)} 条`}>{filtered ? `${uniqueCount(visibleColumnRows)} / ${uniqueCount(columnRows)}` : uniqueCount(columnRows)}</span>
                <button type="button" className="dtw-icon-button dtw-column-toggle" disabled={!canCollapse} aria-label={`${collapsed ? '展开' : '折叠'}「${column.title}」`} title={canCollapse ? `${collapsed ? '展开' : '折叠'}分类` : '至少保留一个展开的分类'} aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => toggleColumn(column.id)}><Icon name={collapsed ? 'expand' : 'collapse'} /></button>
              </header> : <>
                <section className="dtw-column" data-dtw-pane="running" aria-labelledby={runningHeadingId}>
                  <header className="dtw-column-head">
                    <h2 id={runningHeadingId} title="同步展示「我的关注」里正在运行的会话，原卡片不离开">运行中</h2>
                    <span className="dtw-column-count" aria-label={`共 ${runningVisible.length} 条`}>{filtered ? `${runningVisible.length} / ${runningRows.length}` : runningRows.length}</span>
                  </header>
                  <div className="dtw-column-body">
                    <div className="dtw-workspace-groups">{renderGroups(runningRows, 'running')}</div>
                  </div>
                </section>
                <section className="dtw-column" data-dtw-pane="waiting" aria-labelledby={headingId}>
                  <header className="dtw-column-head">
                    <h2 id={headingId} title={column.description}>等我处理</h2>
                    <span className="dtw-column-count" aria-label={`共 ${waitingVisible.length} 条`}>{filtered ? `${waitingVisible.length} / ${paneRows.length}` : paneRows.length}</span>
                    <button type="button" className="dtw-icon-button dtw-column-toggle" disabled={!canCollapse} aria-label={`折叠「等我处理」`} title={canCollapse ? '折叠分类' : '至少保留一个展开的分类'} aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => toggleColumn(column.id)}><Icon name="collapse" /></button>
                    <button type="button" className="dtw-icon-button dtw-column-add" aria-label="添加到「等我处理」" title="添加已有会话" disabled={disabled || !state.runtimeReady} onClick={() => setModal({ type: 'add', columnId: column.id })}><Icon name="plus" /></button>
                  </header>
                  <div className="dtw-column-body" id={bodyId}>
                    <div className="dtw-workspace-groups">{renderGroups(paneRows, 'waiting')}</div>
                  </div>
                </section>
              </>}
            </section>
          }
          return <section key={column.id} data-dtw-column={column.id} data-collapsed={collapsed} className={`dtw-column dtw-column-${column.id} ${collapsed ? 'dtw-column-collapsed' : ''} ${drop?.columnId === column.id ? 'dtw-column-dropping' : ''}`} aria-labelledby={headingId} {...columnHandlers}>
            <header className="dtw-column-head">
              <h2 id={headingId} title={column.description}>{column.title}</h2>
              <span className="dtw-column-count" aria-label={`共 ${uniqueCount(visibleColumnRows)} 条`}>{filtered ? `${uniqueCount(visibleColumnRows)} / ${uniqueCount(columnRows)}` : uniqueCount(columnRows)}</span>
              <button type="button" className="dtw-icon-button dtw-column-toggle" disabled={!canCollapse} aria-label={`${collapsed ? '展开' : '折叠'}「${column.title}」`} title={canCollapse ? `${collapsed ? '展开' : '折叠'}分类` : '至少保留一个展开的分类'} aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => toggleColumn(column.id)}><Icon name={collapsed ? 'expand' : 'collapse'} /></button>
              {!collapsed && <button type="button" className="dtw-icon-button dtw-column-add" aria-label={`添加到「${column.title}」`} title="添加已有会话" disabled={disabled || !state.runtimeReady} onClick={() => setModal({ type: 'add', columnId: column.id })}><Icon name="plus" /></button>}
            </header>
            <div className="dtw-column-body" id={bodyId} hidden={collapsed}>
              <div className="dtw-workspace-groups">{renderGroups(paneRows, column.id === 'waiting' ? 'waiting' : 'home')}</div>
            </div>
          </section>
        })}
      </section>
    </main>
    {(notice || undo) && <aside className="dtw-toast" role="status" aria-live="polite"><span>{notice}</span>{undo && <button className="dtw-text-button" type="button" disabled={disabled || modal !== null} onClick={() => { void restore() }}><Icon name="undo" />撤销取消关注</button>}<button type="button" className="dtw-icon-button" aria-label="关闭操作提示" disabled={modal !== null || busy} onClick={() => { setNotice(''); setUndo(null) }}><Icon name="close" /></button></aside>}
    {modal?.type === 'add' && <AddDialog sessions={state.sessions} watchedIds={watchedIds} initialColumn={modal.columnId} busy={busy} offline={!state.connected} runtimeReady={state.runtimeReady} error={error} onClose={closeModal} onRefresh={() => { void refresh() }} onAdd={async (ids, columnId) => {
      const success = await command({ type: 'add', sessionIds: ids, columnId })
      if (success) { revealColumn(columnId); ids.forEach(id => revealGroup(columnId, id)); setModal(null); setNotice(`已关注 ${ids.length} 条会话。`); setUndo(null) }
      return success
    }} />}
    {modal?.type === 'settings' && <Dialog title="工作台设置" description="设置新会话默认模型、自动纳入、看板显示和聊天背景。" busy={busy} onClose={closeModal} className="dtw-dialog-settings">
      <div className="dtw-settings">
        <DefaultModelSettings selection={state.board.settings.defaultModelSelection} enabled={state.board.settings.lockDefaultModel}
          disabled={disabled} connected={state.connected} loadCatalog={controller.loadModelCatalog} command={command} />
        <section>
          <strong>自动纳入</strong>
          <p>开启后，普通会话开始新一轮时加入「我的关注」，包括已有会话续聊。只打开查看不会纳入，也不会回扫历史；关闭时保留已有关注。</p>
          <div className="dtw-auto">
            <span className="dtw-auto-title" id={autoId}>{state.board.settings.autoCollect ? '已开启，新一轮自动关注' : '已关闭，仅手动关注'}</span>
            <button type="button" role="switch" className="dtw-switch" aria-label="自动纳入会话" aria-checked={state.board.settings.autoCollect} aria-describedby={autoId} disabled={disabled} onClick={() => {
              const autoCollect = !state.board.settings.autoCollect
              void (async () => { if (await command({ type: 'settings', autoCollect })) setNotice(autoCollect ? '已开启自动纳入，新的会话轮次会加入我的关注。' : '已关闭自动纳入，已有关注记录保留。') })()
            }}><span /></button>
          </div>
        </section>
        <section>
          <strong>侧聊自动纳入</strong>
          <p>开启后，侧聊开始新一轮时加入「我的关注」，卡片标记为「侧聊」。此设置独立于普通会话的自动纳入。</p>
          <div className="dtw-auto">
            <span className="dtw-auto-title">{state.board.settings.autoCollectSidechat ? '已开启' : '已关闭'}</span>
            <button type="button" role="switch" className="dtw-switch" aria-label="侧聊自动纳入" aria-checked={state.board.settings.autoCollectSidechat} disabled={disabled} onClick={() => {
              void command({ type: 'sidechatSettings', enabled: !state.board.settings.autoCollectSidechat })
            }}><span /></button>
          </div>
        </section>
        <section>
          <strong>中间列同步展示</strong>
          <p>开启后，「我的关注」里运行中、等待回应、完成未读会同时出现在中间列，原卡片不离开。关闭后，中间列只保留你手动放入「等我处理」的会话。暂时搁置不参与同步。</p>
          <div className="dtw-auto">
            <span className="dtw-auto-title" id={mirrorId}>{state.board.settings.mirrorActivity ? '已开启，活动会话同步出现在中间列' : '已关闭，中间列只显示手动放入的会话'}</span>
            <button type="button" role="switch" className="dtw-switch" aria-label="中间列同步展示活动会话" aria-checked={state.board.settings.mirrorActivity} aria-describedby={mirrorId} disabled={disabled} onClick={() => {
              const enabled = !state.board.settings.mirrorActivity
              void (async () => { if (await command({ type: 'mirrorActivity', enabled })) setNotice(enabled ? '已开启中间列同步展示；关注原卡片不会消失。' : '已关闭中间列同步展示，中间列只保留手动放入的会话。') })()
            }}><span /></button>
          </div>
        </section>
        <section>
          <strong>聊天背景</strong>
          <p>独立保存背景偏好，不依赖外部主题插件。默认关闭，仅浅色模式生效。</p>
          <ChatBackgroundSettings embedded value={state.board.settings.chatBackground} busy={busy} disabled={disabled} error={error} onSave={async value => {
            if (!await command({ type: 'chatBackground', value })) return false
            setNotice(value.enabled ? '聊天背景已保存，返回原生对话查看；深色模式保持原样。' : '已关闭自定义背景，恢复宿主或其他已启用主题的背景。'); return true
          }} />
        </section>
        <section>
          <strong>使用帮助</strong>
          <div className="dtw-rules">
            <section><strong>打开原对话</strong><p>点击卡片标题回到 DSH 原会话，继续使用原生输入与所有现有入口。</p></section>
            <section><strong>整理与排序</strong><p>每列按工作区分组，点击组头可折叠；拖动组头或点击旁边的上、下箭头，可调整该分组在同一分类中的顺序。各列顺序独立保存，筛选隐藏的分组也参与排序；组头不能跨分类移动，不改变任何会话分类或电脑文件。单卡拖拽仍支持组内排序和跨分类移动；拖入其他工作区区域时，卡片仍归入自己的工作区。</p></section>
            <section><strong>折叠分类</strong><p>分类标题旁的箭头可收起或展开该列，至少保留一个展开分类。向折叠列拖入卡片后会展开，折叠只改变显示布局。</p></section>
            <section><strong>归档会话</strong><p>单条在更多菜单选择归档会话，批量在多选后选择归档所选。确认后调用 DSH 原生归档，不强制停止运行；结果逐条显示，失败项可重试。恢复归档使用 DSH 原生入口。</p></section>
            <section><strong>归档即自动取消关注</strong><p>原会话归档后自动移入已取消关注，已有归档关注也会处理。保留原分类与已保存备注；恢复归档后不会自动重新关注，需手动恢复。未就绪或缺失不视为归档。</p></section>
            <section><strong>取消关注后自动跳过</strong><p>取消关注后可从顶部「已取消关注」查看或恢复，分类、已保存备注与可恢复的顺序会保留。升级前的历史记录仅保留 ID，恢复至我的关注。原会话仍在原工作区，自动纳入会跳过排除项，不会停止、归档或删除原会话。</p></section>
            <section><strong>中间列</strong><p>上块同步展示「我的关注」里的运行中会话，下块展示手动放入的「等我处理」以及等待回应、完成未读。默认同步开启，原卡片不离开「我的关注」；可在设置中关闭。暂时搁置不参与同步。中间列的同步卡片用于查看，分类和排序仍以「我的关注」原卡片为准。</p></section>
            <section><strong>复制名称和 ID</strong><p>卡片右下角三个点菜单可复制 Session ID，或同时复制名称和 ID，格式与左侧会话列表右键菜单一致。名称为空时只复制 ID。</p></section>
            <section><strong>状态与备注</strong><p>自动展示不修改人工分类、顺序或备注。「完成未读」沿用 DSH 的页面内存提醒，不代表任务验收完成。长备注可展开，编辑入口在卡片的「更多操作」中。</p></section>
          </div>
        </section>
      </div>
      <footer className="dtw-dialog-footer"><button type="button" className="dtw-button dtw-button-primary" disabled={busy} onClick={closeModal}>完成</button></footer>
    </Dialog>}
    {modal?.type === 'archive' && <Dialog title={modal.result ? '归档结果' : '归档会话'} description="使用 DSH 原生归档，成功后自动取消关注，不删除会话。运行中的活动不会被强制停止；批量逐条执行，可能部分成功。恢复归档请使用 DSH 原生入口。" busy={busy} onClose={closeModal}>
      <div className="dtw-bulk-preview">
        {modal.result ? <><p role="status">已归档 {modal.result.items.filter(item => item.ok).length} 条，失败 {modal.result.items.filter(item => !item.ok).length} 条。</p><ul>{modal.result.items.map(item => <li key={item.sessionId}><strong>{item.title}</strong>：{item.message}</li>)}</ul>{modal.result.syncWarning && <p role="alert">{modal.result.syncWarning}</p>}</> : <ul>{modal.targets.map(target => <li key={target.id}>{target.title}</li>)}</ul>}
        {error && <p role="alert">{error}</p>}
        {!state.connected && <p role="status">连接已断开，请恢复连接后重试。</p>}
      </div>
      <footer className="dtw-dialog-footer"><button type="button" className="dtw-button" disabled={busy} onClick={closeModal}>{modal.result ? '关闭' : '取消'}</button>
        {(!modal.result || modal.result.items.some(item => !item.ok)) && <button type="button" className="dtw-button dtw-button-primary" disabled={disabled || !controller.archiveSessions} onClick={() => { void submitArchive() }}>{busy ? '正在归档…' : modal.result ? '重试失败项' : `确认归档 ${modal.targets.length} 条会话`}</button>}
      </footer>
    </Dialog>}
    {modal?.type === 'bulk-unfollow' && <Dialog title="批量取消关注" description={`将取消 ${modal.ids.length} 条所选会话的关注，不会停止、归档或删除原会话。可从「已取消关注」恢复。`} busy={busy} onClose={closeModal}>
      <div className="dtw-bulk-preview"><ul>{modal.ids.map(id => <li key={id}>{rows.find(row => row.entry.sessionId === id)?.title ?? id}</li>)}</ul>
        {error && <p role="alert">{error}</p>}
        {!state.connected && <p role="status">连接已断开，恢复后可重试。</p>}
      </div>
      <footer className="dtw-dialog-footer"><button type="button" className="dtw-button" disabled={busy} onClick={closeModal}>返回</button><button type="button" className="dtw-button dtw-button-danger" disabled={disabled} onClick={() => { const ids = modal.ids; void (async () => {
        if (await command({ type: 'unfollowMany', sessionIds: ids })) {
          setSelected(new Set()); setSelecting(false); setModal(null); setUndo(null)
          setNotice('批量取消关注已保存；原会话保留，可从「已取消关注」恢复。已被其他窗口取消的记录自动跳过。')
        }
      })() }}>{busy ? '正在保存…' : `确认取消 ${modal.ids.length} 条关注`}</button></footer>
    </Dialog>}
    {modal?.type === 'rename' && <Dialog title="修改会话名" description="保存后同步更新 DSH 原生会话名称。" busy={busy} onClose={closeModal}>
      <form className="dtw-rename-form" onSubmit={event => {
        event.preventDefault()
        if (disabled || !modal.title.trim()) return
        void (async () => {
          if (await perform(() => controller.renameSession(modal.sessionId, modal.title))) { setModal(null); setNotice('会话名已更新。'); setUndo(null) }
        })()
      }}>
        <label>会话名<input data-dtw-initial-focus aria-label="会话名" value={modal.title} disabled={busy} autoComplete="off" onFocus={event => event.currentTarget.select()} onChange={event => { setModal({ ...modal, title: event.target.value }); controller.clearError(); setLocalError(undefined) }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault() }} /></label>
        {error && <p role="alert" className="dtw-inline-warning">{error}</p>}
        {!state.connected && <p role="status">连接已断开，恢复后可重试；当前输入已保留。</p>}
        <footer className="dtw-dialog-footer"><button type="button" className="dtw-button" disabled={busy} onClick={closeModal}>取消</button><button type="submit" className="dtw-button dtw-button-primary" disabled={disabled || !modal.title.trim()}>{busy ? '保存中…' : '保存名称'}</button></footer>
      </form>
    </Dialog>}
    {modal?.type === 'removed' && <Dialog title="已取消关注" description="查看已移出的会话，按需恢复关注。原对话仍保留在 DSH 中。" busy={busy} onClose={closeModal} className="dtw-dialog-add">
      <RemovedList state={state} busy={busy} error={error} openingId={openingId} onRestore={restoreRemoved} onOpen={openSession} onRefresh={refresh} />
      <footer className="dtw-dialog-footer"><button type="button" className="dtw-button" disabled={busy} onClick={closeModal}>返回看板</button></footer>
    </Dialog>}

  </div>
}

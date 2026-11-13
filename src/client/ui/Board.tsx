import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react'
import { COLUMNS, STATUS_LABELS, type BoardControllerFace, type ColumnId, type Command, type SessionView, type WatchEntry } from '../../shared/model.js'
import { Icon } from './Icons.js'
import { moveAnchor, formatUpdatedAt, getAddDisabledReason, getBoardRows, groupWorkspaces, workspaceKey, locateDropTarget, matchesRow, matchesSession, uniqueSessions, workspaceOptions, type BoardRow } from './board-helpers.js'
import { SessionCard, StatusBadge, type NoteDraft } from './SessionCard.js'
import { RemovedList } from './RemovedList.js'

interface UndoEntry { entry: WatchEntry }
interface DropPosition { columnId: ColumnId; beforeSessionId?: string; targetSessionId?: string; edge?: 'before' | 'after' }
type Modal = { type: 'add'; columnId: ColumnId } | { type: 'rules' } | { type: 'removed' } | { type: 'rename'; sessionId: string; title: string }
const MAX_SELECTION = 500
const PAGE_SIZE = 80

function Dialog({ title, description, children, onClose, busy, className = '' }: { title: string; description: string; children: ReactNode; onClose: () => void; busy: boolean; className?: string }) {
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

export function MyFocusBoard({ controller, onNewSession }: { controller: BoardControllerFace; onNewSession?: (workspaceId?: string) => void | Promise<void> }) {
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller])
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  // 状态变化可能让卡片跨列重挂载，草稿在看板层保存以免丢失输入。
  const [noteDrafts, setNoteDrafts] = useState<Record<string, NoteDraft>>({})
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
  const [drop, setDrop] = useState<DropPosition | null>(null)
  const [collapsedColumns, setCollapsedColumns] = useState<Set<ColumnId>>(() => new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const groupId = (column: ColumnId, key: string) => JSON.stringify([column, key])
  const root = useRef<HTMLDivElement>(null)
  const searchId = useId()
  const autoId = useId()
  const rows = useMemo(() => getBoardRows(state), [state])
  const workspaces = useMemo(() => workspaceOptions(state.sessions), [state.sessions])
  const watchedIds = useMemo(() => new Set(state.board.entries.map(entry => entry.sessionId)), [state.board.entries])
  const grouped = useMemo(() => Object.fromEntries(COLUMNS.map(column => [column.id, rows.filter(row => row.displayColumnId === column.id)])) as Record<ColumnId, BoardRow[]>, [rows])
  const visible = useMemo(() => rows.filter(row => matchesRow(row, query, workspace, status)), [rows, query, workspace, status])
  const visibleIds = useMemo(() => new Set(visible.map(row => row.entry.sessionId)), [visible])
  const busy = state.loading || state.saving || pending
  const disabled = busy || !state.connected
  const error = localError || state.error
  const filtered = !!query.trim() || !!workspace || !!status

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
  const refresh = async () => {
    if (pendingRef.current || busy) return
    pendingRef.current = true
    setPending(true)
    setLocalError(undefined)
    try { await controller.refresh() } catch { setLocalError('刷新失败，请稍后重试。现有关注记录仍保留。') }
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
    const row = getBoardRows(controller.getSnapshot()).find(item => item.entry.sessionId === sessionId)
    if (row) { revealColumn(row.displayColumnId); setCollapsedGroups(previous => { const next = new Set(previous); next.delete(groupId(row.displayColumnId, workspaceKey(row))); return next }) }
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
      const row = getBoardRows(controller.getSnapshot()).find(item => item.entry.sessionId === sessionId)
      setNotice(row && row.displayColumnId !== row.entry.columnId ? '原分类已保存；当前仍自动显示在「等我处理」，处理后返回「我的关注」。' : `已调整至「${COLUMNS.find(column => column.id === columnId)?.title}」中的指定位置。`)
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
  const clearDrag = () => { draggingRef.current = null; setDraggingId(null); setDrop(null) }
  const dropPosition = (event: DragEvent<HTMLElement>, columnId: ColumnId): DropPosition => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-dtw-session]') : null
    if (element?.dataset.dtwSession === draggingRef.current) return { columnId, beforeSessionId: draggingRef.current ?? undefined }
    const source = rows.find(row => row.entry.sessionId === draggingRef.current)
    const ownRows = grouped[columnId].filter(row => source && workspaceKey(row) === workspaceKey(source))
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
              <span><strong>{rows.length}</strong>已关注</span>
              {(['running', 'waiting', 'unread', 'idle'] as const).map(item => <span key={item}><i className={`dtw-dot dtw-dot-${item}`} aria-hidden="true" /><strong>{rows.filter(row => row.status === item).length}</strong>{STATUS_LABELS[item]}</span>)}
            </div>
          </div>
          <div className="dtw-header-actions">
            <button type="button" className="dtw-button" disabled={state.loading} onClick={() => { setLocalError(undefined); controller.clearError(); setModal({ type: 'removed' }) }}>已取消关注{state.board.excludedSessionIds.length > 0 ? `（${state.board.excludedSessionIds.length}）` : ''}</button>
            <div className="dtw-auto">
              <span className="dtw-auto-title">自动纳入</span>
              <span className="dtw-sr-only" id={autoId}>{state.board.settings.autoCollect ? '已开启，新一轮自动关注' : '已关闭，仅手动关注'}</span>
              <button type="button" role="switch" className="dtw-switch" aria-label="自动纳入会话" aria-checked={state.board.settings.autoCollect} aria-describedby={autoId} disabled={disabled} onClick={() => {
                const autoCollect = !state.board.settings.autoCollect
                void (async () => { if (await command({ type: 'settings', autoCollect })) setNotice(autoCollect ? '已开启自动纳入，新的会话轮次会加入我的关注。' : '已关闭自动纳入，已有关注记录保留。') })()
              }}><span /></button>
            </div>
            <span className={`dtw-connection ${state.connected ? 'dtw-connected' : ''}`} title={state.connected ? state.runtimeReady ? '已连接' : '同步中' : '连接已断开'}><i aria-hidden="true" /><span className="dtw-sr-only">{state.connected ? '已连接' : '连接已断开'}</span></span>
            <button type="button" className="dtw-icon-button dtw-help" aria-label="查看使用帮助" title="使用帮助与自动纳入规则" onClick={() => setModal({ type: 'rules' })}><Icon name="info" /></button>
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
      </header>
      {!state.connected && <div className="dtw-banner dtw-banner-warning" role="status"><Icon name="warning" /><p>与 DSH 的连接已断开。现有关注仍保留，重新连接后可继续整理。</p><button type="button" className="dtw-text-button" disabled={busy} onClick={() => { void refresh() }}>重新连接</button></div>}
      {state.connected && !state.runtimeReady && <div className="dtw-banner" role="status"><Icon name="refresh" /><p>会话目录正在同步，已有关注记录会继续保留。</p></div>}
      {error && <div className="dtw-banner dtw-banner-error" role="alert"><Icon name="warning" /><p>{error}</p><button type="button" className="dtw-icon-button" aria-label="关闭错误提示" onClick={() => { setLocalError(undefined); controller.clearError() }}><Icon name="close" /></button></div>}
      {(filtered || busy) && <div className="dtw-results" role="status"><span>{filtered ? `显示 ${visible.length} / ${rows.length} 条关注` : '正在同步保存…'}</span>{filtered && <button type="button" className="dtw-text-button" onClick={() => { setQuery(''); setWorkspace(''); setStatus('') }}>清除筛选</button>}</div>}
      <section className="dtw-board" aria-label="关注会话分类看板" style={{ gridTemplateColumns: COLUMNS.map(column => collapsedColumns.has(column.id) ? '44px' : 'minmax(0, 1fr)').join(' ') }}>
        {COLUMNS.map(column => {
          const columnRows = grouped[column.id]
          const visibleRows = columnRows.filter(row => visibleIds.has(row.entry.sessionId))
          const collapsed = collapsedColumns.has(column.id)
          const canCollapse = collapsed || collapsedColumns.size < COLUMNS.length - 1
          const headingId = `${searchId}-${column.id}`
          const bodyId = `${headingId}-body`
          return <section key={column.id} data-dtw-column={column.id} data-collapsed={collapsed} className={`dtw-column dtw-column-${column.id} ${collapsed ? 'dtw-column-collapsed' : ''} ${drop?.columnId === column.id ? 'dtw-column-dropping' : ''}`} aria-labelledby={headingId}
            onDragOver={event => { if (!draggingRef.current || disabled) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; updateDrop(dropPosition(event, column.id)) }}
            onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDrop(null) }}
            onDrop={event => { if (!draggingRef.current || disabled) return; event.preventDefault(); const sessionId = draggingRef.current; const position = dropPosition(event, column.id); clearDrag(); if (sessionId !== position.beforeSessionId) void move(sessionId, position.columnId, position.beforeSessionId) }}>
            <header className="dtw-column-head">
              <h2 id={headingId} title={column.description}>{column.title}</h2>
              <span className="dtw-column-count" aria-label={`共 ${columnRows.length} 条`}>{filtered ? `${visibleRows.length} / ${columnRows.length}` : columnRows.length}</span>
              <button type="button" className="dtw-icon-button dtw-column-toggle" disabled={!canCollapse} aria-label={`${collapsed ? '展开' : '折叠'}「${column.title}」`} title={canCollapse ? `${collapsed ? '展开' : '折叠'}分类` : '至少保留一个展开的分类'} aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => toggleColumn(column.id)}><Icon name={collapsed ? 'expand' : 'collapse'} /></button>
              {!collapsed && <button type="button" className="dtw-icon-button dtw-column-add" aria-label={`添加到「${column.title}」`} title="添加已有会话" disabled={disabled || !state.runtimeReady} onClick={() => setModal({ type: 'add', columnId: column.id })}><Icon name="plus" /></button>}
            </header>
            <div className="dtw-column-body" id={bodyId} hidden={collapsed}>
              {column.id === 'waiting' && <p className="dtw-column-hint">含等待回应与完成未读；自动项处理后回原列，搁置项不归集。</p>}
              <div className="dtw-workspace-groups">
                {state.loading && !rows.length ? <div className="dtw-empty"><Icon name="refresh" /><strong>正在载入关注…</strong></div> : visibleRows.length ? groupWorkspaces(columnRows).filter(group => group.rows.some(row => visibleIds.has(row.entry.sessionId))).map(group => {
                  const matched = group.rows.filter(row => visibleIds.has(row.entry.sessionId))
                  const key = groupId(column.id, group.key)
                  const folded = collapsedGroups.has(key)
                  const groupBodyId = `${bodyId}-${encodeURIComponent(group.key)}`
                  return <section className="dtw-workspace-group" key={group.key} data-dtw-workspace={group.key} aria-label={group.title}>
                    <button type="button" className="dtw-workspace-heading" aria-expanded={!folded} aria-controls={groupBodyId} title={group.title} onClick={() => setCollapsedGroups(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next })}>
                      <Icon name={folded ? 'expand' : 'down'} /><Icon name="folder" /><span className="dtw-workspace-name">{group.title}</span><span className="dtw-workspace-count">{filtered ? `${matched.length} / ${group.rows.length}` : group.rows.length}</span>
                    </button>
                    <div className="dtw-cards" id={groupBodyId} hidden={folded}>
                      {matched.map(row => <SessionCard
                        draft={noteDrafts[row.entry.sessionId] ?? null} setDraft={draft => setNoteDrafts(previous => { const next = { ...previous }; if (draft) next[row.entry.sessionId] = draft; else delete next[row.entry.sessionId]; return next })}
                        key={row.entry.sessionId} row={row} columnRows={group.rows} busy={disabled} opening={openingId === row.entry.sessionId} dragging={draggingId === row.entry.sessionId}
                        dropBefore={drop?.columnId === column.id && drop.targetSessionId === row.entry.sessionId && drop.edge === 'before'}
                        dropAfter={drop?.columnId === column.id && drop.targetSessionId === row.entry.sessionId && drop.edge === 'after'}
                        onOpen={() => { void openSession(row.entry.sessionId) }} onUnfollow={() => { void unfollow(row.entry.sessionId) }}
                        onMove={(columnId, beforeSessionId) => { void move(row.entry.sessionId, columnId, beforeSessionId) }}
                        onRename={() => { controller.clearError(); setLocalError(undefined); setModal({ type: 'rename', sessionId: row.entry.sessionId, title: row.title }) }}
                        onNote={(note, expectedVersion) => command({ type: 'note', sessionId: row.entry.sessionId, note, expectedVersion })}
                        onDragStart={event => {
                          if (disabled || (event.target instanceof Element && event.target.closest('button, input, select, textarea, summary, details'))) { event.preventDefault(); return }
                          draggingRef.current = row.entry.sessionId; setDraggingId(row.entry.sessionId)
                          event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-dtw-session', row.entry.sessionId)
                        }} onDragEnd={clearDrag}
                      />)}</div></section>
                }) : <div className="dtw-empty"><Icon name={filtered ? 'search' : 'plus'} /><strong>{filtered ? '没有符合筛选的会话' : '暂无关注'}</strong><p>{filtered ? '调整筛选即可重新显示。' : '点击上方 ＋ 添加，或拖入卡片。'}</p></div>}
              </div>
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
    {modal?.type === 'rules' && <Dialog title="使用帮助" description="人工分类由你决定，等待回应与未读自动汇总到等我处理。" busy={false} onClose={closeModal} className="dtw-dialog-rules">
      <div className="dtw-rules">
        <section><strong>打开原对话</strong><p>点击卡片标题回到 DSH 原会话，继续使用原生输入与所有现有入口。</p></section>
        <section><strong>整理与排序</strong><p>每列按工作区分组，点击工作区组头可折叠。拖拽支持组内排序和跨分类移动，不改变会话所属工作区；拖入其他工作区区域时，卡片仍归入自己的工作区。宽列同组内从左到右、从上到下排列；上移、下移仅作用于同组。</p></section>
        <section><strong>折叠分类</strong><p>分类标题旁的箭头可收起或展开该列，至少保留一个展开分类。向折叠列拖入卡片后会展开，折叠只改变显示布局。</p></section>
        <section><strong>默认关闭自动纳入</strong><p>开启后，普通会话开始新一轮时加入「我的关注」，包括已有会话续聊。只打开查看不会纳入，也不会回扫历史；关闭时保留已有关注。</p></section>
        <section><strong>取消关注后自动跳过</strong><p>取消关注后可从顶部「已取消关注」查看或恢复，分类、已保存备注与可恢复的顺序会保留。升级前的历史记录仅保留 ID，恢复至我的关注。原会话仍在原工作区，自动纳入会跳过排除项，不会停止、归档或删除原会话。</p></section>
        <section><strong>等我处理</strong><p>展示手动放入的会话，以及我的关注中等待回应、完成未读的会话。自动项只显示一次，处理后回原列；暂时搁置不参与归集。卡片下拉显示原分类，选择等我处理可长期保留，选择暂时搁置可暂停提醒。自动项按原分类顺序展示，上下移动请先设为手动待处理。</p></section>
        <section><strong>状态与备注</strong><p>自动展示不修改人工分类、顺序或备注。「完成未读」沿用 DSH 的页面内存提醒，不代表任务验收完成。长备注可展开，编辑入口在卡片的「更多操作」中。</p></section>
      </div>
      <footer className="dtw-dialog-footer"><button type="button" className="dtw-button dtw-button-primary" onClick={closeModal}>知道了</button></footer>
    </Dialog>}
  </div>
}

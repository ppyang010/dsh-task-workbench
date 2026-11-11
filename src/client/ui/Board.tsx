import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react'
import { COLUMNS, STATUS_LABELS, type BoardControllerFace, type ColumnId, type Command, type RuntimeStatus, type SessionView, type WatchEntry } from '../../shared/model.js'
import { Icon } from './Icons.js'
import { afterSessionId, formatUpdatedAt, getAddDisabledReason, getBoardRows, matchesRow, matchesSession, uniqueSessions, workspaceOptions, type BoardRow } from './board-helpers.js'

interface UndoEntry { entry: WatchEntry; beforeSessionId?: string }
interface DropPosition { columnId: ColumnId; beforeSessionId?: string }
type Modal = { type: 'add'; columnId: ColumnId } | { type: 'rules' }
const MAX_SELECTION = 500
const PAGE_SIZE = 80

function StatusBadge({ status, waitingLabel }: { status: RuntimeStatus; waitingLabel?: string }) {
  return <span className={`dtw-status dtw-status-${status}`} title={waitingLabel || STATUS_LABELS[status]}><i aria-hidden="true" />{STATUS_LABELS[status]}</span>
}

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

function NoteEditor({ row, busy, onSave, onEditingChange }: { row: BoardRow; busy: boolean; onSave: (note: string, version: number) => Promise<boolean>; onEditingChange: (editing: boolean) => void }) {
  const [draft, setDraft] = useState<{ text: string; expectedVersion: number } | null>(null)
  const id = useId()
  const textArea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { onEditingChange(draft !== null); if (draft) textArea.current?.focus() }, [draft === null, onEditingChange])
  if (!draft) return <div className={`dtw-note ${row.entry.note ? '' : 'dtw-note-empty'}`}>
    {row.entry.note && <p>{row.entry.note}</p>}
    <button className="dtw-text-button" type="button" disabled={busy} onClick={() => setDraft({ text: row.entry.note, expectedVersion: row.entry.version })} aria-label={`${row.entry.note ? '编辑' : '添加'}备注：${row.title}`}><Icon name="edit" />{row.entry.note ? '编辑备注' : '添加备注'}</button>
  </div>
  const changedElsewhere = draft.expectedVersion !== row.entry.version
  return <form className="dtw-note-editor" onSubmit={event => { event.preventDefault(); void (async () => { if (await onSave(draft.text, draft.expectedVersion)) setDraft(null) })() }}>
    <label htmlFor={id}>关注备注</label>
    <textarea id={id} ref={textArea} value={draft.text} maxLength={2000} rows={4} disabled={busy} onChange={event => setDraft({ ...draft, text: event.target.value })} placeholder="记下下次回来要处理的事…" onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' && !busy) setDraft(null) }} />
    <div className="dtw-note-count">{draft.text.length} / 2000</div>
    {changedElsewhere && <div className="dtw-inline-warning" role="status"><p>这条关注记录已在别处更新。草稿已保留，确认最新备注后再保存。</p><details><summary>查看最新备注</summary><p>{row.entry.note || '暂无备注'}</p></details><button className="dtw-text-button" type="button" disabled={busy} onClick={() => setDraft({ ...draft, expectedVersion: row.entry.version })}>保留草稿，使用最新版本</button></div>}
    <div className="dtw-note-actions"><button type="button" className="dtw-button dtw-button-small" disabled={busy} onClick={() => setDraft(null)}>取消</button><button type="submit" className="dtw-button dtw-button-primary dtw-button-small" disabled={busy || changedElsewhere}>{busy ? '保存中…' : '保存备注'}</button></div>
  </form>
}

function SessionCard({ row, columnRows, busy, opening, dragging, dropBefore, onOpen, onUnfollow, onMove, onNote, onDragStart, onDragEnd }: {
  row: BoardRow; columnRows: BoardRow[]; busy: boolean; opening: boolean; dragging: boolean; dropBefore: boolean
  onOpen: () => void; onUnfollow: () => void; onMove: (columnId: ColumnId, beforeSessionId?: string) => void; onNote: (note: string, version: number) => Promise<boolean>
  onDragStart: (event: DragEvent<HTMLElement>) => void; onDragEnd: () => void
}) {
  const [editingWithin, setEditingWithin] = useState(false)
  const index = columnRows.findIndex(item => item.entry.sessionId === row.entry.sessionId)
  return <article className={`dtw-card ${dragging ? 'dtw-card-dragging' : ''} ${dropBefore ? 'dtw-card-drop-before' : ''}`} data-dtw-session={row.entry.sessionId} draggable={!busy && !editingWithin} onDragStart={onDragStart} onDragEnd={onDragEnd} aria-label={row.title}>
    <div className="dtw-card-head"><span className="dtw-drag-handle" aria-hidden="true" title="拖动调整分类和顺序"><Icon name="grip" /></span><h3>{row.title}</h3><button type="button" className="dtw-icon-button dtw-unfollow" disabled={busy || editingWithin} onClick={onUnfollow} aria-label={`取消关注：${row.title}`} title="仅取消关注，原会话保留"><Icon name="close" /></button></div>
    <div className="dtw-workspace" title={row.workspaceTitle}><Icon name="folder" /><span>{row.workspaceTitle}</span>{row.entry.source === 'auto' && <span className="dtw-source">自动纳入</span>}</div>
    <NoteEditor row={row} busy={busy} onSave={onNote} onEditingChange={setEditingWithin} />
    <div className="dtw-card-status"><StatusBadge status={row.status} waitingLabel={row.session?.waitingLabel} /><time dateTime={row.session?.updatedAt && row.session.updatedAt > 0 ? new Date(row.session.updatedAt).toJSON() ?? undefined : undefined}>{formatUpdatedAt(row.session?.updatedAt ?? 0)}</time></div>
    {row.session?.waitingLabel && row.status === 'waiting' && <p className="dtw-waiting-label">{row.session.waitingLabel}</p>}
    {row.unavailableReason && <p className="dtw-card-unavailable"><Icon name="info" />{row.unavailableReason}</p>}
    <footer className="dtw-card-footer"><button type="button" className="dtw-open-button" disabled={busy || opening || !!row.unavailableReason} onClick={onOpen} title={row.unavailableReason || '在 DSH 中打开原会话'}>{opening ? '正在打开…' : '打开原对话'}<Icon name="arrow" /></button><select className="dtw-move-select" value={row.entry.columnId} disabled={busy} onChange={event => onMove(event.target.value as ColumnId)} aria-label={`调整分类：${row.title}`}>{COLUMNS.map(column => <option key={column.id} value={column.id}>{column.title}</option>)}</select></footer>
    <div className="dtw-card-order"><span>列内排序</span><button type="button" className="dtw-icon-button" disabled={busy || index <= 0} onClick={() => onMove(row.entry.columnId, columnRows[index - 1]?.entry.sessionId)} aria-label={`上移：${row.title}`}><Icon name="up" /></button><button type="button" className="dtw-icon-button" disabled={busy || index < 0 || index >= columnRows.length - 1} onClick={() => onMove(row.entry.columnId, columnRows[index + 2]?.entry.sessionId)} aria-label={`下移：${row.title}`}><Icon name="down" /></button></div>
  </article>
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

export function MyFocusBoard({ controller }: { controller: BoardControllerFace }) {
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller])
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
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
  const root = useRef<HTMLDivElement>(null)
  const searchId = useId()
  const autoId = useId()
  const rows = useMemo(() => getBoardRows(state), [state])
  const workspaces = useMemo(() => workspaceOptions(state.sessions), [state.sessions])
  const watchedIds = useMemo(() => new Set(state.board.entries.map(entry => entry.sessionId)), [state.board.entries])
  const grouped = useMemo(() => Object.fromEntries(COLUMNS.map(column => [column.id, rows.filter(row => row.entry.columnId === column.id)])) as Record<ColumnId, BoardRow[]>, [rows])
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
  const move = async (sessionId: string, columnId: ColumnId, beforeSessionId?: string) => {
    if (await command({ type: 'move', sessionId, columnId, ...(beforeSessionId ? { beforeSessionId } : {}) })) setNotice(`已调整至「${COLUMNS.find(column => column.id === columnId)?.title}」中的指定位置。`)
  }
  const unfollow = async (sessionId: string) => {
    const entries = controller.getSnapshot().board.entries
    const current = entries.find(entry => entry.sessionId === sessionId)
    if (!current) { setModal(null); setNotice('这条会话已取消关注。'); return }
    const columnEntries = entries.filter(entry => entry.columnId === current.columnId)
    const next = columnEntries[columnEntries.findIndex(entry => entry.sessionId === sessionId) + 1]
    if (await command({ type: 'unfollow', sessionId })) {
      setUndo({ entry: { ...current }, beforeSessionId: next?.sessionId })
      setNotice('已取消关注，自动纳入将跳过这条会话。原对话仍保留。')
      setModal(null)
    }
  }
  const clearDrag = () => { draggingRef.current = null; setDraggingId(null); setDrop(null) }
  const dropPosition = (event: DragEvent<HTMLElement>, columnId: ColumnId): DropPosition => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-dtw-session]') : null
    const targetId = element?.dataset.dtwSession
    if (!element || !targetId) return { columnId }
    if (targetId === draggingRef.current) return { columnId, beforeSessionId: targetId }
    const rect = element.getBoundingClientRect()
    if (event.clientY < rect.top + rect.height / 2) return { columnId, beforeSessionId: targetId }
    return { columnId, beforeSessionId: afterSessionId(grouped[columnId], targetId, draggingRef.current ?? '') }
  }
  const restore = async () => {
    if (!undo) return
    const removed = undo
    const restored = await perform(async () => {
      if (!await controller.command({ type: 'add', sessionIds: [removed.entry.sessionId], columnId: removed.entry.columnId })) return false
      const current = controller.getSnapshot().board.entries.find(entry => entry.sessionId === removed.entry.sessionId)
      if (removed.entry.note && (!current || !await controller.command({ type: 'note', sessionId: current.sessionId, note: removed.entry.note, expectedVersion: current.version }))) return false
      const anchor = controller.getSnapshot().board.entries.find(entry => entry.sessionId === removed.beforeSessionId && entry.columnId === removed.entry.columnId)
      if (anchor && !await controller.command({ type: 'move', sessionId: removed.entry.sessionId, columnId: removed.entry.columnId, beforeSessionId: anchor.sessionId })) return false
      return true
    })
    if (restored) { setUndo(null); setNotice('已恢复关注、备注与可恢复的列内位置。') }
  }

  return <div className="dtw-root" ref={root} tabIndex={-1}>
    <main className="dtw-main" aria-busy={busy}>
      <div className="dtw-breadcrumb"><Icon name="board" /><span>我的工作台</span><span aria-hidden="true">/</span><strong>我的关注</strong><span className={`dtw-connection ${state.connected ? 'dtw-connected' : ''}`}><i aria-hidden="true" />{state.connected ? state.runtimeReady ? '已连接' : '同步中' : '连接已断开'}</span></div>
      <header className="dtw-hero"><div className="dtw-hero-copy"><p className="dtw-eyebrow">把注意力留给重要的对话</p><h1>我的关注<span aria-hidden="true">。</span></h1><p className="dtw-subtitle">跨工作区整理需要跟进的会话，随时回到原对话。</p></div><div className="dtw-header-actions"><div className="dtw-auto"><div><div className="dtw-auto-title">自动纳入<button className="dtw-icon-button" type="button" onClick={() => setModal({ type: 'rules' })} aria-label="查看自动纳入规则"><Icon name="info" /></button></div><p id={autoId}>{state.board.settings.autoCollect ? '已开启 · 新一轮自动关注' : '已关闭 · 仅手动关注'}</p></div><button type="button" role="switch" className="dtw-switch" aria-label="自动纳入会话" aria-checked={state.board.settings.autoCollect} aria-describedby={autoId} disabled={disabled} onClick={() => { const autoCollect = !state.board.settings.autoCollect; void (async () => { if (await command({ type: 'settings', autoCollect })) setNotice(autoCollect ? '已开启自动纳入，新的会话轮次会加入我的关注。' : '已关闭自动纳入，已有关注记录保留。') })() }}><span /></button></div><button type="button" className="dtw-button dtw-button-primary" disabled={disabled || !state.runtimeReady} onClick={() => setModal({ type: 'add', columnId: 'focus' })}><Icon name="plus" />添加已有会话</button></div></header>
      <div className="dtw-stats" aria-label="已关注会话统计"><span><strong>{rows.length}</strong>已关注</span><span className="dtw-stat-divider" aria-hidden="true" />{(['running', 'waiting', 'unread'] as const).map(item => <span key={item}><i className={`dtw-dot dtw-dot-${item}`} aria-hidden="true" /><strong>{rows.filter(row => row.status === item).length}</strong>{STATUS_LABELS[item]}</span>)}<span className="dtw-static-classification"><Icon name="lock" />运行状态只更新标记，分类由你决定</span></div>
      {!state.connected && <div className="dtw-banner dtw-banner-warning" role="status"><Icon name="warning" /><p>与 DSH 的连接已断开。现有关注仍保留，重新连接后可继续整理。</p><button type="button" className="dtw-text-button" disabled={busy} onClick={() => { void refresh() }}>重新连接</button></div>}
      {state.connected && !state.runtimeReady && <div className="dtw-banner" role="status"><Icon name="refresh" /><p>会话目录正在同步，已有关注记录会继续保留。</p></div>}
      {error && <div className="dtw-banner dtw-banner-error" role="alert"><Icon name="warning" /><p>{error}</p><button type="button" className="dtw-icon-button" aria-label="关闭错误提示" onClick={() => { setLocalError(undefined); controller.clearError() }}><Icon name="close" /></button></div>}
      <div className="dtw-toolbar"><div className="dtw-search"><Icon name="search" /><label className="dtw-sr-only" htmlFor={searchId}>搜索已关注会话、工作区、备注或运行状态</label><input id={searchId} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索会话、工作区、备注或运行状态…" /></div><select value={workspace} onChange={event => setWorkspace(event.target.value)} aria-label="按工作区筛选已关注会话"><option value="">全部工作区</option>{workspaces.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><select value={status} onChange={event => setStatus(event.target.value)} aria-label="按运行状态筛选已关注会话"><option value="">全部运行状态</option>{Object.entries(STATUS_LABELS).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select><button type="button" className="dtw-icon-button dtw-refresh" disabled={busy} onClick={() => { void refresh() }} title="刷新关注与会话目录" aria-label="刷新看板"><Icon name="refresh" /></button></div>
      <div className="dtw-results"><span>{filtered ? `显示 ${visible.length} / ${rows.length} 条关注` : '拖拽卡片调整分类与顺序，也可使用卡片上的分类和排序按钮'}</span>{filtered && <button type="button" className="dtw-text-button" onClick={() => { setQuery(''); setWorkspace(''); setStatus('') }}>清除筛选</button>}<span className="dtw-save-state" role="status">{busy ? '正在同步保存…' : ''}</span></div>
      <section className="dtw-board" aria-label="关注会话分类看板">
        {COLUMNS.map(column => {
          const columnRows = grouped[column.id]
          const visibleRows = columnRows.filter(row => visibleIds.has(row.entry.sessionId))
          return <section key={column.id} className={`dtw-column dtw-column-${column.id} ${drop?.columnId === column.id ? 'dtw-column-dropping' : ''}`} aria-labelledby={`${searchId}-${column.id}`} onDragOver={event => { if (!draggingRef.current || disabled) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDrop(dropPosition(event, column.id)) }} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDrop(null) }} onDrop={event => { if (!draggingRef.current || disabled) return; event.preventDefault(); const sessionId = draggingRef.current; const position = dropPosition(event, column.id); clearDrag(); if (sessionId !== position.beforeSessionId) void move(sessionId, position.columnId, position.beforeSessionId) }}>
            <header className="dtw-column-head"><span className="dtw-column-mark" aria-hidden="true" /><h2 id={`${searchId}-${column.id}`}>{column.title}</h2><span className="dtw-column-count" aria-label={`共 ${columnRows.length} 条`}>{filtered ? `${visibleRows.length} / ${columnRows.length}` : columnRows.length}</span></header><p className="dtw-column-description">{column.description}</p>
            <div className={`dtw-cards ${drop?.columnId === column.id && !drop.beforeSessionId ? 'dtw-cards-drop-end' : ''}`}>
              {state.loading && !rows.length ? <div className="dtw-empty"><Icon name="refresh" /><strong>正在载入关注…</strong></div> : visibleRows.length ? visibleRows.map(row => <SessionCard key={row.entry.sessionId} row={row} columnRows={columnRows} busy={disabled} opening={openingId === row.entry.sessionId} dragging={draggingId === row.entry.sessionId} dropBefore={drop?.columnId === column.id && drop.beforeSessionId === row.entry.sessionId} onOpen={() => { void openSession(row.entry.sessionId) }} onUnfollow={() => { void unfollow(row.entry.sessionId) }} onMove={(columnId, beforeSessionId) => { void move(row.entry.sessionId, columnId, beforeSessionId) }} onNote={(note, expectedVersion) => command({ type: 'note', sessionId: row.entry.sessionId, note, expectedVersion })} onDragStart={event => { if (disabled || (event.target instanceof Element && event.target.closest('button, input, select, textarea'))) { event.preventDefault(); return } draggingRef.current = row.entry.sessionId; setDraggingId(row.entry.sessionId); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-dtw-session', row.entry.sessionId) }} onDragEnd={clearDrag} />) : <div className="dtw-empty"><Icon name={filtered ? 'search' : column.id === 'waiting' ? 'info' : column.id === 'later' ? 'folder' : 'plus'} /><strong>{filtered ? '没有符合筛选条件的会话' : column.id === 'focus' ? '留一个位置给重要的对话' : column.id === 'waiting' ? '等待你处理的对话，放在这里' : '先放一放，下次再继续'}</strong><p>{filtered ? '调整筛选后，其他关注会重新显示。' : '添加已有会话，或从其他列拖入。'}</p></div>}
            </div><button type="button" className="dtw-add-to-column" disabled={disabled || !state.runtimeReady} onClick={() => setModal({ type: 'add', columnId: column.id })}><Icon name="plus" />添加已有会话</button>
          </section>
        })}
      </section>
      <div className="dtw-principle"><Icon name="link" /><div><strong>关注留在这里，对话留在原处。</strong><p>打开卡片会回到 DSH 原对话。取消关注只移除关注关系，原工作区和聊天记录都保留。</p></div></div>
    </main>
    {(notice || undo) && <aside className="dtw-toast" role="status" aria-live="polite"><span>{notice}</span>{undo && <button className="dtw-text-button" type="button" disabled={disabled || modal !== null} onClick={() => { void restore() }}><Icon name="undo" />撤销取消关注</button>}<button type="button" className="dtw-icon-button" aria-label="关闭操作提示" disabled={modal !== null || busy} onClick={() => { setNotice(''); setUndo(null) }}><Icon name="close" /></button></aside>}
    {modal?.type === 'add' && <AddDialog sessions={state.sessions} watchedIds={watchedIds} initialColumn={modal.columnId} busy={busy} offline={!state.connected} runtimeReady={state.runtimeReady} error={error} onClose={closeModal} onRefresh={() => { void refresh() }} onAdd={async (ids, columnId) => { const success = await command({ type: 'add', sessionIds: ids, columnId }); if (success) { setModal(null); setNotice(`已关注 ${ids.length} 条会话。`); setUndo(null) } return success }} />}
    {modal?.type === 'rules' && <Dialog title="自动纳入，手动整理" description="默认关闭。开启后会在会话开始新一轮时建立关注关系。" busy={false} onClose={() => setModal(null)} className="dtw-dialog-rules"><div className="dtw-rules"><section><strong>由你决定什么时候开启</strong><p>关闭时仅手动添加；关闭开关会保留已有关注。</p></section><section><strong>新一轮开始时，加入「我的关注」</strong><p>包括新会话和已有会话续聊。只打开查看不会纳入，也不会回扫全部历史。子代理会话会被跳过。</p></section><section><strong>运行状态与分类分别更新</strong><p>运行中、等待回应、完成未读只更新卡片标记。会话的分类和顺序始终由你手动整理。</p></section><section><strong>取消关注后，自动纳入会跳过</strong><p>取消关注会记入排除名单，避免立即加回。之后可从添加窗口重新关注，也可直接撤销。</p></section></div><footer className="dtw-dialog-footer"><button type="button" className="dtw-button dtw-button-primary" onClick={() => setModal(null)}>知道了</button></footer></Dialog>}
  </div>
}

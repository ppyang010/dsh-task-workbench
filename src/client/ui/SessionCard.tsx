import { useEffect, useId, useRef, useState, type DragEvent } from 'react'
import { COLUMNS, STATUS_LABELS, type ColumnId, type RuntimeStatus } from '../../shared/model.js'
import { Icon } from './Icons.js'
import { formatUpdatedAt, type BoardRow } from './board-helpers.js'

export function StatusBadge({ status, waitingLabel }: { status: RuntimeStatus; waitingLabel?: string }) {
  return <span className={`dtw-status dtw-status-${status}`} title={waitingLabel || STATUS_LABELS[status]}><i aria-hidden="true" />{waitingLabel || STATUS_LABELS[status]}</span>
}

export interface SessionCardProps {
  row: BoardRow
  columnRows: BoardRow[]
  busy: boolean
  opening: boolean
  dragging: boolean
  dropBefore: boolean
  dropAfter: boolean
  onOpen: () => void
  onUnfollow: () => void
  onMove: (columnId: ColumnId, beforeSessionId?: string) => void
  onNote: (note: string, version: number) => Promise<boolean>
  onDragStart: (event: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
}

export function SessionCard({ row, columnRows, busy, opening, dragging, dropBefore, dropAfter, onOpen, onUnfollow, onMove, onNote, onDragStart, onDragEnd }: SessionCardProps) {
  const [draft, setDraft] = useState<{ text: string; expectedVersion: number } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [above, setAbove] = useState(false)
  const noteId = useId()
  const textArea = useRef<HTMLTextAreaElement>(null)
  const noteText = useRef<HTMLParagraphElement>(null)
  const menu = useRef<HTMLDetailsElement>(null)
  const menuTrigger = useRef<HTMLElement>(null)
  const title = useRef<HTMLButtonElement>(null)
  const index = columnRows.findIndex(item => item.entry.sessionId === row.entry.sessionId)
  const editing = draft !== null
  const disabled = busy || editing
  const changedElsewhere = draft !== null && draft.expectedVersion !== row.entry.version

  const closeMenu = (restoreFocus = false) => {
    if (menu.current) menu.current.open = false
    setMenuOpen(false)
    if (restoreFocus) menuTrigger.current?.focus()
  }
  useEffect(() => {
    if (editing) textArea.current?.focus()
  }, [editing])
  useEffect(() => {
    if (expanded || editing || !noteText.current) return
    const node = noteText.current
    const measure = () => setOverflowing(node.scrollHeight > node.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [row.entry.note, expanded, editing])
  useEffect(() => {
    if (!menuOpen || !menu.current) return
    const element = menu.current
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !element.contains(event.target)) closeMenu() }
    element.ownerDocument.addEventListener('pointerdown', outside)
    return () => element.ownerDocument.removeEventListener('pointerdown', outside)
  }, [menuOpen])
  useEffect(() => { if (disabled) closeMenu() }, [disabled])

  const editNote = () => {
    closeMenu()
    setDraft({ text: row.entry.note, expectedVersion: row.entry.version })
  }
  const finishEditing = () => { setDraft(null); title.current?.focus() }
  const menuAction = (action: () => void) => { closeMenu(true); action() }

  return <article
    className={`dtw-card ${dragging ? 'dtw-card-dragging' : ''} ${dropBefore ? 'dtw-card-drop-before' : ''} ${dropAfter ? 'dtw-card-drop-after' : ''}`}
    data-dtw-session={row.entry.sessionId}
    draggable={!disabled && !menuOpen}
    onDragStart={onDragStart}
    onDragEnd={onDragEnd}
    aria-label={row.title}
  >
    <div className="dtw-card-head">
      <span className="dtw-drag-handle" aria-hidden="true" title="拖动调整分类和顺序"><Icon name="grip" /></span>
      <h3><button ref={title} type="button" className="dtw-card-title dtw-open-button" disabled={disabled || opening || !!row.unavailableReason} onClick={onOpen} aria-label={`打开原对话：${row.title}`} title={row.unavailableReason || (editing ? '先保存或取消备注' : row.title)}>{opening ? '正在打开…' : row.title}</button></h3>
      <StatusBadge status={row.status} waitingLabel={row.session?.waitingLabel} />
    </div>
    <div className="dtw-card-meta">
      {row.entry.source === 'auto' && <span className="dtw-source" title="由自动纳入加入">自动纳入</span>}
      <time dateTime={row.session?.updatedAt && row.session.updatedAt > 0 ? new Date(row.session.updatedAt).toJSON() ?? undefined : undefined}>{formatUpdatedAt(row.session?.updatedAt ?? 0)}</time>
    </div>
    {draft ? <form className="dtw-note-editor" onSubmit={event => {
      event.preventDefault()
      if (busy || changedElsewhere) return
      void (async () => { if (await onNote(draft.text, draft.expectedVersion)) finishEditing() })()
    }}>
      <label htmlFor={noteId}>关注备注</label>
      <textarea id={noteId} ref={textArea} value={draft.text} maxLength={2000} rows={4} disabled={busy} onChange={event => setDraft({ ...draft, text: event.target.value })} placeholder="记下下次回来要处理的事…" onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' && !busy) { event.preventDefault(); finishEditing() } }} />
      <div className="dtw-note-count">{draft.text.length} / 2000</div>
      {changedElsewhere && <div className="dtw-inline-warning" role="status"><p>这条关注记录已在别处更新。草稿已保留，确认最新备注后再保存。</p><details><summary>查看最新备注</summary><p>{row.entry.note || '暂无备注'}</p></details><button className="dtw-text-button" type="button" disabled={busy} onClick={() => setDraft({ ...draft, expectedVersion: row.entry.version })}>保留草稿，使用最新版本</button></div>}
      <div className="dtw-note-actions"><button type="button" className="dtw-button dtw-button-small" disabled={busy} onClick={finishEditing}>取消</button><button type="submit" className="dtw-button dtw-button-primary dtw-button-small" disabled={busy || changedElsewhere}>{busy ? '保存中…' : '保存备注'}</button></div>
    </form> : row.entry.note ? <div className={`dtw-note-preview ${expanded ? 'is-expanded' : ''}`}>
      <p className="dtw-note-text" ref={noteText} id={noteId}>{row.entry.note}</p>
      {(overflowing || expanded) && <button type="button" className="dtw-icon-button dtw-note-expand" aria-expanded={expanded} aria-controls={noteId} aria-label={`${expanded ? '收起' : '展开'}备注：${row.title}`} title={expanded ? '收起备注' : '展开完整备注'} onClick={() => setExpanded(value => !value)}><Icon name={expanded ? 'up' : 'down'} /></button>}
    </div> : null}
    {row.unavailableReason && <p className="dtw-card-unavailable"><Icon name="info" />{row.unavailableReason}</p>}
    <footer className="dtw-card-actions">
      <select className="dtw-move-select" value={row.entry.columnId} disabled={disabled} onChange={event => onMove(event.target.value as ColumnId)} aria-label={`调整分类：${row.title}`}>{COLUMNS.map(column => <option key={column.id} value={column.id}>{column.title}</option>)}</select>
      <button type="button" className="dtw-button dtw-card-open" disabled={disabled || opening || !!row.unavailableReason} onClick={onOpen} aria-label={`打开对话：${row.title}`} title={row.unavailableReason || (editing ? '先保存或取消备注' : '返回原生会话页面')}><Icon name="arrow" />{opening ? '正在打开…' : '打开对话'}</button>
      <details className="dtw-card-menu" ref={menu} data-placement={above ? 'above' : 'below'} onToggle={event => {
        const open = event.currentTarget.open
        setMenuOpen(open)
        if (open && menuTrigger.current) {
          const rect = menuTrigger.current.getBoundingClientRect()
          const bounds = menu.current?.closest('.dtw-column-body')?.getBoundingClientRect()
          const bottom = Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight)
          const top = Math.max(0, bounds?.top ?? 0)
          setAbove(rect.bottom + 150 > bottom && rect.top - top > 150)
        }
      }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMenu() }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true) } }}>
        <summary ref={menuTrigger} className="dtw-icon-button" aria-label={`更多操作：${row.title}`} aria-disabled={disabled} tabIndex={disabled ? -1 : 0} onClick={event => { if (disabled) event.preventDefault() }} onKeyDown={event => { if (disabled && (event.key === 'Enter' || event.key === ' ')) event.preventDefault() }} title="备注、排序与取消关注"><Icon name="more" /></summary>
        <div className="dtw-card-menu-panel">
          <button type="button" disabled={disabled} onClick={editNote} aria-label={`${row.entry.note ? '编辑' : '添加'}备注：${row.title}`}><Icon name="edit" />{row.entry.note ? '编辑备注' : '添加备注'}</button>
          <button type="button" disabled={disabled || index <= 0} onClick={() => menuAction(() => onMove(row.entry.columnId, columnRows[index - 1]?.entry.sessionId))} aria-label={`上移：${row.title}`}><Icon name="up" />上移</button>
          <button type="button" disabled={disabled || index < 0 || index >= columnRows.length - 1} onClick={() => menuAction(() => onMove(row.entry.columnId, columnRows[index + 2]?.entry.sessionId))} aria-label={`下移：${row.title}`}><Icon name="down" />下移</button>
          <button type="button" className="dtw-menu-danger" disabled={disabled} onClick={() => menuAction(onUnfollow)} aria-label={`取消关注：${row.title}`}><Icon name="close" />取消关注</button>
        </div>
      </details>
    </footer>
  </article>
}

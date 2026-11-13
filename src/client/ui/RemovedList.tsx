import { useId, useMemo, useState } from 'react'
import { COLUMNS, type ClientState } from '../../shared/model.js'
import { Icon } from './Icons.js'
import { workspaceOptions } from './board-helpers.js'
import { getRemovedRows, matchesRemovedRow } from './removed-helpers.js'

export function RemovedList({ state, busy, error, openingId, onRestore, onOpen, onRefresh }: {
  state: ClientState; busy: boolean; error?: string; openingId: string | null
  onRestore: (id: string) => Promise<boolean>; onOpen: (id: string) => Promise<void>; onRefresh: () => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [limit, setLimit] = useState(80)
  const [notice, setNotice] = useState('')
  const searchId = useId()
  const rows = useMemo(() => getRemovedRows(state), [state])
  const options = workspaceOptions(rows.flatMap(row => row.session ? [row.session] : []))
  const filtered = rows.filter(row => matchesRemovedRow(row, query, workspace))
  return <>
    <div className="dtw-dialog-tools">
      <div className="dtw-search"><Icon name="search" /><label className="dtw-sr-only" htmlFor={searchId}>搜索已取消关注</label><input id={searchId} data-dtw-initial-focus type="search" value={query} placeholder="搜索标题、工作区、备注或会话 ID…" onChange={event => { setQuery(event.target.value); setLimit(80) }} /></div>
      <select aria-label="按工作区筛选已取消关注" value={workspace} onChange={event => { setWorkspace(event.target.value); setLimit(80) }}><option value="">全部工作区</option>{options.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
      <button type="button" className="dtw-icon-button" aria-label="刷新已取消关注" disabled={busy} onClick={() => { void onRefresh() }}><Icon name="refresh" /></button>
    </div>
    {error && <div className="dtw-dialog-error" role="alert">{error}</div>}
    {!state.connected && <div className="dtw-dialog-note" role="status">连接已断开，保留现有记录，重新连接后可恢复关注。</div>}
    <div className="dtw-dialog-note" role="status">显示 {filtered.length} / {rows.length} 条{notice && ` · ${notice}`}</div>
    <div className="dtw-session-options dtw-removed-list" aria-label="已取消关注列表" aria-busy={busy}>
      {filtered.length === 0 && <div className="dtw-empty"><Icon name="info" /><strong>{rows.length ? '没有匹配的记录' : '暂无已取消关注的会话'}</strong><p>{rows.length ? '调整搜索词或工作区筛选后重试。' : '取消关注后的会话会保留在这里，可随时恢复关注。'}</p>{(query || workspace) && <button type="button" className="dtw-button" onClick={() => { setQuery(''); setWorkspace('') }}>清除筛选</button>}</div>}
      {filtered.slice(0, limit).map(row => <article className="dtw-removed-item" key={row.sessionId} data-removed-session={row.sessionId}>
        <div className="dtw-removed-main"><strong className="dtw-option-title">{row.title}</strong>
          <div className="dtw-option-meta"><Icon name="folder" />{row.workspaceTitle}<span>·</span>{row.entry ? `原分类：${COLUMNS.find(column => column.id === row.entry?.columnId)?.title}` : '历史取消关注记录'}</div>
          <div className="dtw-removed-id">会话 ID：{row.sessionId}</div>
          <div className="dtw-option-meta">{row.removedAt !== undefined ? `取消于 ${new Date(row.removedAt).toLocaleString('zh-CN', { hour12: false })}` : '旧版本未保存取消时间、备注及原分类；恢复至「我的关注」。'}</div>
          {row.entry?.note && <details className="dtw-removed-note"><summary>查看原备注</summary><p>{row.entry.note}</p></details>}
          {row.reason && <p className="dtw-option-reason">{row.reason}</p>}
        </div>
        <div className="dtw-removed-actions">
          <button type="button" className="dtw-button dtw-button-small" disabled={busy || !!row.reason || !!openingId} title={row.reason || '打开原生会话，不恢复关注'} onClick={() => { void onOpen(row.sessionId) }}>打开对话</button>
          <button type="button" className="dtw-button dtw-button-primary dtw-button-small" disabled={busy || !!row.reason} title={row.reason || '恢复原分类、备注与可恢复的排序位置'} onClick={() => { void (async () => { setNotice(''); if (await onRestore(row.sessionId)) setNotice(`已恢复「${row.title}」的关注`) })() }}>恢复关注</button>
        </div>
      </article>)}
      {filtered.length > limit && <button type="button" className="dtw-load-more" onClick={() => setLimit(value => value + 80)}>再显示 {Math.min(80, filtered.length - limit)} 条</button>}
    </div>
    <div className="dtw-dialog-note"><Icon name="info" /><span>取消关注不删除原对话，自动纳入会跳过这些会话。恢复关注会解除排除；原排序位置不可用时放到原分类末尾。</span></div>
  </>
}

import { useMemo, useState, useSyncExternalStore } from 'react'
import { IDEA_KINDS, type FolderValues, type Idea, type IdeaFolder, type IdeasControllerFace, type IdeaValues } from '../../shared/ideas.ts'
import type { BoardControllerFace } from '../../shared/model.ts'
import { writeSessionClipboard } from '../session-copy.tsx'
import { Dialog } from './Board.tsx'
import { FolderEditor, IdeaEditor, kindName } from './IdeaEditors.tsx'
import { formatUpdatedAt } from './board-helpers.ts'

type View = { kind: 'all' | 'unfiled' | 'trash' } | { kind: 'folder'; id: string }
type Modal =
  | { type: 'createIdea'; id: string; initial: IdeaValues }
  | { type: 'editIdea'; idea: Idea }
  | { type: 'detail'; id: string }
  | { type: 'createFolder'; id: string }
  | { type: 'editFolder'; folder: IdeaFolder }
  | { type: 'deleteFolder'; folder: IdeaFolder }
  | { type: 'mergeFolder'; folder: IdeaFolder; target: IdeaFolder | null }
const PAGE_SIZE = 60

export function discussionText(idea: Idea): string {
  return [`# 点子：${idea.title}`, `类型：${kindName(idea.kind)}`, `标签：${idea.tags.length ? idea.tags.join('、') : '无'}`, '', idea.content || '（暂无正文）'].join('\n')
}

export function IdeasPage({ controller, board }: { controller: IdeasControllerFace; board: BoardControllerFace }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const runtime = useSyncExternalStore(board.subscribe, board.getSnapshot, board.getSnapshot)
  const [view, setView] = useState<View>({ kind: 'all' })
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [modal, setModal] = useState<Modal | null>(null)
  const [notice, setNotice] = useState('')
  const [localError, setLocalError] = useState('')
  const [openingId, setOpeningId] = useState('')
  const busy = state.loading || state.saving
  const disabled = busy || !state.loaded || !runtime.connected
  const error = localError || state.error
  const folders = state.data.folders
  const active = useMemo(() => state.data.ideas.filter(idea => idea.trashedAt === null), [state.data.ideas])
  const trash = useMemo(() => state.data.ideas.filter(idea => idea.trashedAt !== null), [state.data.ideas])
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const idea of active) for (const id of idea.folderIds) counts.set(id, (counts.get(id) ?? 0) + 1)
    return counts
  }, [active])
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return state.data.ideas.filter(idea => {
      if (view.kind === 'trash' ? idea.trashedAt === null : idea.trashedAt !== null) return false
      if (view.kind === 'unfiled' && idea.folderIds.length) return false
      if (view.kind === 'folder' && !idea.folderIds.includes(view.id)) return false
      if (kind && idea.kind !== kind) return false
      return !needle || `${idea.title}\n${idea.content}\n${idea.tags.join(' ')}`.toLocaleLowerCase().includes(needle)
    }).sort((a, b) => (view.kind === 'trash' ? (b.trashedAt ?? 0) - (a.trashedAt ?? 0) : b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id))
  }, [state.data.ideas, view, query, kind])
  const selectedFolder = view.kind === 'folder' ? folders.find(folder => folder.id === view.id) : undefined
  const activeIdea = modal?.type === 'detail' ? state.data.ideas.find(idea => idea.id === modal.id) : undefined
  const latestEditedIdea = modal?.type === 'editIdea' ? state.data.ideas.find(idea => idea.id === modal.idea.id && idea.version !== modal.idea.version && idea.trashedAt === null) : undefined
  const latestEditedFolder = modal?.type === 'editFolder' ? folders.find(folder => folder.id === modal.folder.id && folder.version !== modal.folder.version) : undefined
  const setNewView = (next: View) => { setView(next); setLimit(PAGE_SIZE) }
  const clear = () => { controller.clearError(); setLocalError('') }
  const close = () => { if (!state.saving) { setModal(null); clear() } }
  const newId = (): string | null => {
    try { return globalThis.crypto.randomUUID() }
    catch { setLocalError('无法生成安全的点子编号，请使用支持安全随机数的 DSH 环境。'); return null }
  }
  const createIdea = () => {
    const id = newId(); if (!id) return
    clear(); setModal({ type: 'createIdea', id, initial: { title: '', content: '', kind: 'spark', tags: [], folderIds: selectedFolder ? [selectedFolder.id] : [], sessionIds: [] } })
  }
  const createFolder = () => { const id = newId(); if (id) { clear(); setModal({ type: 'createFolder', id }) } }
  const mutate = async (action: Parameters<IdeasControllerFace['command']>[0], message: string) => {
    if (disabled) return false
    clear()
    const ok = await controller.command(action)
    if (ok) setNotice(message)
    return ok
  }
  const moveTrash = async (idea: Idea, restore: boolean) => {
    if (await mutate({ type: restore ? 'restoreIdea' : 'trashIdea', id: idea.id, expectedVersion: idea.version }, restore ? '已恢复点子及其现存文件夹关联。' : '已移入回收站，可随时恢复。')) setModal(null)
  }
  const openSession = async (id: string) => {
    if (openingId || !runtime.connected) return
    setOpeningId(id); setLocalError('')
    try {
      if (!await board.openSession(id)) setLocalError(board.getSnapshot().error || '暂时无法打开关联会话，请刷新后重试。')
    } catch { setLocalError('打开关联会话失败，请稍后重试。') }
    finally { setOpeningId('') }
  }
  const copy = async (idea: Idea) => {
    try {
      const ok = await writeSessionClipboard(discussionText(idea))
      if (ok) { setNotice('讨论材料已复制；请自行粘贴到会话，不会自动发送。'); setLocalError('') }
      else setLocalError('复制失败，请检查系统剪贴板权限。')
    } catch { setLocalError('复制失败，请检查系统剪贴板权限。') }
  }
  return <div className="dtw-root dtw-ideas-root" aria-label="点子工作台">
    <main className="dtw-main dtw-ideas-main" aria-busy={busy}>
      <header className="dtw-ideas-head"><div><h1>点子</h1><p>记录想法，按主题整理；也可在 AI 会话明确说「记个点子」。不会自动读取聊天或发送消息。</p></div><div className="dtw-ideas-head-actions">
        <button type="button" className="dtw-button" disabled={disabled} onClick={createFolder}>新建文件夹</button>
        <button type="button" className="dtw-button dtw-button-primary" disabled={disabled} onClick={createIdea}>记个点子</button>
      </div></header>
      {!runtime.connected && <div className="dtw-banner dtw-banner-warning" role="status">连接已断开，点子修改暂不可用。</div>}
      {error && !modal && <div className="dtw-banner dtw-banner-error" role="alert"><span>{error}</span><button type="button" className="dtw-button dtw-button-small" disabled={state.saving} onClick={() => { clear(); void controller.refresh() }}>重新加载</button></div>}
      {notice && <div className="dtw-idea-notice" role="status">{notice}<button type="button" className="dtw-text-button" onClick={() => setNotice('')}>关闭</button></div>}
      <div className="dtw-ideas-layout">
        <aside className="dtw-ideas-sidebar" aria-label="点子分类">
          <button type="button" className="dtw-idea-nav" aria-pressed={view.kind === 'all'} onClick={() => setNewView({ kind: 'all' })}><span>全部点子</span><b>{state.loaded ? active.length : '—'}</b></button>
          <button type="button" className="dtw-idea-nav" aria-pressed={view.kind === 'unfiled'} onClick={() => setNewView({ kind: 'unfiled' })}><span>未归类</span><b>{state.loaded ? active.filter(idea => !idea.folderIds.length).length : '—'}</b></button>
          <div className="dtw-idea-nav-heading">文件夹 <span>{state.loaded ? folders.length : '—'}</span></div>
          <div className="dtw-idea-folder-list">{folders.map(folder => <button type="button" key={folder.id} className="dtw-idea-nav" aria-pressed={view.kind === 'folder' && view.id === folder.id} title={folder.title} onClick={() => setNewView({ kind: 'folder', id: folder.id })}><span>{folder.title}</span><b>{folderCounts.get(folder.id) ?? 0}</b></button>)}</div>
          <button type="button" className="dtw-idea-nav dtw-idea-trash-nav" aria-pressed={view.kind === 'trash'} onClick={() => setNewView({ kind: 'trash' })}><span>回收站</span><b>{state.loaded ? trash.length : '—'}</b></button>
        </aside>
        <section className="dtw-ideas-content" aria-label="点子列表">
          <div className="dtw-ideas-view-head"><div><h2>{view.kind === 'trash' ? '回收站' : view.kind === 'unfiled' ? '未归类' : view.kind === 'folder' ? selectedFolder?.title ?? '文件夹已删除' : '全部点子'}</h2>{selectedFolder?.summary && <p>{selectedFolder.summary}</p>}{view.kind === 'trash' && <p>移入回收站的点子不会自动删除，可随时恢复。</p>}</div>
            {selectedFolder && <div><button type="button" className="dtw-button dtw-button-small" disabled={disabled} onClick={() => { clear(); setModal({ type: 'editFolder', folder: structuredClone(selectedFolder) }) }}>编辑文件夹</button> <button type="button" className="dtw-button dtw-button-small" disabled={disabled || folders.length < 2} title={folders.length < 2 ? '至少需要两个文件夹才能合并' : '合并到其他文件夹'} onClick={() => { clear(); setModal({ type: 'mergeFolder', folder: structuredClone(selectedFolder), target: null }) }}>合并文件夹</button> <button type="button" className="dtw-button dtw-button-small" disabled={disabled} onClick={() => { clear(); setModal({ type: 'deleteFolder', folder: structuredClone(selectedFolder) }) }}>删除文件夹</button></div>}
          </div>
          <div className="dtw-ideas-toolbar"><input type="search" aria-label="搜索点子" value={query} placeholder="搜索标题、内容或标签" onChange={event => { setQuery(event.target.value); setLimit(PAGE_SIZE) }} /><select aria-label="按点子类型筛选" value={kind} onChange={event => { setKind(event.target.value); setLimit(PAGE_SIZE) }}><option value="">全部类型</option>{IDEA_KINDS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><button type="button" className="dtw-button dtw-button-small" disabled={state.saving} onClick={() => { clear(); void controller.refresh() }}>刷新</button></div>
          {state.loaded && <p className="dtw-ideas-count" role="status">显示 {Math.min(limit, visible.length)} / {visible.length} 条</p>}
          {state.loading ? <div className="dtw-empty">正在加载独立点子库…</div> : !state.loaded ? <div className="dtw-empty" role="status"><strong>点子库尚未读取</strong><p>数据没有被清空，请检查连接后重新加载。</p></div> : !visible.length ? <div className="dtw-empty"><strong>{view.kind === 'trash' ? '回收站为空' : '暂无匹配的点子'}</strong><p>{query || kind ? '调整搜索或筛选条件后重试。' : view.kind === 'trash' ? '删除的点子会保留在这里。' : '点击「记个点子」开始记录。'}</p></div> : <div className="dtw-idea-grid">{visible.slice(0, limit).map(idea => <article className="dtw-idea-card" key={idea.id}>
            <button type="button" className="dtw-idea-card-open" onClick={() => { clear(); setModal({ type: 'detail', id: idea.id }) }}><strong>{idea.title}</strong><span>{idea.content || '暂无内容'}</span></button>
            <div className="dtw-idea-card-meta"><span className="dtw-idea-kind">{kindName(idea.kind)}</span>{idea.tags.slice(0, 3).map(tag => <span key={tag}>#{tag}</span>)}<time>{formatUpdatedAt(idea.trashedAt ?? idea.updatedAt)}</time></div>
            {view.kind === 'trash' && <button type="button" className="dtw-text-button" disabled={disabled} onClick={() => { void moveTrash(idea, true) }}>恢复点子</button>}
          </article>)}</div>}
          {visible.length > limit && <button type="button" className="dtw-load-more" onClick={() => setLimit(current => current + PAGE_SIZE)}>再显示 {Math.min(PAGE_SIZE, visible.length - limit)} 条</button>}
        </section>
      </div>
    </main>
    {(modal?.type === 'createIdea' || modal?.type === 'editIdea') && <Dialog title={modal.type === 'createIdea' ? '记个点子' : '编辑点子'} description="点子保存在本插件的独立存储，不依赖旧工作台。" busy={state.saving} onClose={close} className="dtw-dialog-add">
      <IdeaEditor initial={modal.type === 'createIdea' ? modal.initial : { title: modal.idea.title, content: modal.idea.content, kind: modal.idea.kind, tags: modal.idea.tags, folderIds: modal.idea.folderIds, sessionIds: modal.idea.sessionIds }} folders={folders} sessions={runtime.sessions} busy={state.saving} disabled={disabled} error={error} latest={latestEditedIdea} onRebase={latestEditedIdea && modal.type === 'editIdea' ? () => { clear(); setModal({ ...modal, idea: { ...modal.idea, version: latestEditedIdea.version } }) } : undefined} onClose={close} onSave={async value => {
        const ok = await mutate(modal.type === 'createIdea' ? { type: 'createIdea', id: modal.id, value } : { type: 'updateIdea', id: modal.idea.id, expectedVersion: modal.idea.version, value }, modal.type === 'createIdea' ? '点子已保存。' : '点子已更新。')
        if (ok) setModal(null); return ok
      }} />
    </Dialog>}
    {(modal?.type === 'createFolder' || modal?.type === 'editFolder') && <Dialog title={modal.type === 'createFolder' ? '新建文件夹' : '编辑文件夹'} description="文件夹用于组织点子，一个点子可以属于多个文件夹。" busy={state.saving} onClose={close}>
      <FolderEditor initial={modal.type === 'createFolder' ? { title: '', summary: '' } : { title: modal.folder.title, summary: modal.folder.summary }} busy={state.saving} disabled={disabled} error={error} latest={latestEditedFolder} onRebase={latestEditedFolder && modal.type === 'editFolder' ? () => { clear(); setModal({ ...modal, folder: { ...modal.folder, version: latestEditedFolder.version } }) } : undefined} onClose={close} onSave={async (value: FolderValues) => {
        const ok = await mutate(modal.type === 'createFolder' ? { type: 'createFolder', id: modal.id, value } : { type: 'updateFolder', id: modal.folder.id, expectedVersion: modal.folder.version, value }, '文件夹已保存。')
        if (ok) setModal(null); return ok
      }} />
    </Dialog>}
    {modal?.type === 'mergeFolder' && <Dialog title="合并文件夹" description="把源文件夹里的点子（包括回收站）合并到目标文件夹，之后删除源文件夹。点子正文不会删除，目标文件夹名称和摘要保持不变。" busy={state.saving} onClose={close}>
      <div className="dtw-idea-fields"><p>源文件夹：{modal.folder.title}，关联 {state.data.ideas.filter(idea => idea.folderIds.includes(modal.folder.id)).length} 条点子。</p>
        <label>合并到 <select aria-label="合并到文件夹" value={modal.target?.id ?? ''} disabled={disabled} onChange={event => { const target = folders.find(folder => folder.id === event.target.value); clear(); setModal({ ...modal, target: target ? structuredClone(target) : null }) }}><option value="">选择目标文件夹</option>{folders.filter(folder => folder.id !== modal.folder.id).map(folder => <option key={folder.id} value={folder.id}>{folder.title}</option>)}</select></label>
        {error && <p role="alert" className="dtw-idea-error">{error}</p>}
      </div>
      <footer className="dtw-dialog-footer"><button type="button" className="dtw-button" disabled={state.saving} onClick={close}>取消</button><button type="button" className="dtw-button dtw-button-danger" disabled={disabled || !modal.target} onClick={() => { const target = modal.target; if (!target) return; void (async () => { if (await mutate({ type: 'mergeFolder', sourceId: modal.folder.id, targetId: target.id, expectedSourceVersion: modal.folder.version, expectedTargetVersion: target.version }, '文件夹已合并，点子仍然保留。')) { setModal(null); setNewView({ kind: 'folder', id: target.id }) } })() }}>确认合并</button></footer>
    </Dialog>}
    {modal?.type === 'deleteFolder' && <Dialog title="删除文件夹" description="只删除这个文件夹及归类关系，点子和回收站里的记录都会保留。" busy={state.saving} onClose={close}>
      <div className="dtw-idea-fields"><p>确定删除「{modal.folder.title}」？共有 {state.data.ideas.filter(idea => idea.folderIds.includes(modal.folder.id)).length} 条点子关联此文件夹。</p>{error && <p role="alert" className="dtw-idea-error">{error}</p>}</div>
      <footer className="dtw-dialog-footer"><button type="button" className="dtw-button" disabled={state.saving} onClick={close}>取消</button><button type="button" className="dtw-button dtw-button-danger" disabled={disabled} onClick={() => { void (async () => { if (await mutate({ type: 'deleteFolder', id: modal.folder.id, expectedVersion: modal.folder.version }, '文件夹已删除，点子仍然保留。')) { setModal(null); setNewView({ kind: 'all' }) } })() }}>确认删除</button></footer>
    </Dialog>}
    {modal?.type === 'detail' && <Dialog title="点子详情" description={activeIdea?.trashedAt !== null ? '回收站中的点子仍保留内容和关联。' : '可编辑、归类、关联原生会话或复制讨论材料。'} busy={state.saving || !!openingId} onClose={close} className="dtw-dialog-add">
      {activeIdea ? <><div className="dtw-idea-detail"><h3>{activeIdea.title}</h3><p className="dtw-idea-detail-meta">{kindName(activeIdea.kind)} · 更新于 {formatUpdatedAt(activeIdea.updatedAt)}</p>
        {activeIdea.tags.length > 0 && <p className="dtw-idea-detail-meta">标签：{activeIdea.tags.map(tag => `#${tag}`).join(' ')}</p>}
        <p className="dtw-idea-detail-meta">文件夹：{activeIdea.folderIds.map(id => folders.find(folder => folder.id === id)?.title).filter(Boolean).join('、') || '未归类'}</p>
        <div className="dtw-idea-prose">{activeIdea.content || '暂无内容'}</div>
        <section className="dtw-idea-sessions"><h4>关联会话</h4>{activeIdea.sessionIds.length ? activeIdea.sessionIds.map(id => {
          const session = runtime.sessions.find(item => item.id === id)
          const available = runtime.connected && runtime.runtimeReady && !!session?.openable && !session.archived && !session.missing
          return <div className="dtw-idea-session" key={id}><span>{session?.title ?? `会话暂不可用 · ${id}`}{session && !available ? '（暂不可打开）' : ''}</span><button type="button" className="dtw-button dtw-button-small" disabled={!available || !!openingId} onClick={() => { void openSession(id) }}>{openingId === id ? '正在打开…' : '打开原会话'}</button></div>
        }) : <p>尚未关联会话，可通过编辑添加。</p>}</section>
        {error && <p role="alert" className="dtw-idea-error">{error}</p>}{notice && <p role="status">{notice}</p>}
      </div><footer className="dtw-dialog-footer"><button type="button" className="dtw-button" disabled={state.saving || !!openingId} onClick={close}>关闭</button>
        {activeIdea.trashedAt === null ? <><button type="button" className="dtw-button" onClick={() => { void copy(activeIdea) }}>复制讨论材料</button><button type="button" className="dtw-button" disabled={disabled} onClick={() => { clear(); setModal({ type: 'editIdea', idea: structuredClone(activeIdea) }) }}>编辑</button><button type="button" className="dtw-button dtw-button-danger" disabled={disabled} onClick={() => { void moveTrash(activeIdea, false) }}>移入回收站</button></> : <button type="button" className="dtw-button dtw-button-primary" disabled={disabled} onClick={() => { void moveTrash(activeIdea, true) }}>恢复点子</button>}
      </footer></> : <div className="dtw-idea-fields"><p>点子已不可用，请关闭并刷新。</p></div>}
    </Dialog>}
  </div>
}

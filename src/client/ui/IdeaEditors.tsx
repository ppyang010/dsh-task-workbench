import { useMemo, useState } from 'react'
import { IDEA_KINDS, ideaValuesSchema, folderValuesSchema, type FolderValues, type Idea, type IdeaFolder, type IdeaValues } from '../../shared/ideas.ts'
import type { SessionView } from '../../shared/model.ts'

const kindName = (id: string) => IDEA_KINDS.find(kind => kind.id === id)?.label ?? id
export { kindName }

export function IdeaEditor({ initial, folders, sessions, busy, disabled, error, latest, onRebase, onSave, onClose }: {
  initial: IdeaValues; folders: IdeaFolder[]; sessions: SessionView[]; busy: boolean; disabled: boolean; error?: string; latest?: Idea; onRebase?: () => void
  onSave(value: IdeaValues): Promise<boolean>; onClose(): void
}) {
  const [draft, setDraft] = useState<IdeaValues>(() => structuredClone(initial))
  const [tagsText, setTagsText] = useState(initial.tags.join(', '))
  const [sessionQuery, setSessionQuery] = useState('')
  const [chosen, setChosen] = useState('')
  const [localError, setLocalError] = useState('')
  const filteredSessions = useMemo(() => {
    const query = sessionQuery.trim().toLocaleLowerCase()
    return sessions.filter(session => !draft.sessionIds.includes(session.id) && !session.subagent && session.openable && !session.archived && !session.missing && (!query || `${session.title} ${session.workspaceTitle} ${session.id}`.toLocaleLowerCase().includes(query))).slice(0, 80)
  }, [sessions, draft.sessionIds, sessionQuery])
  const toggleFolder = (id: string) => setDraft(previous => ({ ...previous, folderIds: previous.folderIds.includes(id) ? previous.folderIds.filter(value => value !== id) : [...previous.folderIds, id] }))
  return <form className="dtw-idea-editor" onSubmit={event => {
    event.preventDefault()
    const tags = [...new Set(tagsText.split(/[,，\n]+/).map(tag => tag.trim()).filter(Boolean))]
    const parsed = ideaValuesSchema.safeParse({ ...draft, tags })
    if (!parsed.success) { setLocalError('请检查标题不为空、标签最多 20 个且每个不超过 40 字，文件夹不超过 50 个、会话不超过 20 个。'); return }
    setLocalError(''); void onSave(parsed.data)
  }}>
    <div className="dtw-idea-fields">
      <label>标题 <input data-dtw-initial-focus aria-label="点子标题" value={draft.title} maxLength={200} required disabled={disabled} onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder="一句话记下这个点子" /></label>
      <label>类型 <select aria-label="点子类型" value={draft.kind} disabled={disabled} onChange={event => setDraft({ ...draft, kind: event.target.value as IdeaValues['kind'] })}>{IDEA_KINDS.map(kind => <option key={kind.id} value={kind.id}>{kind.label}</option>)}</select></label>
      <label>标签 <input aria-label="点子标签" value={tagsText} disabled={disabled} onChange={event => setTagsText(event.target.value)} placeholder="用逗号分隔，例如 AI, 产品" /></label>
      <label>内容 <textarea aria-label="点子内容" value={draft.content} maxLength={40000} rows={8} disabled={disabled} onChange={event => setDraft({ ...draft, content: event.target.value })} placeholder="记录细节；支持保存 Markdown 文本" /></label>
      <fieldset><legend>归入文件夹 <span>可多选，最多 50 个</span></legend>
        {draft.folderIds.filter(id => !folders.some(folder => folder.id === id)).map(id => <p key={id} className="dtw-idea-error">关联的文件夹已删除。<button type="button" className="dtw-text-button" onClick={() => toggleFolder(id)}>从当前草稿移除</button></p>)}
        {folders.length ? <div className="dtw-idea-choices">{folders.map(folder => <label key={folder.id}><input type="checkbox" checked={draft.folderIds.includes(folder.id)} disabled={disabled || (!draft.folderIds.includes(folder.id) && draft.folderIds.length >= 50)} onChange={() => toggleFolder(folder.id)} />{folder.title}</label>)}</div> : <p>还没有文件夹，可先保存点子，稍后创建并归类。</p>}
      </fieldset>
      <fieldset><legend>关联已有会话 <span>仅保存会话 ID，不读取或发送聊天内容；最多 20 个</span></legend>
        {draft.sessionIds.length > 0 && <ul className="dtw-idea-linked-edit">{draft.sessionIds.map(id => {
          const session = sessions.find(item => item.id === id)
          return <li key={id}><span>{session?.title ?? `会话暂不可用 · ${id}`}</span><button type="button" className="dtw-text-button" aria-label={`移除关联：${session?.title ?? id}`} disabled={disabled} onClick={() => setDraft({ ...draft, sessionIds: draft.sessionIds.filter(item => item !== id) })}>移除关联</button></li>
        })}</ul>}
        <div className="dtw-idea-session-picker"><input aria-label="搜索可关联会话" value={sessionQuery} disabled={disabled} onChange={event => { setSessionQuery(event.target.value); setChosen('') }} placeholder="搜索会话名或工作区" />
          <select aria-label="选择可关联会话" value={chosen} disabled={disabled || draft.sessionIds.length >= 20} onChange={event => setChosen(event.target.value)}><option value="">选择已有会话</option>{filteredSessions.map(session => <option key={session.id} value={session.id}>{session.title} · {session.workspaceTitle}</option>)}</select>
          <button type="button" className="dtw-button dtw-button-small" disabled={disabled || !filteredSessions.some(session => session.id === chosen) || draft.sessionIds.length >= 20} onClick={() => { setDraft({ ...draft, sessionIds: [...draft.sessionIds, chosen] }); setChosen('') }}>添加关联</button>
        </div>
        <p>仅列出可打开的普通会话；已关联会话不可用时保留记录。搜索结果最多显示前 80 条。</p>
      </fieldset>
      {(localError || error) && <p className="dtw-idea-error" role="alert">{localError || error}</p>}
      {latest && onRebase && <div className="dtw-inline-warning"><p>其他窗口已更新此点子。请先核对最新内容；保留当前草稿继续保存会覆盖对应字段。</p><details><summary>查看最新保存内容</summary><p>标题：{latest.title}</p><p>类型：{kindName(latest.kind)}；标签：{latest.tags.join('、') || '无'}</p><p className="dtw-idea-prose">{latest.content || '暂无内容'}</p></details><button type="button" className="dtw-text-button" disabled={disabled} onClick={onRebase}>保留草稿，使用最新版本</button></div>}
    </div>
    <footer className="dtw-dialog-footer"><button type="button" className="dtw-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="dtw-button dtw-button-primary" disabled={disabled || !draft.title.trim()}>{busy ? '保存中…' : '保存点子'}</button></footer>
  </form>
}

export function FolderEditor({ initial, busy, disabled, error, latest, onRebase, onSave, onClose }: { initial: FolderValues; busy: boolean; disabled: boolean; error?: string; latest?: IdeaFolder; onRebase?: () => void; onSave(value: FolderValues): Promise<boolean>; onClose(): void }) {
  const [draft, setDraft] = useState(initial)
  const [localError, setLocalError] = useState('')
  return <form className="dtw-idea-editor" onSubmit={event => {
    event.preventDefault(); const parsed = folderValuesSchema.safeParse(draft)
    if (!parsed.success) { setLocalError('请输入文件夹名称，名称不超过 200 字，摘要不超过 10000 字。'); return }
    setLocalError(''); void onSave(parsed.data)
  }}>
    <div className="dtw-idea-fields"><label>文件夹名称 <input data-dtw-initial-focus aria-label="文件夹名称" maxLength={200} required disabled={disabled} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
      <label>摘要（可选） <textarea aria-label="文件夹摘要" maxLength={10000} rows={4} disabled={disabled} value={draft.summary} onChange={event => setDraft({ ...draft, summary: event.target.value })} /></label>
      {(localError || error) && <p className="dtw-idea-error" role="alert">{localError || error}</p>}
      {latest && onRebase && <div className="dtw-inline-warning"><p>其他窗口已更新此文件夹。最新名称：{latest.title}；摘要：{latest.summary || '无'}。保留草稿继续保存会覆盖最新名称和摘要。</p><button type="button" className="dtw-text-button" disabled={disabled} onClick={onRebase}>保留草稿，使用最新版本</button></div>}
    </div>
    <footer className="dtw-dialog-footer"><button type="button" className="dtw-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="dtw-button dtw-button-primary" disabled={disabled || !draft.title.trim()}>{busy ? '保存中…' : '保存文件夹'}</button></footer>
  </form>
}

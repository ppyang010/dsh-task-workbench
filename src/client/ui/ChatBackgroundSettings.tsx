import { useEffect, useState } from 'react'
import { DEFAULT_CHAT_BACKGROUND, chatBackgroundSchema, type ChatBackground } from '../../shared/model.ts'

export function ChatBackgroundSettings({ value, busy, disabled, error, onSave, onClose, embedded = false }: { value: ChatBackground; busy: boolean; disabled: boolean; error?: string; onSave(value: ChatBackground): Promise<boolean>; onClose?: () => void; embedded?: boolean }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value.enabled, value.color])
  const valid = chatBackgroundSchema.safeParse(draft).success
  return <form className={`dtw-background-form ${embedded ? 'dtw-background-form-embedded' : ''}`} onSubmit={event => { event.preventDefault(); if (!disabled && valid) void onSave(draft) }}>
    <label className="dtw-background-enable"><input type="checkbox" checked={draft.enabled} disabled={disabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />启用浅色聊天背景</label>
    <label className="dtw-background-color">背景颜色<input type="color" aria-label="选择聊天背景色" value={valid ? draft.color : DEFAULT_CHAT_BACKGROUND} disabled={disabled} onChange={event => setDraft({ ...draft, color: event.target.value })} /><input aria-label="聊天背景色值" type="text" value={draft.color} maxLength={7} spellCheck={false} disabled={disabled} onChange={event => setDraft({ ...draft, color: event.target.value })} /></label>
    {!valid && <p role="alert">请输入 # 加六位十六进制色值，例如 #f3f0e7。</p>}
    <p className="dtw-background-hint">仅改变原生聊天内容区的背景，包含输入框周围空白；不改变输入框本身、字体、强调色、侧栏或设置窗口。深色模式自动沿用 DSH 默认。建议选浅色，确保原生文字清晰。</p>
    <p className="dtw-background-hint">当前米白参考色为 #F3F0E7。若旧主题插件仍启用，其他主题效果仍由它控制；本功能不会自动停用或卸载旧插件。</p>
    {error && <p role="alert">{error}</p>}
    <div className="dtw-background-actions">
      <button type="button" className="dtw-button" disabled={disabled} onClick={() => { void onSave({ enabled: false, color: DEFAULT_CHAT_BACKGROUND }) }}>恢复 DSH 默认</button>
      {!embedded && <button type="button" className="dtw-button" disabled={busy} onClick={() => onClose?.()}>取消</button>}
      <button type="submit" className="dtw-button dtw-button-primary" disabled={disabled || !valid}>{busy ? '保存中…' : '保存背景'}</button>
    </div>
  </form>
}

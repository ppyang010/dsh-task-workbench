import * as React from 'react'
import type { BoardControllerFace, Command, ModelCatalog, ModelSelection } from '../../shared/model.ts'

const modelKey = ({ provider, model }: ModelSelection) => JSON.stringify([provider, model])

export function DefaultModelSettings({ selection, enabled, disabled, connected, loadCatalog, command }: {
  selection: ModelSelection
  enabled: boolean
  disabled: boolean
  connected: boolean
  loadCatalog: BoardControllerFace['loadModelCatalog']
  command(command: Command): Promise<boolean>
}): React.ReactElement {
  const [catalog, setCatalog] = React.useState<ModelCatalog>()
  const [loadError, setLoadError] = React.useState(false)
  const [attempt, retry] = React.useReducer(count => count + 1, 0)
  const [draft, setDraft] = React.useState<ModelSelection>()
  React.useEffect(() => {
    if (!loadCatalog || !connected) return
    const abort = new AbortController()
    setLoadError(false)
    void loadCatalog(abort.signal).then(value => {
      if (!abort.signal.aborted) setCatalog(value)
    }, () => {
      if (!abort.signal.aborted) setLoadError(true)
    })
    return () => abort.abort()
  }, [loadCatalog, connected, attempt])

  const selected = draft ?? selection
  const groups = catalog?.groups ?? []
  const model = groups.find(group => group.id === selected.provider)?.models.find(item => item.id === selected.model)
  const reasoning = model?.reasoning
  const changed = modelKey(selected) !== modelKey(selection) || selected.reasoningEffort !== selection.reasoningEffort
  const effortAvailable = !selected.reasoningEffort || reasoning?.efforts.some(option => option.id === selected.reasoningEffort)
  return <section>
    <strong>固定新会话默认模型</strong>
    <p>开启后，普通新会话使用已保存的模型。在当前会话切换模型时保留此默认值。</p>
    <div className="dtw-auto">
      <span className="dtw-auto-title">{enabled ? '已固定默认模型' : '跟随 DSH 默认设置'}</span>
      <button type="button" role="switch" className="dtw-switch" aria-label="固定新会话默认模型" aria-checked={enabled} disabled={disabled} onClick={() => {
        void command({ type: 'defaultModelLock', enabled: !enabled })
      }}><span /></button>
    </div>
    <p>已保存 {selection.model} · {selection.provider} · {selection.reasoningEffort ?? '模型默认推理强度'}</p>
    <div className="dtw-default-model-fields">
      <label>模型
        <select value={modelKey(selected)} disabled={disabled || !groups.length} onChange={event => {
          const [provider, modelId] = JSON.parse(event.target.value) as [string, string]
          const next = groups.find(group => group.id === provider)?.models.find(item => item.id === modelId)
          if (next) setDraft({ provider, model: modelId, reasoningEffort: next.reasoning?.defaultEffort })
        }}>
          {!model && <option value={modelKey(selected)} disabled>{selected.model} · {selected.provider}</option>}
          {groups.map(group => <optgroup key={group.id} label={group.name || group.id}>
            {group.models.map(item => <option key={item.id} value={modelKey({ provider: group.id, model: item.id })}>{item.name || item.id}</option>)}
          </optgroup>)}
        </select>
      </label>
      {model && (reasoning?.efforts.length || selected.reasoningEffort) ? <label>推理强度
        <select value={selected.reasoningEffort ?? ''} disabled={disabled} onChange={event => setDraft({ ...selected, reasoningEffort: event.target.value || undefined })}>
          <option value="">模型默认</option>
          {!effortAvailable && <option value={selected.reasoningEffort} disabled>{selected.reasoningEffort}（不可用）</option>}
          {reasoning?.efforts.map(option => <option key={option.id} value={option.id}>{option.name || option.id}</option>)}
        </select>
      </label> : null}
      <button type="button" className="dtw-button" disabled={disabled || !changed || !model || !effortAvailable} onClick={() => {
        void command({ type: 'defaultModelSelection', selection: selected }).then(saved => { if (saved) setDraft(undefined) })
      }}>保存默认模型</button>
    </div>
    {loadError ? <p>暂时无法加载模型目录。 <button type="button" className="dtw-button" disabled={!connected} onClick={retry}>重试</button></p>
      : !catalog && loadCatalog && connected ? <p role="status">正在读取模型目录…</p>
        : catalog && (!groups.length || catalog.failures.length > 0) && <p>{groups.length ? '部分模型提供方暂不可用。' : '模型目录暂无可用模型。'} <button type="button" className="dtw-button" onClick={retry}>刷新目录</button></p>}
  </section>
}

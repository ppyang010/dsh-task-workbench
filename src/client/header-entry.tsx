import * as React from 'react'
import { PANEL_ID } from '../shared/model.ts'

export const HEADER_SLOT = 'conversation.session.header.actions'
// 复用入口 ID，通过宿主优先级覆盖显示；注册本身不依赖旧插件存在。
export const HEADER_OPTIONS = { name: HEADER_SLOT, id: 'personal-workbench', order: -4, priority: -10 } as const

export function registerHeaderEntry(slots: any, layout: { selectPanel(id: string): void }): () => void {
  const HeaderEntry = () => <button type="button" className="dtw-header-entry" title="打开我的任务工作台" aria-label="打开我的任务工作台" onClick={() => layout.selectPanel(PANEL_ID)}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16m6-16v16"/></svg>
    <span>工作台</span>
  </button>
  return slots.inject(HEADER_SLOT, () => slots.register(HEADER_OPTIONS, HeaderEntry))
}

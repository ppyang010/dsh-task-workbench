import { PANEL_ID } from '../shared/model.ts'
import type { Source } from './runtime.ts'

export interface ArchiveLayout {
  panelInfo: Source<{ activePanelId: string | null }>
  selectPanel(id: string): void
}

/** 只补偿 DSH 归档当前会话时的 clearMain→selectPanel(null)，不保留已归档会话引用。 */
export function preserveArchivePanel(
  layout: ArchiveLayout | undefined,
  selection: Source<{ sessionId?: string }> | undefined,
  workspaces: Source<{ archivedSessionIds: readonly string[] }> | undefined,
  sessionId: string,
  interactions?: Pick<Document, 'addEventListener' | 'removeEventListener'>,
): () => void {
  if (!layout?.panelInfo || !selection || !workspaces || layout.panelInfo.getSnapshot().activePanelId !== PANEL_ID || selection.getSnapshot().sessionId !== sessionId) return () => {}
  let active = true
  let restoring = false
  const cancel = (event: Event) => {
    const target = event.target as Element | null
    if (typeof target?.closest === 'function' && target.closest('.dtw-root')) return
    active = false
  }
  const detach = layout.panelInfo.subscribe(() => {
    if (!active || restoring) return
    const panelId = layout.panelInfo.getSnapshot().activePanelId
    if (panelId === PANEL_ID) return
    const nativeCleared = panelId === null && selection.getSnapshot().sessionId === undefined && workspaces.getSnapshot().archivedSessionIds.includes(sessionId)
    if (!nativeCleared) { active = false; return }
    restoring = true
    try { layout.selectPanel(PANEL_ID) }
    catch { /* 面板卸载时不干预宿主导航，也不改变归档结果。 */ }
    finally { restoring = false; active = false }
  })
  // 操作期间用户主动导航/快捷键优先，避免归档响应迟到时抢回页面。
  interactions?.addEventListener('pointerdown', cancel, true)
  interactions?.addEventListener('keydown', cancel, true)
  return () => {
    active = false
    detach()
    interactions?.removeEventListener('pointerdown', cancel, true)
    interactions?.removeEventListener('keydown', cancel, true)
  }
}

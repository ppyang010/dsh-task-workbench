import * as React from 'react'
import { PANEL_ID } from '../shared/model.ts'
import { BoardController } from './controller.ts'
import { createRuntime, openNewSessionPage } from './runtime.ts'
import { MyFocusBoard } from './ui/Board.tsx'
import { registerHeaderEntry } from './header-entry.tsx'
import { registerSessionCopy } from './session-copy.tsx'
import styles from './ui/styles.css'

export const name = 'ppyang010-task-workbench/client'
export const inject = ['slots', 'connection', 'sessions', 'workspaces', 'uiSession', 'uiWorkspace', 'layout']
export function apply(ctx: any): void {
  try {
    const controller = new BoardController(ctx.get('connection').rpc, createRuntime(ctx))
    const sheet = document.createElement('style')
    sheet.dataset.dshTaskWorkbench = ''
    sheet.textContent = styles
    document.head.append(sheet)
    const disposers: Array<() => void> = [() => sheet.remove(), controller.start()]
    const slots = ctx.get('slots')
    const Page = () => {
      React.useEffect(() => controller.activate(), [])
      return <MyFocusBoard controller={controller} onNewSession={workspaceId => openNewSessionPage(ctx, workspaceId)} />
    }
    const Icon = ({ size = 17 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16m6-16v16"/></svg>
    try {
      disposers.push(slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, Page)))
      disposers.push(slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 12, label: '我的任务工作台' }, Icon)))
    } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
    // 顶部入口单独挂载，旧宿主没有此槽位时保留侧边栏与看板。
    try { disposers.push(registerHeaderEntry(slots, ctx.get('layout'))) }
    catch { console.warn('[dsh-task-workbench] 顶部工作台入口不可用，请从侧边栏打开') }
    // 新宿主提供会话上下文菜单；旧宿主继续使用原生复制，不影响看板。
    try {
      const menus = ctx.get('contextMenus')
      if (menus) disposers.push(registerSessionCopy(menus))
    } catch { console.warn('[dsh-task-workbench] 复制名称菜单不可用，保留原生复制') }
    ctx.effect(() => () => { for (const dispose of disposers.reverse()) dispose() })
  } catch {
    // 客户端插件挂载失败不阻断 DSH 本身启动，控制台保留可定位的标识。
    console.error('[dsh-task-workbench] 我的关注挂载失败，请检查 DSH 版本及所需服务')
  }
}

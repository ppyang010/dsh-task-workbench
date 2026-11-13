interface SessionTarget { sessionId: string; displayTitle?: string }
interface CopyAction { id: string; label: string; icon: { key: string }; run(): Promise<void> }
export interface CopyMenus {
  register(input: { id: string; target: 'session'; order: number; resolve(target: SessionTarget): CopyAction[] }): () => void
  notify(text: string, success?: boolean): void
}

export function sessionCopyText(sessionId: string, title: string | undefined): string {
  const name = title?.trim().replace(/[\r\n]+/g, ' ')
  return name ? `${name}\n${sessionId}` : sessionId
}

/** 仅写剪贴板，不读取用户已有内容。 */
export async function writeSessionClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true }
    if (typeof document.execCommand !== 'function') return false
    const input = document.createElement('textarea')
    input.value = text
    input.readOnly = true
    input.style.cssText = 'position:fixed;left:-9999px'
    document.body.append(input)
    try { input.select(); return document.execCommand('copy') }
    finally { input.remove() }
  } catch { return false }
}

/** 独立注册菜单动作，不覆盖原生复制、不监听 DOM、不读取旧开关。 */
export function registerSessionCopy(menus: CopyMenus, write: (text: string) => Promise<boolean> = writeSessionClipboard): () => void {
  let live = true
  const unregister = menus.register({
    id: 'ppyang-task-workbench.copy-name', target: 'session', order: 451,
    resolve: target => {
      // 捕获此次右键目标，不使用当前打开会话或之后的菜单目标。
      const text = sessionCopyText(target.sessionId, target.displayTitle)
      return [{
        id: 'copy-name-and-id', label: '复制名称和 ID', icon: { key: 'workspace.copy' },
        run: async () => {
          if (!live) return
          let ok = false
          try { ok = await write(text) } catch { /* 写入异常按失败提示。 */ }
          if (live) menus.notify(ok ? (text.includes('\n') ? '已复制会话名称和 Session ID' : '已复制 Session ID（会话名称为空）') : '复制失败，请重试', ok)
        },
      }]
    },
  })
  return () => { live = false; unregister() }
}

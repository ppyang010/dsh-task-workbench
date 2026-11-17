import { chatBackgroundSchema, type ChatBackground } from '../shared/model.ts'
import type { BoardControllerFace } from '../shared/model.ts'

/** 仅作用于宿主明确标记的聊天内容区，不改全局 token、输入框、侧栏或工作台。 */
export function chatBackgroundCss(value: ChatBackground): string {
  const parsed = chatBackgroundSchema.safeParse(value)
  if (!parsed.success || !parsed.data.enabled) return ''
  const color = parsed.data.color.toLowerCase()
  const scope = 'html:not([data-theme="dark"]):not([data-color-scheme="dark"]) body:not([data-ds-dark-theme]):not([data-theme="dark"]) [data-conversation-content][data-conversation-region="chat"]'
  // 原生底部吸附容器另画一层渐变；只替换该层的终点色，保留36px淡入和输入卡片样式。
  return `${scope} { background-color: ${color} !important; }
${scope}[data-content-phase="active"] [data-composer-seat][data-conversation-region="composer"] { background: linear-gradient(180deg, color-mix(in srgb, ${color} 0%, transparent) 0px, ${color} 36px) !important; }`
}

/** 关闭/卸载只删除自己的样式，不写入或恢复其他插件的任何配置。 */
export function installChatBackground(controller: Pick<BoardControllerFace, 'subscribe' | 'getSnapshot'>, doc: Document = document): () => void {
  const sheet = doc.createElement('style')
  sheet.dataset.dtwChatBackground = ''
  doc.head.append(sheet)
  const update = () => {
    const value = controller.getSnapshot().board.settings.chatBackground
    const css = chatBackgroundCss(value)
    if (sheet.textContent !== css) sheet.textContent = css
  }
  const unsubscribe = controller.subscribe(update)
  update()
  return () => { unsubscribe(); sheet.remove() }
}

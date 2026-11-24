/** 侧栏插件用父会话、子代理来源和固定标题前缀识别侧聊。 */
export function isSidechat(origin?: string, parentId?: string, title?: string): boolean {
  return origin === 'subagent' && !!parentId && !!title?.startsWith('Side: ')
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { initialState, stateSchema, DEFAULT_CHAT_BACKGROUND } from '../src/shared/model.ts'
import { WatchStore } from '../src/host/store.ts'
import { chatBackgroundCss, installChatBackground } from '../src/client/chat-background.ts'

test('旧配置兼容且默认关闭；背景设置独立持久化，不改其他设置', async () => {
  const legacy = { ...initialState(), settings: { autoCollect: true } }
  assert.deepEqual(stateSchema.parse(legacy).settings.chatBackground, { enabled: false, color: '#f3f0e7' })
  let saved: unknown = legacy
  const store = new WatchStore({ get: () => saved, set: async value => { saved = value } })
  await store.command({ type: 'chatBackground', value: { enabled: true, color: '#F3F0E7' } })
  const reopened = new WatchStore({ get: () => saved, set: async () => {} })
  assert.deepEqual(reopened.snapshot().settings.chatBackground, { enabled: true, color: DEFAULT_CHAT_BACKGROUND })
  assert.equal(reopened.snapshot().settings.autoCollect, true)
  await reopened.command({ type: 'settings', autoCollect: false })
  assert.equal(reopened.snapshot().settings.chatBackground.enabled, true)
})

test('非法色值拒绝保存且不能注入 CSS，存储失败保留旧值', async () => {
  const store = new WatchStore({ get: initialState, set: async () => { throw new Error('保存失败') } })
  const before = store.snapshot()
  await assert.rejects(store.command({ type: 'chatBackground', value: { enabled: true, color: '#f3f0e7' } }))
  assert.deepEqual(store.snapshot(), before)
  for (const color of ['red', '#fff', '#f3f0e7;} body {display:none', 'url(https://example.test)']) {
    await assert.rejects(store.command({ type: 'chatBackground', value: { enabled: true, color } }))
    assert.equal(chatBackgroundCss({ enabled: true, color }), '')
  }
})

test('仅设置浅色聊天区域背景，不改全局 token、字体或壁纸', () => {
  assert.equal(chatBackgroundCss({ enabled: false, color: DEFAULT_CHAT_BACKGROUND }), '')
  const css = chatBackgroundCss({ enabled: true, color: DEFAULT_CHAT_BACKGROUND })
  assert.match(css, /body:not\(\[data-ds-dark-theme\]\)/)
  assert.match(css, /\[data-conversation-content\]\[data-conversation-region="chat"\]/)
  assert.match(css, /background-color: #f3f0e7 !important/)
  assert.doesNotMatch(css, /--dsw-|font|sidebar|backdrop|url\(/)
  assert.match(css, /\[data-content-phase="active"\] \[data-composer-seat\]\[data-conversation-region="composer"\]/)
  assert.match(css, /linear-gradient\(180deg, color-mix\(in srgb, #f3f0e7 0%, transparent\) 0px, #f3f0e7 36px\)/)
  assert.doesNotMatch(css, /data-composer-card|input\s*\{|textarea\s*\{/)
  const custom = chatBackgroundCss({ enabled: true, color: '#abcdef' })
  assert.match(custom, /#abcdef 36px/)
  assert.doesNotMatch(custom, /#f3f0e7/)
})

test('配置更新即时替换样式，关闭清空、卸载清理，不依赖旧插件', () => {
  const board = initialState(); let notify = () => {}; let removed = false; let detached = false
  const sheet = { dataset: {}, textContent: '', remove: () => { removed = true } }
  const doc = { createElement: () => sheet, head: { append() {} } } as unknown as Document
  const dispose = installChatBackground({ getSnapshot: () => ({ board }) as any, subscribe: fn => { notify = fn; return () => { detached = true } } }, doc)
  assert.equal(sheet.textContent, '')
  board.settings.chatBackground.enabled = true; notify(); assert.match(sheet.textContent, /#f3f0e7/)
  board.settings.chatBackground.color = '#abcdef'; notify(); assert.match(sheet.textContent, /#abcdef/)
  board.settings.chatBackground.enabled = false; notify(); assert.equal(sheet.textContent, '')
  dispose(); assert.equal(removed, true); assert.equal(detached, true)
})

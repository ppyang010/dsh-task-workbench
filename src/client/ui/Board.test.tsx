import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createElement, type ReactElement } from 'react'
import { initialState, type BoardControllerFace, type ClientState, type SessionView, type WatchEntry } from '../../shared/model.js'
import { MyFocusBoard } from './Board.js'
import { afterSessionId, formatUpdatedAt, getAddDisabledReason, getBoardRows, matchesRow, matchesSession, uniqueSessions, workspaceOptions } from './board-helpers.js'

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (element: ReactElement) => string }
const entry = (sessionId: string, values: Partial<WatchEntry> = {}): WatchEntry => ({ sessionId, columnId: 'focus', note: '', source: 'manual', addedAt: 1, updatedAt: 1, version: 1, ...values })
const session = (id: string, values: Partial<SessionView> = {}): SessionView => ({ id, title: `会话 ${id}`, workspaceId: 'work-1', workspaceTitle: '产品工作区', updatedAt: 1794400000000, status: 'idle', archived: false, missing: false, subagent: false, openable: true, ...values })
const client = (values: Partial<ClientState> = {}): ClientState => ({ board: initialState(), sessions: [], loading: false, saving: false, connected: true, runtimeReady: true, ...values })
function markup(state: ClientState): string {
  const controller: BoardControllerFace = {
    subscribe: () => () => {}, getSnapshot: () => state,
    refresh: async () => {}, command: async () => true, openSession: async () => true, clearError: () => {},
  }
  return renderToStaticMarkup(createElement(MyFocusBoard, { controller }))
}

test('目录未就绪时保留卡片，不误报会话丢失或运行状态', () => {
  const state = client({ board: { ...initialState(), entries: [entry('a')] }, runtimeReady: false })
  const [row] = getBoardRows(state)
  assert.equal(row.title, '会话资料待同步')
  assert.equal(row.status, 'unknown')
  assert.match(row.unavailableReason, /正在同步/)
  assert.equal(row.entry.columnId, 'focus')
  assert.doesNotMatch(markup(state), /暂时找不到原会话/)
})

test('目录就绪后缺失和已归档会话仍保留关注、备注与原分类', () => {
  const state = client({ board: { ...initialState(), entries: [entry('missing', { columnId: 'later', note: '之后回来确认' }), entry('archived', { columnId: 'waiting' })] }, sessions: [session('archived', { archived: true })] })
  const rows = getBoardRows(state)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].entry.note, '之后回来确认')
  assert.equal(rows[0].entry.columnId, 'later')
  assert.match(rows[0].unavailableReason, /暂时找不到/)
  assert.equal(rows[1].entry.columnId, 'waiting')
  assert.match(rows[1].unavailableReason, /已归档/)
})

test('运行状态变化只更新状态标记，不改变人工分类', () => {
  const board = { ...initialState(), entries: [entry('a', { columnId: 'later' })] }
  for (const status of ['running', 'waiting', 'unread', 'idle'] as const) {
    const [row] = getBoardRows(client({ board, sessions: [session('a', { status })] }))
    assert.equal(row.status, status)
    assert.equal(row.entry.columnId, 'later')
  }
  assert.equal(board.entries[0].version, 1)
})

test('标题、工作区、备注和运行状态支持组合搜索及精确工作区筛选', () => {
  const [row] = getBoardRows(client({ board: { ...initialState(), entries: [entry('a', { note: '确认交互方案' })] }, sessions: [session('a', { title: '关注看板 UI', status: 'waiting', waitingLabel: '等待审批' })] }))
  for (const query of ['关注看板', 'UI', '产品工作区', '交互方案', '等待回应', 'waiting', '审批', '看板   方案']) assert.equal(matchesRow(row, query), true, query)
  assert.equal(matchesRow(row, '看板', 'work-2'), false)
  assert.equal(matchesRow(row, '', 'work-1', 'waiting'), true)
  assert.equal(matchesRow(row, '', '', 'running'), false)
})

test('添加目录按会话 ID 去重，保留最新元数据并支持状态搜索', () => {
  const latest = session('a', { title: '最新标题', updatedAt: 20, status: 'running' })
  const sessions = uniqueSessions([latest, session('a', { title: '旧标题', updatedAt: 10 }), session('b', { updatedAt: 15 })])
  assert.deepEqual(sessions.map(item => item.id), ['a', 'b'])
  assert.equal(sessions[0].title, '最新标题')
  assert.equal(matchesSession(latest, '最新 运行中'), true)
  assert.equal(matchesSession(latest, '最新', 'other'), false)
  assert.equal(workspaceOptions(sessions).length, 1)
  const [row] = getBoardRows(client({ board: { ...initialState(), entries: [entry('a')] }, sessions: [latest, session('a', { updatedAt: 10 })] }))
  assert.equal(row.title, '最新标题')
})

test('已关注、子代理、归档、缺失和不可打开会话具有明确添加禁用原因', () => {
  assert.match(getAddDisabledReason(session('a'), new Set(['a'])), /已关注/)
  assert.match(getAddDisabledReason(session('a', { subagent: true }), new Set()), /子代理/)
  assert.match(getAddDisabledReason(session('a', { archived: true }), new Set()), /已归档/)
  assert.match(getAddDisabledReason(session('a', { missing: true }), new Set()), /不可用/)
  assert.match(getAddDisabledReason(session('a', { openable: false }), new Set()), /无法打开/)
  assert.equal(getAddDisabledReason(session('a'), new Set()), '')
})

test('列内排序锚点包含筛选隐藏卡片，排除拖动中的卡片', () => {
  const rows = getBoardRows(client({ board: { ...initialState(), entries: ['a', 'hidden', 'b', 'c'].map(id => entry(id)) } }))
  assert.equal(afterSessionId(rows, 'a', 'c'), 'hidden')
  assert.equal(afterSessionId(rows, 'b', 'hidden'), 'c')
  assert.equal(afterSessionId(rows, 'c', 'a'), undefined)
  assert.equal(afterSessionId(rows, 'unknown', 'a'), undefined)
})

test('空标题与无效时间可安全呈现', () => {
  const [row] = getBoardRows(client({ board: { ...initialState(), entries: [entry('a')] }, sessions: [session('a', { title: '  ', updatedAt: Number.MAX_VALUE })] }))
  assert.equal(row.title, '未命名会话')
  for (const value of [0, -1, NaN, Infinity, Number.MAX_VALUE]) assert.equal(formatUpdatedAt(value), '更新时间未知')
  assert.doesNotThrow(() => markup(client({ board: { ...initialState(), entries: [entry('a')] }, sessions: [session('a', { updatedAt: Number.MAX_VALUE })] })))
})

test('组件默认呈现工作台与三列，自动纳入关闭且不生成聊天输入框', () => {
  const html = markup(client())
  for (const title of ['我的工作台', '我的关注', '等我处理', '暂时搁置', '添加已有会话']) assert.ok(html.includes(title), title)
  assert.match(html, /role="switch"[^>]*aria-checked="false"/)
  assert.doesNotMatch(html, /<textarea|发送消息|原生输入框示意|宿主侧边栏/)
})

test('会话标题与备注按文本转义，缺失会话的打开按钮禁用', () => {
  const state = client({ board: { ...initialState(), entries: [entry('a', { note: '<script>示例备注</script>' }), entry('missing')] }, sessions: [session('a', { title: '<img src=x onerror=alert(1)>' })] })
  const html = markup(state)
  assert.ok(html.includes('&lt;script&gt;示例备注&lt;/script&gt;'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.doesNotMatch(html, /<script>|<img src=x/)
  assert.match(html, /class="dtw-open-button" disabled=""/)
})

test('保存与加载期间，提交、分类、备注和刷新按钮均显式禁用', () => {
  for (const flags of [{ saving: true }, { loading: true }]) {
    const html = markup(client({ ...flags, board: { ...initialState(), entries: [entry('a')] }, sessions: [session('a')] }))
    assert.match(html, /role="switch"[^>]*disabled=""/)
    assert.match(html, /class="dtw-move-select"[^>]*disabled=""/)
    assert.match(html, /class="dtw-text-button"[^>]*disabled=""[^>]*aria-label="添加备注/)
    assert.match(html, /aria-label="刷新看板"/)
    assert.match(html, /class="dtw-icon-button dtw-refresh"[^>]*disabled=""/)
  }
})

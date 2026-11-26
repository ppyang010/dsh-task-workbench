import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createElement, type ReactElement } from 'react'
import { initialState, type BoardControllerFace, type ClientState, type SessionView, type WatchEntry } from '../../shared/model.js'
import { MyFocusBoard } from './Board.js'
import { afterSessionId, formatUpdatedAt, getAddDisabledReason, getBoardRows, groupWorkspaces, groupWorkspaceId, orderWorkspaceGroups, groupOrderStillCurrent, matchesRow, matchesSession, uniqueSessions, workspaceOptions } from './board-helpers.js'
import { initialGroupOrder, type GroupOrderControllerFace } from '../../shared/group-order.ts'

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (element: ReactElement) => string }
const entry = (sessionId: string, values: Partial<WatchEntry> = {}): WatchEntry => ({ sessionId, columnId: 'focus', note: '', source: 'manual', addedAt: 1, updatedAt: 1, version: 1, ...values })
const session = (id: string, values: Partial<SessionView> = {}): SessionView => ({ id, title: `会话 ${id}`, workspaceId: 'work-1', workspaceTitle: '产品工作区', updatedAt: 1794400000000, status: 'idle', archived: false, missing: false, subagent: false, openable: true, ...values })
const client = (values: Partial<ClientState> = {}): ClientState => ({ board: initialState(), sessions: [], loading: false, saving: false, connected: true, runtimeReady: true, ...values })
function markup(state: ClientState): string {
  const controller: BoardControllerFace = {
    subscribe: () => () => {}, getSnapshot: () => state,
    refresh: async () => {}, command: async () => true, openSession: async () => true, renameSession: async () => true, clearError: () => {},
  }
  const groupOrder: GroupOrderControllerFace = { subscribe: () => () => {}, getSnapshot: () => ({ data: initialGroupOrder(), loaded: true, loading: false, saving: false }), refresh: async () => {}, reorder: async () => true, clearError: () => {} }
  return renderToStaticMarkup(createElement(MyFocusBoard, { controller, groupOrder }))
}

test('精简卡片将分类和来源收进菜单，状态位于标题右侧并保留打开与空闲状态', () => {
  const html = markup(client({ board: { ...initialState(), entries: [entry('a', { source: 'auto', note: '备注内容' })] }, sessions: [session('a')] }))
  const card = html.match(/<article[\s\S]*?<\/article>/)?.[0] ?? ''
  const menu = card.slice(card.indexOf('<details'))
  assert.match(menu, /移动到<\/label><select/)
  assert.match(menu, /<option value="later" selected="">暂时搁置<\/option>/)
  assert.doesNotMatch(menu, /<option value="focus"/)
  assert.match(menu, /aria-label="移到暂时搁置：会话 a"/)
  assert.match(menu, /取消关注/)
  assert.equal((card.match(/aria-label="取消关注：会话 a"/g) ?? []).length, 1)
  assert.doesNotMatch(card, /dtw-card-unfollow/)
  assert.match(html, />多选<\/button>/)
  assert.match(menu, /来源：自动纳入/)
  assert.match(menu, /复制 Session ID/)
  assert.match(menu, /复制名称和 ID/)
  assert.doesNotMatch(card.slice(0, card.indexOf('<details')), /<select|dtw-source/)
  assert.match(card, /class="dtw-card-head">[\s\S]*?<\/h3><span class="dtw-status dtw-status-idle"/)
  assert.match(card, /<footer class="dtw-card-actions"><time class="dtw-card-updated"/)
  assert.match(card, /不等同于上次 AI 回复时间/)
  assert.doesNotMatch(card, /dtw-card-meta/)
  assert.equal((card.match(/<time/g) ?? []).length, 1)
  assert.equal((card.match(/dtw-status-idle/g) ?? []).length, 1)
  assert.match(card, /打开对话/)
  assert.match(card, /备注内容/)
  assert.match(card, /title="会话 a"/)
  assert.match(card, /data-dtw-status="idle"/)
})

test('等我处理默认移到搁置，搁置默认移回我的关注，同步卡片的移动控件禁用', () => {
  const html = markup(client({
    board: { ...initialState(), entries: [entry('waiting', { columnId: 'waiting' }), entry('later', { columnId: 'later' }), entry('running')] },
    sessions: [session('waiting'), session('later'), session('running', { status: 'running' })],
  }))
  const cards = html.match(/<article[\s\S]*?<\/article>/g) ?? []
  assert.match(cards.find(card => card.includes('data-dtw-session="waiting"')) ?? '', /<option value="later" selected="">/)
  assert.match(cards.find(card => card.includes('data-dtw-session="later"')) ?? '', /<option value="focus" selected="">/)
  assert.match(cards.find(card => card.includes('data-dtw-mirrored="true"')) ?? '', /disabled="" aria-label="移到暂时搁置：会话 running"/)
})

test('活动会话卡片标记整卡呼吸状态，空闲卡片保持静态', () => {
  const html = markup(client({
    board: { ...initialState(), entries: [entry('a'), entry('b'), entry('c')] },
    sessions: [session('a', { status: 'running' }), session('b', { status: 'waiting' }), session('c', { status: 'unread' })],
  }))
  assert.match(html, /data-dtw-status="running"/)
  assert.match(html, /data-dtw-status="waiting"/)
  assert.match(html, /data-dtw-status="unread"/)
  assert.doesNotMatch(html, /data-dtw-status="idle"/)
})

test('中间列默认分成运行中和等我处理两块，关注原卡片不消失', () => {
  const html = markup(client({
    board: { ...initialState(), entries: [entry('run'), entry('wait'), entry('idle')] },
    sessions: [session('run', { status: 'running', title: '运行会话' }), session('wait', { status: 'waiting', title: '等待会话' }), session('idle', { title: '空闲会话' })],
  }))
  assert.match(html, /data-dtw-pane="running"/)
  assert.match(html, /data-dtw-pane="waiting"/)
  assert.match(html, /aria-labelledby="[^"]+-running"/)
  assert.match(html, /<h2[^>]*>运行中<\/h2>/)
  assert.match(html, /<h2[^>]*>等我处理<\/h2>/)
  assert.doesNotMatch(html, /dtw-activity-head/)
  assert.equal((html.match(/data-dtw-session="run"/g) ?? []).length, 2)
  assert.equal((html.match(/data-dtw-session="wait"/g) ?? []).length, 2)
  assert.equal((html.match(/data-dtw-session="idle"/g) ?? []).length, 1)
  assert.match(html, /data-dtw-mirrored="true"/)
  assert.doesNotMatch(html, /dtw-column-hint/)
  assert.doesNotMatch(html, /同步展示 · 原卡片仍在我的关注/)
  assert.doesNotMatch(html, /dtw-card-sync/)
  const mirroredCard = html.match(/data-dtw-mirrored="true"[\s\S]*?<\/article>/)?.[0] ?? ''
  assert.doesNotMatch(mirroredCard, /dtw-note-preview/)
  assert.match(html, /dtw-dot-running[^>]*><\/i><strong>1<\/strong>运行中/)
  const closed = markup(client({
    board: { ...initialState(), settings: { ...initialState().settings, mirrorActivity: false }, entries: [entry('run')] },
    sessions: [session('run', { status: 'running', title: '运行会话' })],
  }))
  assert.equal((closed.match(/data-dtw-session="run"/g) ?? []).length, 1)
  assert.doesNotMatch(closed, /data-dtw-mirrored/)
  assert.doesNotMatch(closed, /data-dtw-pane="running"/)
})

test('组头提供同列拖拽和上下排序按钮，未知工作区不可排序', () => {
  const state = client({ board: { ...initialState(), entries: [entry('a'), entry('b'), entry('missing')] }, sessions: [session('a'), session('b', { workspaceId: 'work-2', workspaceTitle: '研发工作区' })] })
  const html = markup(state)
  assert.match(html, /class="dtw-workspace-heading"[^>]*draggable="true"/)
  assert.match(html, /aria-label="上移「我的关注」中的「产品工作区」分组"/)
  assert.match(html, /aria-label="下移「我的关注」中的「产品工作区」分组"/)
  assert.match(html, /aria-label="上移「我的关注」中的「工作区待确认」分组"[^>]*disabled=""/)
  assert.doesNotMatch(html, /移动「我的关注」中的/)
})

test('排序快照兼顾自动待处理，分组或版本变化时拒绝旧拖拽', () => {
  const state = client({ board: { ...initialState(), revision: 2, entries: [entry('a'), entry('b', { columnId: 'waiting' })] }, sessions: [session('a', { status: 'waiting', workspaceTitle: 'A组' }), session('b', { workspaceId: 'work-2', workspaceTitle: 'B组' })] })
  const order = initialGroupOrder()
  const group = { columnId: 'waiting' as const, sourceId: 'work-1', workspaceIds: ['work-1', 'work-2'], expectedBoardRevision: 2, expectedOrderRevision: 0 }
  assert.equal(groupOrderStillCurrent(state, order, group), true)
  assert.equal(groupOrderStillCurrent({ ...state, board: { ...state.board, revision: 3 } }, order, group), false)
  assert.equal(groupOrderStillCurrent({ ...state, sessions: [session('a', { status: 'idle', workspaceTitle: 'A组' }), session('b', { workspaceId: 'work-2', workspaceTitle: 'B组' })] }, order, group), false)
  assert.equal(groupOrderStillCurrent({ ...state, connected: false }, order, group), false)
  assert.equal(groupOrderStillCurrent(state, { ...order, revision: 1 }, group), false)
})

test('恢复自定义分组顺序时保留未知工作区槽位，并按 ID 区分同名工作区', () => {
  const state = client({ board: { ...initialState(), entries: ['a', 'b', 'c', 'missing'].map(id => entry(id)) }, sessions: [session('a', { workspaceId: 'work-1', workspaceTitle: '同名' }), session('b', { workspaceId: 'work-2', workspaceTitle: '同名' }), session('c', { workspaceId: 'work-3', workspaceTitle: '另一工作区' })] })
  const groups = groupWorkspaces(getBoardRows(state)); const unknownIndex = groups.findIndex(group => !groupWorkspaceId(group))
  const ordered = orderWorkspaceGroups(groups, ['work-3', 'work-1'])
  assert.equal(ordered.findIndex(group => !groupWorkspaceId(group)), unknownIndex)
  assert.deepEqual(ordered.map(groupWorkspaceId).filter(Boolean), ['work-3', 'work-1', 'work-2'])
})

test('工作区按 ID 分组，重名不合并，缺失记录保留且组内顺序不变', () => {
  const state = client({ board: { ...initialState(), entries: ['a', 'b', 'c', 'missing'].map(id => entry(id)) }, sessions: [session('a'), session('b', { workspaceId: 'work-2' }), session('c')] })
  const groups = groupWorkspaces(getBoardRows(state))
  assert.equal(groups.length, 3)
  assert.deepEqual(groups.find(group => group.rows[0].entry.sessionId === 'a')?.rows.map(row => row.entry.sessionId), ['a', 'c'])
  assert.equal(groups.filter(group => group.title === '产品工作区').length, 2)
  assert.equal(groups.flatMap(group => group.rows).length, 4)
  const html = markup(state)
  assert.equal((html.match(/class="dtw-workspace-heading"/g) ?? []).length, 3)
  assert.doesNotMatch(html, /class="dtw-workspace"/)
  assert.equal(afterSessionId(groups.find(group => group.rows.length === 2)!.rows, 'a', 'other'), 'c')
})

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

test('组件默认呈现工作台与三列，设置入口收起配置项且不生成聊天输入框', () => {
  const html = markup(client())
  for (const title of ['我的任务工作台', '我的关注', '等我处理', '暂时搁置', '添加已有会话', '多选', '已取消关注', '设置']) assert.ok(html.includes(title), title)
  assert.match(html, /aria-label="打开工作台设置"/)
  assert.doesNotMatch(html, />聊天背景</)
  assert.doesNotMatch(html, /aria-label="自动纳入会话"|aria-label="查看使用帮助"/)
  assert.doesNotMatch(html, /role="switch"/)
  assert.doesNotMatch(html, /<textarea|发送消息|原生输入框示意|宿主侧边栏/)
})

test('会话标题与备注按文本转义，缺失会话的打开按钮禁用', () => {
  const state = client({ board: { ...initialState(), entries: [entry('a', { note: '<script>示例备注</script>' }), entry('missing')] }, sessions: [session('a', { title: '<img src=x onerror=alert(1)>' })] })
  const html = markup(state)
  assert.ok(html.includes('&lt;script&gt;示例备注&lt;/script&gt;'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.doesNotMatch(html, /<script>|<img src=x/)
  assert.match(html, /class="dtw-card-title dtw-open-button" disabled=""/)
  assert.match(html, /class="dtw-button dtw-card-open" disabled=""/)
  assert.match(html, /aria-label="打开对话：/)
})

test('统计项使用可键盘操作的筛选按钮，默认选中全部且零计数仍可点击', () => {
  const html = markup(client())
  assert.equal((html.match(/class="dtw-stat-filter"/g) ?? []).length, 5)
  assert.match(html, /aria-label="显示全部状态的已关注会话" aria-pressed="true"/)
  for (const label of ['运行中', '等待回应', '完成未读', '空闲']) {
    assert.ok(html.includes(`aria-label="筛选${label}会话" aria-pressed="false"`))
  }
})

test('顶部空闲统计仅计入已关注且状态确认为空闲的会话', () => {
  const html = markup(client({ board: { ...initialState(), entries: ['idle', 'running', 'missing'].map(id => entry(id)) }, sessions: [session('idle', { status: 'idle' }), session('running', { status: 'running' }), session('unwatched', { status: 'idle' })] }))
  assert.match(html, /dtw-dot-idle[^>]*><\/i><strong>1<\/strong>空闲/)
  const syncing = markup(client({ runtimeReady: false, board: { ...initialState(), entries: [entry('idle')] }, sessions: [session('idle', { status: 'idle' })] }))
  assert.match(syncing, /dtw-dot-idle[^>]*><\/i><strong>0<\/strong>空闲/)
})

test('保存与加载期间，提交、分类、备注和刷新按钮均显式禁用', () => {
  for (const flags of [{ saving: true }, { loading: true }]) {
    const html = markup(client({ ...flags, board: { ...initialState(), entries: [entry('a')] }, sessions: [session('a')] }))
    assert.doesNotMatch(html, /role="switch"/)
    assert.match(html, /aria-label="打开工作台设置"/)
    assert.match(html, /class="dtw-move-select"[^>]*disabled=""/)
    assert.match(html, /disabled=""[^>]*aria-label="添加备注/)
    assert.match(html, /aria-label="刷新看板"/)
    assert.match(html, /class="dtw-icon-button dtw-refresh"[^>]*disabled=""/)
  }
})

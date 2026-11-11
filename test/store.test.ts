import test from 'node:test'
import assert from 'node:assert/strict'
import { initialState } from '../src/shared/model.ts'
import { WatchStore, openWatchStore } from '../src/host/store.ts'
import { WorkbenchService, isChildSession } from '../src/host/service.ts'

function fixture() {
  let durable = initialState(), writes = 0, fail = false
  const medium = { get: () => structuredClone(durable), set: async (state: typeof durable) => { if (fail) throw new Error('模拟写入失败'); writes++; durable = structuredClone(state) } }
  const store = new WatchStore(medium, () => 100)
  const allowed = new Set(['a', 'b', 'c', 'd', 'fork'])
  return { store, medium, allowed, writes: () => writes, fail: (value: boolean) => { fail = value } }
}

test('初次启用为空，自动纳入默认关闭', async () => {
  const f = fixture(); await f.store.autoCollect('a')
  assert.deepEqual(f.store.snapshot(), initialState()); assert.equal(f.writes(), 0)
})
test('多选加入去重，再次添加不移动人工分类', async () => {
  const { store, allowed } = fixture()
  await store.command({ type: 'add', sessionIds: ['a', 'a', 'b'], columnId: 'later' }, allowed)
  await store.command({ type: 'add', sessionIds: ['a'], columnId: 'focus' }, allowed)
  assert.equal(store.snapshot().entries.length, 2)
  assert.equal(store.snapshot().entries[0].columnId, 'later')
  assert.equal(store.snapshot().revision, 1)
})
test('自动纳入只添加新卡片，已有分类不动', async () => {
  const { store, allowed } = fixture()
  await store.command({ type: 'settings', autoCollect: true })
  await store.command({ type: 'add', sessionIds: ['a'], columnId: 'waiting' }, allowed)
  await store.autoCollect('a'); await store.autoCollect('b')
  assert.deepEqual(store.snapshot().entries.map(e => [e.sessionId, e.columnId, e.source]), [['a', 'waiting', 'manual'], ['b', 'focus', 'auto']])
})
test('取消关注先后穿插自动纳入，最终不复活', async () => {
  const { store } = fixture()
  await store.command({ type: 'settings', autoCollect: true })
  await Promise.all([store.autoCollect('a'), store.command({ type: 'unfollow', sessionId: 'a' }), store.autoCollect('a')])
  assert.equal(store.snapshot().entries.length, 0)
  assert.deepEqual(store.snapshot().excludedSessionIds, ['a'])
})
test('手动重新关注解除排除，关闭开关保留卡片', async () => {
  const { store, allowed } = fixture()
  await store.command({ type: 'unfollow', sessionId: 'a' })
  await store.command({ type: 'add', sessionIds: ['a'], columnId: 'later' }, allowed)
  await store.command({ type: 'settings', autoCollect: false }); await store.autoCollect('b')
  assert.deepEqual(store.snapshot().excludedSessionIds, []); assert.equal(store.snapshot().entries.length, 1)
})
test('相对锚点排序和跨列移动不覆盖无关记录', async () => {
  const { store, allowed } = fixture()
  await store.command({ type: 'add', sessionIds: ['a', 'b', 'c'], columnId: 'focus' }, allowed)
  await store.command({ type: 'move', sessionId: 'c', columnId: 'focus', beforeSessionId: 'a' })
  assert.deepEqual(store.snapshot().entries.map(e => e.sessionId), ['c', 'a', 'b'])
  await store.command({ type: 'move', sessionId: 'a', columnId: 'waiting' })
  assert.equal(store.snapshot().entries.find(e => e.sessionId === 'a')?.columnId, 'waiting')
  await assert.rejects(store.command({ type: 'move', sessionId: 'b', columnId: 'focus', beforeSessionId: 'a' }), { code: 'position_conflict' })
})
test('备注版本冲突拒绝旧覆盖，原备注保留', async () => {
  const { store, allowed } = fixture()
  await store.command({ type: 'add', sessionIds: ['a'], columnId: 'focus' }, allowed)
  await store.command({ type: 'note', sessionId: 'a', note: '新版备注', expectedVersion: 1 })
  await assert.rejects(store.command({ type: 'note', sessionId: 'a', note: '过期备注', expectedVersion: 1 }), { code: 'version_conflict' })
  assert.equal(store.snapshot().entries[0].note, '新版备注')
})
test('持久化失败不发布内存变更，队列之后仍可保存', async () => {
  const f = fixture(); f.fail(true)
  await assert.rejects(f.store.command({ type: 'settings', autoCollect: true }))
  assert.deepEqual(f.store.snapshot(), initialState()); f.fail(false)
  await f.store.command({ type: 'settings', autoCollect: true })
  const reopened = new WatchStore(f.medium)
  assert.equal(reopened.snapshot().settings.autoCollect, true)
})
test('快照隔离，调用者无法修改内部数据', async () => {
  const { store } = fixture(); const snapshot = store.snapshot(); snapshot.settings.autoCollect = true; snapshot.excludedSessionIds.push('a')
  assert.deepEqual(store.snapshot(), initialState())
})
test('损坏或未来结构不静默清空，拒绝未知操作与越长备注', async () => {
  assert.throws(() => new WatchStore({ get: () => ({ schemaVersion: 999 }), set: async () => {} }))
  const { store } = fixture()
  await assert.rejects(store.command({ type: 'delete-session', sessionId: 'a' }), { code: 'invalid_input' })
  await assert.rejects(store.command({ type: 'note', sessionId: 'a', note: 'a'.repeat(2001), expectedVersion: 1 }), { code: 'invalid_input' })
})
test('停用前排空写队列，停用后拒绝新写入', async () => {
  const { store } = fixture(); const writing = store.command({ type: 'settings', autoCollect: true }); await store.drain(); await writing
  await assert.rejects(store.autoCollect('a'), { code: 'closed' })
})
test('普通 fork 不误判为子代理；子代理 origin 和深度都会排除', () => {
  assert.equal(isChildSession({ id: 'fork', parentSession: 'a', isSeeded: true }), false)
  assert.equal(isChildSession({ id: 'child', origin: 'subagent' }), true)
  assert.equal(isChildSession({ id: 'child', delegationDepth: 1 }), true)
})
test('手动加入校验全量历史目录，不需要 Agent live，拒绝归档和子代理', async () => {
  const { store } = fixture(); let calls = 0
  const service = new WorkbenchService(store, {
    sessionQuery: { listSessions: async () => { calls++; return [{ header: { id: 'persisted' }, formatStatus: 'current' }, { header: { id: 'child', origin: 'subagent' } }, { header: { id: 'archived' } }] } },
    workspaceRegistry: { archivedSessionIds: ['archived'] },
  })
  await service.mutate({ type: 'add', sessionIds: ['persisted'], columnId: 'focus' })
  assert.equal(store.snapshot().entries[0].sessionId, 'persisted')
  await assert.rejects(service.mutate({ type: 'add', sessionIds: ['child'], columnId: 'focus' }), { code: 'session_unavailable' })
  await assert.rejects(service.mutate({ type: 'add', sessionIds: ['archived'], columnId: 'focus' }), { code: 'session_unavailable' })
  assert.equal(calls, 3)
})
test('会话只有 turn/start 纳入；查看、结束、报错都不改变分类', async () => {
  const { store } = fixture()
  const service = new WorkbenchService(store, { sessionQuery: { listSessions: async () => [] }, workspaceRegistry: { archivedSessionIds: [] } })
  await store.command({ type: 'settings', autoCollect: true })
  const session = { id: 'a', header: { id: 'a' } }
  await service.onSessionEvent(session, { type: 'session/open' }); assert.equal(store.snapshot().entries.length, 0)
  await service.onSessionEvent(session, { type: 'turn/start' })
  await store.command({ type: 'move', sessionId: 'a', columnId: 'later' })
  for (const type of ['turn/end', 'error', 'user/message', 'turn/start']) await service.onSessionEvent(session, { type })
  assert.equal(store.snapshot().entries[0].columnId, 'later')
  await service.onSessionEvent({ id: 'child', header: { id: 'child', origin: 'subagent' } }, { type: 'turn/start' })
  assert.equal(store.snapshot().entries.length, 1)
})
test('宿主 domain 声明隔离且关闭句柄', async () => {
  let closed = false, name = ''
  const opened = await openWatchStore({ open: async (spec: any) => { name = spec.name; return { global: { get: () => spec.global.initial, set: async () => {} }, close: async () => { closed = true } } } })
  assert.equal(name, 'ppyang010_task_workbench'); await opened.close(); assert.equal(closed, true)
})

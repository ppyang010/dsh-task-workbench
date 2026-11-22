import test from 'node:test'
import assert from 'node:assert/strict'
import { GroupOrderStore, openGroupOrderStore } from '../src/host/group-order-store.ts'
import { GROUP_ORDER_DOMAIN, initialGroupOrder, type GroupOrderCommand, type GroupOrderState } from '../src/shared/group-order.ts'
import { initialState } from '../src/shared/model.ts'

function fixture(initial = initialGroupOrder()) {
  let data: GroupOrderState = initial; let writes = 0; let fail = false
  const board = initialState(); board.revision = 5
  board.entries = ['one', 'two', 'three'].map(sessionId => ({ sessionId, columnId: 'focus', note: `备注${sessionId}`, source: 'manual', addedAt: 1, updatedAt: 2, version: 1 }))
  const members = new Map([['A', ['one']], ['B', ['two']], ['C', ['three']]])
  const store = new GroupOrderStore({ get: () => data, set: async next => { if (fail) throw new Error('模拟保存失败'); data = next; writes++ } })
  const sources = { board: () => structuredClone(board), members: (id: string) => members.get(id) }
  const command = (overrides: Partial<GroupOrderCommand> = {}): GroupOrderCommand => ({ columnId: 'focus', workspaceIds: ['A', 'B', 'C'], sourceId: 'B', beforeId: 'A', expectedOrderRevision: 0, expectedBoardRevision: 5, ...overrides })
  return { store, board, members, sources, command, writes: () => writes, saved: () => data, fail: (on: boolean) => { fail = on } }
}

test('工作区分组可上移，持久化顺序且不改变任何关注记录', async () => {
  const f = fixture(); const before = structuredClone(f.board)
  const after = await f.store.reorder(f.command(), f.sources)
  assert.deepEqual(after.columns.focus, ['B', 'A', 'C']); assert.deepEqual(f.board, before)
  assert.deepEqual(after.columns.waiting, []); assert.equal(f.writes(), 1)
  const reopened = new GroupOrderStore({ get: f.saved, set: async () => {} })
  assert.deepEqual(reopened.snapshot(), after)
})

test('每列独立排序，可下移到末尾，不重排同组会话', async () => {
  const f = fixture(); const before = structuredClone(f.board)
  await f.store.reorder(f.command({ sourceId: 'A', beforeId: undefined }), f.sources)
  const after = await f.store.reorder(f.command({ columnId: 'waiting', workspaceIds: ['A', 'B'], sourceId: 'B', beforeId: 'A', expectedOrderRevision: 1 }), f.sources)
  assert.deepEqual(after.columns.focus, ['B', 'C', 'A']); assert.deepEqual(after.columns.waiting, ['B', 'A'])
  assert.deepEqual(f.board, before)
})

test('暂时不可见分组保留历史槽位，新出现的分组可排序', async () => {
  const initial = initialGroupOrder(); initial.columns.focus = ['暂时隐藏', 'A', 'B']
  const f = fixture(initial)
  const after = await f.store.reorder(f.command({ sourceId: 'C', beforeId: 'A' }), f.sources)
  assert.deepEqual(after.columns.focus, ['暂时隐藏', 'C', 'A', 'B'])
})

test('分组顺序或关注列表版本冲突、工作区缺失、重复 ID 均不写入', async () => {
  const f = fixture(); const before = f.store.snapshot(); const board = structuredClone(f.board)
  for (const request of [
    f.command({ expectedOrderRevision: 1 }), f.command({ expectedBoardRevision: 4 }),
    f.command({ workspaceIds: ['A', '不存在'], sourceId: 'A', beforeId: '不存在' }),
    f.command({ workspaceIds: ['A', 'A'], sourceId: 'A', beforeId: undefined }),
  ]) {
    await assert.rejects(f.store.reorder(request, f.sources)); assert.deepEqual(f.store.snapshot(), before)
  }
  assert.deepEqual(f.board, board); assert.equal(f.writes(), 0)
})

test('并发排序只接受先提交的版本，不会覆盖或修改关注分类', async () => {
  const f = fixture(); const before = structuredClone(f.board)
  const result = await Promise.allSettled([f.store.reorder(f.command(), f.sources), f.store.reorder(f.command({ sourceId: 'C', beforeId: 'A' }), f.sources)])
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(result.filter(item => item.status === 'rejected').length, 1)
  assert.equal(f.store.snapshot().revision, 1); assert.deepEqual(f.board, before)
})

test('保存失败原子回滚；无操作不写入，队列随后可重试', async () => {
  const f = fixture(); const before = f.store.snapshot()
  f.fail(true); await assert.rejects(f.store.reorder(f.command(), f.sources), /模拟保存失败/)
  assert.deepEqual(f.store.snapshot(), before); assert.deepEqual(f.saved(), before)
  f.fail(false); await f.store.reorder(f.command({ sourceId: 'A', beforeId: 'B' }), f.sources)
  assert.equal(f.writes(), 0, '位置未变化不写入')
  await f.store.reorder(f.command(), f.sources); assert.equal(f.writes(), 1)
})

test('不能通过旧的整组跨分类接口改变关注分类', async () => {
  const { commandSchema } = await import('../src/shared/model.ts')
  assert.equal(commandSchema.safeParse({ type: 'moveGroup', workspaceId: 'A', sessionIds: ['one'], columnId: 'later', expectedRevision: 5 }).success, false)
})

test('独立排序域与原关注域隔离，关闭后拒绝写入', async () => {
  let spec: any; let closed = false
  const opened = await openGroupOrderStore({ open: async input => { spec = input; return { global: { get: initialGroupOrder, set: async () => {} }, close: async () => { closed = true } } } })
  assert.equal(spec.name, GROUP_ORDER_DOMAIN); assert.notEqual(spec.name, 'ppyang010_task_workbench')
  await opened.close(); assert.equal(closed, true)
  const f = fixture(); await assert.rejects(opened.store.reorder(f.command(), f.sources), /已关闭/)
})

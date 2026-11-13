import test from 'node:test'
import assert from 'node:assert/strict'
import { initialState, stateSchema, type BoardState } from '../src/shared/model.ts'
import { WatchStore, openWatchStore } from '../src/host/store.ts'
import { WorkbenchService } from '../src/host/service.ts'

function fixture(initial: unknown = initialState()) {
  let durable = structuredClone(initial), writes = 0, fail = false, now = 100
  const medium = {
    get: () => structuredClone(durable),
    set: async (state: BoardState) => {
      if (fail) throw new Error('模拟写入失败')
      writes++
      durable = structuredClone(state)
    },
  }
  const store = new WatchStore(medium, () => now++)
  const allowed = new Set(['a', 'b', 'c', 'd'])
  return { store, medium, allowed, writes: () => writes, fail: (value: boolean) => { fail = value } }
}

async function addNoted(f: ReturnType<typeof fixture>) {
  await f.store.command({ type: 'add', sessionIds: ['a', 'b', 'c'], columnId: 'later' }, f.allowed)
  await f.store.command({ type: 'note', sessionId: 'a', note: '保留我的备注', expectedVersion: 1 })
  return f.store.snapshot().entries[0]
}

test('取消快照保存原始记录和同列后继，重载恢复分类、备注、时间与位置', async () => {
  const f = fixture(), original = await addNoted(f)
  // 全局数组中穿插异列卡片，锚点仍须选择原分类的后继。
  await f.store.command({ type: 'move', sessionId: 'b', columnId: 'focus' })
  await f.store.command({ type: 'unfollow', sessionId: 'a' })
  const removed = f.store.snapshot().removedEntries[0]
  assert.deepEqual(removed.entry, original)
  assert.equal(removed.beforeSessionId, 'c')
  assert.ok(removed.removedAt > original.updatedAt)
  const reopened = new WatchStore(f.medium, () => 200)
  assert.deepEqual(reopened.snapshot(), f.store.snapshot())
  await reopened.command({ type: 'restore', sessionId: 'a' }, f.allowed)
  const restored = reopened.snapshot()
  assert.deepEqual(restored.entries.filter(e => e.columnId === 'later').map(e => e.sessionId), ['a', 'c'])
  assert.deepEqual(restored.entries.find(e => e.sessionId === 'a'), { ...original, version: original.version + 1, updatedAt: 200 })
  assert.deepEqual(restored.excludedSessionIds, [])
  assert.deepEqual(restored.removedEntries, [])
  assert.deepEqual(new WatchStore(f.medium).snapshot(), restored)
})

test('重复取消不覆盖快照与时间，重复恢复不写入或产生重复项', async () => {
  const f = fixture()
  await addNoted(f)
  await f.store.command({ type: 'unfollow', sessionId: 'a' })
  const removed = f.store.snapshot(), before = f.writes()
  await Promise.all([f.store.command({ type: 'unfollow', sessionId: 'a' }), f.store.command({ type: 'unfollow', sessionId: 'a' })])
  assert.deepEqual(f.store.snapshot(), removed)
  assert.equal(f.writes(), before)
  await Promise.all([f.store.command({ type: 'restore', sessionId: 'a' }, f.allowed), f.store.command({ type: 'restore', sessionId: 'a' }, f.allowed)])
  const restored = f.store.snapshot()
  await f.store.command({ type: 'restore', sessionId: 'a' })
  assert.deepEqual(f.store.snapshot(), restored)
  assert.equal(f.writes(), before + 1)
  assert.equal(restored.entries.filter(e => e.sessionId === 'a').length, 1)
})

test('手动重新添加保留快照字段、采用指定分类并清除排除与快照', async () => {
  const f = fixture(), original = await addNoted(f)
  await f.store.command({ type: 'unfollow', sessionId: 'a' })
  await f.store.command({ type: 'add', sessionIds: ['a', 'a'], columnId: 'waiting' }, f.allowed)
  const state = f.store.snapshot(), entry = state.entries.find(e => e.sessionId === 'a')!
  assert.deepEqual(entry, { ...original, columnId: 'waiting', updatedAt: entry.updatedAt, version: original.version + 1 })
  assert.ok(entry.updatedAt > original.updatedAt)
  assert.deepEqual(state.removedEntries, [])
  assert.deepEqual(state.excludedSessionIds, [])
  await assert.rejects(f.store.command({ type: 'note', sessionId: 'a', note: '旧草稿', expectedVersion: original.version }), { code: 'version_conflict' })
})

test('旧版仅排除记录兼容读取，恢复到默认分类空备注，保存后保留其他旧数据', async () => {
  const f = fixture()
  await addNoted(f)
  const { removedEntries: _, ...old } = f.store.snapshot()
  old.excludedSessionIds = ['d']
  const migrated = fixture(old)
  assert.deepEqual(migrated.store.snapshot(), { ...old, removedEntries: [] })
  assert.equal(migrated.writes(), 0)
  await migrated.store.command({ type: 'restore', sessionId: 'd' }, migrated.allowed)
  const state = migrated.store.snapshot()
  assert.deepEqual(state.entries.slice(0, 3), old.entries)
  assert.deepEqual(state.entries[3], { sessionId: 'd', columnId: 'focus', note: '', source: 'manual', addedAt: 100, updatedAt: 100, version: 1 })
  assert.deepEqual(new WatchStore(migrated.medium).snapshot(), state)
})

test('schema 拒绝重复快照、不在排除名单的快照、关注交叉和未来版本', async () => {
  const f = fixture()
  await addNoted(f)
  await f.store.command({ type: 'unfollow', sessionId: 'a' })
  const valid = f.store.snapshot(), removed = valid.removedEntries[0]
  for (const invalid of [
    { ...valid, removedEntries: [removed, removed] },
    { ...valid, excludedSessionIds: [] },
    { ...valid, entries: [...valid.entries, removed.entry] },
    { ...valid, schemaVersion: 2 },
    { ...valid, removedEntries: null },
  ]) {
    assert.equal(stateSchema.safeParse(invalid).success, false)
    assert.throws(() => new WatchStore({ get: () => invalid, set: async () => {} }))
  }
})

test('恢复拒绝未排除与不可用会话，原生服务仅查询目录', async () => {
  const f = fixture(), ids = ['archived', 'child', 'depth', 'incompatible', 'missing', 'ok']
  for (const sessionId of ids) await f.store.command({ type: 'unfollow', sessionId })
  let calls = 0
  const service = new WorkbenchService(f.store, {
    sessionQuery: { listSessions: async () => {
      calls++
      return [
        { header: { id: 'archived' } }, { header: { id: 'child', origin: 'subagent' } },
        { header: { id: 'depth', delegationDepth: 1 } }, { header: { id: 'incompatible' }, formatStatus: 'future' },
        { header: { id: 'ok' }, formatStatus: 'current' },
      ]
    } },
    workspaceRegistry: { archivedSessionIds: ['archived'] },
  })
  const before = service.read()
  for (const sessionId of ids.filter(id => id !== 'ok')) {
    await assert.rejects(service.mutate({ type: 'restore', sessionId }), { code: 'session_unavailable' })
    assert.deepEqual(service.read(), before)
  }
  await assert.rejects(service.mutate({ type: 'restore', sessionId: 'never-removed' }), { code: 'not_removed' })
  await service.mutate({ type: 'restore', sessionId: 'ok' })
  const reads = calls, restored = service.read()
  await service.mutate({ type: 'restore', sessionId: 'ok' })
  assert.deepEqual(service.read(), restored)
  assert.equal(calls, reads)
})

test('自动纳入事件不复活带快照和历史排除项', async () => {
  const f = fixture()
  await addNoted(f)
  await f.store.command({ type: 'settings', autoCollect: true })
  await f.store.command({ type: 'unfollow', sessionId: 'a' })
  await f.store.command({ type: 'unfollow', sessionId: 'd' })
  const before = f.store.snapshot()
  const service = new WorkbenchService(f.store, { sessionQuery: { listSessions: async () => [] }, workspaceRegistry: { archivedSessionIds: [] } })
  for (const id of ['a', 'd']) await service.onSessionEvent({ id, header: { id } }, { type: 'turn/start' })
  assert.deepEqual(f.store.snapshot(), before)
})

test('跨窗口取消恢复后拒绝旧备注版本，多次恢复版本持续递增', async () => {
  const f = fixture(), original = await addNoted(f)
  for (let index = 1; index <= 2; index++) {
    await f.store.command({ type: 'unfollow', sessionId: 'a' })
    await f.store.command({ type: 'restore', sessionId: 'a' }, f.allowed)
    assert.equal(f.store.snapshot().entries.find(e => e.sessionId === 'a')!.version, original.version + index)
  }
  await assert.rejects(f.store.command({ type: 'note', sessionId: 'a', note: '取消前打开的草稿', expectedVersion: original.version }), { code: 'version_conflict' })
  assert.equal(f.store.snapshot().entries.find(e => e.sessionId === 'a')!.note, original.note)
})

test('取消、恢复与手动重新加入保存失败均保持内存和持久数据原子性', async () => {
  const f = fixture()
  await addNoted(f)
  const active = f.store.snapshot()
  f.fail(true)
  await assert.rejects(f.store.command({ type: 'unfollow', sessionId: 'a' }), /模拟写入失败/)
  assert.deepEqual(f.store.snapshot(), active)
  assert.deepEqual(new WatchStore(f.medium).snapshot(), active)
  f.fail(false)
  await f.store.command({ type: 'unfollow', sessionId: 'a' })
  const removed = f.store.snapshot()
  f.fail(true)
  await assert.rejects(f.store.command({ type: 'restore', sessionId: 'a' }, f.allowed), /模拟写入失败/)
  await assert.rejects(f.store.command({ type: 'add', sessionIds: ['a'], columnId: 'waiting' }, f.allowed), /模拟写入失败/)
  assert.deepEqual(f.store.snapshot(), removed)
  assert.deepEqual(new WatchStore(f.medium).snapshot(), removed)
  f.fail(false)
  await f.store.command({ type: 'restore', sessionId: 'a' }, f.allowed)
  assert.equal(f.store.snapshot().removedEntries.length, 0)
})

test('原后继已删除或移到异列时恢复到原分类列尾', async () => {
  for (const change of ['unfollow', 'move'] as const) {
    const f = fixture()
    await addNoted(f)
    await f.store.command({ type: 'unfollow', sessionId: 'a' })
    await f.store.command(change === 'unfollow' ? { type: 'unfollow', sessionId: 'b' } : { type: 'move', sessionId: 'b', columnId: 'waiting' })
    await f.store.command({ type: 'restore', sessionId: 'a' }, f.allowed)
    assert.deepEqual(f.store.snapshot().entries.filter(e => e.columnId === 'later').map(e => e.sessionId), ['c', 'a'])
  }
})

test('domain 使用 schema 默认值兼容旧 global，未来数据打开失败并关闭句柄', async () => {
  const { removedEntries: _, ...old } = initialState()
  old.excludedSessionIds.push('a')
  let closed = 0
  const opened = await openWatchStore({ open: async (raw: unknown) => {
    const spec = raw as { name: string; version: number; global: { schema: typeof stateSchema } }
    assert.equal(spec.name, 'ppyang010_task_workbench')
    assert.equal(spec.version, 1)
    // 与已安装 storageDomain 一致：保存的 global 经过 schema.parse。
    return { global: { get: () => spec.global.schema.parse(old), set: async () => {} }, close: async () => { closed++ } }
  } })
  assert.deepEqual(opened.store.snapshot(), { ...old, removedEntries: [] })
  await opened.close()
  await assert.rejects(openWatchStore({ open: async () => ({ global: { get: () => ({ ...old, schemaVersion: 2 }), set: async () => {} }, close: async () => { closed++ } }) }))
  assert.equal(closed, 2)
})

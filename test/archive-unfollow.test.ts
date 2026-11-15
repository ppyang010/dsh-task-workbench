import test from 'node:test'
import assert from 'node:assert/strict'
import { WatchStore } from '../src/host/store.ts'
import { WorkbenchService } from '../src/host/service.ts'
import { initialState } from '../src/shared/model.ts'
import { watchArchived } from '../src/host/archive-watch.ts'

function fixture() {
  let data = initialState(); let fail = false; let writes = 0
  const registry = { archivedSessionIds: [] as string[] }
  const store = new WatchStore({ get: () => data, set: async next => { if (fail) throw new Error('存储失败'); data = next; writes++ } }, () => 100)
  const service = new WorkbenchService(store, { workspaceRegistry: registry, sessionQuery: { listSessions: async () => ['a', 'b'].map(id => ({ header: { id } })) } })
  return { registry, store, service, writes: () => writes, fail: (value: boolean) => { fail = value } }
}

test('已归档的存量关注被取消并保留备注、分类和快照，未关注归档项不写入排除', async () => {
  const f = fixture()
  await f.service.mutate({ type: 'add', sessionIds: ['a', 'b'], columnId: 'later' })
  await f.service.mutate({ type: 'note', sessionId: 'a', note: '保留说明', expectedVersion: 1 })
  f.registry.archivedSessionIds = ['a', 'never-followed']
  await f.service.reconcileArchived()
  const state = f.service.read()
  assert.deepEqual(state.entries.map(e => e.sessionId), ['b'])
  assert.deepEqual(state.excludedSessionIds, ['a'])
  assert.equal(state.removedEntries[0].entry.note, '保留说明')
  assert.equal(state.removedEntries[0].entry.columnId, 'later')
  assert.deepEqual(f.registry.archivedSessionIds, ['a', 'never-followed'])
  const count = f.writes(); await f.service.reconcileArchived(); assert.equal(f.writes(), count)
})

test('取消归档和开始新轮次均不复活，必须手动恢复关注', async () => {
  const f = fixture()
  await f.service.mutate({ type: 'add', sessionIds: ['a'], columnId: 'focus' })
  await f.service.mutate({ type: 'settings', autoCollect: true })
  f.registry.archivedSessionIds = ['a']; await f.service.reconcileArchived()
  await assert.rejects(f.service.mutate({ type: 'restore', sessionId: 'a' }))
  f.registry.archivedSessionIds = []; await f.service.reconcileArchived()
  await f.service.onSessionEvent({ id: 'a', header: { id: 'a' } }, { type: 'turn/start' })
  assert.equal(f.service.read().entries.length, 0)
  await f.service.mutate({ type: 'restore', sessionId: 'a' })
  assert.equal(f.service.read().entries[0].sessionId, 'a')
})

test('保存失败与目录未就绪不移除关注，恢复存储后可重试', async () => {
  const f = fixture(); await f.service.mutate({ type: 'add', sessionIds: ['a', 'b'], columnId: 'waiting' })
  const before = f.service.read(); f.registry.archivedSessionIds = ['a', 'b']; f.fail(true)
  await assert.rejects(f.service.reconcileArchived()); assert.deepEqual(f.service.read(), before)
  f.fail(false); await assert.rejects(f.store.reconcileArchived(() => { throw new Error('registry not started') }))
  assert.deepEqual(f.service.read(), before)
  await f.service.reconcileArchived(); assert.equal(f.service.read().entries.length, 0)
  assert.equal(f.service.read().removedEntries.length, 2)
})

test('队列执行时读取最新归档集合，取消归档先完成时不误移除', async () => {
  const f = fixture(); await f.service.mutate({ type: 'add', sessionIds: ['a'], columnId: 'focus' })
  f.registry.archivedSessionIds = ['a']
  const pending = f.service.reconcileArchived(); f.registry.archivedSessionIds = []
  await pending; assert.equal(f.service.read().entries.length, 1)
})

test('后台监视启动即同步，停止时等待在途同步并清理定时器', async () => {
  let calls = 0; let resolve!: () => void
  const stop = watchArchived({ reconcileArchived: () => { calls++; return new Promise<void>(done => { resolve = done }) } }, () => assert.fail('不应报错'))
  await Promise.resolve(); assert.equal(calls, 1)
  let finished = false; const closing = stop().then(() => { finished = true })
  await Promise.resolve(); assert.equal(finished, false)
  resolve(); await closing; assert.equal(finished, true)
})

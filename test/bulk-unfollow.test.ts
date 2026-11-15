import test from 'node:test'
import assert from 'node:assert/strict'
import { WatchStore } from '../src/host/store.ts'
import { initialState, commandSchema } from '../src/shared/model.ts'

function fixture() {
  let saved = initialState(); let writes = 0; let fail = false
  const store = new WatchStore({ get: () => saved, set: async next => { if (fail) throw new Error('保存失败'); saved = next; writes++ } }, () => 100)
  return { store, writes: () => writes, fail: () => { fail = true }, saved: () => saved }
}

test('批量取消只写一次，去重和跳过过期项，保留快照且可逐条恢复', async () => {
  const f = fixture()
  await f.store.command({ type: 'add', sessionIds: ['a', 'b', 'c'], columnId: 'focus' }, new Set(['a', 'b', 'c']))
  await f.store.command({ type: 'note', sessionId: 'a', note: '保留备注', expectedVersion: 1 })
  const count = f.writes()
  await f.store.command({ type: 'unfollowMany', sessionIds: ['a', 'b', 'a', 'not-followed'] })
  assert.equal(f.writes(), count + 1)
  assert.deepEqual(f.store.snapshot().entries.map(e => e.sessionId), ['c'])
  assert.deepEqual(f.store.snapshot().excludedSessionIds, ['a', 'b'])
  assert.equal(f.store.snapshot().removedEntries.length, 2)
  await f.store.command({ type: 'restore', sessionId: 'b' }, new Set(['a', 'b', 'c']))
  await f.store.command({ type: 'restore', sessionId: 'a' }, new Set(['a', 'b', 'c']))
  assert.deepEqual(f.store.snapshot().entries.map(e => e.sessionId), ['a', 'b', 'c'])
  assert.equal(f.store.snapshot().entries[0].note, '保留备注')
})

test('批量保存失败全部回滚，重试请求幂等且不覆盖取消快照', async () => {
  const f = fixture()
  await f.store.command({ type: 'add', sessionIds: ['a', 'b'], columnId: 'later' }, new Set(['a', 'b']))
  const before = f.store.snapshot(); f.fail()
  await assert.rejects(f.store.command({ type: 'unfollowMany', sessionIds: ['a', 'b'] }))
  assert.deepEqual(f.store.snapshot(), before); assert.deepEqual(f.saved(), before)
  const g = fixture()
  await g.store.command({ type: 'add', sessionIds: ['a'], columnId: 'waiting' }, new Set(['a']))
  await g.store.command({ type: 'unfollowMany', sessionIds: ['a'] })
  const removed = g.store.snapshot(); const writes = g.writes()
  await g.store.command({ type: 'unfollowMany', sessionIds: ['a'] })
  assert.deepEqual(g.store.snapshot(), removed); assert.equal(g.writes(), writes)
})

test('批量命令校验空集合、上限和非法ID，不接受未来字段', () => {
  for (const sessionIds of [[], Array(501).fill('a'), [' bad ']]) assert.equal(commandSchema.safeParse({ type: 'unfollowMany', sessionIds }).success, false)
  assert.equal(commandSchema.safeParse({ type: 'unfollowMany', sessionIds: ['a'], deleteSession: true }).success, false)
})

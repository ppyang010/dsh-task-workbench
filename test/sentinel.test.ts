import test from 'node:test'
import assert from 'node:assert/strict'
import { loadSentinelState, sortSentinelFires, watchKey } from '../src/client/sentinel.ts'

const watch = { id: 'watch-1', sessionId: 'a', kind: 'file', target: 'report.md', live: true, fireCount: 1 }

test('哨兵仅向同源状态端点发起只读请求，兼容无历史的响应', async () => {
  const signal = new AbortController().signal
  const state = await loadSentinelState(signal, async (path, init) => {
    assert.equal(path, '/plugins/dsh-sentinel/state')
    assert.equal(init?.method, 'GET')
    assert.equal(init?.credentials, 'same-origin')
    assert.equal(init?.signal, signal)
    return Response.json({ watches: [watch] })
  })
  assert.deepEqual(state, { watches: [watch], recentFires: [] })
})

test('哨兵区分不可用、权限不足和不兼容的响应', async () => {
  const signal = new AbortController().signal
  for (const [response, message] of [
    [new Response(null, { status: 404 }), /已启用/],
    [new Response(null, { status: 403 }), /权限/],
    [Response.json({ watches: [{ ...watch, live: 'false' }] }), /无法识别/],
  ] as const) {
    await assert.rejects(loadSentinelState(signal, async () => response), message)
  }
})

test('不同会话可使用相同的哨兵编号，近期触发按时间倒序展示', () => {
  const old = { sessionId: 'a', id: 'watch-1', at: '2026-11-18T10:00:00Z' }
  const recent = { ...old, sessionId: 'b', at: '2026-11-19T10:00:00Z' }
  assert.notEqual(watchKey(old), watchKey(recent))
  assert.deepEqual(sortSentinelFires([old, recent]), [recent, old])
})

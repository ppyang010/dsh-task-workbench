import test from 'node:test'
import assert from 'node:assert/strict'
import { GroupOrderController } from '../src/client/group-order-controller.ts'
import { GROUP_ORDER_RPC, initialGroupOrder } from '../src/shared/group-order.ts'

const request = { columnId: 'focus' as const, workspaceIds: ['A', 'B'], sourceId: 'B', beforeId: 'A', expectedOrderRevision: 0, expectedBoardRevision: 1 }
test('排序失败提示不会被后台刷新冲掉，可由用户关闭或重试', async () => {
  let fail = true
  const controller = new GroupOrderController({ call: async (_channel, endpoint, payload) => {
    assert.equal(endpoint.startsWith(`${GROUP_ORDER_RPC}/`), true)
    assert.ok(Object.hasOwn(payload as object, 'args'))
    if (endpoint.endsWith('/mutate') && fail) return { ok: true, value: { ok: false, error: { message: '模拟保存失败' } } }
    return { ok: true, value: { ok: true, value: initialGroupOrder() } }
  } })
  await controller.refresh(); assert.equal(controller.getSnapshot().loaded, true)
  assert.equal(await controller.reorder(request), false); assert.equal(controller.getSnapshot().error, '模拟保存失败')
  await controller.refresh(); assert.equal(controller.getSnapshot().error, '模拟保存失败')
  controller.clearError(); assert.equal(controller.getSnapshot().error, undefined)
  fail = false; assert.equal(await controller.reorder(request), true)
  controller.dispose()
})

test('慢速旧读取不会覆盖新排序结果', async () => {
  let slow = false; let entered!: () => void; let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const old = initialGroupOrder(); const newer = { ...initialGroupOrder(), revision: 1, columns: { focus: ['B', 'A'], waiting: [], later: [] } }
  const controller = new GroupOrderController({ call: async (_channel, endpoint) => {
    if (endpoint.endsWith('/mutate')) return { ok: true, value: { ok: true, value: newer } }
    if (slow) { entered(); await gate }
    return { ok: true, value: { ok: true, value: old } }
  } })
  await controller.refresh(); slow = true
  const refresh = controller.refresh(); await started
  assert.equal(await controller.reorder(request), true); release(); await refresh
  assert.deepEqual(controller.getSnapshot().data, newer)
  controller.dispose()
})

test('初次读取失败不影响关注看板，服务恢复后可启用排序', async () => {
  let online = false
  const controller = new GroupOrderController({ call: async () => online ? { ok: true, value: { ok: true, value: initialGroupOrder() } } : { ok: false } })
  await controller.refresh(); assert.equal(controller.getSnapshot().loaded, false); assert.match(controller.getSnapshot().error ?? '', /关注数据不受影响/)
  online = true; await controller.refresh()
  assert.equal(controller.getSnapshot().loaded, true); assert.equal(controller.getSnapshot().error, undefined)
  controller.dispose()
})

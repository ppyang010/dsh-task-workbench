import test from 'node:test'
import assert from 'node:assert/strict'
import { initialState, stateSchema } from '../src/shared/model.ts'
import { registerSessionCopy, sessionCopyText, type CopyMenus } from '../src/client/session-copy.tsx'

function setup(write: (text: string) => Promise<boolean> = async () => true) {
  let contribution!: Parameters<CopyMenus['register']>[0]
  const notices: unknown[] = []
  let removed = false
  const dispose = registerSessionCopy({ register: input => { contribution = input; return () => { removed = true } }, notify: (text, ok) => notices.push([text, ok]) }, write)
  return { contribution, notices, dispose, removed: () => removed }
}

test('注册独立菜单，不需要开关、控制器或 DOM，不覆盖原生菜单 ID', () => {
  const f = setup()
  assert.equal(f.contribution.target, 'session')
  assert.equal(f.contribution.order, 451)
  assert.notEqual(f.contribution.id, 'session.id')
  const actions = f.contribution.resolve({ sessionId: 'id', displayTitle: '名称' })
  assert.equal(actions.length, 1)
  assert.equal(actions[0].label, '复制名称和 ID')
  f.dispose(); assert.equal(f.removed(), true)
})

test('附带名称使用两行格式，空名仅复制ID，多行名整理为一行', () => {
  assert.equal(sessionCopyText('id', ' 会话名称 '), '会话名称\nid')
  assert.equal(sessionCopyText('id', ''), 'id')
  assert.equal(sessionCopyText('id', '名称\r\n换行'), '名称 换行\nid')
})

test('兼容历史开关数据但新菜单不读取开关', async () => {
  for (const enabled of [false, true]) {
    assert.equal(stateSchema.parse({ ...initialState(), settings: { autoCollect: false, copySessionName: enabled } }).settings.copySessionName, enabled)
    const writes: string[] = []
    const f = setup(async text => { writes.push(text); return true })
    await f.contribution.resolve({ sessionId: 'id', displayTitle: '名称' })[0].run()
    assert.deepEqual(writes, ['名称\nid'])
  }
  assert.equal(stateSchema.parse({ ...initialState(), settings: { autoCollect: true } }).settings.autoCollect, true)
})

test('复制捕获的右键目标，不受之后菜单目标变化影响', async () => {
  const writes: string[] = []
  const f = setup(async text => { writes.push(text); return true })
  const target = { sessionId: '右键ID', displayTitle: '右键会话' }
  const action = f.contribution.resolve(target)[0]
  target.sessionId = '其他ID'; target.displayTitle = '其他会话'
  await action.run()
  assert.deepEqual(writes, ['右键会话\n右键ID'])
  assert.deepEqual(f.notices, [['已复制会话名称和 Session ID', true]])
})

test('空名称降级为ID并明确提示', async () => {
  const writes: string[] = []
  const f = setup(async text => { writes.push(text); return true })
  await f.contribution.resolve({ sessionId: 'id' })[0].run()
  assert.deepEqual(writes, ['id'])
  assert.deepEqual(f.notices, [['已复制 Session ID（会话名称为空）', true]])
})

test('剪贴板失败和异常均不伪报成功，卸载后不写入或继续提示', async () => {
  for (const write of [async () => false, async () => { throw new Error('denied') }]) {
    const f = setup(write)
    await f.contribution.resolve({ sessionId: 'id' })[0].run()
    assert.deepEqual(f.notices, [['复制失败，请重试', false]])
  }
  let settle!: (ok: boolean) => void
  let calls = 0
  const f = setup(() => { calls++; return new Promise(resolve => { settle = resolve }) })
  const action = f.contribution.resolve({ sessionId: 'id' })[0]
  const pending = action.run(); f.dispose(); settle(true); await pending
  await action.run()
  assert.equal(calls, 1)
  assert.deepEqual(f.notices, [])
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { PANEL_ID } from '../src/shared/model.ts'
import { preserveArchivePanel } from '../src/client/archive-navigation.ts'
import { createRuntime } from '../src/client/runtime.ts'

function source<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }, set: (next: T) => { value = next; for (const fn of [...listeners]) fn() }, listeners }
}
function fixture() {
  const panelInfo = source<{ activePanelId: string | null }>({ activePanelId: PANEL_ID })
  const selection = source<{ sessionId?: string }>({ sessionId: 'current' })
  const list = source({ archivedSessionIds: [] as string[] })
  const restored: string[] = []
  const layout = { panelInfo, selectPanel: (id: string) => { restored.push(id); panelInfo.set({ activePanelId: id }) } }
  const nativeClear = () => { list.set({ archivedSessionIds: ['current'] }); selection.set({}); panelInfo.set({ activePanelId: null }) }
  return { layout, selection, list, restored, nativeClear }
}

test('原生清空已归档当前会话后保留工作台，但不恢复会话选择', () => {
  const f = fixture(); const release = preserveArchivePanel(f.layout, f.selection, f.list, 'current')
  f.nativeClear()
  assert.equal(f.layout.panelInfo.getSnapshot().activePanelId, PANEL_ID)
  assert.deepEqual(f.selection.getSnapshot(), {})
  assert.deepEqual(f.restored, [PANEL_ID])
  release(); assert.equal(f.layout.panelInfo.listeners.size, 0)
})

test('其他会话、其他面板、主动切换和非归档清空均不抢回工作台', () => {
  const other = fixture(); const r1 = preserveArchivePanel(other.layout, other.selection, other.list, 'other'); other.nativeClear(); assert.deepEqual(other.restored, []); r1()
  const panel = fixture(); panel.layout.panelInfo.set({ activePanelId: 'files' }); const r2 = preserveArchivePanel(panel.layout, panel.selection, panel.list, 'current'); panel.nativeClear(); assert.deepEqual(panel.restored, []); r2()
  const user = fixture(); const r3 = preserveArchivePanel(user.layout, user.selection, user.list, 'current'); user.layout.panelInfo.set({ activePanelId: 'files' }); user.nativeClear(); assert.deepEqual(user.restored, []); r3()
  const noArchive = fixture(); const r4 = preserveArchivePanel(noArchive.layout, noArchive.selection, noArchive.list, 'current'); noArchive.selection.set({}); noArchive.layout.panelInfo.set({ activePanelId: null }); assert.deepEqual(noArchive.restored, []); r4()
})

test('用户输入取消导航保护，释放时清理输入监听', () => {
  const handlers = new Map<string, EventListenerOrEventListenerObject>()
  const events = { addEventListener: (name: string, fn: EventListenerOrEventListenerObject) => handlers.set(name, fn), removeEventListener: (name: string) => handlers.delete(name) } as unknown as Document
  const f = fixture(); const release = preserveArchivePanel(f.layout, f.selection, f.list, 'current', events)
  ;(handlers.get('pointerdown') as (event: Event) => void)(new Event('pointerdown'))
  f.nativeClear(); assert.deepEqual(f.restored, [])
  release(); assert.equal(handlers.size, 0)
})

test('原生归档调用链等待完成且成功失败均清理保护', async () => {
  const f = fixture(); let fail = false
  const services: Record<string, any> = { layout: f.layout, uiWorkspace: { selection: f.selection }, workspaces: { list: f.list, archiveSession: async (_id: string, options: unknown) => {
    assert.deepEqual(options, { stopActivity: false })
    assert.equal(f.layout.panelInfo.listeners.size, 1)
    if (fail) throw new Error('归档失败')
    f.nativeClear()
  } } }
  const runtime = createRuntime({ get: name => services[name] })
  await runtime.archive!('current'); assert.equal(f.layout.panelInfo.getSnapshot().activePanelId, PANEL_ID); assert.equal(f.layout.panelInfo.listeners.size, 0)
  f.selection.set({ sessionId: 'current' }); f.list.set({ archivedSessionIds: [] }); fail = true
  await assert.rejects(runtime.archive!('current'), /归档失败/)
  assert.equal(f.layout.panelInfo.listeners.size, 0)
})

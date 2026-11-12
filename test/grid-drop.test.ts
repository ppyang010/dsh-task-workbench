import test from 'node:test'
import assert from 'node:assert/strict'
import { afterSessionId, getBoardRows, locateDropTarget, type CardBox } from '../src/client/ui/board-helpers.ts'
import { initialState, type ClientState } from '../src/shared/model.ts'

const box = (sessionId: string, left: number, top: number, height = 120): CardBox => ({ sessionId, left, top, right: left + 200, bottom: top + height })
const grid = [box('a', 0, 0), box('b', 212, 0), box('c', 424, 0), box('d', 0, 132), box('e', 212, 132)]

test('单列按上下半区插入，不因指针左右移动而改变位置', () => {
  const list = [box('a', 0, 0), box('b', 0, 132)]
  assert.deepEqual(locateDropTarget(list, 180, 10), { sessionId: 'a', edge: 'before' })
  assert.deepEqual(locateDropTarget(list, 10, 110), { sessionId: 'a', edge: 'after' })
  assert.deepEqual(locateDropTarget(list, 180, 140), { sessionId: 'b', edge: 'before' })
})
test('同一行并排卡片按左右半区定位，而非沿用上下半区', () => {
  assert.deepEqual(locateDropTarget(grid, 30, 110, 'grid'), { sessionId: 'a', edge: 'before' })
  assert.deepEqual(locateDropTarget(grid, 180, 10, 'grid'), { sessionId: 'a', edge: 'after' })
  assert.deepEqual(locateDropTarget(grid, 230, 110, 'grid'), { sessionId: 'b', edge: 'before' })
  assert.deepEqual(locateDropTarget(grid, 600, 10, 'grid'), { sessionId: 'c', edge: 'after' })
})
test('网格末行不足整行时仍按横向插入；目标列只有一张卡也适用', () => {
  assert.deepEqual(locateDropTarget(grid, 20, 230, 'grid'), { sessionId: 'd', edge: 'before' })
  assert.deepEqual(locateDropTarget(grid, 400, 140, 'grid'), { sessionId: 'e', edge: 'after' })
  assert.deepEqual(locateDropTarget([box('a', 0, 0)], 180, 10, 'grid'), { sessionId: 'a', edge: 'after' })
})
test('展开长备注造成不同卡高时，先定位到所在行再判断横向位置', () => {
  const uneven = [box('a', 0, 0, 260), box('b', 212, 0, 120), box('c', 0, 272), box('d', 212, 272)]
  assert.deepEqual(locateDropTarget(uneven, 240, 210, 'grid'), { sessionId: 'b', edge: 'before' })
  assert.deepEqual(locateDropTarget(uneven, 240, 290, 'grid'), { sessionId: 'd', edge: 'before' })
})
test('卡片间距和行间空隙也能稳定定位', () => {
  assert.deepEqual(locateDropTarget(grid, 205, 40, 'grid'), { sessionId: 'a', edge: 'after' })
  assert.deepEqual(locateDropTarget(grid, 220, 130, 'grid'), { sessionId: 'e', edge: 'before' })
})
test('整个网格上方和下方分别指向第一张之前和最后一张之后', () => {
  assert.deepEqual(locateDropTarget(grid, 600, -30, 'grid'), { sessionId: 'a', edge: 'before' })
  assert.deepEqual(locateDropTarget(grid, 0, 400, 'grid'), { sessionId: 'e', edge: 'after' })
})
test('空列与隐藏的折叠内容不生成虚假卡片目标', () => {
  assert.equal(locateDropTarget([], 50, 50, 'grid'), undefined)
  assert.equal(locateDropTarget([{ sessionId: 'hidden', left: 0, top: 0, right: 0, bottom: 0 }], 50, 50, 'grid'), undefined)
})
test('二维拖拽转换成服务端锚点时，保留筛选隐藏卡片的顺序', () => {
  const state: ClientState = { board: { ...initialState(), entries: ['a', 'hidden', 'b', 'dragged'].map(sessionId => ({ sessionId, columnId: 'focus', note: '', source: 'manual', addedAt: 1, updatedAt: 1, version: 1 })) }, sessions: [], connected: true, runtimeReady: true, loading: false, saving: false }
  const target = locateDropTarget([box('a', 0, 0), box('b', 212, 0)], 180, 20, 'grid')!
  assert.equal(target.edge, 'after')
  assert.equal(afterSessionId(getBoardRows(state), target.sessionId, 'dragged'), 'hidden')
})
test('几何定位不原地改变传入列表', () => {
  const reversed = [...grid].reverse(), original = structuredClone(reversed)
  locateDropTarget(reversed, 300, 160, 'grid')
  assert.deepEqual(reversed, original)
})

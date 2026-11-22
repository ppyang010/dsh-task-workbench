import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { createElement, type ReactElement } from 'react'
import { IdeaEditor, FolderEditor } from './IdeaEditors.tsx'
import type { Idea, IdeaValues } from '../../shared/ideas.ts'

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (element: ReactElement) => string }
const values: IdeaValues = { title: '我的草稿', content: '正文草稿', kind: 'spark', tags: [], folderIds: ['11111111-1111-4111-8111-111111111111'], sessionIds: [] }
const latest: Idea = { id: '22222222-2222-4222-8222-222222222222', title: '<最新标题>', content: '<script>不要执行</script>', kind: 'project', tags: ['标签'], folderIds: [], sessionIds: [], version: 2, createdAt: 1, updatedAt: 2, trashedAt: null }

test('点子编辑显示丢失文件夹修复和冲突内容，并安全转义', () => {
  const html = renderToStaticMarkup(createElement(IdeaEditor, { initial: values, folders: [], sessions: [], busy: false, disabled: false, latest, onRebase() {}, onSave: async () => true, onClose() {} }))
  assert.match(html, /关联的文件夹已删除/); assert.match(html, /从当前草稿移除/)
  assert.match(html, /保留草稿，使用最新版本/); assert.match(html, /&lt;最新标题&gt;/)
  assert.match(html, /&lt;script&gt;不要执行&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/)
})

test('文件夹编辑冲突展示最新信息和显式重试入口', () => {
  const html = renderToStaticMarkup(createElement(FolderEditor, { initial: { title: '我的草稿', summary: '' }, latest: { id: latest.id, title: '最新名称', summary: '最新摘要', version: 2, createdAt: 1, updatedAt: 2 }, onRebase() {}, busy: false, disabled: false, onSave: async () => true, onClose() {} }))
  assert.match(html, /最新名称/); assert.match(html, /最新摘要/); assert.match(html, /保留草稿，使用最新版本/)
})

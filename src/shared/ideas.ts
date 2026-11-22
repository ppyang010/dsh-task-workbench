import { z } from 'zod'
import { sessionIdSchema } from './model.ts'

export const IDEAS_DOMAIN = 'ppyang010_task_workbench_ideas'
export const IDEAS_RPC = 'ppyangTaskWorkbenchIdeas'
export const IDEA_KINDS = [
  { id: 'project', label: '项目点子' },
  { id: 'skill', label: '技能点子' },
  { id: 'plugin', label: '插件点子' },
  { id: 'spark', label: '突发奇想' },
  { id: 'random', label: '其他点子' },
] as const
export const ideaKindSchema = z.enum(['project', 'skill', 'plugin', 'spark', 'random'])
const idSchema = z.uuid()
const titleSchema = z.string().trim().min(1, '标题不能为空').max(200)
const tagSchema = z.string().trim().min(1).max(40)
const tagsSchema = z.array(tagSchema).max(20).refine(items => new Set(items).size === items.length, '标签不能重复')
const folderIdsSchema = z.array(idSchema).max(50).refine(items => new Set(items).size === items.length, '文件夹不能重复')
const sessionIdsSchema = z.array(sessionIdSchema).max(20).refine(items => new Set(items).size === items.length, '关联会话不能重复')
export const ideaValuesSchema = z.object({
  title: titleSchema,
  content: z.string().max(40000),
  kind: ideaKindSchema,
  tags: tagsSchema,
  folderIds: folderIdsSchema,
  sessionIds: sessionIdsSchema,
}).strict()
export const folderValuesSchema = z.object({ title: titleSchema, summary: z.string().max(10000) }).strict()
export const ideaSchema = ideaValuesSchema.extend({
  id: idSchema, version: z.number().int().positive(), createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(), trashedAt: z.number().finite().nonnegative().nullable(),
}).strict()
export const ideaFolderSchema = folderValuesSchema.extend({
  id: idSchema, version: z.number().int().positive(), createdAt: z.number().finite().nonnegative(), updatedAt: z.number().finite().nonnegative(),
}).strict()
export const ideasStateSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative(),
  ideas: z.array(ideaSchema).max(10000), folders: z.array(ideaFolderSchema).max(1000),
}).strict().superRefine((state, ctx) => {
  const ideas = new Set<string>(); const folders = new Set<string>()
  for (const folder of state.folders) {
    if (folders.has(folder.id)) ctx.addIssue({ code: 'custom', message: '文件夹 ID 不能重复' })
    folders.add(folder.id)
  }
  for (const idea of state.ideas) {
    if (ideas.has(idea.id)) ctx.addIssue({ code: 'custom', message: '点子 ID 不能重复' })
    ideas.add(idea.id)
    if (idea.folderIds.some(id => !folders.has(id))) ctx.addIssue({ code: 'custom', message: '点子引用的文件夹不存在' })
  }
})
export type Idea = z.infer<typeof ideaSchema>
export type IdeaValues = z.infer<typeof ideaValuesSchema>
export type IdeaFolder = z.infer<typeof ideaFolderSchema>
export type FolderValues = z.infer<typeof folderValuesSchema>
export type IdeasState = z.infer<typeof ideasStateSchema>
export const initialIdeasState = (): IdeasState => ({ schemaVersion: 1, revision: 0, ideas: [], folders: [] })
export const ideaCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('createIdea'), id: idSchema, value: ideaValuesSchema }).strict(),
  z.object({ type: z.literal('updateIdea'), id: idSchema, expectedVersion: z.number().int().positive(), value: ideaValuesSchema }).strict(),
  z.object({ type: z.literal('trashIdea'), id: idSchema, expectedVersion: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('restoreIdea'), id: idSchema, expectedVersion: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('createFolder'), id: idSchema, value: folderValuesSchema }).strict(),
  z.object({ type: z.literal('updateFolder'), id: idSchema, expectedVersion: z.number().int().positive(), value: folderValuesSchema }).strict(),
  z.object({ type: z.literal('deleteFolder'), id: idSchema, expectedVersion: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('mergeFolder'), sourceId: idSchema, targetId: idSchema, expectedSourceVersion: z.number().int().positive(), expectedTargetVersion: z.number().int().positive() }).strict(),
])
export type IdeaCommand = z.infer<typeof ideaCommandSchema>
export interface IdeasClientState { data: IdeasState; loaded: boolean; loading: boolean; saving: boolean; error?: string }
export interface IdeasControllerFace {
  subscribe(listener: () => void): () => void
  getSnapshot(): IdeasClientState
  refresh(): Promise<void>
  command(command: IdeaCommand): Promise<boolean>
  clearError(): void
}

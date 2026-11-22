import { z } from 'zod'
import { columnSchema, type ColumnId } from './model.ts'

export const GROUP_ORDER_DOMAIN = 'ppyang010_task_workbench_group_order'
export const GROUP_ORDER_RPC = 'ppyangTaskWorkbenchGroupOrder'
const workspaceIdSchema = z.string().min(1).max(300).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), '工作区 ID 无效')
const idsSchema = z.array(workspaceIdSchema).max(20000).refine(ids => new Set(ids).size === ids.length, '工作区不能重复')
export const groupOrderStateSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative(),
  columns: z.object({ focus: idsSchema, waiting: idsSchema, later: idsSchema }).strict(),
}).strict()
export type GroupOrderState = z.infer<typeof groupOrderStateSchema>
export const initialGroupOrder = (): GroupOrderState => ({ schemaVersion: 1, revision: 0, columns: { focus: [], waiting: [], later: [] } })
export const groupOrderCommandSchema = z.object({
  columnId: columnSchema, workspaceIds: idsSchema.refine(ids => ids.length > 0), sourceId: workspaceIdSchema,
  beforeId: workspaceIdSchema.optional(), expectedOrderRevision: z.number().int().nonnegative(), expectedBoardRevision: z.number().int().nonnegative(),
}).strict().superRefine((command, ctx) => {
  if (!command.workspaceIds.includes(command.sourceId)) ctx.addIssue({ code: 'custom', message: '源分组不在当前列表中' })
  if (command.beforeId && !command.workspaceIds.includes(command.beforeId)) ctx.addIssue({ code: 'custom', message: '目标分组不在当前列表中' })
})
export type GroupOrderCommand = z.infer<typeof groupOrderCommandSchema>
export interface GroupOrderClientState { data: GroupOrderState; loaded: boolean; loading: boolean; saving: boolean; error?: string }
export interface GroupOrderControllerFace {
  subscribe(listener: () => void): () => void
  getSnapshot(): GroupOrderClientState
  refresh(): Promise<void>
  reorder(request: GroupOrderCommand): Promise<boolean>
  clearError(): void
}
export interface GroupDragSnapshot {
  columnId: ColumnId
  sourceId: string
  workspaceIds: string[]
  expectedOrderRevision: number
  expectedBoardRevision: number
}

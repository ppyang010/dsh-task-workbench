import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { GROUP_ORDER_RPC } from '../shared/group-order.ts'
import type { GroupOrderStore } from './group-order-store.ts'
import { WorkbenchError, type WatchStore } from './store.ts'

type Registry = { get?(id: string): { sessionIds: readonly string[] } | undefined }
export interface GroupOrderServices { order: GroupOrderStore; watch: WatchStore; registry: Registry }

/** 只写独立的分组顺序域；不提供整组跨分类操作。 */
export class GroupOrderRemote extends TypertRemoteService {
  constructor(ctx: any, private ready: Promise<GroupOrderServices>) { super(ctx, GROUP_ORDER_RPC) }
  @Remote('read')
  async read() { return this.respond(async () => (await this.ready).order.snapshot()) }
  @Remote('mutate')
  async mutate(request: unknown) { return this.respond(async () => {
    const services = await this.ready
    if (typeof services.registry.get !== 'function') throw new WorkbenchError('unsupported', '当前宿主无法校验工作区，暂不能调整分组顺序')
    return services.order.reorder(request, {
      board: () => services.watch.snapshot(),
      members: id => services.registry.get?.(id)?.sessionIds,
    })
  }) }
  private async respond(operation: () => Promise<unknown>) {
    try { return { ok: true, value: await operation() } }
    catch (error) {
      if (error instanceof WorkbenchError) return { ok: false, error: { code: error.code, message: error.message } }
      this.ctx.logger?.warn('工作区分组顺序暂不可用，请检查独立存储')
      return { ok: false, error: { code: 'unavailable', message: '分组顺序保存状态不明，请先刷新核对；关注和分类未改变' } }
    }
  }
}

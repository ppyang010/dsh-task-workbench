import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { RPC_NAMESPACE } from '../shared/model.ts'
import { openWatchStore, WorkbenchError } from './store.ts'
import { WorkbenchService, type HostServices } from './service.ts'

export const name = 'ppyang010-task-workbench'
export const inject = ['storageDomain', 'sessionQuery', 'workspaceRegistry']

/** 使用宿主的认证 RPC 通道；不注册额外 HTTP 路由或模型工具。 */
class WorkbenchRemote extends TypertRemoteService {
  constructor(ctx: any, private ready: Promise<WorkbenchService>) { super(ctx, RPC_NAMESPACE) }
  @Remote('read')
  async read() { return this.respond(async () => (await this.ready).read()) }
  @Remote('mutate')
  async mutate(request: unknown) { return this.respond(async () => (await this.ready).mutate(request)) }
  private async respond(operation: () => Promise<unknown>) {
    try { return { ok: true, value: await operation() } }
    catch (error) {
      if (error instanceof WorkbenchError) return { ok: false, error: { code: error.code, message: error.message } }
      this.ctx.logger?.warn('关注数据暂不可用，请检查存储与会话目录服务')
      return { ok: false, error: { code: 'unavailable', message: '关注数据暂不可用，已保留原记录，请稍后重试' } }
    }
  }
}
export function apply(ctx: any): void {
  const opened = openWatchStore(ctx.get('storageDomain'))
  const ready = opened.then(({ store }) => new WorkbenchService(store, {
    sessionQuery: ctx.get('sessionQuery'), workspaceRegistry: ctx.get('workspaceRegistry'),
  } as HostServices))
  void ready.catch(() => { ctx.logger?.warn('我的关注初始化失败，未重置已有数据') })
  ctx.plugin(WorkbenchRemote, ready)
  ctx.on('session/event', (session: any, event: any) => {
    // 只观察新一轮开始，不监听历史回放，也不改变会话本身。
    if (event.type !== 'turn/start') return
    void ready.then(service => service.onSessionEvent(session, event)).catch(() => { ctx.logger?.warn('自动纳入暂未保存，请检查关注存储') })
  })
  ctx.effect(() => async () => {
    try { await (await opened).close() } catch { /* 已记录初始化失败，不覆盖原有数据。 */ }
  })
}

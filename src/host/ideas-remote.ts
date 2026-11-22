import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { IDEAS_RPC } from '../shared/ideas.ts'
import { WorkbenchError } from './store.ts'
import type { IdeasStore } from './ideas-store.ts'

/** 同一宿主的认证 RPC，不读取旧工作台、不开放新的网络监听。 */
export class IdeasRemote extends TypertRemoteService {
  constructor(ctx: any, private ready: Promise<IdeasStore>) { super(ctx, IDEAS_RPC) }
  @Remote('read')
  async read() { return this.respond(async () => (await this.ready).snapshot()) }
  @Remote('mutate')
  async mutate(request: unknown) { return this.respond(async () => (await this.ready).command(request)) }
  private async respond(operation: () => Promise<unknown>) {
    try { return { ok: true, value: await operation() } }
    catch (error) {
      if (error instanceof WorkbenchError) return { ok: false, error: { code: error.code, message: error.message } }
      this.ctx.logger?.warn('点子数据暂不可用，请检查独立存储')
      return { ok: false, error: { code: 'unavailable', message: '点子数据暂不可用，已保留原记录，请稍后重试' } }
    }
  }
}

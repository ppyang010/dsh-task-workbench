import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { watchArchived } from './archive-watch.ts'
import { RPC_NAMESPACE } from '../shared/model.ts'
import { installDefaultModelLock } from './default-model-lock.ts'
import { openWatchStore, WorkbenchError } from './store.ts'
import { WorkbenchService, type HostServices } from './service.ts'
import { openIdeasStore } from './ideas-store.ts'
import { IdeasRemote } from './ideas-remote.ts'
import { createIdeaCaptureTool, IDEA_CAPTURE_GUIDANCE } from './idea-capture-tool.ts'
import { openGroupOrderStore } from './group-order-store.ts'
import { GroupOrderRemote } from './group-order-remote.ts'
import { isSidechat } from '../shared/sidechat.ts'

export const name = 'ppyang010-task-workbench'
export const inject = ['storageDomain', 'sessionQuery', 'workspaceRegistry']

/** 关注数据通过宿主认证 RPC 通道访问，不注册额外 HTTP 路由。 */
class WorkbenchRemote extends TypertRemoteService {
  constructor(ctx: any, private ready: Promise<WorkbenchService>) { super(ctx, RPC_NAMESPACE) }
  @Remote('read')
  async read() { return this.respond(async () => {
    const service = await this.ready
    await service.reconcileArchived()
    return service.read()
  }) }
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
  let validateDefaultModel: HostServices['validateDefaultModel']
  ctx.inject(['agentDefaultModel', 'llm'], (modelCtx: any) => {
    modelCtx.effect(async () => {
      const { store } = await opened
      try {
        const dispose = installDefaultModelLock(modelCtx.get('agentDefaultModel'), () => store.lockedModelSelection)
        validateDefaultModel = async selection => {
          const llm = modelCtx.get('llm')
          try { await llm.resolveCallConfig(selection) }
          catch { throw new WorkbenchError('model_unavailable', '所选模型或推理强度当前不可用，请检查模型提供方配置') }
        }
        return () => { validateDefaultModel = undefined; dispose() }
      } catch {
        ctx.logger?.warn('宿主默认模型接口不可用，工作台未接入默认模型锁定')
      }
    }, 'task-workbench: default model lock')
  })
  const ready = opened.then(({ store }) => new WorkbenchService(store, {
    sessionQuery: ctx.get('sessionQuery'), workspaceRegistry: ctx.get('workspaceRegistry'),
    validateDefaultModel: async selection => {
      if (!validateDefaultModel) throw new WorkbenchError('unavailable', '当前 DSH 未提供默认模型锁定所需的服务')
      await validateDefaultModel(selection)
    },
  } as HostServices))
  void ready.catch(() => { ctx.logger?.warn('我的关注初始化失败，未重置已有数据') })
  ctx.plugin(WorkbenchRemote, ready)
  const openedIdeas = openIdeasStore(ctx.get('storageDomain'))
  const ideasReady = openedIdeas.then(({ store }) => store)
  void ideasReady.catch(() => { ctx.logger?.warn('独立点子库初始化失败，未重置已有数据') })
  ctx.plugin(IdeasRemote, ideasReady)
  const openedGroupOrder = openGroupOrderStore(ctx.get('storageDomain'))
  const groupOrderReady = Promise.all([openedGroupOrder, opened]).then(([order, watch]) => ({ order: order.store, watch: watch.store, registry: ctx.get('workspaceRegistry') }))
  void groupOrderReady.catch(() => { ctx.logger?.warn('分组顺序存储初始化失败，原有关注数据未改变') })
  ctx.plugin(GroupOrderRemote, groupOrderReady)
  ctx.on('session/event', (session: any, event: any) => {
    // 只观察新一轮开始，不监听历史回放，也不改变会话本身。
    if (event.type !== 'turn/start') return
    void ready.then(service => service.onSessionEvent(session, event)).catch(() => { ctx.logger?.warn('自动纳入暂未保存，请检查关注存储') })
  })
  let stopped = false
  let stopWatching: (() => Promise<void>) | undefined
  void ready.then(service => {
    if (!stopped) stopWatching = watchArchived(service, () => { ctx.logger?.warn('归档自动取消关注暂未保存，将在下次同步重试') })
  }).catch(() => { /* 初始化错误由 ready 统一记录。 */ })
  ctx.effect(() => async () => {
    stopped = true
    await stopWatching?.()
    try { await (await openedGroupOrder).close() } catch { /* 分组顺序初始化失败，不覆盖其他数据。 */ }
    try { await (await openedIdeas).close() } catch { /* 独立点子库初始化失败，不覆盖原数据。 */ }
    try { await (await opened).close() } catch { /* 已记录初始化失败，不覆盖原有数据。 */ }
  })
  // 工具和提示服务是可选能力；缺少时不阻断已有工作台。子 fiber 卸载时先注销工具，再关闭点子域。
  ctx.inject(['tools'], (toolCtx: any) => {
    toolCtx.effect(() => toolCtx.get('tools').register(createIdeaCaptureTool(ideasReady)), 'task-workbench: save-idea tool')
    toolCtx.inject(['systemPrompt'], (promptCtx: any) => {
      promptCtx.effect(() => promptCtx.get('systemPrompt').section({ name: 'plugin:task-workbench-ideas', order: 500, text: IDEA_CAPTURE_GUIDANCE }), 'task-workbench: idea guidance')
      promptCtx.inject(['sessionTitle'], (titleCtx: any) => {
        titleCtx.effect(() => titleCtx.get('systemPrompt').section({
          name: 'plugin:task-workbench-sidechat-knowledge',
          order: 501,
          text: ({ agent }: { agent?: { session?: { header: { origin?: string; parentSession?: string } } } }) => {
            const session = agent?.session
            const header = session?.header
            if (!session || header?.origin !== 'subagent' || !header.parentSession) return ''
            const title = titleCtx.get('sessionTitle').get(session)
            if (title?.source.kind !== 'user' || !isSidechat(header.origin, header.parentSession, title.title)) return ''
            return '当前是侧聊。按现有流程调用 workbench_submit_knowledge 提交知识草稿时，在 tags 中保留一项「来自侧聊」（已有则不重复，标签总数最多 20 项）。这只是来源标识，继续等待用户在知识库确认入库。'
          },
        }), 'task-workbench: sidechat knowledge guidance')
      })
    })
  })
}

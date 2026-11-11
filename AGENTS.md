# 工程约定

- 此工程是独立 DSH 插件，第一版只做「我的关注」。不用任务执行、认领、验收来模拟关注关系。
- 仓库中的源码、注释、文档与测试说明使用简体中文。
- 会话的分类只由手动操作改变；运行状态订阅不改分类。自动纳入默认关闭。
- 不调用创建、恢复运行、发送消息、停止、移动工作区、归档或删除会话的接口。唯一会话写侧能力是 DSH 原生 UI 导航，非模型调用。
- 用户关注、排除名单与设置写入独立 storageDomain；聊天正文、凭据与本机绝对路径不进入仓库。
- 客户端通过 DSH 官方 module loader 复用 React，禁止把第二份 React 打进插件。
- Host Remote 方法参数名是 RPC 契约，构建不能改名或压缩；每个请求仍需服务端 schema 校验。
- 修改后运行 pnpm run typecheck、pnpm test、pnpm run build、pnpm run pack:check。真实 DSH 操作验证与 mock 验证必须分开记录。
- .planning 与 .artifacts 仅本机使用，不推送公开仓库。

/** 宿主归档集合没有变更订阅，轻量定时核对；关闭面板后仍有效。 */
export function watchArchived(service: { reconcileArchived(): Promise<void> }, onError: () => void, intervalMs = 2000): () => Promise<void> {
  let stopped = false
  let pending: Promise<void> | undefined
  const run = () => {
    if (stopped || pending) return
    pending = Promise.resolve().then(() => service.reconcileArchived()).catch(() => { if (!stopped) onError() }).finally(() => { pending = undefined })
  }
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  run()
  return async () => { stopped = true; clearInterval(timer); await pending }
}

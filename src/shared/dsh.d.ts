declare module '@deepseek-ai/dsh-typert-protocol' {
  export class TypertRemoteService {
    constructor(ctx: any, serviceKey: string, options?: { namespace?: string })
    ctx: any
  }
  export function Remote(name: string): (method: any, context: ClassMethodDecoratorContext) => void
}

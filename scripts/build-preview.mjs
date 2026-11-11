import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
const root = new URL('../', import.meta.url)
const output = new URL('.artifacts/preview/', root)
await mkdir(output, { recursive: true })
const built = await build({ entryPoints: [new URL('examples/preview.tsx', root).pathname], bundle: true, platform: 'browser', target: 'es2022', format: 'iife', jsx: 'automatic', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, write: false, minify: false })
const script = built.outputFiles[0].text.replaceAll('</script', '<\\/script')
await writeFile(new URL('index.html', output), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'"><title>我的关注 · 首版组件验证</title><style>body{margin:0;background:#f6f7f3}#app{height:calc(100vh - 44px);min-height:640px}button{cursor:pointer}</style></head><body><div id="app"></div><script>${script}</script></body></html>`)
console.log('生产组件的离线合成会话验证页已生成：.artifacts/preview/index.html')

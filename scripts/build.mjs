import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const root = new URL('../', import.meta.url)
const output = new URL('lib/', root)
await mkdir(output, { recursive: true })
await build({ entryPoints: [new URL('src/host/index.ts', root).pathname], outfile: new URL('index.js', output).pathname, bundle: true, platform: 'node', target: 'node22', format: 'esm', external: ['@deepseek-ai/*', 'zod'], minify: false, keepNames: true, legalComments: 'none' })
const client = await build({ entryPoints: [new URL('src/client/index.tsx', root).pathname], bundle: true, platform: 'browser', target: 'es2022', format: 'cjs', external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'], loader: { '.css': 'text' }, jsx: 'automatic', write: false, minify: false, legalComments: 'none' })
const source = client.outputFiles[0].text
// 官方 module loader 提供 React；插件不生成第二份 React 实例。
await writeFile(new URL('client.js', output), `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${source}\nreturn module.exports;}});\n`)
console.log('构建完成：宿主 ESM 与官方加载器客户端。')

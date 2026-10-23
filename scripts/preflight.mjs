// 安装前预检：把 dsh-client-modules 会检查的东西先自己查一遍。
//
//   node scripts/preflight.mjs
//
// 检查项：
//   1. package.json 的 dsh.client 与 exports["./client"] 是否配套
//   2. exports 里声明的每个文件是否真的存在
//   3. Host 入口能否被 Node 加载
//   4. 引用的官方包是否都写在 peerDependencies / dependencies 里
//
// 这些错一旦装进 profile，DSH 会启动失败（required plugin did not activate），
// 而且不会自动回滚 —— 所以必须在安装之前挡住。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []
const notes = []

const fail = (msg) => failures.push(msg)
const ok = (msg) => notes.push(`  ok    ${msg}`)

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// ── 1. client 声明必须配套（照抄 dsh-client-modules 的判定） ──
//
// 官方实现（dsh-client-modules/lib/index.js）：
//   parseDshClient   dsh.client 必须是对象，platform 必须是字符串
//   clientExportOf   exports["./client"] 必须是字符串，或是带字符串 default 的对象
//   initialBundleSnapshot  该文件必须真实存在，否则抛 MissingClientBundleError
//
// 任何一条不满足，client-modules（required 插件）启动失败，整个 DSH 起不来。
const clientDecl = pkg.dsh?.client
const declaresClient = clientDecl !== undefined

if (declaresClient) {
  if (typeof clientDecl !== 'object' || clientDecl === null) {
    fail('dsh.client 必须是对象')
  } else if (typeof clientDecl.platform !== 'string') {
    fail('dsh.client.platform 必须是字符串')
  } else {
    ok(`dsh.client 声明合法，platform=${clientDecl.platform}`)
  }
}

const clientExport = pkg.exports?.['./client']
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  if (typeof value !== 'string' || value.includes('*')) continue
  if (existsSync(join(ROOT, value))) ok(`exports["${key}"] -> ${value} 存在`)
  else fail(`exports["${key}"] 指向 ${value}，但文件不存在`)
}

if (declaresClient) {
  if (clientExport === undefined) {
    fail('声明了 dsh.client，但 exports 里没有 "./client" —— DSH 启动会直接失败')
  } else if (typeof clientExport === 'string') {
    ok(`exports["./client"] = ${clientExport}`)
    const clientAbs = join(ROOT, clientExport)
    if (!existsSync(clientAbs)) fail(`exports["./client"] 指向 ${clientExport}，但文件不存在`)
  } else if (typeof clientExport === 'object' && typeof clientExport?.default === 'string') {
    ok(`exports["./client"].default = ${clientExport.default}`)
  } else {
    fail('exports["./client"] 必须是字符串，或带字符串 default 的对象')
  }
} else {
  ok('未声明 dsh.client（纯 Host 插件）')
}

// ── 3. Host 入口能加载 ─────────────────────────────────────
const entry = join(ROOT, 'lib', 'index.js')
if (!existsSync(entry)) {
  fail('lib/index.js 不存在，先跑 npm run build')
} else {
  try {
    const mod = await import(pathToFileURL(entry).href)
    const missing = ['name', 'apply'].filter((k) => mod[k] === undefined)
    if (missing.length > 0) fail(`lib/index.js 缺少导出：${missing.join(', ')}`)
    else ok(`lib/index.js 可加载，导出 ${Object.keys(mod).join(', ')}`)
  } catch (error) {
    fail(`lib/index.js 加载失败：${error.message}`)
  }
}

// ── 4. client bundle 必须是合法 classic script ───────────────
//
// 页面把所有 client bundle 拼成一段 classic script 加载。只要有一个 bundle
// 带 `export`/`import`，全组都编译不过，DSH 直接拒绝启动（required plugin
// did not activate）。这个错装进 profile 之后不会自动回滚。
const clientPath = join(ROOT, 'lib', 'client.js')
if (declaresClient) {
  if (!existsSync(clientPath)) {
    fail('声明了 dsh.client，但 lib/client.js 不存在')
  } else {
    const text = readFileSync(clientPath, 'utf8')
    if (/^\s*(export|import)\s/m.test(text)) {
      fail('lib/client.js 含 export/import —— classic script 里是语法错误，会让 DSH 起不来')
    } else {
      ok('lib/client.js 无 export/import（合法 classic script）')
    }
    if (!text.includes('__ModuleLoader__')) {
      fail('lib/client.js 没有 window.__ModuleLoader__.load 注册，加载后不会生效')
    } else {
      ok('lib/client.js 通过 __ModuleLoader__ 注册')
    }
  }
}

// ── 5. 用到的官方包都声明了 ────────────────────────────────
const declared = new Set([
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.dependencies ?? {}),
])
for (const file of [entry, clientPath]) {
  if (!existsSync(file)) continue
  const text = readFileSync(file, 'utf8')
  const specs = [...text.matchAll(/from\s*["']([^"'.][^"']*)["']/g)].map((m) => m[1])
  for (const spec of specs) {
    if (!spec.startsWith('@deepseek-ai/')) continue
    // 类型导入编译后已消失，只剩运行时导入
    if (!declared.has(spec)) fail(`${file.replace(ROOT, '')} 运行时导入了 ${spec}，但没写进 peerDependencies`)
  }
}
ok('运行时导入的官方包都已声明')

// ── 6. locale 与 icon ──────────────────────────────────────
//
// 这两项都走 dsh-app-boot 的 readPluginMeta()，那条路径**把解析失败当成
// 「没有元数据」静默跳过**，所以少任何一环都不会报错，只会在插件页上显示
// package.json 里那串中英拼接描述、或者干脆没有图标。
//
// 必要条件（缺一即静默失效）：
//   ① exports 里有 "./locale/*.json"
//   ② files 里有 "locale/*.json"
//   ③ locale/<语言>.json 存在且含 { meta: { title, description } }
//   图标：package.json 的 "icon" 指向存在的文件，且 files 里列上
const localeExport = pkg.exports?.['./locale/*.json']
if (localeExport === undefined) {
  fail('exports 里缺 "./locale/*.json" —— 插件页的标题和描述不会跟随语言')
} else if (!(pkg.files ?? []).some((f) => f.includes('locale'))) {
  fail('files 里缺 "locale/*.json" —— locale 文件不会被打进包里')
} else {
  const locales = ['zh', 'en']
  for (const lang of locales) {
    const file = join(ROOT, 'locale', `${lang}.json`)
    if (!existsSync(file)) {
      fail(`locale/${lang}.json 不存在`)
      continue
    }
    try {
      const body = JSON.parse(readFileSync(file, 'utf8'))
      const meta = body?.meta
      if (typeof meta?.title !== 'string' || meta.title === '') fail(`locale/${lang}.json 缺 meta.title`)
      else if (typeof meta?.description !== 'string' || meta.description === '') fail(`locale/${lang}.json 缺 meta.description`)
      else ok(`locale/${lang}.json 可解析（title 与 description 都有）`)
    } catch (error) {
      fail(`locale/${lang}.json 不是合法 JSON：${error.message}`)
    }
  }
}

if (pkg.icon === undefined) {
  fail('package.json 缺 "icon" —— 插件页没有图标')
} else if (!existsSync(join(ROOT, pkg.icon))) {
  fail(`icon 指向 ${pkg.icon}，但文件不存在`)
} else if (!(pkg.files ?? []).includes(pkg.icon)) {
  fail(`files 里没列 ${pkg.icon} —— 图标不会被打进包里`)
} else {
  ok(`icon = ${pkg.icon}，文件存在且已列进 files`)
}

// ── 结果 ───────────────────────────────────────────────────
console.log(notes.join('\n'))
if (failures.length > 0) {
  console.error('\n预检失败：')
  for (const f of failures) console.error(`  FAIL  ${f}`)
  process.exit(1)
}
console.log('\n预检通过')

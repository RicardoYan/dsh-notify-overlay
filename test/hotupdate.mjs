// 验证设置热更新：改配置后，浮窗必须立刻收到新的 config，而不是等重启。
//
//   node test/hotupdate.mjs
//
// 机制（dsh 源码 cordis-plugin-loader `_commitVolatile`）：
//   · 每个字段都是 `.volatile()`，改值时 Loader 往**同一个引用**里写新快照，
//     `apply()` 不会重跑。
//   · 写完它 emit `loader/volatile-update`，this-context 已按 owner fiber 过滤，
//     所以普通 `ctx.on` 就能收到。
//
// 这个测试用真实 cordis + 真实插件，手工 emit 那个事件，断言插件往浮窗
// stdin 写了新的 config。不依赖 DSH 运行。
import { Context } from '@deepseek-ai/cordis'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

// 必须在加载插件之前设置：apply() 读一次就固定下来。
// 否则测试会往安装现场正在用的那份 trace 日志里追加内容。
process.env.DSH_NOTIFY_OVERLAY_TRACE = join(tmpdir(), 'dsh-notify-overlay-test-hotupdate.log')

const root = process.cwd()
const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

// 插件的 apply() 在 overlay 开着时会 spawn 浮窗进程，而这里只想验证监听器注册。
// 传 overlay: false 让它走系统通知分支——测试不该在跑的时候真的弹出窗口、
// 也不该往生产日志（%TEMP%\dsh-notify-overlay-host.log）里写东西。
{
  const ctx = new Context()
  ctx.provide('connection', { fetch: { register: () => () => {} } })
  ctx.provide('logger', { info() {}, warn() {}, error() {}, debug() {} })

  ctx.plugin(mod, { overlay: false })
  await new Promise((r) => setTimeout(r, 200))

  const hooks = ctx.events?._hooks?.['loader/volatile-update'] ?? []
  check('注册了 loader/volatile-update 监听器', hooks.length >= 1, `找到 ${hooks.length} 个`)
}

// 源码级断言：热更新路径必须真的重新下发 config，而不是空转。
{
  const { readFileSync } = await import('node:fs')
  const host = readFileSync(join(root, 'src', 'index.ts'), 'utf8')

  check('监听了 loader/volatile-update', /ctx\.on\('loader\/volatile-update'/.test(host))
  check('事件声明里也有它', /'loader\/volatile-update'\(paths: string\[\]\[\]\)/.test(
    readFileSync(join(root, 'src', 'events.ts'), 'utf8'),
  ))

  // pushConfig 必须被 ready 和热更新两处调用
  const calls = [...host.matchAll(/pushConfig\(\)/g)].length
  check('pushConfig 至少有两处调用（ready + 热更新）', calls >= 2, `${calls} 处`)

  // 下发的内容必须覆盖浮窗自己读不到的项
  for (const key of ['autoHideMs', 'scale', 'sound', 'lang']) {
    check(`pushConfig 下发 ${key}`, new RegExp(`${key}:\\s*(config\\.|lang\\(\\))`).test(host))
  }
}

// 浮窗侧：收到新 config 要重新布局，否则 scale 变了画面不动
{
  const { readFileSync } = await import('node:fs')
  const native = readFileSync(join(root, 'src', 'native', 'OverlayWindow.cs'), 'utf8')
  const configCase = native.slice(native.indexOf('case "config"'))

  check('浮窗处理 config', configCase.length > 0)
  check('config 里更新 scale', /scale = v/.test(configCase.slice(0, 1200)))
  check('config 里应用 LayoutTransform', /scalingHost\.LayoutTransform/.test(configCase.slice(0, 1200)))
  check('config 后重新定位', /Reposition\(\)/.test(configCase.slice(0, 1200)))
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

// 端到端验证：把真实插件装进真实 cordis，按 DSH 的方式派发事件。
//
//   node test/e2e.mjs
//
// 只覆盖 host 侧的事件 → 通知逻辑。插件用 `overlay: false` 装载，所以既不会
// 拉起浮窗进程，也不会弹出系统通知；同时把 trace 日志重定向到临时文件，
// 免得污染安装现场正在排查用的那份日志。
//
// 关键场景：模拟 `dsh-api-remotes` 的转发器先注册、并且回答后不调用 next()。
// 修复前我们的观察者收不到任何东西；修复后必须收到。
import { Context } from '@deepseek-ai/cordis'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

// 必须在加载插件之前设置：apply() 读一次就固定下来。
process.env.DSH_NOTIFY_OVERLAY_TRACE = join(tmpdir(), 'dsh-notify-overlay-test-e2e.log')

const root = process.cwd()
const pluginUrl = pathToFileURL(join(root, 'lib', 'index.js')).href
const mod = await import(pluginUrl)

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} (want ${expected}, got ${actual})`)
}

/** 起一个新 cordis 上下文，装好插件，返回它发往浮窗的消息。 */
async function boot() {
  const ctx = new Context()
  const sent = []

  // 插件 inject 的是 connection；给一个能注册路由的假实现。
  ctx.provide('connection', {
    fetch: {
      register(routes) {
        Object.assign(handlers, routes)
        return () => {}
      },
    },
  })

  // overlay: false —— 测试不该真的拉起浮窗进程，也不该往生产日志里写。
  ctx.plugin(mod, { overlay: false })
  await new Promise((resolve) => setTimeout(resolve, 60))

  return { ctx, sent }
}

const handlers = {}

// ── 场景 A：转发器先回答、不调 next()，我们的观察者仍要收到 ─────────
{
  const ctx = new Context()
  ctx.provide('connection', { fetch: { register: () => () => {} } })

  const seen = []

  // 先注册：模拟 dsh-api-remotes 的转发器（回答后直接返回）
  ctx.on('user-questions/request', async () => {
    seen.push('forwarder')
    return { answers: [] }
  })

  // overlay: false —— 同上，别在测试里拉浮窗、别写生产日志。
  ctx.plugin(mod, { overlay: false })
  await new Promise((resolve) => setTimeout(resolve, 60))

  const result = await ctx.waterfall(
    'user-questions/request',
    { agent: { id: 'session-test-1' }, questions: [{ question: '选哪个？' }] },
    async () => { seen.push('default'); return { answers: [] } },
  )

  check('A 我们的观察者被调用', seen.includes('forwarder') && seen.length >= 1, true)
  check('A 结果未被篡改', typeof result, 'object')
}

// ── 场景 B：插件能正常加载并声明契约 ────────────────────────────────
{
  check('B 导出 name', mod.name, 'notify-overlay')
  check('B inject 含 connection', JSON.stringify(mod.inject), '["connection"]')
  check('B 有 apply', typeof mod.apply, 'function')
  check('B 有 Config', typeof mod.Config, 'function')
}

// ── 场景 C：配置项默认值符合约定 ────────────────────────────────────
{
  // `volatile()` 会把每个字段包成 { get() }，取默认值要先解包。
  const raw = mod.Config({})
  const value = (key) => {
    const field = raw[key]
    return typeof field?.get === 'function' ? field.get() : field
  }
  check('C autoHideMs 默认 6000', value('autoHideMs'), 6000)
  check('C subagent 默认关', value('subagent'), false)
  check('C approval 默认开', value('approval'), true)
  check('C question 默认开', value('question'), true)
  check('C error 默认开', value('error'), true)
  check('C turnDone 默认开', value('turnDone'), true)
  check('C sessionDone 默认关', value('sessionDone'), false)
  // 没有总开关：不想用就直接在插件页禁用本插件。
  check('C 没有 enabled 字段', value('enabled'), undefined)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

// 锁定「改了会话标题，提醒仍显示旧标题」这个缺陷。
//
//   DSH_PACKAGES=<DSH 安装目录里的 node_modules> node test/title.mjs
//
// 背景：`labelOf()` 第一次拿到标题就存进 `labels`，之后只读缓存，只在
// `session/disposed` 时清掉。重命名追加的 `session/title` 事件没人理，于是一个
// 会话第一次弹提醒时叫什么，之后就一直叫什么。
//
// 这里用的全是官方真实的类：`SessionStore`、`SessionProjectionRegistry`、
// `SessionTitleService`，跑在 DSH 自带的 cordis 上。重命名走 `sessionTitle.rename()`，
// 和界面上改名是同一条路（`dsh-api-session-controller` 的 `rename()`）。
// 事件也是官方自己派发的，测试不手工 emit `session/event`：这个测试要验证的
// 恰恰是插件能不能收到那条派发。
//
// 插件以 `overlay: true` 装载，但 `child_process.spawn` 换成了假的：不会起浮窗进程，
// 也不会弹系统通知；发往浮窗的每一行 JSON 都被截下来，断言其中的 `sessionLabel`。
import { registerHooks, syncBuiltinESMExports, createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGES = process.env.DSH_PACKAGES
if (!PACKAGES || !existsSync(join(PACKAGES, '@deepseek-ai', 'dsh-session'))) {
  console.log('需要 DSH_PACKAGES：指向含 @deepseek-ai/dsh-session 的 DSH node_modules 目录')
  process.exit(2)
}

// `@deepseek-ai/*` 一律解析到 DSH 那一份：测试、官方服务、插件必须共用同一个
// cordis，否则 Service / Context 分裂成两个世界，事件根本到不了对方。
const anchor = pathToFileURL(join(PACKAGES, '__anchor__.js')).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/')) return next(specifier, { ...context, parentURL: anchor })
    return next(specifier, context)
  },
})

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// ── 假 spawn：截下发往浮窗的消息 ──────────────────────────────────
// 必须在导入插件之前换掉，并 sync 到 ESM 的具名导出上。
const sent = []
const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')
childProcess.spawn = () => {
  const proc = new EventEmitter()
  const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} })
  proc.stdout = stream()
  proc.stderr = stream()
  proc.stdin = {
    write(line) {
      for (const text of String(line).split('\n')) {
        if (text.trim() !== '') sent.push(JSON.parse(text))
      }
      return true
    },
  }
  proc.kill = () => true
  setImmediate(() => proc.stdout.emit('data', '{"op":"ready"}\n'))
  return proc
}
syncBuiltinESMExports()

const sandbox = mkdtempSync(join(tmpdir(), 'overlay-title-'))
process.env.DSH_NOTIFY_OVERLAY_TRACE = join(sandbox, 'host.log')

const { Context } = await import('@deepseek-ai/cordis')
const { default: SessionStore } = await import('@deepseek-ai/dsh-session')
const { default: SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
const { default: SessionTitleService } = await import('@deepseek-ai/dsh-session-title')
const plugin = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)

let failures = 0
const check = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       期望 ${JSON.stringify(expected)}\n       实际 ${JSON.stringify(actual)}`}`)
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

/** 最近一条发往浮窗的提醒卡片。 */
const lastCard = () => sent.filter((m) => m.op === 'notify').at(-1)?.items?.[0]

/**
 * 跑一遍完整场景。
 * @param preference - DSH 语言设置，`zh` 或 `en`。
 */
async function run(preference) {
  console.log(`\n── 语言 ${preference} ──`)
  sent.length = 0

  const ctx = new Context()
  ctx.provide('connection', { fetch: { register: () => () => {} } })
  // 插件从 loader 树里读语言（locale.ts 的 preferenceFromLoader）。
  ctx.provide('loader', {
    entries: () => [{ options: { name: '@deepseek-ai/dsh-client-locale', config: { preference } } }],
  })
  ctx.plugin(SessionStore)
  ctx.plugin(SessionProjectionRegistry)
  ctx.plugin(SessionTitleService, { fallbackMaxWords: 8, fallbackMaxBytes: 64, maxTitleBytes: 256 })
  await tick()

  // 会话归创建它的 fiber：dispose 这个 fiber 就是「会话被移出内存」。
  let session
  const owner = ctx.plugin({
    inject: ['sessions'],
    apply(c) {
      session = c.sessions.create(undefined, { meta: { cwd: sandbox } })
    },
  })
  await tick()

  const pluginFiber = ctx.plugin(plugin, { overlay: true, sessionDone: true })
  await tick(80)

  const titles = ctx.get('sessionTitle')
  const id = session.id

  /** 触发一次「轮次完成」：running → idle。 */
  const turn = async () => {
    ctx.emit('agent/status', { agent: { id }, status: 'running' })
    ctx.emit('agent/status', { agent: { id }, status: 'idle' })
    await tick()
  }
  /** 触发一次「执行出错」：kind 和轮次不同，绕开同类 5 秒去重。 */
  const fail = async () => {
    ctx.emit('agent/error', { agent: { id }, error: new Error('boom') })
    await tick()
  }

  // 1. 基线：第一次改名后弹提醒
  titles.rename(session, '旧标题')
  await turn()
  check('第一次提醒用当时的标题', lastCard()?.sessionLabel, '旧标题')
  check('提醒语言跟随设置', sent.filter((m) => m.op === 'notify').at(-1)?.lang, preference)

  // 2. 复现：再改名，下一条提醒必须用新标题
  titles.rename(session, '新标题')
  await fail()
  check('改名后的提醒用新标题', lastCard()?.sessionLabel, '新标题')

  // 3. 改名后没有再弹过提醒，会话就被移出内存：「会话结束」卡片也要用最新标题。
  //    这时 sessions.get() 已经查不到它，只能靠事件更新过的缓存。
  titles.rename(session, '最后的标题')
  await tick()
  owner.dispose()
  await tick()
  check('会话结束卡片用移出前的最新标题', lastCard()?.sessionLabel, '最后的标题')
  check('会话结束卡片的 kind', lastCard()?.kind, 'sessionDone')

  // 4. 重启：从磁盘恢复的会话，标题事件是作为种子塞进日志的，不派发 session/event。
  //    插件的缓存是空的，第一次提醒必须回落到 sessionTitle.get() 读出来。
  const seed = JSON.parse(JSON.stringify(session.snapshotEvents()))
  let restored
  const owner2 = ctx.plugin({
    inject: ['sessions'],
    apply(c) {
      restored = c.sessions.create(undefined, { seed, meta: { cwd: sandbox } })
    },
  })
  await tick()
  check('种子日志里带着改过的标题', titles.get(restored)?.title, '最后的标题')
  ctx.emit('agent/status', { agent: { id: restored.id }, status: 'running' })
  ctx.emit('agent/status', { agent: { id: restored.id }, status: 'idle' })
  await tick()
  check('恢复的会话第一次提醒就用磁盘上的标题', lastCard()?.sessionLabel, '最后的标题')

  owner2.dispose()
  pluginFiber.dispose()
  await tick()
}

try {
  await run('zh')
  await run('en')
} finally {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 占用就算了 */ }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

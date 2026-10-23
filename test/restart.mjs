// 验证浮窗是**按需启动**：不常驻、不自动重启，只在真要发消息时启动。
//
//   node test/restart.mjs
//
// 设计理由（踩过的坑）：
//   · 常驻 + 自动重启会让浮窗一直锁着自己的 .exe。pnpm 装插件要替换这个文件，
//     拿不到句柄就失败（EPERM rename），而杀掉进程只会立刻被重启、重新锁上，
//     形成死循环——更新插件变成只能重启 DSH 才能做的事。
//   · 所以改成：加载时不启动；只有真要发消息时启动；退出后不重启，等下次需要。
//
// 注意：正在运行的 DSH 也会拉起浮窗，所以这里不能按名字数进程，只能按
// **本测试新增的 pid** 判断，否则会数到 DSH 那个。
import { Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const exe = join(root, 'lib', 'native', 'dsh-notify-overlay.exe')

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

if (!existsSync(exe)) {
  console.error(`缺少 ${exe}，先跑 npm run build:native`)
  process.exit(1)
}

/** 当前全部浮窗 pid（含 DSH 拉起的）。 */
function overlayPids() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      "Get-Process -Name 'dsh-notify-overlay' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id",
    ], { encoding: 'utf8' })
    return out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '')
  } catch {
    return []
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 基线：测试开始前已有的进程（DSH 的），全程忽略。
const baseline = new Set(overlayPids())
const fresh = () => overlayPids().filter((pid) => !baseline.has(pid))

const logPath = join(tmpdir(), 'dsh-notify-overlay.log')
const logSize = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').length : 0)

const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)

const ctx = new Context()
ctx.provide('connection', { fetch: { register: () => () => {} } })
ctx.provide('logger', { info() {}, warn() {}, error() {}, debug() {} })

ctx.plugin(mod)

const fakeAgent = { id: 'session-lazy-test', session: { header: {} } }

/** 发一轮 running→idle，让插件走一次 notify。 */
async function trigger() {
  ctx.events.emit('agent/status', { agent: fakeAgent, status: 'running' })
  await wait(50)
  ctx.events.emit('agent/status', { agent: fakeAgent, status: 'idle' })
  await wait(400)
}

// ── 1. 加载后不该新增任何进程 ──────────────────────────────────────
await wait(1600)
check('加载插件不启动浮窗', fresh().length === 0, `新增=${fresh().join(',')}`)

// ── 2. 有提醒时才启动 ──────────────────────────────────────────────
const beforeStart = logSize()
await trigger()
await wait(1500)

const started = fresh()
check('有提醒时启动浮窗', started.length === 1, `新增=${started.join(',')}`)
const freshLog = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(beforeStart) : ''
check('新进程发出了 ready', /main 启动完成，发出 ready/.test(freshLog))

// ── 3. 杀掉后不会自己回来 ──────────────────────────────────────────
for (const pid of started) {
  try { process.kill(Number(pid)) } catch { /* 已退出 */ }
}
await wait(2600)
check('杀掉后不自动重启', fresh().length === 0, `新增=${fresh().join(',')}`)

// ── 4. 下一条提醒重新拉起 ──────────────────────────────────────────
const beforeSecond = logSize()
await trigger()
await wait(1500)

const revived = fresh()
check('下一次提醒重新拉起浮窗', revived.length === 1, `新增=${revived.join(',')}`)
const secondLog = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(beforeSecond) : ''
check('重新拉起后重新握手', /main 启动完成，发出 ready/.test(secondLog))

// ── 5. 卸载后本测试的进程消失 ──────────────────────────────────────
ctx.fiber.dispose?.()
await wait(1000)
check('卸载后没有残留进程', fresh().length === 0, `新增=${fresh().join(',')}`)
for (const pid of fresh()) {
  try { process.kill(Number(pid)) } catch { /* 已退出 */ }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

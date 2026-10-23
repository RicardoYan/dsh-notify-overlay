// 验证「只启动一次，之后复用」——不是每条提醒都新开进程。
//
//   node test/reuse.mjs
//
// 按需启动的语义是：没有进程时才 spawn；已经有进程就直接复用。连续多条提醒
// 必须只对应一个进程、一次握手、一次 config 下发。
//
// 同样要按 pid 基线过滤：正在运行的 DSH 也会拉起浮窗。
import { Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

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

const baseline = new Set(overlayPids())
const fresh = () => overlayPids().filter((pid) => !baseline.has(pid))

const logPath = join(tmpdir(), 'dsh-notify-overlay.log')
const logText = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')
const countIn = (text, needle) => (text.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length

const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)

const ctx = new Context()
ctx.provide('connection', { fetch: { register: () => () => {} } })
ctx.provide('logger', { info() {}, warn() {}, error() {}, debug() {} })

ctx.plugin(mod)

// 等 apply 跑完再发事件：注册监听器是异步的，抢在前面的事件会被丢掉。
await wait(1200)

const beforeSize = logText().length

/** 发一轮 running→idle。sessionId 各不相同，避免被 5 秒去重吃掉。 */
async function trigger(index) {
  const agent = { id: `session-reuse-${index}`, session: { header: {} } }
  ctx.events.emit('agent/status', { agent, status: 'running' })
  await wait(60)
  ctx.events.emit('agent/status', { agent, status: 'idle' })
  await wait(500)
}

// 连续 5 条提醒：第 1 条应启动进程，后 4 条复用。
for (let i = 0; i < 5; i++) await trigger(i)
await wait(1800)

const delta = logText().slice(beforeSize)
const readyCount = countIn(delta, 'main 启动完成，发出 ready')
const notifyCount = countIn(delta, 'notify batch=1')
const pids = fresh()

console.log(`\n五条提醒结果：ready ${readyCount} 次, notify ${notifyCount} 次, 进程 ${pids.length} 个\n`)

check('只启动了一个进程', pids.length === 1, `新增=${pids.join(',')}`)
check('只握手一次（没有反复启动）', readyCount === 1, `ready=${readyCount}`)
check('五条通知都送达了', notifyCount === 5, `notify=${notifyCount}`)
check('复用同一进程（进程数 < 通知数）', pids.length < notifyCount)

// 收尾
ctx.fiber.dispose?.()
await wait(900)
for (const pid of fresh()) {
  try { process.kill(Number(pid)) } catch { /* 已退出 */ }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

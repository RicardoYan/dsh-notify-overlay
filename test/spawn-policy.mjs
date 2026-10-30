// 验证「撤下类指令不拉起浮窗」。
//
//   node test/spawn-policy.mjs
//
// 背景（2026-10-29 现场）：浏览器半区每次焦点变化、以及每秒一次轮询都会上报
// 当前会话，Host 收到就 withdraw 该会话的 error —— 一次一条 `remove`。
// `send()` 原来的写法是「没有进程就 spawn」，于是一次切窗口就能凭空拉起一个
// 浮窗，而它唯一的活儿是被通知「没有东西可撤」。用户看到的就是小球乱冒。
//
// 策略：
//   · remove / theme / config / clear / exit → 没有进程就直接丢弃
//   · notify / sound → 仍然拉起（它们是提醒本身）
//
// 判定依据是「浮窗进程有没有真的启动」，看的是浮窗自己那份日志
// （`dsh-notify-overlay.log`，由 exe 写到 %TEMP%）。测试期间把 %TEMP% 重定向到
// 临时目录，所以**不会碰生产日志**，也不会在屏幕上弹窗（浮窗没有内容时不 Show）。
// 起出来的进程由 `ctx.fiber.dispose()` 收掉——插件的 dispose 会发 `exit` 再 kill。
import { Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()

// 必须在加载插件之前改：`apply()` 读一次 tmpdir 就固定下来，
// 浮窗子进程也继承这个环境变量，于是它自己那份日志也落在临时目录。
const sandbox = mkdtempSync(join(tmpdir(), 'overlay-spawn-policy-'))
const realTemp = process.env.TEMP
const realTmp = process.env.TMP
process.env.TEMP = sandbox
process.env.TMP = sandbox
process.env.DSH_NOTIFY_OVERLAY_TRACE = join(sandbox, 'host.log')

const overlayLog = join(sandbox, 'dsh-notify-overlay.log')
const hostLog = join(sandbox, 'host.log')

let failures = 0
let code = 1
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

const readOverlayLog = () => (existsSync(overlayLog) ? readFileSync(overlayLog, 'utf8') : '')
const readHostLog = () => (existsSync(hostLog) ? readFileSync(hostLog, 'utf8') : '')

/** 浮窗日志里出现几次「main 启动完成」＝ 真起了几次进程。 */
const spawnCount = () => [...readOverlayLog().matchAll(/main 启动完成/g)].length

/**
 * PIDs of overlay processes this test started.
 *
 * They are children of this process, so the tasklist query is enough; the
 * sandbox `%TEMP%` cannot locate them by itself and the overlay logs no pid.
 * @returns the pid of every running `dsh-notify-overlay.exe` under us.
 */
function overlayPids() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='dsh-notify-overlay.exe'" | ` +
      `Where-Object { $_.ParentProcessId -eq ${process.pid} } | ` +
      `ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', timeout: 8000 })
    return out.split(/\s+/).filter((s) => /^\d+$/.test(s))
  } catch {
    return []
  }
}

try {
  const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)

  /** Apply the plugin and expose its HTTP routes. */
  async function mount() {
    const routes = new Map()
    const ctx = new Context()
    ctx.provide('connection', {
      fetch: {
        register: (route) => {
          routes.set(`${(route.methods ?? ['GET']).join(',')} ${route.path}`, route.fetch)
          return () => routes.delete(route.path)
        },
      },
    })
    ctx.provide('logger', { info() {}, warn() {}, error() {}, debug() {} })
    ctx.provide('sessions', { get: () => undefined })
    ctx.provide('sessionTitle', { get: () => undefined })
    ctx.plugin(mod, { overlay: true })
    await new Promise((r) => setTimeout(r, 200))
    return { ctx, routes }
  }

  async function post(routes, path, body) {
    const handler = routes.get(`POST ${path}`)
    if (handler === undefined) throw new Error(`没有注册 ${path}`)
    return handler(new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))
  }

  // ── 一、只有撤下类指令：不许拉起浮窗 ─────────────────────────
  {
    const before = spawnCount()
    const { ctx, routes } = await mount()

    // 浏览器半区切窗口时的真实调用：上报当前会话 → 内部 withdraw(error)。
    // 原来每一条都会拉起一个浮窗。
    for (let i = 0; i < 6; i++) {
      await post(routes, '/api/notify-overlay/active', { sessionId: `session-${i}`, focused: i % 2 === 0 })
    }
    await post(routes, '/api/notify-overlay/theme', { dark: true })
    await new Promise((r) => setTimeout(r, 800))

    check('6 次切窗口上报 + 1 次主题，一次都没起浮窗', spawnCount() === before,
      `启动了 ${spawnCount() - before} 次；浮窗日志：${readOverlayLog().slice(0, 200) || '(空)'}`)

    // 收尾：`ctx.dispose` 在 Context 上不存在（那是 `ctx.fiber.dispose`），
    // 写错了不会报错，只会让浮窗子进程留着不走 —— 测试进程于是永远不退出。
    // 照 `test/reuse.mjs` 的写法：先让插件自己 dispose，再按 pid 兜底。
    ctx.fiber.dispose?.()
    await new Promise((r) => setTimeout(r, 500))
    for (const pid of overlayPids()) {
      try { process.kill(Number(pid)) } catch { /* 已退出 */ }
    }
    await new Promise((r) => setTimeout(r, 300))
  }

  // ── 二、真提醒仍然拉起浮窗（证明一不是「全都不启动」） ────────
  {
    const before = spawnCount()
    const { ctx, routes } = await mount()

    // 先来一条撤下类，确认它不启动
    await post(routes, '/api/notify-overlay/active', { sessionId: 'session-y', focused: false })
    await new Promise((r) => setTimeout(r, 400))
    check('单独一条 remove 不启动', spawnCount() === before, `${spawnCount() - before} 次`)

    // 再来一条真提醒：必须启动
    ctx.emit?.('approval/request', { agent: { id: 'session-y' }, toolName: 'Bash', reason: 'spawn-policy test' },
      () => new Promise(() => {}))
    await new Promise((r) => setTimeout(r, 1500))

    check('真提醒仍然拉起浮窗', spawnCount() > before,
      `只起了 ${spawnCount() - before} 次；浮窗日志：${readOverlayLog().slice(0, 200) || '(空)'}`)

    ctx.fiber.dispose?.()
    await new Promise((r) => setTimeout(r, 500))
    for (const pid of overlayPids()) {
      try { process.kill(Number(pid)) } catch { /* 已退出 */ }
    }
    await new Promise((r) => setTimeout(r, 300))
  }

  // ── 三、源码级断言：把分类钉死在关键分支上 ───────────────────
  {
    const host = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
    check('send 在 spawn 前判断 needsRunningOverlay', /needsRunningOverlay\(msg\)/.test(host))
    for (const op of ['remove', 'theme', 'config', 'clear', 'exit']) {
      check(`${op} 归入撤下类`, new RegExp(`op === '${op}'`).test(host))
    }
    // notify / sound 不能落进撤下类，否则提醒本身就不弹了
    const predicate = host.match(/function needsRunningOverlay[\s\S]*?\n  \}/)?.[0] ?? ''
    check('needsRunningOverlay 不含 notify', !predicate.includes("'notify'"), predicate.slice(0, 200))
    check('needsRunningOverlay 不含 sound', !predicate.includes("'sound'"), predicate.slice(0, 200))
  }

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  code = failures === 0 ? 0 : 1
} finally {
  process.env.TEMP = realTemp
  process.env.TMP = realTmp
  await new Promise((r) => setTimeout(r, 300))
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 进程还占着就算了 */ }
}

// 显式退出：cordis 的 plugin fiber 会留下计时器，单靠 process.exitCode
// 事件循环不会自己空掉，测试进程会挂在那里，浮窗子进程也跟着不走。
process.exit(code)

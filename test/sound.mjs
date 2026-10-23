// 实测声音指令：响铃只由 host 的 sound 指令触发，卡片本身不发声。
//
//   node test/sound.mjs
//
// 起真实浮窗进程，分别发：
//   1. 只发 notify（卡片）→ 不应有任何 chime 记录
//   2. 只发 sound      → 应记录一次 chime
//   3. notify + sound  → 一声铃 + 一张卡片
//
// 验证手段是浮窗写进 %TEMP%\dsh-notify-overlay.log 的 trace。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const exe = join(here, '..', 'lib', 'native', 'dsh-notify-overlay.exe')
if (!existsSync(exe)) {
  console.error(`缺少 ${exe}，先跑 npm run build:native`)
  process.exit(1)
}

const logPath = join(tmpdir(), 'dsh-notify-overlay.log')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一个干净进程，依次发若干指令，返回这段时间新增的日志。 */
async function run(label, messages) {
  const before = existsSync(logPath) ? readFileSync(logPath, 'utf8').length : 0
  const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => {})
  child.stdout.resume()

  await wait(900)
  for (const message of messages) {
    child.stdin.write(JSON.stringify(message) + '\n')
    await wait(250)
  }
  await wait(600)

  const tail = readFileSync(logPath, 'utf8').slice(before)
  try { child.kill() } catch { /* 已退出 */ }
  await wait(300)
  return { label, tail }
}

const card = {
  op: 'notify',
  autoHideMs: 60000,
  lang: 'zh',
  items: [{
    sessionId: 'session-sound-test',
    kind: 'turn',
    title: '轮次完成',
    body: '测试',
    sessionLabel: '声音测试',
    at: Date.now(),
    persistent: false,
  }],
}

const cardOnly = await run('只有卡片', [card])
const soundOnly = await run('只有声音', [{ op: 'sound' }])
const both = await run('卡片+声音', [card, { op: 'sound' }])

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

const countSound = (text) => (text.match(/op=sound/g) ?? []).length
const countNotify = (text) => (text.match(/op=notify/g) ?? []).length

console.log('\n── 实测结果 ──')
for (const r of [cardOnly, soundOnly, both]) {
  console.log(`${r.label}: sound 指令 ${countSound(r.tail)} 次, notify 指令 ${countNotify(r.tail)} 次`)
}

check('卡片指令被浮窗接受', countNotify(cardOnly.tail) === 1)
check('卡片本身不触发 sound', countSound(cardOnly.tail) === 0)
check('独立 sound 指令被接受', countSound(soundOnly.tail) === 1)
check('只有 sound 时不画卡片', countNotify(soundOnly.tail) === 0)
check('两者可并存', countNotify(both.tail) === 1 && countSound(both.tail) === 1)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

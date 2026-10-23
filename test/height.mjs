// 实测卡片高度随正文自适应。
//
//   node test/height.mjs
//
// 每个场景起一个**全新的**浮窗进程：`Appear()` 只在窗口第一次显示时记录
// 尺寸，复用同一个进程会读到上一条的旧值（这个坑已经踩过一次）。
//
// 为什么必须实测：`SizeToContent="WidthAndHeight"` 只保证窗口跟布局走，
// TextBlock 换行占几行、卡片会不会被裁掉，只有真实布局跑过才知道。
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

/** 起一个新进程、送一条提醒、读回它记录的卡片尺寸。 */
async function measure(label, body) {
  const before = existsSync(logPath) ? readFileSync(logPath, 'utf8').length : 0
  const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => {})
  child.stdout.resume()

  await wait(900)
  // 先给主题，避免深色默认值影响字体度量
  child.stdin.write(JSON.stringify({ op: 'theme', dark: false }) + '\n')
  child.stdin.write(JSON.stringify({
    op: 'notify',
    autoHideMs: 120000,
    lang: 'zh',
    items: [{
      sessionId: 'session-height-' + label,
      kind: 'question',
      title: '需要你回答',
      body,
      sessionLabel: '高度测试',
      at: Date.now(),
      persistent: true,
    }],
  }) + '\n')

  await wait(900)
  const text = readFileSync(logPath, 'utf8').slice(before)
  const sizes = [...text.matchAll(/Appear ok size=([\d.]+)x([\d.]+)/g)]

  try { child.kill() } catch { /* 已经退出 */ }
  await wait(250)

  const last = sizes.at(-1)
  return last === undefined ? null : { w: Number(last[1]), h: Number(last[2]) }
}

const short = await measure('short', '短')
const medium = await measure('medium', '中等长度的正文，大约两行左右，用来看看卡片会不会跟着变高。')
const long = await measure('long', '这是一段很长很长的正文，'.repeat(12) + '结尾。')

console.table([
  { case: '短', width: short?.w, height: short?.h },
  { case: '中', width: medium?.w, height: medium?.h },
  { case: '长', width: long?.w, height: long?.h },
])

let failures = 0
const check = (label, ok) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
}

check('三个场景都完成了布局', short !== null && medium !== null && long !== null)
if (short && medium && long) {
  check('宽度不随正文变化', short.w === medium.w && medium.w === long.w)
  check('中比短高', medium.h > short.h)
  check('长比中高', long.h > medium.h)
  check('长文本高度有限（没失控）', long.h < 1400)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

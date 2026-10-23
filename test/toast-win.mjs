// Windows 真机投递测试：toast 到底有没有进系统通知库。
//
//   node test/toast-win.mjs
//
// 只在 Windows 上跑。判断「发出去」不能靠退出码——WinRT 的 Show() 在 AUMID
// 没注册时会正常返回、不抛异常、也不显示，正是笔记 §8 记的那个坑。唯一可靠
// 的判据是系统通知库 wpndatabase.db 的 Notification 表多了一行，而且绑到
// DSH 自己的 handler（electron.app.DeepSeek Harness）。
//
// 两个必须一起读的细节：
//   · 库文件是 WAL 模式，只拷 wpndatabase.db 会看不到新写入——要把 -wal 和
//     -shm 一起拷到临时目录再打开，否则永远读到旧快照。
//   · 不要用 ToastNotificationManager.History：它只保留最近若干条，且清空后
//     不可靠；直接查库是唯一稳的。
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

if (process.platform !== 'win32') {
  console.log('跳过：非 Windows')
  process.exit(0)
}

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`}`)
}

/** 找运行时自带的 python；找不到就跳过，不让测试依赖外部环境。 */
function findPython() {
  const candidates = [
    join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python',
    'python3',
  ]
  for (const candidate of candidates) {
    if (candidate.includes('\\') && !existsSync(candidate)) continue
    const probe = spawnSync(candidate, ['-c', 'print(1)'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return null
}

const python = findPython()
if (python === null) {
  console.log('跳过：找不到 python（通知库是 SQLite，需要它来读）')
  process.exit(0)
}

const notificationDir = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'Notifications')
const liveDb = join(notificationDir, 'wpndatabase.db')
if (!existsSync(liveDb)) {
  console.log('跳过：找不到 wpndatabase.db')
  process.exit(0)
}

/** 拷一份库（含 WAL）并数出 Notification 行数与最新一行的 handler。 */
function snapshot() {
  const dir = mkdtempSync(join(tmpdir(), 'toast-'))
  for (const name of readdirSync(notificationDir)) {
    if (name.startsWith('wpndatabase.db')) {
      copyFileSync(join(notificationDir, name), join(dir, name))
    }
  }
  const script = `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
cur = c.cursor()
cur.execute('select count(*) from Notification')
count = cur.fetchone()[0]
cur.execute('pragma table_info(Notification)')
cols = [r[1] for r in cur.fetchall()]
cur.execute('select * from Notification order by rowid desc limit 1')
row = cur.fetchone()
handler = ''
if row is not None:
    d = dict(zip(cols, row))
    cur.execute('select PrimaryId from NotificationHandler where RecordId = ?', (d['HandlerId'],))
    got = cur.fetchone()
    handler = got[0] if got else ''
print(count, '|', handler)
`
  const out = spawnSync(python, ['-c', script, join(dir, 'wpndatabase.db')], { encoding: 'utf8' })
  if (out.status !== 0) {
    console.log('读通知库失败：', String(out.stderr).slice(0, 400))
    process.exit(1)
  }
  const [count, handler] = String(out.stdout).trim().split(' | ')
  return { count: Number(count), handler: handler ?? '' }
}

const before = snapshot()
console.log(`投递前：${before.count} 条`)

// 从独立进程发一条，然后立刻退出——正是 Host 的实际行为。之前用 detached +
// unref 时这里会丢通知，所以这条测试就是那个回归的守卫。
const payload = `验证 ${Date.now()}`
const fired = spawnSync(process.execPath, ['-e', `
  import(${JSON.stringify(`file:///${join(root, 'lib', 'system-notify.js').replace(/\\/g, '/')}`)}).then(({ showSystemNotice }) => {
    showSystemNotice({ title: ${JSON.stringify(payload)}, body: '需要审批 · Bash', context: '重构通知模块' }, (m) => {
      console.error(m)
    })
  })
`], { encoding: 'utf8', timeout: 30_000 })

check('发送进程正常退出', fired.status, 0)
const fireErr = String(fired.stderr ?? '').trim()
if (fireErr !== '') console.log(`     发送侧报告：${fireErr}`)

// WinRT 投递是异步的，给它一点时间入库。
await new Promise((resolve) => setTimeout(resolve, 3000))

const after = snapshot()
console.log(`投递后：${after.count} 条，最新 handler=${after.handler || '(无)'}`)

check('通知进了系统通知库', after.count > before.count, true)
check('绑定到 DSH 快捷方式声明的 AUMID', after.handler, 'com.deepseek.dsh')

// 回归守卫：这三个值都验证过「能入库但不显示」，绝不能再用。
// 尤其是 electron.app.DeepSeek Harness —— 它是 Electron 的兜底 id，在
// wpndatabase.db 里查得到 handler，看起来完全正常，实际一条都不弹。
const src = readFileSync(join(root, 'src', 'system-notify.ts'), 'utf8')
const appId = /const APP_ID = '([^']+)'/.exec(src)?.[1]
check('APP_ID 是 com.deepseek.dsh', appId, 'com.deepseek.dsh')
check('没有退回 Electron 兜底 AUMID', /electron\.app\.DeepSeek Harness/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), false)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

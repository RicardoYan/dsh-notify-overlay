// 系统通知：转义、拼接、分发。
//
//   node test/system.mjs
//
// 这一层最容易悄悄坏掉，而且坏了没有任何报错：标题里一个 `'` 就能让整条
// PowerShell 命令语法错误，而 `spawn` 成功不等于通知发出去。
//
// 所以这里直接**导入真实函数**断言输出，不再用正则去匹配源码字符串——
// 那种写法只能证明「两句话挨得近」，改一行周边代码就会误报。
// 真正投递到系统那一步由 test/toast-win.mjs 做（需要真机）。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const { psLiteral, windowsScript, asLiteral } =
  await import(pathToFileURL(join(root, 'lib', 'system-notify.js')).href)

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       期望 ${JSON.stringify(expected)}\n       实际 ${JSON.stringify(actual)}`}`)
}

/** 断言输出里包含某段文本。 */
function checkContains(label, haystack, needle) {
  const ok = String(haystack).includes(needle)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       期望包含 ${JSON.stringify(needle)}`}`)
}

/** 断言输出里**不**包含某段文本（用于防止危险写法回归）。 */
function checkOmits(label, haystack, needle) {
  const ok = !String(haystack).includes(needle)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       不应包含 ${JSON.stringify(needle)}`}`)
}

check('system-notify 源文件存在', existsSync(join(root, 'src', 'system-notify.ts')), true)
check('编译产物存在', existsSync(join(root, 'lib', 'system-notify.js')), true)

// ── 1. PowerShell 单引号转义 ──────────────────────────────────
// 单引号串里只有 `'` 需要处理（写成两个），其余字符全是字面量。
check('普通文本原样包裹', psLiteral('abc'), "'abc'")
check('单引号翻倍', psLiteral("a'b"), "'a''b'")
check('$ 不当变量', psLiteral('$HOME'), "'$HOME'")
check('反引号不转义', psLiteral('a`b'), "'a`b'")
check('双引号无需处理', psLiteral('a"b'), `'a"b'`)
check('两个单引号', psLiteral("''"), "''''''")

// ── 2. Windows toast 脚本 ─────────────────────────────────────
{
  const script = windowsScript({ title: '需要审批', body: 'Bash · 请求执行', context: '会话 A' })

  check('用 -EncodedCommand 能跑的纯文本脚本', typeof script, 'string')
  checkContains('标题进了脚本', script, '需要审批')
  checkContains('会话名拼进正文', script, '会话 A')
  checkContains('正文与上下文用分隔符拼接', script, '请求执行 — 会话 A')
  checkContains('XML 用单引号包裹', script, `$xml = '<toast>`)
  checkContains('用正确的 AUMID', script, 'com.deepseek.dsh')
  checkOmits('不用 Electron 兜底 AUMID', script, 'electron.app.DeepSeek Harness')
  checkContains('静音提交（声音由插件管）', script, '<audio silent="true"/>')
  checkContains('XML 特殊字符先转义', script, '[System.Security.SecurityElement]::Escape')
}

// 恶意/畸形输入不能让脚本语法错误
{
  const nasty = windowsScript({ title: "a'b\"c$d`e", body: 'x<y>&z', context: '' })
  // 最关键的：脚本里不能出现未转义的单引号破坏字面量
  const titleLines = nasty.split('\n').filter((l) => l.includes('$title ='))
  check('标题只占一行赋值', titleLines.length, 1)
  const bodyLines = nasty.split('\n').filter((l) => l.includes('$body ='))
  check('正文只占一行赋值', bodyLines.length, 1)
}

// 换行必须折叠，否则 XML 结构会被撑坏
{
  const script = windowsScript({ title: 'a\nb', body: 'c\r\nd', context: '' })
  checkContains('标题换行被折叠', script, `$title = [System.Security.SecurityElement]::Escape('a b')`)
  checkContains('正文换行被折叠', script, `$body = [System.Security.SecurityElement]::Escape('c d')`)
}

// ── 3. AppleScript 转义 ───────────────────────────────────────
// 未在 macOS 实测，所以只锁「不会产生语法上必然错误的东西」。
check('AppleScript 双引号转义', asLiteral('a"b'), '"a\\"b"')
check('AppleScript 反斜杠转义', asLiteral('a\\b'), '"a\\\\b"')
check('AppleScript 换行折叠成空格', asLiteral('a\nb'), '"a b"')

// ── 4. 分发：overlay 关闭时必须走系统通知 ─────────────────────
const hostSource = readFileSync(join(root, 'src', 'index.ts'), 'utf8')

check('overlay 默认开（Windows 用浮窗）', /overlay: z\.boolean\(\)\.default\(true\)/.test(hostSource), true)
check('按平台判断浮窗可用', /overlayAvailable = process\.platform === 'win32'/.test(hostSource), true)
check('浮窗不可用时 send 直接返回', /if \(!overlayAvailable\) return/.test(hostSource), true)
check('关掉开关会停掉浮窗进程', /stopOverlay\('开关已关闭'\)/.test(hostSource), true)
check('热更新跟踪 overlay 的前值', /let overlayWasOn = config\.overlay\.get\(\)/.test(hostSource), true)

// 顺序关系：去重必须在两条投递分支之前（不然同一事件可能投两次）
{
  const dedupe = hostSource.indexOf('lastSent.set(sessionId, { kind: reminder.kind, at: now })')
  const sys = hostSource.indexOf('showSystemNotice({')
  const card = hostSource.indexOf("op: 'notify',")
  check('去重在系统通知之前', dedupe !== -1 && dedupe < sys, true)
  check('去重在浮窗卡片之前', dedupe !== -1 && dedupe < card, true)
}

// ── 5. 面板 ────────────────────────────────────────────────────
const clientSource = readFileSync(join(root, 'src', 'client.ts'), 'utf8')

check('面板有 overlay 开关行', /\{ field: 'overlay', kind: 'switch', labelKey: 'fieldOverlay'/.test(clientSource), true)
check('中英文都有该行文案', /fieldOverlay: '用浮窗提醒'/.test(clientSource) && /fieldOverlay: 'Use the overlay window'/.test(clientSource), true)

// 提示语必须说清「点击没反应」。以前这里写的是「只能把 DSH 唤到前台」，
// 实测证明那句是错的（笔记 §10），所以断言改成锁正确说法。
check('提示语说明点击无反应', /点击没有反应/.test(clientSource) && /clicking does nothing/.test(clientSource), true)
check('提示语不再声称能唤回', /唤到前台|brings DSH forward/.test(clientSource), false)

// ── 6. 构建脚本带上新模块 ──────────────────────────────────────
const buildSource = readFileSync(join(root, 'scripts', 'build.mjs'), 'utf8')
check('build 的 HOST_MODULES 含 system-notify', /HOST_MODULES = \['locale\.ts', 'system-notify\.ts'\]/.test(buildSource), true)
check('build 会清理旧的 system-notify.js', /'system-notify\.js'/.test(buildSource), true)

// ── 7. 真实调用不炸（端到端冒烟） ─────────────────────────────
// 只看「调用后进程能正常结束、没有未捕获异常」。真机投递见 test/toast-win.mjs。
{
  const smoke = spawnSync(process.execPath, ['-e', `
    import(${JSON.stringify(pathToFileURL(join(root, 'lib', 'system-notify.js')).href)}).then(({ showSystemNotice }) => {
      let err = null
      showSystemNotice({ title: "a'b\\"c$d", body: 'line1\\nline2', context: '会话' }, (m) => { err = m })
      setTimeout(() => console.log(JSON.stringify({ err })), 200)
    })
  `], { encoding: 'utf8', timeout: 20_000 })
  check('真实调用后进程正常退出', smoke.status, 0)
  check('真实调用没有未捕获异常', /Uncaught|SyntaxError|ParserError/.test(String(smoke.stderr ?? '')), false)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

// 锁定「文字显示不全」这个缺陷的正确行为。
//
//   node test/text.mjs
//
// 两个真实缺陷：
//   1. `session.header` 里没有 title 字段（见 dsh-session 的 header 字面量），
//      旧代码读 header.title 永远拿不到，兜底成 sessionId.slice(0,8) ——
//      于是每条提醒都显示成 "session-"。
//   2. 正文曾被按 UTF-16 码元截断，会劈坏代理对，且换行没折叠。
//
// 现在的约定：**不截断**（卡片高度自适应），只折叠空白。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

// ── 场景 1：会话标题来源 ───────────────────────────────────────────
{
  // header 的真实字段集（dsh-session prepare() 的字面量）
  const header = { version: 4, id: 'session-3349e469', createdAt: 1, isSeeded: false }
  check('header 确实没有 title 字段', header.title === undefined)

  const oldLabel = header.title ?? 'session-3349e469'.slice(0, 8)
  check('旧兜底会显示成 session-（对用户无意义）', oldLabel === 'session-')

  const fromService = { title: '插件设置页怎么做' }
  check('标题服务有值就用它', fromService?.title === '插件设置页怎么做')

  // 与 C# IsIdPrefix 相同的判定
  const isIdPrefix = (t) =>
    t === 'session-' || (t.startsWith('session-') && t.length <= 'session-1234abcd'.length)
  check('session- 被识别为 id 前缀', isIdPrefix('session-'))
  check('session-3349e469 被识别为 id 前缀', isIdPrefix('session-3349e469'))
  check('真实标题不被误判', !isIdPrefix('插件设置页怎么做'))
}

// ── 场景 2：源码里不该再有截断 ─────────────────────────────────────
{
  const host = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  const native = readFileSync(join(root, 'src', 'native', 'OverlayWindow.cs'), 'utf8')

  check('Host 不再 slice 正文', !/body:\s*L\([^)]*\.slice\(/.test(host))
  check('Host 有 flatten()', /function flatten\(/.test(host))

  // C# 里不许再对正文做长度截断
  check('原生侧不再 Substring 截正文', !/extra\s*=\s*extra\.Substring/.test(native))
  check('原生侧不再给正文设 MaxHeight', !/Text\s*=\s*Sub\(it\)[\s\S]{0,300}?MaxHeight/.test(native))
  check('原生侧保留自适应高度', /SizeToContent\s*=\s*SizeToContent\.WidthAndHeight/.test(native))
  check('原生侧有 Flatten()', /static string Flatten\(/.test(native))
}

// ── 场景 3：折叠空白的语义 ─────────────────────────────────────────
{
  const flatten = (text) => text.replace(/\s+/g, ' ').trim()
  check('换行折叠成空格', flatten('第一行\n\n第二行') === '第一行 第二行')
  check('首尾空白去掉', flatten('  中间  ') === '中间')
  check('短文本原样', flatten('短') === '短')
  check('不截断长文本', flatten('字'.repeat(500)).length === 500)
  check('emoji 不被劈坏', flatten('😀😀😀') === '😀😀😀')
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

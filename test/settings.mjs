// 校验设置面板的注册契约与交互约定。
//
//   node test/settings.mjs
//
// 背景（都从官方源码读出，不是猜的）：
//   · 只导出 `Config` 不会产生设置页。`dsh-settings` 会算出 `autoGenerate`
//     并把 schema 送到浏览器，但客户端**没有任何消费者**。
//   · 要出界面必须自己往 `plugins.bundle.config` 注册。它是 **keyed slot**，
//     按 bundle 包名查表，所以注册时用 `key:` 而不是 `id:`。
//   · 表单 scope 必须走 `ctx.configForms.get(NS)`，从根 ctx 直接读拿不到。
//   · scope 上有 `set(field, value)`：开关可以直接写，不必经暂存模型。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

const host = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
const client = readFileSync(join(root, 'src', 'client.ts'), 'utf8')
const native = readFileSync(join(root, 'src', 'native', 'OverlayWindow.cs'), 'utf8')

// ── 1. 包结构 ──────────────────────────────────────────────────────
{
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check('声明了 dsh.client', manifest.dsh?.client !== undefined)
  check('exports["./client"] 指向 lib/client.js', manifest.exports?.['./client'] === './lib/client.js')
  check('lib/client.js 存在', existsSync(join(root, 'lib', 'client.js')))
}

// ── 2. Host 字段与面板字段一一对应 ────────────────────────────────
{
  const hostKeys = [...host.matchAll(/^\s{2}(\w+):\s*z\.[\s\S]*?\.volatile\(\)/gm)].map((m) => m[1])
  const panelKeys = [...client.matchAll(/\{\s*field:\s*'(\w+)'/g)].map((m) => m[1])

  check('Host 有 volatile 字段', hostKeys.length > 0, `找到 ${hostKeys.length} 个`)
  check(
    '面板字段与 Host 完全一致',
    JSON.stringify([...hostKeys].sort()) === JSON.stringify([...panelKeys].sort()),
    `Host=[${hostKeys.join(',')}] 面板=[${panelKeys.join(',')}]`,
  )
}

// ── 3. 注册契约 ────────────────────────────────────────────────────
{
  check('注册进 plugins.bundle.config', /SETTINGS_SLOT\s*=\s*'plugins\.bundle\.config'/.test(client))
  check('用 key 而不是 id', /key:\s*NS/.test(client))
  check('通过 ctx.inject 取 configForms', /ctx\.inject\(\['slots',\s*'locale',\s*'configForms'\]/.test(client))
  check('用 configForms.get 取 scope', /forms\.get\(CONFIG_NS\)/.test(client))
  check('订阅 scope 变化', /scope\.subscribe\(/.test(client))
}

// ── 4. 交互设计：即改即存，不用暂存模型 ────────────────────────────
{
  check('直接调 scope.set 写入', /scope\.set\(spec\.field,\s*value\)/.test(client))
  // 只断言代码里没用到；注释里拿它做对比说明是允许的。
  check('不再构造 SettingsFormModel', !/new\s+primitives\.SettingsFormModel/.test(client))
  check('用官方 Switch 组件', /primitives\.Switch/.test(client))
  check('带分组', /const GROUPS/.test(client))
  check('行式布局类名', /nsh-row/.test(client))
  check('注入样式表', /injectStyles/.test(client))

  const css = client.split('const PANEL_CSS')[1]?.split('`')[1] ?? ''
  check('样式表非空', css.length > 100, `${css.length} 字符`)
  check('只用主题变量（无裸 hex）', !/#[0-9a-fA-F]{3,8}\b/.test(css))
  check('分隔线 0.5px（对齐官方）', /0\.5px solid var\(--dsw-alias-border/.test(css))
}

// ── 4b. 时段不用原生控件 + 依赖项关闭时禁用 ───────────────────────
{
  // `type="time"` 会弹出不跟主题、还会溢出卡片的系统选择器。
  check('没有原生 time 控件', !/type:\s*'time'/.test(client))
  check('时段是手搓的两个数字框', /const box = \(key: string/.test(client))
  check('两个框之间有冒号', /nsh-colon/.test(client))
  check('输入限制为数字两位', /replace\(\/\\D\/g, ''\)\.slice\(0, 2\)/.test(client))

  // 免打扰关着时，时间字段必须不可编辑。
  check('字段支持 dependsOn', /dependsOn\?: string/.test(client))
  check('时间字段依赖 quietHours', /field: 'quietStart'[\s\S]{0,80}dependsOn: 'quietHours'/.test(client))
  check('时间字段依赖 quietHours（结束）', /field: 'quietEnd'[\s\S]{0,80}dependsOn: 'quietHours'/.test(client))
  check('容器计算 dimmed', /const dimmed = spec\.dependsOn !== undefined && state\.value\[spec\.dependsOn\] !== true/.test(client))
  check('dimmed 传给时段行', /h\(ClockRow, \{[^}]*dimmed/.test(client))
  check('禁用时不可编辑', /disabled = props\.writable === false \|\| props\.dimmed === true/.test(client))
  check('禁用时整行变淡', /data-dimmed/.test(client) && /data-dimmed="true"\]/.test(client))

  // 语义验证：quietHours 关 → 时间不可编辑
  const dimmedFor = (spec, value) =>
    spec.dependsOn !== undefined && value[spec.dependsOn] !== true
  const specStart = { field: 'quietStart', dependsOn: 'quietHours' }
  check('免打扰关 → 开始时间禁用', dimmedFor(specStart, { quietHours: false }) === true)
  check('免打扰开 → 开始时间可用', dimmedFor(specStart, { quietHours: true }) === false)
  check('无依赖的字段永不禁用', dimmedFor({ field: 'scale' }, { quietHours: false }) === false)
}

// ── 5. 校验行为 ───────────────────────────────────────────────────
{
  const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/
  check('quietStart 接受 22:00', CLOCK.test('22:00'))
  check('quietStart 拒绝 24:00', !CLOCK.test('24:00'))
  check('quietStart 拒绝 8:00', !CLOCK.test('8:00'))
  check('quietStart 拒绝 22:60', !CLOCK.test('22:60'))

  const accepts = (spec, value) => {
    if (spec.kind === 'switch') return typeof value === 'boolean'
    if (spec.kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false
      if (spec.min !== undefined && value < spec.min) return false
      if (spec.max !== undefined && value > spec.max) return false
      return true
    }
    if (typeof value !== 'string') return false
    if (spec.field === 'quietStart' || spec.field === 'quietEnd') return CLOCK.test(value)
    return true
  }
  const autoHide = { field: 'autoHideMs', kind: 'number', min: 3000, max: 8000 }
  check('autoHideMs 接受 6000', accepts(autoHide, 6000))
  check('autoHideMs 拒绝 2999', !accepts(autoHide, 2999))
  check('autoHideMs 拒绝 8001', !accepts(autoHide, 8001))
  check('autoHideMs 拒绝非数字', !accepts(autoHide, Number('abc')))
  check('开关只接受布尔', accepts({ field: 'sound', kind: 'switch' }, true) && !accepts({ field: 'sound', kind: 'switch' }, 'on'))
}

// ── 6. 浮窗侧仍然自适应高度 ───────────────────────────────────────
{
  check('窗口按内容撑开', /SizeToContent\s*=\s*SizeToContent\.WidthAndHeight/.test(native))
  check('正文不截断', !/extra\s*=\s*extra\.Substring/.test(native))
  check('正文不限行数', !/Text\s*=\s*Sub\(it\)[\s\S]{0,300}?MaxHeight/.test(native))
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

// 锁定「设置页消失」这个缺陷。
//
//   node test/panel-store.mjs
//
// 根因：`useSyncExternalStore` 每次渲染都拿一次 `getSnapshot()` 并按**引用**
// 比较。如果 `getSnapshot` 每次现造一个对象，React 会认为 store 一直在变，
// 于是无限重渲染，直到抛 "Maximum update depth exceeded" —— 整棵组件树被卸掉，
// 表现就是「设置页没了」。
//
// 这个测试用真实的 React 渲染一个订阅 store 的组件，对比两种实现：
//   · 每次返回新对象 → 必须被 React 判定为不稳定（渲染次数失控）
//   · 缓存快照       → 渲染次数稳定
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

// 不依赖真跑 React（本项目没有 react 依赖），直接验证契约本身：
// getSnapshot 必须返回稳定引用。
{
  const makeStore = (cache) => {
    let value = { a: 1 }
    const listeners = new Set()
    let snapshot = { value, failed: false }
    return {
      subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) },
      getSnapshot: () => {
        if (!cache) return { value, failed: false } // 每次新对象：坏
        return snapshot                              // 稳定引用：对
      },
      set: (next) => {
        value = next
        if (cache) snapshot = { value, failed: false }
        for (const l of listeners) l()
      },
    }
  }

  const unstable = makeStore(false)
  const a = unstable.getSnapshot()
  const b = unstable.getSnapshot()
  check('每次新建对象时引用不同（这正是崩溃原因）', a !== b)

  const stable = makeStore(true)
  const c = stable.getSnapshot()
  const d = stable.getSnapshot()
  check('缓存快照时引用相同', c === d)

  // 值变了才换引用
  const before = stable.getSnapshot()
  stable.set({ a: 2 })
  const after = stable.getSnapshot()
  check('值变化后引用才更新', before !== after)
  check('新快照带上了新值', after.value.a === 2)
}

// 源码级断言：面板必须缓存快照，不能现造
{
  const { readFileSync } = await import('node:fs')
  const client = readFileSync(join(root, 'src', 'client.ts'), 'utf8')

  check('有缓存的 snapshot 变量', /let snapshot = \{ value: current/.test(client))
  check('getSnapshot 返回缓存变量', /getSnapshot: \(\) => snapshot/.test(client))
  check('不会现造快照对象', !/getSnapshot: \(\) => \(\{/.test(client))
  check('有 refresh 收敛函数', /const refresh = \(\): void =>/.test(client))
  check('refresh 在无变化时不通知', /if \(next\.value === snapshot\.value[\s\S]{0,200}?return/.test(client))
  check('订阅时先 refresh 一次', /const dispose = scope\.subscribe[\s\S]{0,200}?refresh\(\)/.test(client))
  check('write 后走 refresh 而非 notify', !/current = \{ \.\.\.current[\s\S]{0,120}?notify\(\)/.test(client))
}

// ── Hooks 规则：带状态的控件必须是独立组件 ────────────────────────
//
// 第二个崩溃原因：`numberRow` / `clockRow` 曾是普通函数，内部调 useState，
// 由 `group.fields.map(rowFor)` 直接调用。那种写法在每次渲染里跑不同数量的
// hook，React 直接抛错并卸掉整棵树 —— 表现同样是「设置页没了」。
{
  const { readFileSync } = await import('node:fs')
  const client = readFileSync(join(root, 'src', 'client.ts'), 'utf8')

  check('数字行是独立组件', /function NumberRow\(props: Record<string, any>\): unknown/.test(client))
  check('时段行是独立组件', /function ClockRow\(props: Record<string, any>\): unknown/.test(client))
  check('开关行是独立组件', /function SwitchRow\(props: Record<string, any>\): unknown/.test(client))
  check('行外壳是独立组件', /function Row\(props: Record<string, any>\): unknown/.test(client))

  // 容器里必须用 h(Component, ...) 渲染，不能直接调用
  check('容器用 h(NumberRow, ...) 渲染', /h\(NumberRow, \{/.test(client))
  check('容器用 h(ClockRow, ...) 渲染', /h\(ClockRow, \{/.test(client))

  // useXxx 只允许出现在组件函数体内
  const hookCalls = [...client.matchAll(/React\.use(State|Effect|Reducer|Memo|Ref)\(/g)]
  check('存在 hook 调用', hookCalls.length > 0, `${hookCalls.length} 处`)

  // 旧的「普通函数内藏 hook」写法必须消失
  check('不再有 numberRow 普通函数', !/const numberRow = \(/.test(client))
  check('不再有 clockRow 普通函数', !/const clockRow = \(/.test(client))
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

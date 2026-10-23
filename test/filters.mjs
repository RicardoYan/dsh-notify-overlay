// 锁定提醒过滤的四条规则。
//
//   node test/filters.mjs
//
// 1. DSH 在前台时**只响声音**，不弹卡片：窗口自己已经用黄点（等你回答）和
//    蓝点（回答完成）标出来了，再画卡片只会盖住用户正在看的内容。
// 2. 不记时间、不搞宽限窗口：只问「DSH 现在是不是前台」。
// 3. 子代理的提醒要指向**最顶层父会话**，因为只有顶层会话能在界面里打开。
// 4. 子代理完成只在**整棵子树都空闲**时提示一次。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const host = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
const client = readFileSync(join(root, 'src', 'client.ts'), 'utf8')
const native = readFileSync(join(root, 'src', 'native', 'OverlayWindow.cs'), 'utf8')

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

// ── 1. 没有总开关 ─────────────────────────────────────────────────
{
  check('Host Config 没有 enabled', !/^\s{2}enabled:\s*z\./m.test(host))
  check('cfg() 不读 enabled', !/config\.enabled\.get\(\)/.test(host))
  check('notify() 没有总开关分支', !/总开关关闭/.test(host))
  check('面板没有 enabled 行', !/field:\s*'enabled'/.test(client))
}

// ── 2. 三档：正在看的静默 / DSH 在前的只响 / 后台的弹卡片 ─────────
{
  check('有 lookingAt 判定', /function lookingAt\(sessionId: string\): boolean/.test(host))
  check('同时比 focused 和 sessionId', /onScreen\.focused && onScreen\.sessionId === sessionId/.test(host))
  check('有 chooseChannel 统一决策', /function chooseChannel\(sessionId: string\): Channel/.test(host))
  check('三种通道', /type Channel = 'card' \| 'sound' \| 'silent'/.test(host))
  check('正在看 → silent', /if \(lookingAt\(sessionId\)\) return 'silent'/.test(host))
  check('DSH 在前 → sound', /if \(onScreen\.focused\) return 'sound'/.test(host))
  check('其余 → card', /return 'card'\s*\n\s*\}/.test(host))
  check('删掉了只看前台的 dshInFront', !/function dshInFront/.test(host))

  // 语义建模：与 chooseChannel 同构
  const chooseChannel = (onScreen, sessionId) => {
    if (onScreen.focused && onScreen.sessionId === sessionId) return 'silent'
    if (onScreen.focused) return 'sound'
    return 'card'
  }
  const here = { focused: true, sessionId: 'A' }

  check('正在看 A、事件属于 A → 静默', chooseChannel(here, 'A') === 'silent')
  check('正在看 A、事件属于 B → 只响声音', chooseChannel(here, 'B') === 'sound')
  check('DSH 在后台、事件属于 A → 弹卡片', chooseChannel({ focused: false, sessionId: 'A' }, 'A') === 'card')
  check('DSH 在后台、事件属于 B → 弹卡片', chooseChannel({ focused: false, sessionId: 'B' }, 'B') === 'card')
  check('无当前会话但在前台 → 只响', chooseChannel({ focused: true, sessionId: null }, 'A') === 'sound')
}

// ── 2a. 当前会话的读法必须与官方一致 ──────────────────────────────
//
// 踩过的坑：`ctx.sessions.list` 是**store 对象**，不是函数。写成 `list()` 会
// 抛错，被 catch 吞成永久 null → onScreen.sessionId 永远是 null →
// lookingAt 永远 false → 正在看的会话也会响。官方读法见
// dsh-client-ui-workspace 的 mainSessionId()：`list.getSnapshot().byId`。
{
  check('用 list.getSnapshot 读快照', /list\?\.getSnapshot\?\.\(\)\?\.byId/.test(client))
  check('不把 list 当函数调用', !/sessions\?\.list\?\.\(\)/.test(client))

  // 行为建模：两种写法在真实形状上的差别
  const sessions = {
    list: {
      getSnapshot: () => ({ byId: { 'session-abc': { id: 'session-abc', retainedBy: { mainView: 1 } } } }),
    },
  }
  const readCorrect = (s) => {
    const byId = s?.list?.getSnapshot?.()?.byId
    if (byId === undefined) return null
    for (const id of Object.keys(byId)) {
      if ((byId[id]?.retainedBy?.mainView ?? 0) > 0) return id
    }
    return null
  }
  const readWrong = (s) => {
    try {
      const state = (s?.list?.() ?? s)
      const byId = state?.byId
      if (byId === undefined) return null
      return Object.keys(byId)[0] ?? null
    } catch {
      return null
    }
  }

  check('正确读法拿到当前会话', readCorrect(sessions) === 'session-abc')
  check('旧写法拿到 null（这就是漏响的原因）', readWrong(sessions) === null)
}

// ── 2b. 声音由 TS 单一决策，浮窗不判断 ────────────────────────────
{
  check('host 发独立 sound 指令', /send\(\{ op: 'sound' \}\)/.test(host))
  check('sound 受 c.sound 开关控制', /if \(c\.sound\) send\(\{ op: 'sound' \}\)/.test(host))
  // 位置关系而不是距离：中间多了系统通知分支也不该让这条断言失效。
  // 要求 lastSent.set 先出现，op: 'sound' 在它之后。
  check('sound 在去重之后发', (() => {
    const dedupe = host.indexOf("lastSent.set(sessionId, { kind: reminder.kind, at: now })")
    const sound = host.indexOf("op: 'sound'")
    return dedupe !== -1 && sound !== -1 && dedupe < sound
  })())
  check('sound 通道不再退化成卡片', !/channel === 'sound' && canRing/.test(host))
  check('静音时不弹卡片（保持静默）', /if \(channel === 'sound'\) \{/.test(host))
  check('不在 notify 消息里带 sound 标志', !/sound: c\.sound,/.test(host))
  check('浮窗能处理 sound 指令', /case "sound":/.test(native))
  check('浮窗的 sound 只响不放', /case "sound":[\s\S]{0,240}?PlayChime\(\)[\s\S]{0,60}?break;/.test(native))
  check('卡片不再自带响铃', !/mode = Mode\.Card;\s*\n\s*Render\(\);\s*\n\s*PlayChime\(\);/.test(native))
  check('浮窗没有自己的声音开关', !/bool playSound/.test(native))
  check('PlayChime 不再判开关', !/if \(!playSound\) return/.test(native))
  check('删掉了 chime 指令', !/case "chime":/.test(native))

  const soundSites = (native.match(/PlayChime\(\);/g) ?? []).length
  check('浮窗只在 sound 指令里响铃（1 处）', soundSites === 1, `找到 ${soundSites} 处`)
}

// ── 2b2. 声音开关 × 三种通道的完整矩阵 ────────────────────────────
//
// 「声音关」就是不要吵。此时 DSH 在前台，屏幕上的黄点/蓝点已经是通知本身，
// 静默是正确结果——**不能**退化成卡片去挡用户正在读的内容。
{
  // 与源码同构
  const deliver = (channel, canRing) => {
    if (channel === 'silent') return []
    const actions = []
    if (canRing) actions.push('sound')
    if (channel === 'sound') return actions
    actions.push('card')
    return actions
  }

  check('静默 + 有声 → 什么都不做', deliver('silent', true).length === 0)
  check('静默 + 静音 → 什么都不做', deliver('silent', false).length === 0)
  check('只响 + 有声 → 只有声音', JSON.stringify(deliver('sound', true)) === '["sound"]')
  check('只响 + 静音 → 静默（不弹卡片）', JSON.stringify(deliver('sound', false)) === '[]')
  check('卡片 + 有声 → 声音和卡片', JSON.stringify(deliver('card', true)) === '["sound","card"]')
  check('卡片 + 静音 → 只有卡片', JSON.stringify(deliver('card', false)) === '["card"]')

  // 静默只允许出现在「正在看」或「前台且静音」两种明确情形
  check('正在看时永不发声', deliver('silent', true).includes('sound') === false)
  check('声音开时 sound 通道一定响', deliver('sound', true).includes('sound') === true)
  check('卡片通道永不被静音吃掉', deliver('card', false).includes('card') === true)
}

// ── 2c. 去重覆盖所有通道 ──────────────────────────────────────────
{
  const gate = (() => {
    const last = new Map()
    return (sessionId, kind, now) => {
      const prev = last.get(sessionId)
      if (prev !== undefined && prev.kind === kind && now - prev.at < 5000) return false
      last.set(sessionId, { kind, at: now })
      return true
    }
  })()
  const results = [
    gate('A', 'turn', 1000),
    gate('A', 'turn', 1500),
    gate('A', 'turn', 7000),
  ]
  check('5 秒内重复被去重', results.join(',') === 'true,false,true')
  check('不同会话互不影响', gate('B', 'turn', 7100) === true)
}

// ── 3. 没有宽限窗口 ───────────────────────────────────────────────
{
  check('删掉了 FOCUS_GRACE_MS', !/FOCUS_GRACE_MS/.test(host))
  check('不再记时间', !/at: Date\.now\(\),\s*\n\s*\}/.test(host))
  check('onScreen 有 sessionId 和 focused', /let onScreen: \{ sessionId: string \| null; focused: boolean \}/.test(host))
}

// ── 4. 子代理 → 最顶层父会话 ──────────────────────────────────────
{
  check('有 rootSessionOf', /function rootSessionOf\(sessionId: string\): string/.test(host))
  check('读 header.parentSession', /header\?\.parentSession/.test(host))
  check('沿父链向上走', /current = parent/.test(host))
  check('有防环', /seen\.has\(parent\)/.test(host))
  check('有步数上限', /step < 32/.test(host))
  check('父会话不在世时停下', /sessions\.get\?\.\(parent\) === undefined\) return current/.test(host))
  check('有 isSubagentSession', /function isSubagentSession\(sessionId: string\): boolean/.test(host))
  check('判 origin === subagent', /header\?\.origin === 'subagent'/.test(host))
  check('有 targetOf', /function targetOf\(sessionId: string\)/.test(host))
  check('审批指向根', /kind: 'approval'/.test(host) && /targetOf\(agentId\)\.root/.test(host))
  check('提问指向根', /kind: 'question'/.test(host))
  check('出错指向根', /const \{ root, subagent \} = targetOf\(agentId\)/.test(host))
  check('子代理出错有单独标题', /Subagent failed/.test(host))
}

// ── 4b. rootSessionOf 行为建模 ────────────────────────────────────
{
  const rootSessionOf = (sessions, sessionId) => {
    let current = sessionId
    const seen = new Set([current])
    for (let step = 0; step < 32; step++) {
      const parent = sessions.get(current)?.header?.parentSession
      if (typeof parent !== 'string' || parent === '') return current
      if (seen.has(parent)) return current
      if (sessions.get(parent) === undefined) return current
      seen.add(parent)
      current = parent
    }
    return current
  }

  const make = (map) => ({ get: (id) => (Object.hasOwn(map, id) ? { header: map[id] } : undefined) })

  check('顶层会话返回自身', rootSessionOf(make({ A: {} }), 'A') === 'A')

  const deep = make({ R: {}, C: { parentSession: 'R' }, G: { parentSession: 'C' } })
  check('子代理指向根', rootSessionOf(deep, 'C') === 'R')
  check('嵌套子代理也指向根', rootSessionOf(deep, 'G') === 'R')

  const deeper = make({
    R: {}, C1: { parentSession: 'R' }, C2: { parentSession: 'C1' }, C3: { parentSession: 'C2' },
  })
  check('四层嵌套指向根', rootSessionOf(deeper, 'C3') === 'R')

  check('父不在世时停在自身', rootSessionOf(make({ G: { parentSession: 'GONE' } }), 'G') === 'G')

  const cyclic = make({ A: { parentSession: 'B' }, B: { parentSession: 'A' } })
  check('环不会挂死', typeof rootSessionOf(cyclic, 'A') === 'string')
  check('自指返回自身', rootSessionOf(make({ A: { parentSession: 'A' } }), 'A') === 'A')
  check('未知会话返回自身', rootSessionOf(make({}), 'X') === 'X')
}

// ── 5. 子代理完成只在整树空闲时提示 ───────────────────────────────
{
  check('有 anyDescendantRunning', /function anyDescendantRunning\(root: string\): boolean/.test(host))
  check('提示前先查同树是否还在跑', /if \(anyDescendantRunning\(root\)\)/.test(host))
  check('文案改成「全部完成」', /子代理全部完成/.test(host))

  const running = new Map([['R', false], ['C1', false], ['C2', false], ['C3', true]])
  const rootOf = { R: 'R', C1: 'R', C2: 'R', C3: 'R' }
  const anyRunning = (root) => {
    for (const [id, isRunning] of running) {
      if (!isRunning || id === root) continue
      if (rootOf[id] === root) return true
    }
    return false
  }
  check('还有子代理在跑 → 不提示', anyRunning('R') === true)
  running.set('C3', false)
  check('全部空闲 → 提示', anyRunning('R') === false)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

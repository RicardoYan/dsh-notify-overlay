// 复现并锁定 waterfall 短路问题。
//
//   node test/waterfall.mjs
//
// 背景：`approval/request` 与 `user-questions/request` 是 waterfall 事件。
// `dsh-api-remotes` 先注册了一个转发器，把请求交给浏览器面板回答，拿到结果后
// 直接 resolve，**不调用 next()** —— 链在这里就断了。之后注册的监听器不会执行。
//
// 这解释了实测现象：`agent/status`（emit）能收到，这两个（waterfall）收不到。
//
// 这个测试用真实的 cordis 跑最小场景，不依赖 DSH 运行时。
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const cordisEntry = join(
  here, '..', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js',
)

const { Context: Ctx } = await import(cordisEntry).catch(() => import('@deepseek-ai/cordis'))

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} (want ${expected}, got ${actual})`)
}

// ── 场景 1：后注册的监听器被不调用 next() 的前一个短路 ──────────────
{
  const ctx = new Ctx()
  const seen = []

  // 转发器：模拟 dsh-api-remotes，拿到"面板答案"后直接返回，不调 next()
  ctx.on('approval/request', async (req) => {
    seen.push('forwarder')
    return { outcome: 'allow' }
  })

  // 我们的观察者：后注册，同优先级
  ctx.on('approval/request', async (req, next) => {
    seen.push('observer')
    return next()
  })

  const result = await ctx.waterfall('approval/request', { id: 1 }, async () => {
    seen.push('default')
    return { outcome: 'deny' }
  })

  check('场景1 只跑了转发器', seen.join(','), 'forwarder')
  check('场景1 结果是转发器的答案', result.outcome, 'allow')
}

// ── 场景 2：prepend 的观察者先跑，再委派给转发器 ──────────────────
{
  const ctx = new Ctx()
  const seen = []

  ctx.on('approval/request', async (req) => {
    seen.push('forwarder')
    return { outcome: 'allow' }
  })

  ctx.on('approval/request', async (req, next) => {
    seen.push('observer')
    return next()
  }, { prepend: true })

  const result = await ctx.waterfall('approval/request', { id: 2 }, async () => {
    seen.push('default')
    return { outcome: 'deny' }
  })

  check('场景2 观察者在转发器之前', seen.join(','), 'observer,forwarder')
  check('场景2 答案未被我们篡改', result.outcome, 'allow')
}

// ── 场景 3：emit 事件不受影响，所有监听器都跑 ────────────────────
{
  const ctx = new Ctx()
  const seen = []

  ctx.on('agent/status', () => { seen.push('first') })
  ctx.on('agent/status', () => { seen.push('second') })

  ctx.emit('agent/status', { status: 'idle' })

  check('场景3 emit 两个都跑', seen.join(','), 'first,second')
}

// ── 场景 4：观察者抛错不能污染 waterfall ────────────────────────
{
  const ctx = new Ctx()
  ctx.on('approval/request', async () => ({ outcome: 'allow' }))
  ctx.on('approval/request', (_req, next) => {
    try { throw new Error('观察者出错') } catch { /* 必须自己吞掉 */ }
    return next()
  }, { prepend: true })

  const result = await ctx.waterfall('approval/request', { id: 4 }, async () => ({ outcome: 'deny' }))
  check('场景4 观察者抛错仍放行', result.outcome, 'allow')
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

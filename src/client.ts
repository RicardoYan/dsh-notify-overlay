/**
 * dsh-notify-overlay — browser half.
 *
 * Registers through `window.__ModuleLoader__.load`, the same entry point every
 * DSH client bundle uses; a plain ES module with `export`s is not loadable here
 * (the page concatenates classic scripts, so an `export` would be a syntax
 * error and the whole app would fail to compose).
 *
 * What this half does:
 *
 *   1. Reads the active DSH theme and reports it, so the overlay follows
 *      light/dark automatically.
 *   2. Fetches the conversation the overlay asked to open and navigates there.
 *   3. Reports the conversation currently on screen, so an error reminder for it
 *      can be withdrawn — opening the conversation counts as handling the error.
 *
 * Navigation has to happen on this side because `uiWorkspace.openSession` only
 * exists in the renderer: an overlay click reaches the Host, the Host caches the
 * id, this half polls it, and the renderer performs the jump.
 *
 * It also owns the settings panel — see `registerSettings` for why a plugin with
 * a `Config` schema still has no UI unless it registers one itself.
 */
import type { Context } from '@deepseek-ai/cordis'

const NS = 'dsh-notify-overlay'

const PENDING = '/api/notify-overlay/pending'
const ACK = '/api/notify-overlay/ack'
const THEME = '/api/notify-overlay/theme'
const ACTIVE = '/api/notify-overlay/active'
/** Diagnostic channel: what the click-to-jump path actually did. */
const JUMP = '/api/notify-overlay/jump'

/** How often the pending navigation is polled; bounds the click-to-jump delay. */
const POLL_MS = 800

/** How often the on-screen conversation is sampled. */
const ACTIVE_POLL_MS = 1000

/** A session summary as the renderer's session store exposes it. */
interface SessionSummary {
  id?: string
  retainedBy?: { mainView?: number }
}

/** The module loader the renderer installs before running client bundles. */
interface ModuleLoader {
  load(registration: {
    id: string
    factory: (require: (id: string) => unknown) => unknown
  }): void
}

declare global {
  interface Window {
    __ModuleLoader__?: ModuleLoader
  }
}


/**
 * Where the settings panel lives.
 *
 * `plugins.bundle.config` is a **keyed** slot owned by the Plugins page
 * (`dsh-client-ui-plugin-manager`), rendered on a bundle's card between its
 * description and its rows. It is empty unless a client half registers into it:
 * a Host `Config` schema alone produces no UI, because nothing in the browser
 * consumes the `autoGenerate` descriptor `dsh-settings` computes.
 */
const SETTINGS_SLOT = 'plugins.bundle.config'

/** Config key the form model is bound to: the profile entry id from the patch. */
const CONFIG_NS = 'notify-overlay'

/**
 * Panel copy, registered through the locale service.
 *
 * `ctx.locale.bind(NS)` resolves a key against the active language with the
 * shared fallback chain. Reading a preference field directly is not part of the
 * service's surface — guessing at one left the panel permanently in Chinese.
 */
const ZH = {
  nav: '通知浮窗',
  groupDelivery: '通知方式',
  groupEvents: '提醒类型',
  groupLook: '显示与声音',
  groupQuiet: '免打扰',
  intro: '控制哪些提醒会出现在屏幕右下角。审批、提问和出错会一直留着，直到你处理完。',
  fieldOverlay: '用浮窗提醒',
  hintOverlay: '关闭后改用系统通知。系统通知只能提醒，点击没有反应。',
  fieldApproval: '审批提醒',
  hintApproval: '需要你授权工具调用时提醒。',
  fieldQuestion: '提问提醒',
  hintQuestion: 'Agent 有问题要问你时提醒。',
  fieldError: '出错提醒',
  hintError: '执行失败时提醒。打开那个对话即视为已处理。',
  fieldTurnDone: '轮次完成',
  hintTurnDone: '一轮回答结束时提醒。',
  fieldSubagent: '子代理完成',
  hintSubagent: '所有子代理都跑完时提醒一次。',
  fieldSessionDone: '会话结束',
  hintSessionDone: '会话被删除时提醒。',
  fieldAutoHide: '卡片停留时长（毫秒）',
  hintAutoHide: '3 秒到 8 秒之间。超时后持久提醒收进小球，其余直接消失。',
  fieldScale: '界面缩放',
  hintScale: '0.6 到 1.8 倍。',
  fieldSound: '提示音',
  hintSound: '有提醒时播放声音。',
  fieldQuiet: '免打扰时段',
  hintQuiet: '开启后，在该时段内不打扰。审批和提问不受影响。',
  fieldQuietStart: '开始时间',
  hintQuietStart: '24 小时制，形如 22:00。',
  fieldQuietEnd: '结束时间',
  fieldHour: '小时',
  fieldMinute: '分钟',
  hintQuietEnd: '24 小时制，形如 08:00。可跨午夜。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '保存失败',
  unavailable: '当前不可编辑',
  readOnly: '只读',
  overridden: '已修改',
  reset: '恢复默认',
  invalid: '格式不对',
}

const EN: typeof ZH = {
  nav: 'Notification overlay',
  groupDelivery: 'Delivery',
  groupEvents: 'What to remind you about',
  groupLook: 'Display and sound',
  groupQuiet: 'Quiet hours',
  intro: 'Choose which reminders appear at the bottom right. Approvals, questions, and failures stay until you deal with them.',
  fieldOverlay: 'Use the overlay window',
  hintOverlay: 'Off switches to system notifications. They only remind you — clicking does nothing.',
  fieldApproval: 'Approvals',
  hintApproval: 'When a tool call needs your authorization.',
  fieldQuestion: 'Questions',
  hintQuestion: 'When the agent asks you something.',
  fieldError: 'Failures',
  hintError: 'When a run fails. Opening that conversation counts as handling it.',
  fieldTurnDone: 'Turn complete',
  hintTurnDone: 'When a reply finishes.',
  fieldSubagent: 'Subagent finished',
  hintSubagent: 'Once when every subagent has finished.',
  fieldSessionDone: 'Conversation closed',
  hintSessionDone: 'When a conversation is deleted.',
  fieldAutoHide: 'Card dwell time (ms)',
  hintAutoHide: 'Between 3 and 8 seconds. After it expires, persistent reminders move to the ball and the rest disappear.',
  fieldScale: 'Scale',
  hintScale: '0.6 to 1.8.',
  fieldSound: 'Sound',
  hintSound: 'Play a sound when a reminder arrives.',
  fieldQuiet: 'Quiet hours',
  hintQuiet: 'Silence reminders inside the window. Approvals and questions are never silenced.',
  fieldQuietStart: 'Start',
  hintQuietStart: '24-hour, like 22:00.',
  fieldQuietEnd: 'End',
  fieldHour: 'Hour',
  fieldMinute: 'Minute',
  hintQuietEnd: '24-hour, like 08:00. May cross midnight.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'Could not save',
  unavailable: 'Not editable here',
  readOnly: 'Read-only',
  overridden: 'Changed',
  reset: 'Reset',
  invalid: 'Invalid',
}

window.__ModuleLoader__?.load({
  id: NS,
  factory: (require: (id: string) => unknown) => ({
    name: NS,
    inject: ['slots', 'locale'],
    apply(ctx: Context & Record<string, any>): void {
      // ── Theme ───────────────────────────────────────────────
      /** DSH marks dark mode with a `data-ds-dark-theme` attribute on `<body>`. */
      const isDark = (): boolean =>
        typeof document !== 'undefined'
        && document.body?.hasAttribute?.('data-ds-dark-theme') === true

      let lastDark: boolean | null = null

      async function pushTheme(): Promise<void> {
        const dark = isDark()
        if (dark === lastDark) return
        lastDark = dark
        try {
          await fetch(THEME, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dark }),
          })
        } catch {
          // Host not ready yet; the next mutation retries.
          lastDark = null
        }
      }

      ctx.effect(() => {
        if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
          return () => {}
        }
        const observer = new MutationObserver(() => { void pushTheme() })
        observer.observe(document.body, {
          attributes: true,
          attributeFilter: ['data-ds-dark-theme'],
        })
        void pushTheme()
        return () => observer.disconnect()
      }, 'notify-overlay: theme observer')

      /**
       * Record what the click-to-jump path did, for the Host's trace log.
       *
       * The failure mode is silent by nature — a card is clicked, nothing moves,
       * and there is no error anywhere. Without this line the Host log cannot
       * distinguish "never polled" from "polled but no navigation seam".
       * @param detail - what happened.
       */
      async function reportJump(detail: string): Promise<void> {
        try {
          await fetch(JUMP, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ detail }),
          })
        } catch {
          // Host gone; the log line is a convenience, not a requirement.
        }
      }

      // ── Pending navigation → open the conversation ─────────
      // The window-side click already called FocusDsh, so DSH is on its way to the
      // foreground. The old guard required `document.hasFocus()` here, which races
      // that transition: the first poll after a click can still see the window
      // unfocused, and the pending id then waits for an unrelated later poll. It
      // also blocked the jump outright when the window was restored from minimized.
      //
      // Visibility is still required (the renderer must be painting), but focus is
      // not: the click just asked for the jump, so honouring it is correct even if
      // this document has not received focus yet — `openSession` works regardless.
      async function drainPending(): Promise<void> {
        if (typeof document === 'undefined') return
        if (document.visibilityState !== 'visible') return

        let sessionId: string | null = null
        try {
          const res = await fetch(PENDING, { cache: 'no-store' })
          if (!res.ok) return
          const body = await res.json() as { sessionId?: string | null }
          sessionId = body?.sessionId ?? null
        } catch {
          return
        }
        if (sessionId === null) return

        try {
          const workspace = ctx.get('uiWorkspace')
          if (typeof workspace?.openSession === 'function') {
            workspace.openSession(sessionId)
            void reportJump(`openSession ${sessionId}`)
          } else if (typeof ctx.get('sessions')?.open === 'function') {
            ctx.get('sessions').open(sessionId)
            void reportJump(`sessions.open ${sessionId}`)
          } else {
            // Neither seam is mounted: record it, because the visible symptom is
            // "clicked the card and nothing happened".
            void reportJump(`no navigation seam for ${sessionId}`)
          }
        } catch (error) {
          void reportJump(`openSession threw: ${String(error)}`)
        }

        try {
          await fetch(ACK, { method: 'POST' })
        } catch {
          // Host gone; the next poll starts over.
        }
      }

      ctx.effect(() => {
        if (typeof window === 'undefined') return () => {}
        const timer = window.setInterval(() => { void drainPending() }, POLL_MS)
        const onFocus = (): void => { void drainPending() }
        window.addEventListener('focus', onFocus)
        return () => {
          window.clearInterval(timer)
          window.removeEventListener('focus', onFocus)
        }
      }, 'notify-overlay: pending poller')

      // ── Window focus ──────────────────────────────────────────
      //
      // The Host only needs one fact: is DSH the window the user is looking at?
      // When it is, the UI already says everything (amber = waiting for an
      // answer, blue = finished), so reminders only ring; when it is not, a card
      // is the only way to be noticed.
      //
      // `hasFocus()` is the honest signal — `visibilityState` alone stays
      // `visible` behind another application, which would silence every reminder
      // for someone working in another window.
      //
      // The main-view session is still reported, but only so the Host can
      // withdraw an error reminder for the conversation being opened.
      let lastPushed = ''

      /**
       * The conversation the main view shows, or null.
       *
       * `ctx.sessions.list` is a store, not a function — the snapshot comes from
       * `list.getSnapshot()`, exactly as the shipped UI reads it
       * (`dsh-client-ui-workspace`, `mainSessionId()`). Calling `list()` throws,
       * and the catch below swallowed that into a permanent `null`, so every
       * reminder looked like it belonged to some other conversation and rang
       * instead of staying quiet.
       */
      function readMainSessionId(): string | null {
        try {
          const sessions = ctx.get('sessions') as
            { list?: { getSnapshot?: () => { byId?: Record<string, SessionSummary> } } } | undefined
          const byId = sessions?.list?.getSnapshot?.()?.byId
          if (byId === undefined) return null
          for (const id of Object.keys(byId)) {
            if ((byId[id]?.retainedBy?.mainView ?? 0) > 0) return id
          }
        } catch {
          // Session store unavailable this tick.
        }
        return null
      }

      async function pushActive(): Promise<void> {
        const sessionId = readMainSessionId()
        const focused = typeof document !== 'undefined'
          && document.visibilityState === 'visible'
          && document.hasFocus()

        const key = `${sessionId ?? ''}|${focused}`
        if (key === lastPushed) return
        const previous = lastPushed
        lastPushed = key
        try {
          await fetch(ACTIVE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, focused }),
          })
        } catch {
          // Host gone: forget the sent value so the next tick retries.
          lastPushed = previous
        }
      }

      ctx.effect(() => {
        if (typeof window === 'undefined') return () => {}
        const timer = window.setInterval(() => { void pushActive() }, ACTIVE_POLL_MS)
        const onFocus = (): void => { void pushActive() }
        const onVisibility = (): void => { void pushActive() }
        window.addEventListener('focus', onFocus)
        window.addEventListener('blur', onFocus)
        document.addEventListener('visibilitychange', onVisibility)
        void pushActive()
        return () => {
          window.clearInterval(timer)
          window.removeEventListener('focus', onFocus)
          window.removeEventListener('blur', onFocus)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, 'notify-overlay: on-screen reporter')

      // The panel's copy lives in the locale catalog, not in a side table: that
      // is what makes it follow a language switch without remounting.
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'notify-overlay: dictionaries')

      registerSettings(ctx, require)
    },
  }),
})

/**
 * Mount the settings panel into the Plugins page.
 *
 * Everything here is reached through the injected `require`, because this bundle
 * is a classic script: it has no module graph of its own, and the renderer's
 * loader hands each `require` call a module the page already holds.
 * @param ctx - the browser plugin context.
 * @param require - the loader's module resolver; the panel's primitives come
 *   through it because this bundle is a classic script with no module graph.
 */
function registerSettings(
  ctx: Context & Record<string, any>,
  require: (id: string) => unknown,
): void {
  ctx.inject(['slots', 'locale', 'configForms'], (child: Context & Record<string, any>) => {
    // `configForms` may be absent on surfaces without a configurable profile.
    // Read it through the injected child, never off the root context.
    const forms = child.configForms
    if (forms === undefined || typeof forms.get !== 'function') return

    let scope
    try {
      scope = forms.get(CONFIG_NS)
    } catch {
      return
    }
    if (scope === undefined) return

    child.effect(() => child.slots.inject(SETTINGS_SLOT, () => child.slots.register({
      name: SETTINGS_SLOT,
      // Keyed slot: the page looks the entry up by the bundle's package name, so
      // `key` is required. `id` would register an entry nobody dispatches.
      key: NS,
      locale: NS,
      inject: () => createPanel(ctx, scope, require, child),
    }, SettingsPanel as any)), 'notify-overlay: settings panel')
  })
}

/**
 * Stylesheet for the panel.
 *
 * Client bundles cannot import CSS, so DSH's own plugins inline a `<style>`. The
 * panel renders inside an official card on the Plugins page, so only the form
 * itself is dressed here — no outer card, no heading. Every colour is a
 * `--dsw-alias-*` token; a raw hex value would be wrong in one of the two themes.
 *
 * Geometry mirrors the shipped plugin settings pages: 0.5px separators, 14px row
 * titles, 12.5–13px secondary text, 28px controls.
 */
const PANEL_CSS = `
.nsh-form{box-sizing:border-box;display:grid;gap:18px;padding:16px 0}
.nsh-group{display:grid;gap:2px}
.nsh-groupTitle{margin:0 0 4px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:.04em}
.nsh-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.nsh-row:last-child{border-bottom:0}
.nsh-rowText{flex:1;min-width:0;display:grid;gap:3px}
.nsh-rowTitle{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}
.nsh-rowDesc{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:18px}
.nsh-field{flex:none;display:flex;align-items:center;gap:8px}
.nsh-number{appearance:none;width:88px;height:28px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-variant-numeric:tabular-nums;padding:0 8px}
.nsh-number:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.nsh-number[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}
.nsh-number:disabled{opacity:.45}
/* 时段：两个等宽数字框加冒号，不用原生 time 控件（它会弹出不跟主题的系统选择器）。 */
.nsh-clockGroup{display:inline-flex;align-items:center;gap:4px}
.nsh-clock{appearance:none;width:34px;height:28px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-variant-numeric:tabular-nums;text-align:center;padding:0}
.nsh-clock:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.nsh-clock:disabled{opacity:.45}
.nsh-colon{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1;user-select:none}
/* 依赖项关闭时整行（标题+说明+控件）一起变淡，明确「现在不生效」。 */
.nsh-row[data-dimmed="true"] .nsh-rowTitle,.nsh-row[data-dimmed="true"] .nsh-rowDesc,.nsh-row[data-dimmed="true"] .nsh-colon{opacity:.5}
.nsh-status{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.nsh-status[data-error="true"]{color:var(--dsw-alias-state-error-primary)}
`

/** Element id carrying {@link PANEL_CSS}, so it is inserted exactly once. */
const STYLE_ID = 'dsh-notify-overlay-settings-css'

/**
 * Insert the panel stylesheet, once per page.
 * @returns a disposer that removes the tag when this plugin unloads.
 */
function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.getElementById(STYLE_ID) !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
  return () => {
    if (style.parentNode !== null) style.parentNode.removeChild(style)
  }
}

/** One editable setting row. */
interface FieldSpec {
  /** Config key; must match a `.volatile()` key in the Host `Config`. */
  field: string
  kind: 'switch' | 'number' | 'clock'
  /** Locale key for the row label. */
  labelKey: string
  /** Locale key for the explanation under the label. */
  hintKey: string
  /** Minimum accepted value, `number` only. */
  min?: number
  /** Maximum accepted value, `number` only. */
  max?: number
  /**
   * Another field this row is only meaningful under.
   *
   * Its control is disabled while the dependency is falsy: the quiet-hour times
   * describe a schedule that nothing consults while quiet hours are off, and an
   * editable field that changes nothing reads as broken.
   */
  dependsOn?: string
}

/**
 * Rows, grouped the way the panel renders them.
 *
 * Grouping is presentation only: every row writes one config key, and the Host
 * schema is flat.
 */
const GROUPS: ReadonlyArray<{ titleKey: string; fields: readonly FieldSpec[] }> = [
  {
    titleKey: 'groupDelivery',
    fields: [
      { field: 'overlay', kind: 'switch', labelKey: 'fieldOverlay', hintKey: 'hintOverlay' },
    ],
  },
  {
    titleKey: 'groupEvents',
    fields: [
      { field: 'approval', kind: 'switch', labelKey: 'fieldApproval', hintKey: 'hintApproval' },
      { field: 'question', kind: 'switch', labelKey: 'fieldQuestion', hintKey: 'hintQuestion' },
      { field: 'error', kind: 'switch', labelKey: 'fieldError', hintKey: 'hintError' },
      { field: 'turnDone', kind: 'switch', labelKey: 'fieldTurnDone', hintKey: 'hintTurnDone' },
      { field: 'subagent', kind: 'switch', labelKey: 'fieldSubagent', hintKey: 'hintSubagent' },
      { field: 'sessionDone', kind: 'switch', labelKey: 'fieldSessionDone', hintKey: 'hintSessionDone' },
    ],
  },
  {
    titleKey: 'groupLook',
    fields: [
      { field: 'autoHideMs', kind: 'number', labelKey: 'fieldAutoHide', hintKey: 'hintAutoHide', min: 3000, max: 8000 },
      { field: 'scale', kind: 'number', labelKey: 'fieldScale', hintKey: 'hintScale', min: 0.6, max: 1.8 },
      { field: 'sound', kind: 'switch', labelKey: 'fieldSound', hintKey: 'hintSound' },
    ],
  },
  {
    titleKey: 'groupQuiet',
    fields: [
      { field: 'quietHours', kind: 'switch', labelKey: 'fieldQuiet', hintKey: 'hintQuiet' },
      { field: 'quietStart', kind: 'clock', labelKey: 'fieldQuietStart', hintKey: 'hintQuietStart', dependsOn: 'quietHours' },
      { field: 'quietEnd', kind: 'clock', labelKey: 'fieldQuietEnd', hintKey: 'hintQuietEnd', dependsOn: 'quietHours' },
    ],
  },
]

/** Every configurable key, in display order. */
const FIELDS: readonly FieldSpec[] = GROUPS.flatMap((group) => group.fields)

/** The `HH:MM` shape the Host accepts for `quietStart` / `quietEnd`. */
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Whether the Host's schema would accept a candidate value.
 *
 * The panel writes on change instead of staging a draft, so it must reject bad
 * input itself — a rejected write would otherwise look like a control that
 * silently springs back.
 * @param spec - the row being edited.
 * @param value - the candidate value.
 * @returns true when the value may be written.
 */
function accepts(spec: FieldSpec, value: unknown): boolean {
  if (spec.kind === 'switch') return typeof value === 'boolean'
  if (spec.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
    if (spec.min !== undefined && value < spec.min) return false
    if (spec.max !== undefined && value > spec.max) return false
    return true
  }
  if (typeof value !== 'string') return false
  return CLOCK_PATTERN.test(value)
}

/**
 * Build the props the panel body receives.
 *
 * Unlike the staged `SettingsFormModel` the shipped text forms use, this panel
 * writes straight through: flipping a switch calls `scope.set(key, value)`. A
 * reminder toggle has no draft state worth previewing, and a save button would
 * make "off" ambiguous until pressed.
 * @param ctx - plugin context, used for locale.
 * @param scope - the config form from `configForms.get`.
 * @param require - the loader's module resolver.
 * @param child - the injected child context that owns the subscription.
 * @returns props for {@link SettingsPanel}.
 */
function createPanel(
  ctx: Context & Record<string, any>,
  scope: any,
  require: (id: string) => unknown,
  child: Context & Record<string, any>,
): Record<string, unknown> {
  const primitives = require('@deepseek-ai/dsh-client-ui-primitives') as any

  // The live snapshot is the panel's single source of truth; a write goes to the
  // Host and comes back through this subscription, so no local mirror can drift.
  const read = (): Record<string, unknown> => {
    const snapshot = scope.getSnapshot() ?? {}
    return (snapshot.value ?? {}) as Record<string, unknown>
  }

  let current = read()
  let failed = false

  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  /**
   * The snapshot handed to React.
   *
   * `useSyncExternalStore` compares this by reference on every render; returning
   * a freshly built object each call makes React believe the store changed on
   * every render, which spins until "Maximum update depth exceeded" tears the
   * page down. Keep one object and replace it only when something really moved.
   */
  let snapshot = { value: current, failed, writable: true }

  const refresh = (): void => {
    const shell = scope.getSnapshot() ?? {}
    const next = {
      value: current,
      failed,
      writable: shell.status === 'ready' && shell.writable !== false,
    }
    if (next.value === snapshot.value && next.failed === snapshot.failed && next.writable === snapshot.writable) {
      return
    }
    snapshot = next
    notify()
  }

  child.effect(() => {
    const dispose = scope.subscribe(() => {
      current = read()
      refresh()
    })
    refresh()
    return () => {
      if (typeof dispose === 'function') dispose()
      listeners.clear()
    }
  }, 'notify-overlay: settings subscription')

  child.effect(() => injectStyles(), 'notify-overlay: settings styles')

  // `bind` returns a translator closed over the catalog: it resolves against the
  // active language on every call, so a language switch re-renders correctly.
  const t = ctx.locale.bind(NS) as (key: string) => string

  return {
    hooks: {
      // Exposed to the component as `useNotifyOverlayPanel`.
      notifyOverlayPanel: {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    },
    t,
    groups: GROUPS,
    write: (spec: FieldSpec, value: unknown) => {
      if (!accepts(spec, value)) return false
      failed = false
      // Optimistic: reflect the change at once so the control does not lag, then
      // let the Host echo decide whether it stuck.
      current = { ...current, [spec.field]: value }
      refresh()
      try {
        Promise.resolve(scope.set(spec.field, value)).then(
          (accepted: unknown) => {
            if (accepted === false) {
              failed = true
              current = read()
              refresh()
            }
          },
          () => {
            failed = true
            current = read()
            refresh()
          },
        )
      } catch {
        failed = true
        current = read()
        refresh()
        return false
      }
      return true
    },
    primitives,
    react: require('react'),
  }
}

/**
 * One labelled row: text on the left, the control on the right.
 *
 * Kept as its own component so the numeric and clock rows may hold draft state:
 * calling `useState` from a helper that is merely invoked during `map` would run
 * a different number of hooks per render and take the tree down.
 * @param props - row copy plus the control element.
 */
function Row(props: Record<string, any>): unknown {
  const h = props.react.createElement
  return h('div', {
    className: 'nsh-row',
    'data-dimmed': props.dimmed === true ? 'true' : undefined,
  }, [
    h('label', { className: 'nsh-rowText', key: 'text', htmlFor: props.id }, [
      h('span', { className: 'nsh-rowTitle', key: 'title' }, props.title),
      h('span', { className: 'nsh-rowDesc', key: 'desc' }, props.desc),
    ]),
    h('span', { className: 'nsh-field', key: 'field' }, props.control),
  ])
}

/**
 * A boolean row.
 * @param props - panel props plus the field spec.
 */
function SwitchRow(props: Record<string, any>): unknown {
  const h = props.react.createElement
  const spec = props.spec as FieldSpec
  return h(Row, {
    react: props.react,
    title: props.t(spec.labelKey),
    desc: props.t(spec.hintKey),
    control: h(props.primitives.Switch, {
      checked: props.value === true,
      disabled: props.writable === false,
      label: props.t(spec.labelKey),
      onChange: (next: boolean) => props.write(spec, next),
    }),
  })
}

/**
 * A numeric row.
 *
 * The draft is local so an out-of-range intermediate value (`80` on the way to
 * `8000`) is never written; it commits on blur or Enter.
 * @param props - panel props plus the field spec.
 */
function NumberRow(props: Record<string, any>): unknown {
  const React = props.react
  const h = React.createElement
  const spec = props.spec as FieldSpec
  const id = `nsh-${spec.field}`
  const stored = props.value
  const [draft, setDraft] = React.useState(String(stored ?? ''))
  const [focused, setFocused] = React.useState(false)

  React.useEffect(() => {
    if (!focused) setDraft(String(stored ?? ''))
  }, [stored, focused])

  const commit = (): void => {
    if (draft.trim() === '') return
    const parsed = Number(draft)
    if (accepts(spec, parsed)) props.write(spec, parsed)
    else setDraft(String(stored ?? ''))
  }

  const invalid = draft.trim() !== '' && !accepts(spec, Number(draft))

  return h(Row, {
    react: React,
    id,
    dimmed: props.dimmed,
    title: props.t(spec.labelKey),
    desc: props.t(spec.hintKey),
    control: h('input', {
      id,
      className: 'nsh-number',
      type: 'number',
      value: draft,
      min: spec.min,
      max: spec.max,
      disabled: props.writable === false || props.dimmed === true,
      'aria-invalid': invalid ? 'true' : undefined,
      onFocus: () => setFocused(true),
      onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
      onBlur: () => { setFocused(false); commit() },
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') setDraft(String(stored ?? ''))
      },
    }),
  })
}

/**
 * A `HH:MM` row.
 *
 * Two plain digit inputs and a colon, not `type="time"`: the browser's native
 * time control opens an unstyled OS picker that ignores every theme token and
 * spills outside the card (seen in practice), so the field is composed by hand.
 *
 * The draft is local and commits on blur or Enter, so dragging from `22:00` to
 * `08:00` does not write `02:00` on the way through.
 * @param props - panel props plus the field spec.
 */
function ClockRow(props: Record<string, any>): unknown {
  const React = props.react
  const h = React.createElement
  const spec = props.spec as FieldSpec
  const id = `nsh-${spec.field}`
  const stored = String(props.value ?? '')
  const disabled = props.writable === false || props.dimmed === true

  /** Split `HH:MM` into its two halves; anything malformed starts empty. */
  const parts = (): [string, string] => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(stored)
    if (match === null) return ['', '']
    return [match[1] ?? '', match[2] ?? '']
  }

  const [hour, setHour] = React.useState(parts()[0])
  const [minute, setMinute] = React.useState(parts()[1])
  const [focused, setFocused] = React.useState(false)

  React.useEffect(() => {
    if (focused) return
    const [h0, m0] = parts()
    setHour(h0)
    setMinute(m0)
  }, [stored, focused])

  const commit = (): void => {
    const hh = hour.padStart(2, '0')
    const mm = minute.padStart(2, '0')
    const next = `${hh}:${mm}`
    if (CLOCK_PATTERN.test(next)) {
      if (next !== stored) props.write(spec, next)
      return
    }
    const [h0, m0] = parts()
    setHour(h0)
    setMinute(m0)
  }

  /** Two digits max, numeric only; the caller clamps the range on commit. */
  const digits = (value: string): string => value.replace(/\D/g, '').slice(0, 2)

  const box = (key: string, value: string, set: (next: string) => void, max: number, label: string) =>
    h('input', {
      key,
      className: 'nsh-clock',
      type: 'text',
      inputMode: 'numeric',
      maxLength: 2,
      value,
      disabled,
      'aria-label': label,
      onFocus: () => setFocused(true),
      onChange: (event: { target: { value: string } }) => {
        const next = digits(event.target.value)
        // Typing `9` into a two-digit slot means `09`, not an invalid `9`.
        if (next.length === 2 && Number(next) > max) return
        set(next)
      },
      onBlur: () => { setFocused(false); commit() },
      onKeyDown: (event: { key: string; target: { blur: () => void } }) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') {
          const [h0, m0] = parts()
          setHour(h0)
          setMinute(m0)
        }
        if (event.key === ':' || event.key === 'ArrowRight') {
          // `:` jumps to the minutes box, the way a time field should.
          const sibling = (event.target as unknown as { nextElementSibling?: { focus?: () => void } })
            ?.nextElementSibling
          sibling?.focus?.()
        }
      },
    })

  return h(Row, {
    react: React,
    id,
    title: props.t(spec.labelKey),
    desc: props.t(spec.hintKey),
    control: h('span', { className: 'nsh-clockGroup' }, [
      box('h', hour, setHour, 23, props.t('fieldHour')),
      h('span', { className: 'nsh-colon', key: ':' }, ':'),
      box('m', minute, setMinute, 59, props.t('fieldMinute')),
    ]),
  })
}

/**
 * The panel body.
 *
 * Uses the React and primitives instances it was handed rather than importing
 * them: client bundles share the page's single React, and a second copy would
 * break hooks.
 * @param props - the object `createPanel` returned.
 */
function SettingsPanel(props: Record<string, any>): unknown {
  const h = props.react.createElement
  const state = props.useNotifyOverlayPanel((value: unknown) => value) as {
    value: Record<string, unknown>
    failed: boolean
    writable: boolean
  }

  const shared = {
    react: props.react,
    primitives: props.primitives,
    t: props.t,
    write: props.write,
    writable: state.writable,
  }

  const renderRow = (spec: FieldSpec): unknown => {
    const value = state.value[spec.field]
    // A dependent row is inert while its switch is off: the quiet-hour times
    // describe a schedule nothing consults, so leaving them editable reads as a
    // control that does nothing.
    const dimmed = spec.dependsOn !== undefined && state.value[spec.dependsOn] !== true
    if (spec.kind === 'switch') return h(SwitchRow, { key: spec.field, ...shared, spec, value })
    if (spec.kind === 'number') return h(NumberRow, { key: spec.field, ...shared, spec, value, dimmed })
    return h(ClockRow, { key: spec.field, ...shared, spec, value, dimmed })
  }

  const groups = (props.groups as typeof GROUPS).map((group) => h('div', { className: 'nsh-group', key: group.titleKey }, [
    h('p', { className: 'nsh-groupTitle', key: 'title' }, props.t(group.titleKey)),
    ...group.fields.map(renderRow),
  ]))

  return h('div', { className: 'nsh-form' }, [
    state.failed
      ? h('p', { className: 'nsh-status', 'data-error': 'true', role: 'alert', key: 'err' }, props.t('saveFailed'))
      : null,
    ...groups,
  ])
}

/**
 * dsh-notify-overlay — host half.
 *
 * Owns the overlay process and forwards DSH events to it:
 *
 *   1. Listens for approvals, questions, turns, errors, and session disposal.
 *   2. Pushes each event to a resident WPF overlay over stdin/stdout, one JSON
 *      object per line.
 *   3. Receives the overlay's click reports and caches the conversation the
 *      user asked to open.
 *   4. Exposes loopback endpoints the browser half reads: the pending
 *      conversation, the active theme, and the conversation currently on screen.
 *
 * Delivery lives in the Host, not the browser half: the browser runs in a
 * sandboxed renderer and cannot spawn a process, and an in-page overlay would be
 * covered by the DSH window — which is the problem this plugin exists to solve.
 *
 * Opening a conversation has to round-trip through the browser half because
 * `uiWorkspace.openSession` only exists in the renderer: the overlay reports a
 * click → the Host caches that id → the browser half polls it → the renderer
 * navigates.
 *
 * Persistence split. Approvals, questions, and errors block the conversation, so
 * after their transient card expires they stay in the overlay's pending list and
 * count on the collapsed ball. Turn completion, subagent completion, and session
 * disposal only notify; they leave nothing behind.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from './events.js'
import { L, lang, preferenceFromLoader, setLocaleSource, type Text } from './locale.js'
import { showSystemNotice } from './system-notify.js'

export const name = 'notify-overlay'

export const inject = ['connection']

export const Config = z.object({
  /**
   * Draw the reminder in the plugin's own always-on-top window.
   *
   * On: the WPF overlay (Windows only), which keeps a pending list, a draggable
   * count ball, and click-to-open-the-conversation.
   * Off: a native OS notification, which only reminds — clicking it does
   * nothing. The toast's `activationType="protocol"` can hand `dsh://open` to
   * DSH, but DSH answers with `show()` + `focus()`, which cannot raise a
   * background window (Windows notes §10).
   *
   * Off is the path that works off Windows; it is honoured as written, so on a
   * platform without the overlay the switch being on means nothing is shown.
   */
  overlay: z.boolean().default(true).volatile(),

  // One switch per reminder kind. Off means neither a card nor a list entry.
  approval: z.boolean().default(true).volatile(),
  question: z.boolean().default(true).volatile(),
  error: z.boolean().default(true).volatile(),
  turnDone: z.boolean().default(true).volatile(),
  subagent: z.boolean().default(false).volatile(),
  sessionDone: z.boolean().default(false).volatile(),

  /**
   * How long a transient card stays on screen, in milliseconds. When it expires,
   * a persistent kind moves into the pending list and a non-persistent kind is
   * discarded.
   */
  autoHideMs: z.natural().min(3000).max(8000).default(6000).volatile(),

  /**
   * Uniform scale factor. The overlay is designed at 1.0 for a 460px card;
   * 0.85 shrinks every font and gap, 1.15 grows them.
   */
  scale: z.number().min(0.6).max(1.8).default(1).volatile(),

  sound: z.boolean().default(true).volatile(),

  quietHours: z.boolean().default(false).volatile(),
  quietStart: z.string().default('22:00').volatile(),
  quietEnd: z.string().default('08:00').volatile(),
})

/** Reminder kinds that block a conversation, so they persist until handled. */
const PERSISTENT = new Set(['approval', 'question', 'error'])

/** Reminder kinds that need an answer before the conversation can continue. */
const BLOCKING = new Set(['approval', 'question'])

const PENDING_PATH = '/api/notify-overlay/pending'
const ACK_PATH = '/api/notify-overlay/ack'
const THEME_PATH = '/api/notify-overlay/theme'
const ACTIVE_PATH = '/api/notify-overlay/active'

/** Duplicate suppression window for the same session and kind. */
const DEDUPE_MS = 5000

const here = dirname(fileURLToPath(import.meta.url))

/** Configuration snapshot, read fresh so edits apply without remounting. */
interface Settings {
  overlay: boolean
  approval: boolean
  question: boolean
  error: boolean
  turnDone: boolean
  subagent: boolean
  sessionDone: boolean
  autoHideMs: number
  sound: boolean
  quietHours: boolean
  quietStart: string
  quietEnd: string
}

/** The reminder kinds this plugin emits. */
type Kind = 'approval' | 'question' | 'error' | 'turn' | 'subagent' | 'sessionDone'

/** One reminder handed to the overlay. */
interface Reminder {
  sessionId: string
  kind: Kind
  title: Text
  body: Text
}

/** Everything the overlay writes back on stdout. */
interface OverlayMessage {
  op?: string
  sessionId?: string
  kind?: string
  message?: string
}

/** A request object seen by the approval and question waterfalls. */
interface AnswerableRequest {
  agent?: { id?: string }
  toolName?: string
  reason?: string
  request?: { toolName?: string; reason?: string; questions?: { question?: string }[] }
  questions?: { question?: string }[]
}

export function apply(ctx: Context & Record<string, any>, config: any): void {
  const logger = ctx.logger('notify-overlay')

  // 排查通道：浮窗是独立进程、Host 的 logger 也不落盘，
  // 所以这里单独写一份文件，安装现场能直接读到发生了什么。
  //
  // `DSH_NOTIFY_OVERLAY_TRACE` overrides the path so tests can write somewhere
  // disposable instead of appending to the file a real installation is
  // troubleshooting with.
  const traceFile = process.env.DSH_NOTIFY_OVERLAY_TRACE
    ?? join(tmpdir(), 'dsh-notify-overlay-host.log')
  const trace = (message: string): void => {
    logger.info(message)
    try {
      appendFileSync(traceFile, `${new Date().toISOString()} ${message}\n`, 'utf8')
    } catch {
      // 排查日志写不了不影响功能
    }
  }

  trace('apply() 开始')

  // Language follows the DSH setting; see locale.ts for how the preference is
  // read and why the OS locale stands in when the user left it automatic.
  setLocaleSource(() => preferenceFromLoader(ctx.get?.('loader')))

  // ── Configuration ─────────────────────────────────────────
  const cfg = (): Settings => ({
    overlay: config.overlay.get() as boolean,
    approval: config.approval.get() as boolean,
    question: config.question.get() as boolean,
    error: config.error.get() as boolean,
    turnDone: config.turnDone.get() as boolean,
    subagent: config.subagent.get() as boolean,
    sessionDone: config.sessionDone.get() as boolean,
    autoHideMs: config.autoHideMs.get() as number,
    sound: config.sound.get() as boolean,
    quietHours: config.quietHours.get() as boolean,
    quietStart: config.quietStart.get() as string,
    quietEnd: config.quietEnd.get() as string,
  })

  // ── Overlay process ───────────────────────────────────────
  //
  // The WPF binary is Windows-only and shipped as a file inside the package, so
  // `existsSync` is TRUE on macOS and Linux as well — it is a plain file in the
  // tarball. Availability therefore has to be decided by platform, not by the
  // file: on any other OS the overlay simply never starts, and reminders go to
  // the OS notification path instead of being dropped.
  const exePath = join(here, 'native', 'dsh-notify-overlay.exe')
  const overlayAvailable = process.platform === 'win32' && existsSync(exePath)
  if (!overlayAvailable) {
    trace(`浮窗不可用（platform=${process.platform}），提醒走系统通知`)
  }

  let child: ChildProcessWithoutNullStreams | null = null
  let ready = false
  /** Messages queued until the overlay reports ready. */
  const outbox: unknown[] = []
  /** Set once the plugin unloads, so nothing is started during teardown. */
  let disposed = false

  /**
   * What the browser reports about the window right now.
   *
   * `sessionId` is the conversation in the main view; `focused` says whether the
   * DSH window owns the foreground. Together they answer the one question that
   * decides card-versus-nothing: is the user already looking at this
   * conversation's state?
   */
  let onScreen: { sessionId: string | null; focused: boolean } =
    { sessionId: null, focused: false }

  function write(msg: unknown): void {
    try {
      child?.stdin.write(`${JSON.stringify(msg)}\n`)
    } catch {
      // A closed pipe means the overlay is going away; the exit handler cleans up.
    }
  }

  /**
   * Whether a message only makes sense against an overlay that is already
   * running.
   *
   * `remove` withdraws an entry from the overlay's pending list, `theme` and
   * `config` retune a window that is already drawing. None of them has anything
   * to act on when there is no process: its in-memory state is empty by
   * definition. Starting a process to deliver one of them therefore only makes
   * the ball appear — or keeps it alive — for a reminder the user has already
   * dealt with.
   *
   * `notify` and `sound` are the opposite: they are the reminders themselves, so
   * they are what justifies starting the process at all.
   * @param msg - the command about to be delivered.
   * @returns true when the message must be dropped if nothing is running.
   */
  function needsRunningOverlay(msg: unknown): boolean {
    const op = (msg as { op?: unknown } | null)?.op
    return op === 'remove' || op === 'theme' || op === 'config' || op === 'clear' || op === 'exit'
  }

  /**
   * Deliver one message to the overlay, starting it first if it is not running.
   *
   * The overlay is **lazily started**, not kept alive:
   *
   *   - Nothing is spawned at load. An idle overlay is a process the user did not
   *     ask for, and it holds a lock on its own `.exe` — which is exactly what
   *     made reinstalling the plugin impossible (pnpm could not replace the
   *     binary while the running copy held it, and killing the process only
   *     brought it straight back).
   *   - After an exit nothing is respawned. The next message that actually needs
   *     the overlay brings it back, so a killed process costs one reminder, not
   *     a restart loop.
   *   - A message that only *adjusts* an existing overlay does not start one.
   *     The browser half reports the active conversation on every focus change
   *     and once a second, and each report withdraws that conversation's error;
   *     with the ball hidden that was one `remove` per focus change, and every
   *     one of them spawned a fresh overlay whose only job was to be told
   *     "nothing to remove". The user saw it as the ball popping up whenever they
   *     switched windows.
   *
   * @param msg - the command to deliver.
   */
  function send(msg: unknown): void {
    if (disposed) return
    // No overlay on this platform: nothing can consume the message, and starting
    // a Windows binary elsewhere would only fail. Reminders take the OS path.
    if (!overlayAvailable) return
    if (child === null) {
      // Nothing is running, so there is no pending list to withdraw from and no
      // window to retheme. Dropping is the correct outcome, not a loss.
      if (needsRunningOverlay(msg)) return
      outbox.push(msg)
      spawnOverlay()
      return
    }
    if (!ready) {
      outbox.push(msg)
      return
    }
    write(msg)
  }

  /**
   * Stop the overlay process on request.
   *
   * The window is resident: once started it stays on screen until told to go. So
   * turning the `overlay` switch off has to close it, or a topmost WPF window —
   * possibly still showing a card — would linger until DSH restarts.
   *
   * `op: 'exit'` first so the window closes itself cleanly (the WPF side treats a
   * closed stdin as a reason to shut down too), then `kill` as the backstop for a
   * process that ignores it.
   * @param reason - why it is being stopped, for the trace log.
   */
  function stopOverlay(reason: string): void {
    if (child === null) return
    trace(`停止浮窗：${reason}`)
    try {
      write({ op: 'exit' })
    } catch {
      // Pipe already gone; the kill below is the backstop.
    }
    try {
      child.kill()
    } catch {
      // Already exited.
    }
    // Drop the reference now rather than waiting for the exit event: `send` would
    // otherwise queue into a process that is on its way out.
    child = null
    ready = false
    outbox.length = 0
  }

  /**
   * Hand the overlay everything it cannot read for itself.
   *
   * The overlay is a separate process: it cannot resolve the DSH language or
   * read this plugin's config, so both are pushed. Called when the overlay
   * reports ready and again whenever a `.volatile()` field changes — see the
   * `loader/volatile-update` listener at the end of `apply`.
   */
  function pushConfig(): void {
    // No process yet: the config is pushed on `ready` when one is started, so
    // there is nothing to do — and starting one just to hand it settings would
    // defeat the lazy start.
    if (child === null) return
    try {
      write({
        op: 'config',
        autoHideMs: config.autoHideMs.get(),
        scale: config.scale.get(),
        sound: config.sound.get(),
        lang: lang(),
      })
      trace('config 已下发')
    } catch (error) {
      // 配置读取失败会让整个 ready 分支中断、浮窗永远收不到设置，
      // 之前就是这么静默失败的，所以必须记下来。
      trace(`下发 config 失败：${String(error)}`)
    }
  }

  /**
   * Start the overlay process and wire its three streams.
   *
   * Called only from {@link send}, i.e. when there is something to deliver. It is
   * never called on a timer and never from the exit handler.
   */
  function spawnOverlay(): void {
    if (disposed || child !== null) return

    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(exePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      logger.warn(`浮窗启动失败：${String(error)}`)
      return
    }
    child = proc
    ready = false

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const text = line.trim()
        if (text === '') continue
        let msg: OverlayMessage
        try {
          msg = JSON.parse(text) as OverlayMessage
        } catch {
          continue
        }
        if (msg.op === 'ready') {
          ready = true
          trace('浮窗报告 ready')
          while (outbox.length > 0) write(outbox.shift())
          // The overlay draws its own text, so it needs the resolved language as
          // well as the current settings.
          pushConfig()
        } else if (msg.op === 'click') {
          // The overlay reported a conversation to open; the browser half collects it.
          pendingSession = msg.sessionId ?? null
        } else if (msg.op === 'error') {
          logger.warn(`浮窗错误：${msg.message ?? ''}`)
        }
      }
    })

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      logger.warn(`浮窗 stderr：${String(chunk).trim()}`)
    })

    proc.on('error', (error) => {
      logger.warn(`浮窗进程错误：${String(error)}`)
    })

    proc.on('exit', (code) => {
      // Ignore the exit of a process we already replaced or shut down.
      if (child !== proc) return
      ready = false
      child = null
      trace(`浮窗已退出（code=${code ?? '信号'}），等下次需要时再启动`)
    })
  }

  ctx.effect(() => () => {
    // Mark first: a queued send must not start a new process while tearing down.
    disposed = true
    try {
      write({ op: 'exit' })
    } catch {
      // Already gone.
    }
    try {
      child?.kill()
    } catch {
      // Already gone.
    }
    child = null
  }, 'notify-overlay: dispose child')

  // ── Live setting changes ──────────────────────────────────
  //
  // Every field is `.volatile()`, so the Loader writes a new value into the same
  // reference instead of remounting this plugin: `apply()` does not run again.
  // `loader/volatile-update` is the only signal that the values moved
  // (cordis-plugin-loader `_commitVolatile`), and it fires with a this-context
  // filtered to the owning fiber, so a plain `ctx.on` receives it.
  //
  // Without this the overlay kept the config it got at startup: changing the
  // card dwell time or the scale from the settings panel did nothing until the
  // next restart.
  //
  // Turning `overlay` off also has to stop the process — see `stopOverlay`. The
  // previous value is tracked here because the event only says which fields
  // moved, not what they moved from.
  let overlayWasOn = config.overlay.get() as boolean
  ctx.effect(() => ctx.on('loader/volatile-update' as any, (paths: unknown) => {
    trace(`配置热更新：${Array.isArray(paths) ? paths.map((p) => (Array.isArray(p) ? p.join('.') : String(p))).join(', ') : String(paths)}`)
    const overlayNow = config.overlay.get() as boolean
    if (overlayWasOn && !overlayNow) stopOverlay('开关已关闭')
    overlayWasOn = overlayNow
    pushConfig()
  }), 'notify-overlay: config hot update')

  // ── Pending navigation ────────────────────────────────────
  let pendingSession: string | null = null

  /**
   * Conversation titles, kept after disposal so the card can still name them.
   * Kept current by the `session/title` listener below, so a rename shows up on
   * the next reminder.
   */
  const labels = new Map<string, string>()
  /** Last reminder per conversation, for duplicate suppression. */
  const lastSent = new Map<string, { kind: Kind; at: number }>()

  /**
   * The conversation's display name.
   *
   * `session.header` carries no title (see the header literal in
   * `dsh-session/lib/index.js`): titles are folded by the separate
   * `sessionTitle` service from `session/title` events. Reading `header.title`
   * silently always missed and fell through to the id prefix, which is why cards
   * read "session-" (the first eight characters of every session id).
   *
   * `sessionTitle.get()` scans the whole log, so it is only the first read for a
   * conversation; later titles arrive through the `session/title` listener. That
   * first read is still needed: a conversation restored from disk gets its log
   * as a seed, which dispatches no `session/event`.
   */
  function labelOf(sessionId: string): string {
    const cached = labels.get(sessionId)
    if (cached !== undefined) return cached
    try {
      const session = ctx.get('sessions')?.get?.(sessionId)
      if (session !== undefined) {
        const title = ctx.get('sessionTitle')?.get?.(session)?.title
        if (typeof title === 'string' && title !== '') {
          labels.set(sessionId, title)
          return title
        }
      }
    } catch {
      // Session or title service unavailable; fall back to the id prefix.
    }
    return sessionId.slice(0, 8)
  }

  // A rename, a generated title and the first-message fallback all append a
  // `session/title` event (`dsh-session-title` `rename()` / `runProvider()` /
  // `ensureFallback()`); the latest one is the title.
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'session/title') return
      const sessionId = session?.id
      const title = (event.data as { title?: unknown } | undefined)?.title
      if (typeof sessionId !== 'string' || typeof title !== 'string' || title === '') return
      labels.set(sessionId, title)
      trace(`标题更新 session=${sessionId}`)
    } catch {
      // Title observation must never throw into the session append path.
    }
  }), 'notify-overlay: session title')

  /**
   * Normalize free text for a card.
   *
   * Collapses runs of whitespace (including newlines) into single spaces so a
   * multi-paragraph message does not render as a column of blank lines. The text
   * is NOT truncated: the overlay sizes itself to its content, so the card grows
   * instead of hiding what the user needs to read.
   */
  function flatten(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
  }

  // ── Gating ────────────────────────────────────────────────
  /** Minutes since midnight for an `HH:MM` string, or undefined when malformed. */
  const parseClock = (value: string): number | undefined => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value)
    if (match === null) return undefined
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (hour > 23 || minute > 59) return undefined
    return hour * 60 + minute
  }

  /**
   * Whether quiet hours silence this kind right now.
   *
   * Blocking kinds are never silenced: an approval or question left unseen stops
   * the conversation entirely.
   */
  function quietNow(kind: Kind): boolean {
    const c = cfg()
    if (!c.quietHours) return false
    if (BLOCKING.has(kind)) return false
    const start = parseClock(c.quietStart)
    const end = parseClock(c.quietEnd)
    if (start === undefined || end === undefined) return false
    const now = new Date()
    const minutes = now.getHours() * 60 + now.getMinutes()
    return start <= end
      ? minutes >= start && minutes < end
      : minutes >= start || minutes < end
  }

  function kindEnabled(kind: Kind, c: Settings): boolean {
    switch (kind) {
      case 'approval': return c.approval
      case 'question': return c.question
      case 'error': return c.error
      case 'turn': return c.turnDone
      case 'subagent': return c.subagent
      case 'sessionDone': return c.sessionDone
    }
  }

  /**
   * Walk up to the top-level conversation a session belongs to.
   *
   * A subagent's session names its parent in `header.parentSession`
   * (`dsh-session/lib/index.js` builds that field from `meta.parentSession`), and
   * a nested subagent therefore chains: grandchild → child → root. Reminders must
   * land on the root, because that is the only conversation the user can open —
   * pointing a card at a subagent session would jump nowhere.
   *
   * The walk is bounded and cycle-safe: a malformed chain must not hang a
   * notification. When the parent is no longer live (disposed, or never loaded
   * into this runtime) the deepest session we could reach is the best answer
   * available.
   * @param sessionId - the session the event came from.
   * @returns the topmost live ancestor, or the input when it has no parent.
   */
  function rootSessionOf(sessionId: string): string {
    const sessions = ctx.get('sessions')
    if (sessions === undefined) return sessionId

    let current = sessionId
    const seen = new Set<string>([current])
    // `delegationDepth` is not trusted for the bound: a chain that lies about its
    // depth would either stop early or loop. A plain guard is enough.
    for (let step = 0; step < 32; step++) {
      let parent: unknown
      try {
        parent = sessions.get?.(current)?.header?.parentSession
      } catch {
        return current
      }
      if (typeof parent !== 'string' || parent === '') return current
      if (seen.has(parent)) return current
      if (sessions.get?.(parent) === undefined) return current
      seen.add(parent)
      current = parent
    }
    return current
  }

  /**
   * Whether a session is a subagent at all.
   *
   * `origin` is only set on delegated sessions (`dsh-session/lib/index.js` rejects
   * any other value), so an absent origin means a top-level conversation.
   * @param sessionId - session to classify.
   * @returns true for a delegated session.
   */
  function isSubagentSession(sessionId: string): boolean {
    try {
      return ctx.get('sessions')?.get?.(sessionId)?.header?.origin === 'subagent'
    } catch {
      return false
    }
  }

  /**
   * Resolve where a reminder should point, and whether it is worth showing.
   *
   * A subagent finishing is only worth a reminder when the whole delegation tree
   * is done: while siblings are still running, the root conversation is not
   * waiting on the user. Conversely an approval or question raised inside a
   * subagent blocks that tree, so it must surface — pointing at the root, since a
   * subagent session cannot be opened in the UI.
   * @param sessionId - the session the event came from.
   * @returns the conversation to point at, and whether it is a subagent's event.
   */
  function targetOf(sessionId: string): { root: string; subagent: boolean } {
    const root = rootSessionOf(sessionId)
    return { root, subagent: root !== sessionId || isSubagentSession(sessionId) }
  }

  /**
   * Whether the reminder is about the conversation the user is looking at.
   *
   * The window already marks that conversation's state — amber while it waits
   * for an answer, blue once it finishes. When the user is watching that
   * conversation happen, there is nothing to announce: not a card, not a sound.
   * @param sessionId - conversation the reminder belongs to.
   * @returns true when the user already sees this conversation's state.
   */
  function lookingAt(sessionId: string): boolean {
    return onScreen.focused && onScreen.sessionId === sessionId
  }

  /**
   * How one reminder should interrupt, decided entirely on this side.
   *
   * The policy lives in TypeScript because this is where the settings and the
   * window state both are. The overlay is a dumb renderer: it draws a card when
   * told to and beeps when told to, and decides nothing on its own.
   *
   * Three outcomes, checked in order:
   *
   *   1. `silent` — the user is already looking at this conversation. The state
   *      marker on screen says it; a card would cover the transcript and a chime
   *      would announce what their eyes are already on.
   *   2. `sound` — DSH is in front but the user is reading a different
   *      conversation. They are at the machine, so one chime is enough to pull
   *      attention; a card would cover what they are reading.
   *   3. `card` — DSH is not in front. A sound alone may go unnoticed, so draw
   *      the card (and beep, if sound is enabled).
   */
  type Channel = 'card' | 'sound' | 'silent'

  /**
   * Pick the channel for one reminder.
   * @param sessionId - the conversation the reminder belongs to.
   * @returns which channel to use.
   */
  function chooseChannel(sessionId: string): Channel {
    if (lookingAt(sessionId)) return 'silent'
    if (onScreen.focused) return 'sound'
    return 'card'
  }

  function notify(reminder: Reminder): void {
    const c = cfg()
    if (!kindEnabled(reminder.kind, c)) {
      trace(`notify 跳过（该类关闭）kind=${reminder.kind}`)
      return
    }
    if (quietNow(reminder.kind)) {
      trace(`notify 跳过（免打扰）kind=${reminder.kind}`)
      return
    }

    // Which surface carries this reminder. `overlay` on a platform with no WPF
    // binary is honoured as written (the user chose that), so it is a silent
    // dead end rather than a fallback — see the `overlay` config doc.
    const useOverlay = c.overlay && overlayAvailable

    const sessionId = reminder.sessionId
    const channel = chooseChannel(sessionId)

    if (channel === 'silent') {
      trace(`notify 跳过（正在看这个会话）kind=${reminder.kind}`)
      return
    }

    // One dedupe for every channel, so a card and its sound can never disagree
    // about how many times an event fired.
    const now = Date.now()
    const previous = lastSent.get(sessionId)
    if (previous !== undefined
      && previous.kind === reminder.kind
      && now - previous.at < DEDUPE_MS) return
    lastSent.set(sessionId, { kind: reminder.kind, at: now })

    if (!useOverlay) {
      // The system path has no chime of its own: the OS draws the notification
      // and `sound` only ever drove the overlay's audio. Windows toasts are
      // posted silent for the same reason — one reminder, one sound.
      if (channel === 'sound') {
        trace(`notify 跳过（系统通知模式，DSH 在前台）kind=${reminder.kind}`)
        return
      }
      trace(`notify 系统通知 kind=${reminder.kind} session=${sessionId}`)
      showSystemNotice({
        title: String(reminder.title),
        body: String(reminder.body),
        context: labelOf(sessionId),
      }, (message) => trace(message))
      return
    }

    // Sound is its own message, not a flag on the card: the overlay must not be
    // the place that decides whether a reminder makes noise.
    if (c.sound) send({ op: 'sound' })

    // The sound channel is done here, muted or not. With sound off this is a
    // deliberate silence — the user turned noise off and is at the machine, so
    // the on-screen markers are the notification. Does NOT fall back to a card:
    // a muted reminder must not turn into a card covering what they are reading.
    if (channel === 'sound') {
      trace(c.sound
        ? `notify 只响声音（DSH 在前台）kind=${reminder.kind} session=${sessionId}`
        : `notify 跳过（DSH 在前台且声音关闭）kind=${reminder.kind}`)
      return
    }

    trace(`notify 发送 kind=${reminder.kind} session=${sessionId}`)

    send({
      op: 'notify',
      items: [{
        sessionId,
        kind: reminder.kind,
        // Rendered here: the overlay is a separate process and cannot resolve
        // the DSH language itself. `String()` picks the language now in force.
        title: String(reminder.title),
        body: String(reminder.body),
        sessionLabel: labelOf(sessionId),
        at: now,
        persistent: PERSISTENT.has(reminder.kind),
      }],
      autoHideMs: c.autoHideMs,
      lang: lang(),
    })
  }

  /**
   * Withdraw one persistent reminder.
   *
   * Called when an approval or question is answered, and when the user opens the
   * conversation an error belongs to. `kind` is required: one conversation can
   * hold both an approval and an error, and they must not clear each other.
   */
  function withdraw(sessionId: string | undefined, kind: Kind): void {
    if (sessionId === undefined) return
    // An OS notification has no pending list to clear: it is dismissed by the
    // user, not by us. Only the overlay understands a `remove`.
    if (cfg().overlay && overlayAvailable) send({ op: 'remove', sessionId, kind })
    lastSent.delete(sessionId)
  }

  // ── Approvals and questions (waterfall: observe, never intercept) ──
  trace('注册 approval/request 与 user-questions/request 监听器')

  ctx.effect(() => ctx.on('approval/request', (req: AnswerableRequest, next: () => unknown) => {
    let sessionId: string | undefined
    try {
      const agentId = req?.agent?.id
      // An approval raised inside a subagent blocks that whole tree, so it must
      // surface — but it points at the root, the only conversation that can be
      // opened in the UI.
      sessionId = agentId === undefined ? undefined : targetOf(agentId).root
      trace(`收到 approval/request，agentId=${agentId ?? '(无)'} 指向=${sessionId ?? '(无)'}`)
      if (sessionId !== undefined) {
        const tool = req.toolName ?? req.request?.toolName
        const reason = req.reason ?? req.request?.reason
        const detail = [tool, reason]
          .filter((part): part is string => typeof part === 'string' && part !== '')
          .join(' · ')
        notify({
          sessionId,
          kind: 'approval',
          title: L('需要审批', 'Approval needed'),
          body: detail === ''
            ? L('请求授权', 'Requests authorization')
            : L(detail, detail),
        })
      }
    } catch {
      // Never let observation break the waterfall.
    }

    const result = next()
    // Clear the persistent card once the request settles, either way.
    if (sessionId !== undefined) {
      const id = sessionId
      Promise.resolve(result).then(
        () => withdraw(id, 'approval'),
        () => withdraw(id, 'approval'),
      )
    }
    return result
  }, { prepend: true }), 'notify-overlay: approval')

  // WATERFALL GOTCHA — read before touching the two listeners above.
  //
  // `approval/request` and `user-questions/request` are waterfalls, and
  // `dsh-api-remotes` registers an earlier listener on both that forwards the
  // request to the browser panel. It resolves WITHOUT calling `next()` once the
  // panel answers (dsh-api-remotes/lib/index.js `forwardWaterfall`), which ends
  // the chain: a listener registered after it never runs. `agent/status` works
  // because it is an `emit`, where every listener runs.
  //
  // So both listeners are registered with `prepend: true` — we run first, look,
  // and always delegate with `next()`. Never return early from them.

  ctx.effect(() => ctx.on('user-questions/request', (req: AnswerableRequest, next: () => unknown) => {
    let sessionId: string | undefined
    try {
      const agentId = req?.agent?.id
      // Same reasoning as approvals: a question from a subagent stops that whole
      // tree, and the card must point at the conversation the user can open.
      sessionId = agentId === undefined ? undefined : targetOf(agentId).root
      trace(`收到 user-questions/request，agentId=${agentId ?? '(无)'} 指向=${sessionId ?? '(无)'}`)
      if (sessionId !== undefined) {
        const questions = req.questions ?? req.request?.questions
        const first = Array.isArray(questions) && questions.length > 0
          ? questions[0]?.question
          : undefined
        notify({
          sessionId,
          kind: 'question',
          title: L('需要你回答', 'Your answer is needed'),
          body: typeof first === 'string'
            ? L(flatten(first), flatten(first))
            : L('Agent 有问题要问你', 'The agent has a question for you'),
        })
      }
    } catch (error) {
      trace(`user-questions 处理出错：${String(error)}`)
    }

    const result = next()
    if (sessionId !== undefined) {
      const id = sessionId
      Promise.resolve(result).then(
        () => withdraw(id, 'question'),
        () => withdraw(id, 'question'),
      )
    }
    return result
  }, { prepend: true }), 'notify-overlay: question')

  // ── Turn completion (running → not running edge) ───────────
  const running = new Map<string, boolean>()

  /**
   * Whether any session beneath `root` is still running.
   *
   * Subagent completion only matters to the user once the whole tree settles: a
   * root conversation with three children runs three more turns, and announcing
   * each one would be noise for something the user cannot act on.
   * @param root - the top-level conversation.
   * @returns true while any descendant is running.
   */
  function anyDescendantRunning(root: string): boolean {
    const sessions = ctx.get('sessions')
    if (sessions === undefined) return false
    for (const [sessionId, isRunning] of running) {
      if (!isRunning || sessionId === root) continue
      if (rootSessionOf(sessionId) === root) return true
    }
    return false
  }

  ctx.effect(() => ctx.on('agent/status', (payload: any) => {
    try {
      const agent = payload?.agent
      const status = payload?.status
      const sessionId = agent?.id as string | undefined
      if (sessionId === undefined) return

      const previous = running.get(sessionId)
      running.set(sessionId, status === 'running')

      // Only the running → idle edge, so multi-step tool use does not spam.
      if (previous !== true || status === 'running') return

      const { root, subagent } = targetOf(sessionId)

      if (subagent) {
        // A subagent merely finishing is not news: the root is still working.
        // Only speak once every session under the root has gone idle.
        if (anyDescendantRunning(root)) {
          trace(`notify 跳过（子代理完成但同树仍在跑）session=${sessionId} root=${root}`)
          return
        }
        notify({
          sessionId: root,
          kind: 'subagent',
          title: L('子代理全部完成', 'Subagents finished'),
          body: L('', ''),
        })
      } else {
        notify({
          sessionId: root,
          kind: 'turn',
          title: L('轮次完成', 'Turn complete'),
          body: L('Agent 已空闲', 'The agent is idle'),
        })
      }
    } catch {
      // Status observation must never throw into the agent loop.
    }
  }), 'notify-overlay: agent status')

  // ── Errors ────────────────────────────────────────────────
  ctx.effect(() => ctx.on('agent/error', (payload: any) => {
    try {
      const agentId = payload?.agent?.id as string | undefined
      if (agentId === undefined) return
      const { root, subagent } = targetOf(agentId)
      // A subagent failing is reported against its root so the card opens
      // somewhere real, and the message says which side failed.
      const error = payload?.error
      const text = error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : (error?.message ?? '未知错误')
      notify({
        sessionId: root,
        kind: 'error',
        title: subagent ? L('子代理出错', 'Subagent failed') : L('执行出错', 'Run failed'),
        body: L(flatten(String(text)), flatten(String(text))),
      })
    } catch {
      // Error observation must never throw into the agent loop.
    }
  }), 'notify-overlay: agent error')

  // ── Session disposal ─────────────────────────────────────
  //
  // `session/disposed` fires when a session leaves the in-memory registry: on
  // delete, on subagent teardown, and for every session when DSH exits.
  // Archiving does NOT dispose (it only joins `archivedSessionIds`).
  ctx.effect(() => ctx.on('session/disposed', (session: any) => {
    try {
      const sessionId = session?.id as string | undefined
      if (sessionId === undefined) return
      notify({
        sessionId,
        kind: 'sessionDone',
        title: L('会话结束', 'Conversation closed'),
        body: L('', ''),
      })
      labels.delete(sessionId)
      running.delete(sessionId)
      lastSent.delete(sessionId)
    } catch {
      // Disposal observation must never throw.
    }
  }), 'notify-overlay: session disposed')

  const json = (body: unknown): Response => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  // ── HTTP: the browser half collects a pending navigation ───
  ctx.effect(() => ctx.connection.fetch.register({
    path: PENDING_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response(JSON.stringify({ sessionId: pendingSession }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    }),
  }), 'notify-overlay: pending route')

  // ── HTTP: the browser half confirms it navigated ───────────
  ctx.effect(() => ctx.connection.fetch.register({
    path: ACK_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      pendingSession = null
      return json({ ok: true })
    },
  }), 'notify-overlay: ack route')

  // ── HTTP: the browser half reports the active theme ────────
  //
  // Only worth delivering while the overlay is in use. The browser reports every
  // time the theme changes, and `send` starts the window — so forwarding
  // unconditionally meant the WPF process was launched (and told its config)
  // even with `overlay` off, for a card nobody would ever see.
  ctx.effect(() => ctx.connection.fetch.register({
    path: THEME_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request: Request) => {
      try {
        const body = await request.json() as { dark?: boolean }
        if (cfg().overlay && overlayAvailable) send({ op: 'theme', dark: body?.dark === true })
      } catch {
        // Malformed body: keep the previous theme.
      }
      return json({ ok: true })
    },
  }), 'notify-overlay: theme route')

  // ── HTTP: the browser half reports window focus ───────────────
  //
  // Only the browser can answer "is DSH the window the user is looking at?".
  // `notify()` reads it: in front means the UI already shows the state, so it
  // rings instead of drawing a card.
  //
  // Opening the conversation an error belongs to counts as handling it, so the
  // error's list entry is withdrawn there.
  ctx.effect(() => ctx.connection.fetch.register({
    path: ACTIVE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request: Request) => {
      try {
        const body = await request.json() as { sessionId?: string | null; focused?: boolean }
        const sessionId = typeof body?.sessionId === 'string' && body.sessionId !== ''
          ? body.sessionId
          : null
        onScreen = { sessionId, focused: body?.focused === true }
        if (sessionId !== null) withdraw(sessionId, 'error')
      } catch {
        // Malformed body: leave the last known state alone.
      }
      return json({ ok: true })
    },
  }), 'notify-overlay: active session route')

  logger.info('通知浮窗就绪（首次提醒时启动进程）')
}

/**
 * Event declarations for the Host half.
 *
 * DSH emits these through the plugin context, but the event names are not part
 * of the published cordis `Events` interface this package compiles against —
 * its declarations only cover the framework's own lifecycle events. Declaring
 * them here keeps `ctx.on(...)` type-checked instead of falling back to `any`.
 *
 * Payloads are intentionally loose: these events belong to DSH internals, and a
 * shape this plugin does not read must not break the build.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** An approval is requested; a waterfall, so listeners must call `next()`. */
    'approval/request'(request: unknown, next: () => unknown): unknown
    /** The agent asks the user one or more questions; a waterfall as well. */
    'user-questions/request'(request: unknown, next: () => unknown): unknown
    /** An agent changed run status (`running` and idle states). */
    'agent/status'(payload: { agent?: unknown; status?: string }): void
    /** An agent failed. */
    'agent/error'(payload: { agent?: unknown; error?: unknown }): void
    /** A conversation was disposed and will not be resumed in place. */
    'session/disposed'(session: { id?: string }): void
    /**
     * The Loader committed new values into this plugin's `.volatile()` config
     * references. Emitted from `cordis-plugin-loader`'s `_commitVolatile` with a
     * this-context filtered to the owning fiber, so only that plugin hears it.
     * `paths` lists the config paths that actually changed.
     */
    'loader/volatile-update'(paths: string[][]): void
  }
}

export {}

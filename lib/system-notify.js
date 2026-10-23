/**
 * dsh-notify-overlay — OS notifications.
 *
 * The fallback delivery path: used instead of the WPF overlay window when the
 * user turns the window off, and the only path that can work off Windows.
 *
 * Why this lives in the Host rather than the renderer: a Web `Notification` from
 * the renderer would keep click-to-navigate, but DSH's window does not disable
 * `backgroundThrottling`, so a renderer-side poll is throttled to roughly once a
 * minute while the window is hidden — exactly the situation a notification
 * exists for. Spawning a platform command from the Host has no such problem and
 * needs no Host→renderer channel.
 *
 * The trade-off is deliberate and confirmed with the user: an OS notification
 * only brings DSH forward; it cannot open a specific conversation.
 *
 * Per platform:
 *   · Windows — a WinRT toast through PowerShell (see the Windows notes §9).
 *     Not the `New-BurntToastNotification`-style module: that needs an install.
 *   · macOS — `osascript`'s `display notification`, built in. NOT verified on a
 *     real Mac; see `asLiteral`.
 *   · Linux — `notify-send` (libnotify), present on essentially every desktop.
 *     Also unverified.
 *
 * Delivery is best-effort: a missing or failing helper costs one notification,
 * never a broken reminder path. The child is deliberately neither detached nor
 * unref'd — see the comment on the spawn below for why both lose the toast.
 */
import { spawn } from 'node:child_process';
/**
 * The AUMID the toast is posted under.
 *
 * Must be the one DSH's Start-menu shortcut declares, which is
 * `com.deepseek.dsh` — read from the `System.AppUserModel.ID` property of
 * `Start Menu\Programs\DeepSeek Harness.lnk`.
 *
 * Do NOT use `electron.app.DeepSeek Harness`. That is Electron's automatic
 * fallback id, and it is the value that shows up in `wpndatabase.db` as a
 * handler, so it looks correct from the database alone. It is only a label with
 * no shortcut behind it: Windows accepts the toast, logs "delivered" in the
 * PushNotification platform log, files it in the database — and shows nothing,
 * neither a banner nor an entry in the notification center.
 *
 * Measured on this machine (one variable at a time, all through the same script):
 *
 *   com.deepseek.dsh                    → banner ✔
 *   electron.app.DeepSeek Harness       → nothing ✗  (5 attempts)
 *   {1AC14E77-...}\WindowsPowerShell... → banner ✔
 *   Test.NoProcess.OwnsThis             → nothing ✗
 */
const APP_ID = 'com.deepseek.dsh';
/**
 * Quote one value as a PowerShell single-quoted literal.
 *
 * PowerShell escapes a single quote by doubling it, and nothing else inside a
 * single-quoted string is special — so `$`, backticks, and braces in a session
 * title cannot turn into code. Double quotes would interpolate.
 * @param value - raw text from a conversation title or an error message.
 * @returns the quoted literal, quotes included.
 */
export function psLiteral(value) {
    return `'${value.replace(/'/g, "''")}'`;
}
/**
 * Quote one value for an AppleScript string literal.
 *
 * `osascript -e` receives the script as one command-line argument, so nothing
 * goes through a shell — the only hazards are AppleScript's own quoting rules.
 * Inside a double-quoted literal, `\` and `"` are escaped with a backslash.
 *
 * Line breaks are folded to spaces rather than escaped: the text is a single
 * notification line, and a raw newline would split the `-e` script into two
 * statements (AppleScript has no `\n` escape sequence, unlike most languages).
 *
 * NOT verified against a real macOS — this was written from the AppleScript
 * grammar, without a machine to run it on. The Windows path is the tested one.
 * @param value - raw text.
 * @returns the quoted literal, quotes included.
 */
export function asLiteral(value) {
    return `"${value
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')}"`;
}
/**
 * Build the Windows toast script.
 *
 * Uses the toast XML template rather than the WinRT `ToastNotification` object
 * graph so the text is plain XML; `SecurityElement.Escape` handles `&` and `<`,
 * which a title like "a & b" would otherwise break.
 *
 * `silent` is set because the plugin owns sound on its own terms: with sound
 * enabled the Host already rings the overlay chime, and letting Windows add its
 * own would double up on a machine where both paths could run.
 * @param notice - what to show.
 * @returns a PowerShell script that shows one toast.
 */
export function windowsScript(notice) {
    // Toast bodies are one line each; a newline in a title would break the layout.
    const title = notice.title.replace(/\s+/g, ' ').trim();
    const body = [notice.body, notice.context]
        .map((part) => part.replace(/\s+/g, ' ').trim())
        .filter((part) => part !== '')
        .join(' — ');
    return [
        '$ErrorActionPreference = "Stop"',
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
        '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null',
        `$title = [System.Security.SecurityElement]::Escape(${psLiteral(title)})`,
        `$body = [System.Security.SecurityElement]::Escape(${psLiteral(body)})`,
        // Single-quoted here-strings would be cleaner, but the XML is built by
        // concatenation so the two escaped values can be inserted as expressions.
        // The single quotes below are deliberate: a double-quoted PowerShell string
        // would treat the XML's own `"` as terminators and fail to parse.
        '$xml = \'<toast><visual><binding template="ToastGeneric">\'',
        '$xml += \'<text>\' + $title + \'</text>\'',
        '$xml += \'<text>\' + $body + \'</text>\'',
        '$xml += \'</binding></visual><audio silent="true"/></toast>\'',
        '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
        '$doc.LoadXml($xml)',
        '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psLiteral(APP_ID)}).Show($toast)`,
    ].join('\n');
}
/** Encode a script for `-EncodedCommand` (UTF-16LE base64), avoiding all quoting layers. */
function encoded(script) {
    return Buffer.from(script, 'utf16le').toString('base64');
}
/**
 * Show one OS notification.
 *
 * Best-effort by design: the caller has no useful recovery from a missing
 * notification helper, and blocking the agent loop on a spawn would be worse
 * than a missed toast.
 * @param notice - what to show.
 * @param onError - receives a human-readable reason when the helper could not run.
 */
export function showSystemNotice(notice, onError) {
    let command;
    let args;
    if (process.platform === 'win32') {
        command = 'powershell.exe';
        args = [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy', 'Bypass',
            '-EncodedCommand', encoded(windowsScript(notice)),
        ];
    }
    else if (process.platform === 'darwin') {
        // `display notification` has no title-vs-body distinction beyond these two
        // fields; the conversation goes into the subtitle, which macOS shows as a
        // second line for both banners and Notification Center entries.
        const subtitle = notice.context.trim();
        const script = [
            `display notification ${asLiteral(notice.body)}`,
            `with title ${asLiteral(notice.title)}`,
            ...(subtitle === '' ? [] : [`subtitle ${asLiteral(subtitle)}`]),
        ].join(' ');
        command = 'osascript';
        args = ['-e', script];
    }
    else {
        // `notify-send <summary> <body>`: the app name is its own flag, so the two
        // positional arguments are the title and the text.
        command = 'notify-send';
        args = ['--app-name', APP_ID, notice.title, notice.body];
    }
    try {
        // NOT detached, and NOT unref'd.
        //
        // Both were tried and both lose the notification. A detached child is torn
        // down with the parent on Windows, and an unref'd child does not keep the
        // Node event loop alive, so a Host that exits right after notifying kills the
        // PowerShell process before the toast reaches the notification database —
        // measured by firing and then checking `wpndatabase.db`.
        //
        // The cost is one short-lived child that the event loop waits for. The
        // helpers finish in tens of milliseconds; `timeout` bounds a wedged one so a
        // broken notification can never hold the Host open.
        const child = spawn(command, args, {
            stdio: 'ignore',
            windowsHide: true,
            timeout: 5_000,
        });
        child.on('error', (error) => {
            onError(`系统通知启动失败（${command}）：${String(error)}`);
        });
        // A non-zero exit is the normal way a missing/denied helper reports itself.
        child.on('exit', (code, signal) => {
            if (code !== 0 && code !== null)
                onError(`系统通知退出码 ${code}（${command}）`);
            else if (signal !== null && signal !== undefined)
                onError(`系统通知被信号 ${signal} 结束（${command}）`);
        });
    }
    catch (error) {
        onError(`系统通知启动失败（${command}）：${String(error)}`);
    }
}

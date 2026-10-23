// 只读：列出 DSH 进程的所有顶层窗口。
//
//   node list-windows.mjs
//
// 不调用任何 ShowWindow / SetForegroundWindow —— 只看不碰。
// MainWindowHandle 只反映「进程的主窗口」，同进程的第二个顶层窗口它看不到，
// 这就是之前误判「只有一个窗口」的原因。
import { spawnSync } from 'node:child_process'

const script = `
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
  public static List<string> Rows(uint targetPid, string targetName, bool all) {
    var rows = new List<string>();
    EnumWindows((h, lp) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!all) {
        if (pid != targetPid && targetName != "") {
          try {
            var p = System.Diagnostics.Process.GetProcessById((int)pid);
            if (p.ProcessName != targetName) return true;
          } catch { return true; }
        }
      }
      var title = new StringBuilder(512);
      GetWindowText(h, title, title.Capacity);
      var cls = new StringBuilder(256);
      GetClassName(h, cls, cls.Capacity);
      rows.Add(string.Format("{0}|{1}|{2}|{3}|{4}|{5}|{6}",
        h.ToInt64(), pid, IsWindowVisible(h) ? 1 : 0, IsIconic(h) ? 1 : 0,
        IsZoomed(h) ? 1 : 0, cls.ToString(), title.ToString()));
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
"@
[W]::Rows(0, "DeepSeek Harness", $false) | ForEach-Object { $_ }
`

const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
  encoding: 'utf8',
  windowsHide: true,
})

const rows = (result.stdout ?? '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== '' && line.includes('|'))

console.log('句柄 | pid | 可见 | 最小化 | 最大化 | 类名 | 标题')
console.log('─'.repeat(100))
for (const line of rows) {
  const [hwnd, pid, visible, iconic, zoomed, cls, ...titleParts] = line.split('|')
  const title = titleParts.join('|')
  console.log(
    `${hwnd.padStart(9)} | ${pid.padStart(5)} | ${visible === '1' ? '是' : '否'} | `
    + `${iconic === '1' ? '是' : '否'} | ${zoomed === '1' ? '是' : '否'} | ${cls} | ${title}`,
  )
}
console.log(`\n共 ${rows.length} 个顶层窗口`)

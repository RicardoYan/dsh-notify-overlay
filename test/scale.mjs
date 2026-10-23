// 验证 scale 配置：依次用 0.85 / 1.0 / 1.25 显示，并打印窗口尺寸
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EXE = 'E:\\dsh-plugins\\dsh-notify-overlay\\lib\\native\\dsh-notify-overlay.exe';
const child = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  for (const l of d.split('\n')) if (l.trim()) console.log('[out]', l.trim());
});

const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');

const items = [
  { sessionId: 'a', kind: 'approval', title: '需要审批',
    body: 'Bash · 请求在工作区外执行命令', sessionLabel: '重构通知模块', at: Date.now(), sticky: true },
  { sessionId: 'b', kind: 'question', title: '需要你回答',
    body: '要保留免打扰时段吗？', sessionLabel: '插件配置讨论', at: Date.now() - 4000, sticky: true },
];

await sleep(1200);
send({ op: 'theme', dark: true });
await sleep(200);

for (const s of [0.85, 1.0, 1.25]) {
  send({ op: 'clear' });
  await sleep(200);
  send({ op: 'config', autoHideMs: 60000, scale: s });
  await sleep(200);
  send({ op: 'upsert', items });
  await sleep(900);
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `Add-Type @"
using System; using System.Runtime.InteropServices;
public class WX {
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lp);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
 delegate bool EnumProc(IntPtr h, IntPtr lp);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
 public static string Find(int t) {
   string res = null;
   EnumWindows((h, lp) => {
     uint p; GetWindowThreadProcessId(h, out p);
     if ((int)p == t && IsWindowVisible(h)) {
       var r = new RECT(); GetWindowRect(h, out r);
       int w = r.R-r.L, hh = r.B-r.T;
       if (w > 100 && hh > 30 && hh < 900) res = w + "x" + hh;
     }
     return true;
   }, IntPtr.Zero);
   return res;
 }
}
"@
[WX]::Find((Get-Process -Name 'dsh-notify-overlay').Id)`,
  ], { encoding: 'utf8' }).trim();
  console.log(`scale=${s}  ->  ${out}`);
  await sleep(600);
}

send({ op: 'exit' });

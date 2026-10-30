// 验证：反复开关列表，小球位置不应该漂移
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EXE = join(here, '..', 'lib', 'native', 'dsh-notify-overlay.exe');
const child = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stdout.setEncoding('utf8');
let state = null;
child.stdout.on('data', (d) => {
  for (const l of d.split('\n')) {
    const s = l.trim(); if (!s) continue;
    let m; try { m = JSON.parse(s); } catch { continue; }
    if (m.op === 'hotzones') state = m;
  }
});
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const waitFor = async (pred, ms = 2500) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(40); }
  return false;
};
const probe = async () => { state = null; send({ op: 'hotzones' }); await waitFor(() => state !== null); return state; };

await sleep(1200);
send({ op: 'config', autoHideMs: 2000, scale: 1, sound: false, lang: 'zh' });
await sleep(200);

// 造出小球
send({ op: 'notify', lang: 'zh', autoHideMs: 500, items: [
  { sessionId: 'a', kind: 'approval', title: 'x', body: 'y', sessionLabel: 'S1', at: Date.now(), persistent: true },
]});
await sleep(1200);

let s = await probe();
const first = { x: Math.round(s.win.left), y: Math.round(s.win.top), mode: s.mode };
console.log(`初始小球位置: (${first.x}, ${first.y})  mode=${first.mode}`);

console.log('\n反复「展开列表 → 收起」10 次:');
for (let i = 1; i <= 10; i++) {
  send({ op: 'simclick', name: 'ball' });
  await sleep(250);
  send({ op: 'simclick', name: 'footer' });
  await sleep(250);
  s = await probe();
  const pos = { x: Math.round(s.win.left), y: Math.round(s.win.top) };
  const drift = Math.abs(pos.x - first.x) + Math.abs(pos.y - first.y);
  console.log(`  第 ${i} 次: (${pos.x}, ${pos.y})  mode=${s.mode}  漂移=${drift}`);
}

send({ op: 'exit' });
await sleep(300);
child.kill();

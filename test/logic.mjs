// 逻辑测试：用 simclick 直接触发元素事件，不依赖屏幕坐标
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EXE = join(here, '..', 'lib', 'native', 'dsh-notify-overlay.exe');
const child = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stdout.setEncoding('utf8');

let zones = null, win = null;
const clicks = [];
const log = [];
child.stdout.on('data', (d) => {
  for (const l of d.split('\n')) {
    const s = l.trim(); if (!s) continue;
    let m; try { m = JSON.parse(s); } catch { continue; }
    if (m.op === 'hotzones') { zones = m.zones; win = m.win; }
    else if (m.op === 'click') clicks.push(m.sessionId);
    else if (m.op === 'simclick') log.push(m);
  }
});
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const waitFor = async (pred, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(40); }
  return false;
};
const refresh = async () => { zones = null; send({ op: 'hotzones' }); await waitFor(() => zones !== null); return zones.map(z => z.name); };
const sim = async (name) => { log.length = 0; send({ op: 'simclick', name }); await waitFor(() => log.length > 0); };

const now = Date.now();
await sleep(1200);
send({ op: 'theme', dark: true });
send({ op: 'config', autoHideMs: 600000, scale: 1 });
await sleep(200);
send({ op: 'upsert', items: [
  { sessionId: 'a', kind: 'approval', title: '需要审批', body: 'Bash · 请求在工作区外执行命令',
    sessionLabel: '重构通知模块', at: now, sticky: true },
  { sessionId: 'b', kind: 'question', title: '需要你回答', body: '要保留免打扰时段吗？',
    sessionLabel: '插件配置讨论', at: now - 1000, sticky: true },
  { sessionId: 'c', kind: 'turn', title: '轮次完成', body: 'Agent 已空闲',
    sessionLabel: '数据分析任务', at: now - 2000, sticky: false },
]});
await sleep(1000);

let names = await refresh();
console.log('初始区域 =', names.join(','), ' 高 =', win.height.toFixed(0));

console.log('\n[测1] simclick toggle → 期望展开，无 click');
clicks.length = 0;
await sim('toggle');
await sleep(500);
names = await refresh();
console.log('  区域 =', names.join(','));
console.log('  高 =', win.height.toFixed(0), ' clicks =', JSON.stringify(clicks));

console.log('\n[测2] simclick row-b → 期望 click b');
clicks.length = 0;
await sim('row-b');
await sleep(500);
names = await refresh();
console.log('  区域 =', names.join(','));
console.log('  clicks =', JSON.stringify(clicks));

console.log('\n[测3] simclick rowclose-c → 期望无 click，c 消失');
clicks.length = 0;
await refresh();
await sim('rowclose-c');
await sleep(500);
names = await refresh();
console.log('  区域 =', names.join(','));
console.log('  clicks =', JSON.stringify(clicks));

console.log('\n[测4] simclick head → 期望 click 剩余最优先的');
clicks.length = 0;
await refresh();
await sim('head');
await sleep(500);
console.log('  clicks =', JSON.stringify(clicks));

send({ op: 'exit' });
await sleep(200);
child.kill();

// 三形态流转自测：临时卡片 → 小球 → 列表 → 回到小球
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EXE = join(here, '..', 'lib', 'native', 'dsh-notify-overlay.exe');
const child = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');

let state = null;
const clicks = [];
child.stdout.on('data', (d) => {
  for (const l of d.split('\n')) {
    const s = l.trim(); if (!s) continue;
    let m; try { m = JSON.parse(s); } catch { continue; }
    if (m.op === 'hotzones') state = m;
    else if (m.op === 'click') clicks.push(m.sessionId);
    else if (m.op === 'error') console.log('  [err]', m.message);
  }
});
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const waitFor = async (pred, ms = 2500) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(40); }
  return false;
};
const probe = async () => { state = null; send({ op: 'hotzones' }); await waitFor(() => state !== null); return state; };
const sim = async (name) => {
  send({ op: 'simclick', name });
  await sleep(400);
};

const now = Date.now();
await sleep(1200);
send({ op: 'config', autoHideMs: 1500, scale: 1, sound: false, lang: 'zh' });
await sleep(200);

console.log('=== 阶段 1：一条持久提醒 → 应弹卡片 ===');
send({ op: 'notify', lang: 'zh', autoHideMs: 1500, items: [{
  sessionId: 'a', kind: 'approval', title: '需要审批', body: 'Bash · 请求在工作区外执行命令',
  sessionLabel: '重构通知模块', at: now, persistent: true,
}]});
await sleep(500);
let s = await probe();
console.log('  mode =', s.mode, ' 区域 =', s.zones.map(z => z.name).join(','), ' 窗口 =', `${Math.round(s.win.width)}x${Math.round(s.win.height)}`);

console.log('\n=== 阶段 2：等卡片超时 → 应变小球（计数 1）===');
await sleep(2000);
s = await probe();
console.log('  mode =', s.mode, ' 区域 =', s.zones.map(z => z.name).join(','), ' 窗口 =', `${Math.round(s.win.width)}x${Math.round(s.win.height)}`);

console.log('\n=== 阶段 3：再推两条持久 → 卡片后应累计小球计数 3 ===');
send({ op: 'notify', lang: 'zh', autoHideMs: 1500, items: [
  { sessionId: 'b', kind: 'question', title: '需要你回答', body: '要保留免打扰时段吗？', sessionLabel: '插件配置讨论', at: now - 1000, persistent: true },
]});
await sleep(2200);
send({ op: 'notify', lang: 'zh', autoHideMs: 1500, items: [
  { sessionId: 'c', kind: 'error', title: '执行出错', body: 'ENOENT: 找不到指定文件', sessionLabel: '构建失败排查', at: now - 2000, persistent: true },
]});
await sleep(2200);
s = await probe();
console.log('  mode =', s.mode, ' 区域 =', s.zones.map(z => z.name).join(','));

console.log('\n=== 阶段 4：点小球 → 应展开列表 ===');
await sim('ball');
await sleep(500);
s = await probe();
console.log('  mode =', s.mode, ' 区域 =', s.zones.map(z => z.name).join(','), ' 窗口高 =', Math.round(s.win.height));

console.log('\n=== 阶段 5：列表里关掉一条 → 应刷新，仍为列表 ===');
clicks.length = 0;
await sim('rowclose-b');
await sleep(400);
s = await probe();
console.log('  mode =', s.mode, ' 区域 =', s.zones.map(z => z.name).join(','), ' clicks =', JSON.stringify(clicks));

console.log('\n=== 阶段 6：点列表底部「收起」→ 应回小球 ===');
await sim('footer');
await sleep(400);
s = await probe();
console.log('  mode =', s.mode, ' 区域 =', s.zones.map(z => z.name).join(','));

console.log('\n=== 阶段 7：host 撤下全部 → 应变隐藏 ===');
send({ op: 'remove', sessionId: 'a', kind: 'approval' });
send({ op: 'remove', sessionId: 'c', kind: 'error' });
await sleep(600);
s = await probe();
console.log('  mode =', s.mode, ' 区域 =', s.zones.map(z => z.name).join(','));

console.log('\n=== 阶段 8：非持久提醒 → 卡片后应彻底隐藏，不留小球 ===');
send({ op: 'notify', lang: 'zh', autoHideMs: 1200, items: [{
  sessionId: 't', kind: 'turn', title: '轮次完成', body: 'Agent 已空闲',
  sessionLabel: '数据分析任务', at: Date.now(), persistent: false,
}]});
await sleep(500);
s = await probe();
console.log('  卡片期 mode =', s.mode);
await sleep(1600);
s = await probe();
console.log('  超时后 mode =', s.mode, '（应为 Hidden）');

console.log('\n=== 阶段 9：英文语言 ===');
send({ op: 'notify', lang: 'en', autoHideMs: 3000, items: [{
  sessionId: 'z', kind: 'turn', title: 'Turn complete', body: 'The agent is idle',
  sessionLabel: 'Data analysis', at: Date.now(), persistent: false,
}]});
await sleep(600);
s = await probe();
console.log('  mode =', s.mode, ' 区域 =', s.zones.map(z => z.name).join(','));

send({ op: 'exit' });
await sleep(300);
child.kill();

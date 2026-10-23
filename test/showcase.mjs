// 新 UI 演示：三种形态完整走一遍，你看着屏幕上的浮窗
//
//   node test/showcase.mjs
//
// 时间线：
//   0s    弹一张「需要审批」卡片（6 秒后自动消失）
//   7s    变成小球（计数 1）
//   9s    再弹「需要回答」卡片
//   16s   变成小球（计数 2）
//   18s   再弹「出错」卡片
//   25s   变成小球（计数 3）
//   27s   自动点小球 → 展开列表（3 条 + 收起按钮）
//   40s   自动点「收起」→ 回到小球
//   45s   切浅色 12 秒
//   60s   英文卡片演示
//   之后  常驻，等你上手点。Ctrl+C 结束

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EXE = 'E:\\dsh-plugins\\dsh-notify-overlay\\lib\\native\\dsh-notify-overlay.exe';
const child = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (d) => {
  for (const l of d.split('\n')) if (l.trim()) {
    try {
      const m = JSON.parse(l.trim());
      if (m.op !== 'hotzones') console.log('  [浮窗]', l.trim());
    } catch {}
  }
});
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const stamp = (s) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);

process.on('SIGINT', () => { try { send({ op: 'exit' }); } catch {} child.kill(); process.exit(0); });

await sleep(1200);
send({ op: 'config', autoHideMs: 6000, scale: 1, sound: false, lang: 'zh' });
await sleep(200);

const mk = (id, kind, title, body, label, persistent) => ({
  sessionId: id, kind, title, body, sessionLabel: label, at: Date.now(), persistent,
});

stamp('① 弹「需要审批」卡片 —— 6 秒后自动收成小球');
send({ op: 'notify', lang: 'zh', autoHideMs: 6000, items: [
  mk('a', 'approval', '需要审批', 'Bash · 请求在工作区外执行命令', '重构通知模块', true),
]});

await sleep(7000);
stamp('② 应该是小球了，计数 1');

await sleep(2000);
stamp('③ 再弹「需要回答」');
send({ op: 'notify', lang: 'zh', autoHideMs: 6000, items: [
  mk('b', 'question', '需要你回答', '要保留免打扰时段吗？', '插件配置讨论', true),
]});

await sleep(7000);
stamp('④ 小球，计数 2');

await sleep(2000);
stamp('⑤ 再弹「出错」');
send({ op: 'notify', lang: 'zh', autoHideMs: 6000, items: [
  mk('c', 'error', '执行出错', 'ENOENT: 找不到指定文件', '构建失败排查', true),
]});

await sleep(7000);
stamp('⑥ 小球，计数 3');

await sleep(2000);
stamp('⑦ 自动点开小球 → 列表（3 条 + 收起）');
send({ op: 'simclick', name: 'ball' });

await sleep(13000);
stamp('⑧ 自动点「收起」→ 回到小球');
send({ op: 'simclick', name: 'footer' });

await sleep(5000);
stamp('⑨ 切浅色 12 秒');
send({ op: 'theme', dark: false });
await sleep(12000);
send({ op: 'theme', dark: true });
stamp('   切回深色');

await sleep(3000);
stamp('⑩ 英文卡片（弱提醒，6 秒后消失，不留小球）');
send({ op: 'notify', lang: 'en', autoHideMs: 6000, items: [
  mk('t', 'turn', 'Turn complete', 'The agent is idle', 'Data analysis', false),
]});

await sleep(8000);
stamp('⑪ 回到小球常驻，随便点。Ctrl+C 结束');
await new Promise(() => {});

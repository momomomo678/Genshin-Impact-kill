// 调试：开局后打印 state 中每位玩家的身份字段
'use strict';
const WebSocket = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ws = new WebSocket('ws://localhost:3000');
  const msgs = [];
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    msgs.push(m);
    if (m.t === 'state') {
      console.log('== state turn', m.state.turnNo, 'phase', m.state.phase, '==');
      for (const p of m.state.players) {
        console.log(`  ${p.name}: identityRevealed=${p.identityRevealed} mainRevealed=${p.mainRevealed} identity=${p.identity}`);
      }
    }
  });
  await new Promise((res) => ws.on('open', res));
  console.log('已连接');
  ws.send(JSON.stringify({ t: 'create', name: '探查者' }));
  await sleep(500);
  ws.send(JSON.stringify({ t: 'add_ai' }));
  await sleep(500);
  ws.send(JSON.stringify({ t: 'start' }));
  await sleep(1500);
  console.log('收到消息总数：', msgs.length, '类型：', msgs.map((m) => m.t).join(','));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

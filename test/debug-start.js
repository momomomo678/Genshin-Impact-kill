// 调试：打印建房间→开局后的原始消息
'use strict';
const WebSocket = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket('ws://localhost:3000');
  const box = { ws, name, msgs: [] };
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    box.msgs.push(m);
  });
  return new Promise((res, rej) => { ws.on('open', () => res(box)); ws.on('error', rej); });
}

(async () => {
  const A = await client('A');
  const B = await client('B');
  A.ws.send(JSON.stringify({ t: 'create', name: '甲' }));
  await sleep(400);
  const lobby = A.msgs.find((m) => m.t === 'lobby');
  B.ws.send(JSON.stringify({ t: 'join', code: lobby.roomCode, name: '乙' }));
  await sleep(400);
  A.ws.send(JSON.stringify({ t: 'add_ai' }));
  await sleep(400);
  A.ws.send(JSON.stringify({ t: 'start' }));
  await sleep(1200);
  console.log('--- A 收到的消息类型 ---');
  console.log(A.msgs.map((m) => m.t + (m.t === 'state' ? '#' + m.state.turnNo : '')).join(', '));
  console.log('--- B 收到的消息类型 ---');
  console.log(B.msgs.map((m) => m.t + (m.t === 'state' ? '#' + m.state.turnNo : '')).join(', '));
  const errs = [...A.msgs, ...B.msgs].filter((m) => m.t === 'error');
  console.log('错误消息：', JSON.stringify(errs));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

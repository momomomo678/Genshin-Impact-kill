// 原神杀 · 协议联机测试
// 用法：node test/client-test.js （需先启动 server.js）
// 模拟：A 建房 → B 加入 → A 补位 AI 到 4 人 → A 开局。
// 两个「真人」客户端会自动结束回合、放弃响应，驱动对局推进。
'use strict';

const WebSocket = require('ws');
const URL = 'ws://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(URL);
  const box = {
    ws, name, msgs: [], identity: null, state: null, errors: [],
    myId: null, actedTurn: -1,
  };
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    box.msgs.push(m);
    if (m.t === 'lobby') box.myId = m.playerId;
    if (m.t === 'identity') box.identity = m.identity;
    if (m.t === 'state') box.state = m.state;
    if (m.t === 'error') box.errors.push(m.msg);
    if (m.t === 'ask') scheduleResponse(box);
  });
  function scheduleResponse(b) {
    setTimeout(() => {
      if (b.askJustHandled) return;
      // 通用策略：只要需要我响应，一律放弃/自动弃置，让对局流动
      b.ws.send(JSON.stringify({ t: 'respond', value: null }));
    }, 500);
  }
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(box));
    ws.on('error', (e) => reject(e));
  });
}

async function main() {
  const A = await client('A');
  const B = await client('B');
  const send = (c, o) => c.ws.send(JSON.stringify(o));

  send(A, { t: 'create', name: '玩家甲' });
  await sleep(300);
  const lobbyA = A.msgs.find((m) => m.t === 'lobby');
  const code = lobbyA.roomCode;
  console.log('A 建房成功，房间号', code);

  send(B, { t: 'join', code, name: '玩家乙' });
  await sleep(300);
  send(A, { t: 'add_ai' });
  await sleep(300);
  send(A, { t: 'start' });
  await sleep(800);
  if (!A.msgs.some((m) => m.t === 'game_start')) throw new Error('A 未收到 game_start');
  if (!B.msgs.some((m) => m.t === 'game_start')) throw new Error('B 未收到 game_start');
  if (!A.identity || !B.identity) throw new Error('未收到身份消息');
  if (!A.msgs.some((m) => m.t === 'hand')) throw new Error('未收到手牌');
  console.log('开局成功：A 身份=' + A.identity + ' B 身份=' + B.identity);

  // 主循环：自动结束自己的回合，推动对局
  const deadline = Date.now() + 120000;
  let lastTurn = 0;
  while (Date.now() < deadline) {
    for (const box of [A, B]) {
      const st = box.state;
      if (st && !st.over && st.currentId === box.myId && st.phase === 'play') {
        if (box.actedTurn !== st.turnNo) {
          box.actedTurn = st.turnNo;
          setTimeout(() => send(box, { t: 'end_turn' }), 700);
        }
      }
    }
    if (A.state) {
      if (A.state.turnNo > lastTurn) { lastTurn = A.state.turnNo; console.log('  回合推进：', lastTurn); }
      if (A.state.over) break;
    }
    await sleep(1000);
  }

  console.log('========================================');
  if (A.state) console.log('最终：回合', A.state.turnNo, '阶段', A.state.phase, '结束:', A.state.over, A.state.over ? '(' + (A.state.players.find(p=>!p.alive) ? '有人阵亡' : '') + ')' : '');
  console.log('A 收到：log x' + A.msgs.filter((m) => m.t === 'log').length, 'hand x' + A.msgs.filter((m) => m.t === 'hand').length, 'state x' + A.msgs.filter((m) => m.t === 'state').length, 'ask x' + A.msgs.filter((m) => m.t === 'ask').length);
  if (A.errors.length) console.log('A 错误：', A.errors.slice(0, 5));
  if (B.errors.length) console.log('B 错误：', B.errors.slice(0, 5));

  if (lastTurn < 3) throw new Error('对局未能推进（回合数不足 3）');
  if (A.errors.length || B.errors.length) throw new Error('对局中出现错误消息');
  console.log('协议联机测试通过 ✔');
  A.ws.close(); B.ws.close();
  process.exit(0);
}

main().catch((e) => { console.error('测试失败：', e.message); process.exit(1); });

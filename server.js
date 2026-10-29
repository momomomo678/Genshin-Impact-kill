// ============================================================
// 原神杀 · 服务器入口
// ------------------------------------------------------------
// 职责：
//  1. 用 http 静态托管 public/ 下的前端页面（手机电脑浏览器都能开）
//  2. 用 WebSocket 管理房间：建房 / 加房 / 补位 AI / 开局 / 结算
//  3. 对局消息路由：出牌、响应、弃牌、结束回合、重开
// 联机方式：
//  局域网：手机/电脑访问 http://<本机IP>:3000
//  互联网：樱花映射(SakuraFrp) 把本机 3000 端口映射出去，或 RedMine
//          VPN 组网后访问对方局域网 IP。
// ============================================================
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { CONFIG, IDENTITY_CONFIG } = require('./src/config');
const { Game } = require('./src/game');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------- HTTP 静态服务 ----------------
const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end('Bad Request'); return; }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ server });

const rooms = new Map(); // code -> room
let pidSeq = 0;

function makeCode() {
  let code;
  do { code = String(1000 + Math.floor(Math.random() * 9000)); } while (rooms.has(code));
  return code;
}
function sanitizeName(name) {
  name = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name) name = '旅行者';
  return name.slice(0, 12);
}
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function roomPlayers(room) { return Array.from(room.players.values()).sort((a, b) => a.seat - b.seat); }
function lobbyPayload(room, forId) {
  return {
    t: 'lobby', roomCode: room.code, isHost: room.hostId === forId, playerId: forId,
    testMode: room.testMode || false,
    players: roomPlayers(room).map((p) => ({ id: p.id, name: p.name, isAI: p.isAI, isHost: p.id === room.hostId })),
  };
}
function broadcast(room, obj) {
  for (const p of room.players.values()) if (p.connected && p.ws) send(p.ws, obj);
}
function sendTo(room, playerId, obj) {
  const p = room.players.get(playerId);
  if (p && p.connected && p.ws) send(p.ws, obj);
}
// 向房间内每位玩家发送「各自视角」的大厅状态（playerId/isHost 必须逐人正确）
function broadcastLobby(room) {
  for (const p of room.players.values()) {
    if (p.connected && p.ws) send(p.ws, lobbyPayload(room, p.id));
  }
}
function findRoomByWs(ws) { return ws.clientInfo && rooms.get(ws.clientInfo.code); }

function routeEvent(room, type, playerId, data) {
  switch (type) {
    case 'state': broadcast(room, { t: 'state', state: data }); break;
    case 'log': room.logs.push(...data); broadcast(room, { t: 'log', entries: data }); break;
    case 'hand': sendTo(room, playerId, { t: 'hand', cards: data }); break;
    case 'ask': sendTo(room, playerId, { t: 'ask', ask: data }); break;
    case 'ask_end': sendTo(room, playerId, { t: 'ask_end' }); break;
    case 'error': sendTo(room, playerId, { t: 'error', msg: data }); break;
    case 'game_over': broadcast(room, { t: 'game_over', winner: data.winner, players: data.players }); break;
    case 'choose_char': sendTo(room, playerId, { t: 'choose_char', choices: data.choices }); break;
    case 'identity': sendTo(room, playerId, { t: 'identity', identity: data.identity, char: data.char }); break;
    default: break;
  }
}

// ---------------- 房间操作 ----------------
function createRoom(ws, name, charId, testMode) {
  if (ws.clientInfo) { send(ws, { t: 'error', msg: '你已在房间中' }); return; }
  const code = makeCode();
  const room = { code, players: new Map(), hostId: null, game: null, logs: [], testMode: !!testMode };
  const id = 'p' + (++pidSeq);
  const p = { id, name: sanitizeName(name), seat: 0, isAI: false, isBot: false, connected: true, ws, charId: charId || '' };
  room.hostId = id;
  room.players.set(id, p);
  rooms.set(code, room);
  ws.clientInfo = { code, pid: id };
  send(ws, lobbyPayload(room, id));
  console.log(`[房间 ${code}] 创建，房主 ${p.name}${testMode ? '（测试模式）' : ''}`);
}

function joinRoom(ws, code, name, charId) {
  if (ws.clientInfo) { send(ws, { t: 'error', msg: '你已在房间中' }); return; }
  const room = rooms.get(String(code).trim());
  if (!room) { send(ws, { t: 'error', msg: '房间不存在，请检查房间号' }); return; }
  if (room.game) { send(ws, { t: 'error', msg: '该房间对局已开始，无法加入' }); return; }
  if (room.players.size >= CONFIG.MAX_PLAYERS) { send(ws, { t: 'error', msg: `房间已满（最多 ${CONFIG.MAX_PLAYERS} 人）` }); return; }
  const id = 'p' + (++pidSeq);
  const p = { id, name: sanitizeName(name), seat: room.players.size, isAI: false, isBot: false, connected: true, ws, charId: charId || '' };
  room.players.set(id, p);
  ws.clientInfo = { code, pid: id };
  send(ws, lobbyPayload(room, id));
  broadcastLobby(room);
  console.log(`[房间 ${code}] ${p.name} 加入（${room.players.size} 人）`);
}

function addAI(ws) {
  const room = findRoomByWs(ws);
  if (!room || room.game) { send(ws, { t: 'error', msg: '当前无法补位' }); return; }
  if (room.hostId !== ws.clientInfo.pid) { send(ws, { t: 'error', msg: '只有房主可以补位 AI' }); return; }
  const target = Math.min(CONFIG.DEFAULT_FILL_AI, CONFIG.MAX_PLAYERS);
  let n = 1;
  while (room.players.size < target && room.players.size < CONFIG.MAX_PLAYERS) {
    const id = 'p' + (++pidSeq);
    const ai = { id, name: `AI·提瓦特${n}`, seat: room.players.size, isAI: true, isBot: true, connected: true, ws: null };
    room.players.set(id, ai);
    n++;
  }
  broadcastLobby(room);
  console.log(`[房间 ${room.code}] 补位 AI，现共 ${room.players.size} 人`);
}

function startGame(ws, charChoices) {
  const room = findRoomByWs(ws);
  if (!room) return;
  if (room.hostId !== ws.clientInfo.pid) { send(ws, { t: 'error', msg: '只有房主可以开始游戏' }); return; }
  if (room.game) { send(ws, { t: 'error', msg: '对局已开始' }); return; }
  const n = room.players.size;
  if (n < CONFIG.MIN_PLAYERS || n > CONFIG.MAX_PLAYERS) {
    send(ws, { t: 'error', msg: `当前人数 ${n} 人无法开局（支持 ${CONFIG.MIN_PLAYERS}~${CONFIG.MAX_PLAYERS} 人）` }); return;
  }
  // 测试模式下不需要身份配置检查
  if (!room.testMode && !IDENTITY_CONFIG[n]) {
    send(ws, { t: 'error', msg: `当前人数 ${n} 人无法开局` }); return;
  }
  const meta = roomPlayers(room).map((p, i) => ({
    id: p.id, name: p.name, seat: p.seat, isAI: p.isAI, isBot: p.isBot || !p.connected,
    charId: p.charId || '',
    chosenChar: (room.testMode && charChoices && charChoices[i]) ? charChoices[i] : '',
  }));
  meta.testMode = room.testMode || false;
  room.logs = [];
  const game = new Game(meta, (type, pid, data) => routeEvent(room, type, pid, data));
  room.game = game;
  // 先广播 game_start，再 prepare（测试模式同步选角可能卡住前端状态）
  broadcast(room, { t: 'game_start', roomCode: room.code, playerCount: n, testMode: room.testMode || false });
  game.prepare();
  console.log(`[房间 ${room.code}] 对局开始（${n} 人）${room.testMode ? '（测试模式）' : ''}`);
}

function restartGame(ws) {
  const room = findRoomByWs(ws);
  if (!room || !room.game || !room.game.over) return;
  if (room.hostId !== ws.clientInfo.pid) { send(ws, { t: 'error', msg: '只有房主可以重开' }); return; }
  // 掉线玩家继续由 AI 托管
  for (const p of room.players.values()) p.isBot = p.isBot || !p.connected;
  const meta = roomPlayers(room).map((p) => ({ id: p.id, name: p.name, seat: p.seat, isAI: p.isAI, isBot: p.isBot }));
  room.logs = [];
  const game = new Game(meta, (type, pid, data) => routeEvent(room, type, pid, data));
  room.game = game;
  game.prepare();
  broadcast(room, { t: 'game_start', roomCode: room.code, playerCount: meta.length });
  for (const p of room.players.values()) {
    const gp = game.players.find((x) => x.id === p.id);
    if (p.connected && p.ws) {
      send(p.ws, { t: 'identity', identity: gp.identity, char: { id: gp.char.id, name: gp.char.name, element: gp.char.element, maxHp: gp.maxHp, desc: gp.char.desc, skills: gp.char.skills } });
    }
  }
  game.start();
  for (const p of room.players.values()) {
    const gp = game.players.find((x) => x.id === p.id);
    if (p.connected && p.ws && gp) send(p.ws, { t: 'hand', cards: game.handMeta(gp) });
  }
  console.log(`[房间 ${room.code}] 再来一局`);
}

// 把房间玩家映射为对局玩家对象（游戏引擎内部以对局玩家为准）
function toGamePlayer(room, pid) {
  if (!room || !room.game) return null;
  return room.game.players.find((x) => x.id === pid) || null;
}

// ---------------- 消息处理 ----------------
function handleMessage(ws, msg) {
  if (!msg || typeof msg.t !== 'string') return;
  switch (msg.t) {
    case 'create': createRoom(ws, msg.name, msg.charId, msg.testMode); break;
    case 'join': joinRoom(ws, msg.code, msg.name, msg.charId); break;
    case 'add_ai': addAI(ws); break;
    case 'start': startGame(ws, msg.charChoices); break;
    case 'restart': restartGame(ws); break;
    case 'play': {
      const room = findRoomByWs(ws);
      if (!room || !room.game) { send(ws, { t: 'error', msg: '对局未开始' }); return; }
      let gp = toGamePlayer(room, ws.clientInfo.pid);
      // 测试模式下，房主操作当前行动玩家
      if (room.testMode && ws.clientInfo.pid === room.hostId && room.game.current) {
        gp = room.game.current;
      }
      if (!gp) return;
      console.log(`[房间 ${room.code}] play: ${gp.name} 出 ${String(msg.cardId)} 目标 ${JSON.stringify(msg.targets)} 阶段=${room.game.phase} 当前=${room.game.current && room.game.current.name}`);
      room.game.playCard(gp, String(msg.cardId), Array.isArray(msg.targets) ? msg.targets : [], msg);
      break;
    }
    case 'respond': {
      const room = findRoomByWs(ws);
      if (!room || !room.game) { send(ws, { t: 'error', msg: '对局未开始' }); return; }
      const p = room.players.get(ws.clientInfo.pid);
      if (!p) return;
      if (room.game.ask && room.game.ask.playerId === p.id) room.game.resolveAsk(p.id, msg.value);
      else send(ws, { t: 'error', msg: '当前没有需要你响应的操作' });
      break;
    }
    case 'end_turn': {
      const room = findRoomByWs(ws);
      if (!room || !room.game) return;
      let gp = toGamePlayer(room, ws.clientInfo.pid);
      // 测试模式下，房主操作当前行动玩家
      if (room.testMode && ws.clientInfo.pid === room.hostId && room.game.current) {
        gp = room.game.current;
      }
      if (gp) room.game.onEndTurn(gp);
      break;
    }
    case 'skill': {
      const room = findRoomByWs(ws);
      if (!room || !room.game) return;
      let gp = toGamePlayer(room, ws.clientInfo.pid);
      // 测试模式下，房主操作当前行动玩家
      if (room.testMode && ws.clientInfo.pid === room.hostId && room.game.current) {
        gp = room.game.current;
      }
      if (gp) room.game.useSkill(gp, String(msg.skillId), Array.isArray(msg.targets) ? msg.targets : [], msg.cardId || null);
      break;
    }
    case 'cheat': {
      const room = findRoomByWs(ws);
      if (!room || !room.game) { send(ws, { t: 'error', msg: '对局未开始' }); return; }
      // 只有房主能作弊
      if (ws.clientInfo.pid !== room.hostId) { send(ws, { t: 'error', msg: '只有房主能作弊' }); return; }
      const game = room.game;
      const target = game.players.find((p) => p.id === msg.targetId);
      if (!target) { send(ws, { t: 'error', msg: '目标不存在' }); return; }
      if (msg.action === 'add_card') {
        // 给指定玩家加一张指定类型的牌
        const kind = msg.cardKind;
        const { CARD_META } = require('./src/cards');
        const cardMeta = CARD_META[kind];
        if (!cardMeta) { send(ws, { t: 'error', msg: '卡牌类型不存在: ' + kind }); return; }
        const card = {
          id: 'cheat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          name: cardMeta.name, kind, suit: 'spade', rank: 'A',
        };
        target.hand.push(card);
        game.emit('hand', target.id, game.handMeta(target));
        game.log(`【作弊】${target.name} 获得一张【${cardMeta.name}】`, 'error');
        game.emitState();
      } else if (msg.action === 'add_hp') {
        target.hp = Math.min(target.maxHp, target.hp + (msg.amount || 1));
        game.log(`【作弊】${target.name} 回复 ${msg.amount || 1} 点生命（${target.hp}/${target.maxHp}）`, 'error');
        game.emitState();
      } else if (msg.action === 'sub_hp') {
        const amount = msg.amount || 1;
        // 胡桃【幽蝶能留一缕芳】：作弊扣血也触发免死
        if (target.char && target.char.id === 'hu_tao') {
          target._permanentUsed = target._permanentUsed || {};
          if (!target._permanentUsed['hu_tao_3_used'] && target.hp - amount <= 0) {
            target._permanentUsed['hu_tao_3_used'] = true;
            target.hp = 1;
            game.log(`【作弊】${target.name} 触发【幽蝶能留一缕芳】！保留1点生命！`, 'skill');
            game.emitState();
            break;
          }
        }
        target.hp = Math.max(0, target.hp - amount);
        game.log(`【作弊】${target.name} 扣除 ${amount} 点生命（${target.hp}/${target.maxHp}）`, 'error');
        if (target.hp <= 0) game.enterDying(target, null);
        game.emitState();
      }
      break;
    }
    case 'play_discard': {
      const room = findRoomByWs(ws);
      if (!room || !room.game) return;
      const gp = toGamePlayer(room, ws.clientInfo.pid);
      if (gp) room.game.discardInPlay(gp, msg.cards);
      break;
    }
    case 'leave': {
      const room = findRoomByWs(ws);
      if (room) handleDisconnect(ws);
      break;
    }
    case 'choose_char': {
      const room = findRoomByWs(ws);
      if (!room || !room.game) { send(ws, { t: 'error', msg: '对局未开始' }); return; }
      const pid = ws.clientInfo.pid;
      const gp = room.game.players.find((p) => p.id === pid);
      if (!gp || gp.char) { send(ws, { t: 'error', msg: '你已经选过角色了' }); return; }
      room.game.setChar(gp, msg.charId);
      break;
    }
    default: break;
  }
}

function handleDisconnect(ws) {
  const info = ws.clientInfo;
  if (!info || !info.code) return;
  const room = rooms.get(info.code);
  if (!room) return;
  const p = room.players.get(info.pid);
  if (!p) return;

  if (!room.game) {
    // 大厅阶段：房主离开则解散房间
    if (info.pid === room.hostId) {
      rooms.delete(room.code);
      for (const q of room.players.values()) {
        if (q.connected && q.ws) send(q.ws, { t: 'room_closed', msg: '房主已离开，房间已解散' });
        if (q.ws) { q.ws.clientInfo = null; }
      }
      console.log(`[房间 ${room.code}] 房主离开，房间解散`);
      return;
    }
    room.players.delete(info.pid);
    roomPlayers(room).forEach((q, i) => { q.seat = i; });
    broadcastLobby(room);
    console.log(`[房间 ${room.code}] ${p.name} 离开大厅（剩 ${room.players.size} 人）`);
    return;
  }

  // 对局中：AI 接管，保证不卡局
  p.connected = false;
  p.isBot = true;
  const gp = room.game.players.find((x) => x.id === p.id);
  if (gp) gp.isBot = true;
  room.game.log(`${p.name} 掉线，已由 AI 托管。`, 'warn');
  room.game.emitState();
  if (room.game.ask && room.game.ask.playerId === p.id) {
    room.game.resolveAsk(p.id, null);
  } else if (room.game.phase === 'play' && room.game.current && room.game.current.id === p.id && gp) {
    require('./src/ai').aiPlayTurn(gp, room.game);
  }
  console.log(`[房间 ${room.code}] ${p.name} 掉线，AI 接管`);
}

// ---------------- WebSocket 连接 ----------------
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let msg = null;
    try { msg = JSON.parse(data.toString()); } catch { send(ws, { t: 'error', msg: '消息格式错误' }); return; }
    try { handleMessage(ws, msg); } catch (e) { console.error('[消息处理错误]', e); send(ws, { t: 'error', msg: '服务器内部错误' }); }
  });
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => { /* 忽略单个连接的底层错误 */ });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* noop */ }
  }
}, CONFIG.HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

// ---------------- 启动 ----------------
server.listen(CONFIG.PORT, () => {
  console.log('==============================================');
  console.log('  原神杀 服务器已启动');
  console.log(`  本机访问：   http://localhost:${CONFIG.PORT}`);
  const ips = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const i of iface || []) {
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
    }
  }
  for (const ip of ips) console.log(`  局域网访问：http://${ip}:${CONFIG.PORT}`);
  console.log('  互联网联机：使用樱花映射/RedMine VPN 映射本机端口后分享地址');
  console.log('==============================================');
});

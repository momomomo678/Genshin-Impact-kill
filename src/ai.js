// ============================================================
// 原神杀 · 简单 AI 托管
// ------------------------------------------------------------
// 用途：1) 房主可以一键“补位 AI”单人测试；2) 玩家掉线后由 AI
// 自动接管，保证对局不被卡住。AI 决策刻意从简，只为让流程跑通。
// 响应类函数（aiDodge/aiSlashResponse/aiSave/aiWuxie）内部直接
// 消耗卡牌，返回 true 表示已响应。
// ============================================================
'use strict';

function aiDodge(p, game) {
  const jink = p.hand.find((c) => c.kind === 'jink');
  if (jink) { game.consumeCard(p, jink); return true; }
  return false;
}

function aiSlashResponse(p, game) {
  // 优先用普通攻击，没有就用元素攻击（元素攻击继承普通攻击机制）
  const slash = p.hand.find((c) => c.kind === 'slash');
  if (slash) { game.consumeCard(p, slash); return true; }
  const elemental = p.hand.find((c) => c.kind === 'elemental');
  if (elemental) { game.consumeCard(p, elemental); return true; }
  return false;
}

function aiSave(p, game) {
  const egg = p.hand.find((c) => c.kind === 'food_egg');
  if (egg) { game.consumeCard(p, egg); return true; }
  return false;
}

function aiWuxie(p, game, ctx) {
  const affectsMe = ctx.targetsMe || ctx.trickName === '深渊入侵' || ctx.trickName === '搜查令';
  if (!affectsMe) return false;
  const w = p.hand.find((c) => c.kind === 'wuxie');
  if (w) { game.consumeCard(p, w); return true; }
  return false;
}

function pickOther(p, game) {
  return game.players.find((x) => x.alive && x.id !== p.id) || null;
}

function pickOtherWithCards(p, game, inRangeOnly) {
  const cands = game.players.filter((x) => x.alive && x.id !== p.id && (!inRangeOnly || game.inRange(p, x)));
  for (const x of cands) {
    if (x.hand.length || x.equip.weapon || x.equip.armor) return x;
  }
  return null;
}

// 选杀的目标：优先打已知敌对阵营，否则打最近的存活角色
function chooseTarget(p, game) {
  const others = game.players.filter((x) => x.alive && x.id !== p.id);
  if (!others.length) return null;
  let cands = others;
  if (p.identity === 'main') {
    const enemies = others.filter((x) => x.identity === 'rebel' || x.identity === 'spy');
    if (enemies.length) cands = enemies;
  } else {
    const mains = others.filter((x) => x.identity === 'main' || x.mainRevealed);
    if (mains.length) cands = mains;
  }
  return cands.find((x) => game.inRange(p, x)) || others.find((x) => game.inRange(p, x)) || null;
}

// 出牌阶段：轮询执行预排的操作列表，等待他人响应时暂停
function aiPlayTurn(p, game) {
  const acts = [];

  const eq = p.hand.find((c) => c.kind === 'crossbow' || c.kind === 'bagua');
  if (eq) acts.push(() => game.playCard(p, eq.id, []));

  const peach = p.hand.find((c) => c.kind === 'peach');
  if (peach && p.hp < p.maxHp) acts.push(() => game.playCard(p, peach.id, []));

  const wz = p.hand.find((c) => c.kind === 'wuzhong');
  if (wz) acts.push(() => game.playCard(p, wz.id, []));

  const dm = p.hand.find((c) => c.kind === 'dimai');
  if (dm) acts.push(() => game.playCard(p, dm.id, []));

  const ys = p.hand.find((c) => c.kind === 'yanshou');
  if (ys) acts.push(() => game.playCard(p, ys.id, []));

  const ld = p.hand.find((c) => c.kind === 'leidian');
  if (ld) acts.push(() => game.playCard(p, ld.id, []));

  // 仙跳墙：有杀的时候先用
  const hasSlash = p.hand.some((c) => c.kind === 'slash');
  if (hasSlash) {
    const wine = p.hand.find((c) => c.kind === 'wine');
    if (wine) acts.push(() => game.playCard(p, wine.id, []));
  }

  const slash = p.hand.find((c) => c.kind === 'slash');
  if (slash) {
    const target = chooseTarget(p, game);
    if (target) acts.push(() => game.playCard(p, slash.id, [target.id]));
  }
  const elem = p.hand.find((c) => c.kind === 'elemental');
  if (elem) {
    const target = chooseTarget(p, game);
    if (target) acts.push(() => game.playCard(p, elem.id, [target.id]));
  }

  const dt = p.hand.find((c) => c.kind === 'dismantle');
  if (dt) {
    const t = pickOtherWithCards(p, game, false);
    if (t) acts.push(() => game.playCard(p, dt.id, [t.id]));
  }
  const sn = p.hand.find((c) => c.kind === 'snatch');
  if (sn) {
    const t = pickOtherWithCards(p, game, true);
    if (t) acts.push(() => game.playCard(p, sn.id, [t.id]));
  }
  const du = p.hand.find((c) => c.kind === 'duel');
  if (du) {
    const t = pickOther(p, game);
    if (t) acts.push(() => game.playCard(p, du.id, [t.id]));
  }
  const nm = p.hand.find((c) => c.kind === 'nanman');
  if (nm) acts.push(() => game.playCard(p, nm.id, []));
  const ar = p.hand.find((c) => c.kind === 'arrows');
  if (ar) acts.push(() => game.playCard(p, ar.id, []));
  const gd = p.hand.find((c) => c.kind === 'garden');
  if (gd) acts.push(() => game.playCard(p, gd.id, []));
  const gb = p.hand.find((c) => c.kind === 'guanbijing');
  if (gb) {
    const t = pickOther(p, game);
    if (t) acts.push(() => game.playCard(p, gb.id, [t.id]));
  }
  const lr = p.hand.find((c) => c.kind === 'liangren');
  if (lr) {
    const t = pickOther(p, game);
    if (t) acts.push(() => game.playCard(p, lr.id, [t.id]));
  }

  let idx = 0;
  const myTurn = game.turnNo;
  const tick = () => {
    if (game.over || !p.alive) return;
    // 回合已轮转，本循环使命结束
    if (game.turnNo !== myTurn || p !== game.current) return;
    // 濒死结算 / 弃牌阶段等窗口期：稍后再继续
    if (game.phase !== 'play' || game.waiting) { setTimeout(tick, 400); return; }
    if (idx >= acts.length) { game.onEndTurn(p); return; }
    const fn = acts[idx++];
    setTimeout(() => {
      if (game.over || !p.alive) return;
      if (game.turnNo !== myTurn || p !== game.current) return;
      if (game.phase !== 'play' || game.waiting) { setTimeout(tick, 500); return; }
      try { fn(); } catch (e) { console.error('[AI act error]', e); }
      setTimeout(tick, 900);
    }, 1000 + Math.random() * 800);
  };
  tick();
}

function aiDiscard(p, game, count) {
  game.discardRandom(p, count, '弃牌阶段(AI)');
  game.push(() => game.endPhase(p));
}

module.exports = { aiPlayTurn, aiDiscard, aiDodge, aiSlashResponse, aiSave, aiWuxie };

// ============================================================
// 原神杀 · 核心游戏逻辑（服务端权威结算）
// ------------------------------------------------------------
// 职责：牌堆管理、身份/角色分配、回合流程（准备→判定→摸牌→
// 出牌→弃牌→结束）、卡牌效果结算、伤害/濒死/死亡、胜负判定。
//
// 与传输层解耦：Game 通过 this.onEvent(type, playerId, data) 通知
// 服务器（见 server.js 的挂接），服务器负责转发给对应玩家。
// 所有需要等待玩家输入的流程都走「队列 + 等待」模型，保证单线程
// 顺序结算且不会重入。
// ============================================================
'use strict';

const { CONFIG, IDENTITY_CONFIG, IDENTITY_META } = require('./config');
const { CARD_META, buildDeck, rankText, suitColor, isRed } = require('./cards');
const { CHARACTERS, applyHooks } = require('./characters');

class Game {
  /**
   * @param {Array} playersMeta  [{ id, name, seat, isAI, isBot }]
   * @param {Function} onEvent  (type, playerId, data) => void
   */
  constructor(playersMeta, onEvent) {
    this.id = 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    this.onEvent = onEvent;
    this.testMode = playersMeta.testMode || false;
    this.players = playersMeta.map((m, i) => ({
      id: m.id, name: m.name, seat: i, isAI: !!m.isAI, isBot: !!m.isBot,
      charId: m.charId || '', chosenChar: m.chosenChar || '', char: null, identity: null, identityRevealed: false,
      hp: 0, maxHp: 0, hand: [], equip: { weapon: [], armor: [], plusOne: [], minusOne: [] },
      alive: true, slashUsed: 0, _skillFlags: {},
    }));
    this.current = null;        // 当前行动玩家
    this.phase = 'prepare';     // prepare/judge/draw/play/discard/end/dying
    this.turnNo = 0;
    this.deck = buildDeck();
    this.discard = [];          // 弃牌堆（含已使用牌）
    this.queue = [];            // 待执行步骤队列
    this.waiting = false;       // 正在等待玩家输入
    this.ask = null;            // 当前响应请求
    this._draining = false;
    this._playTimer = null;
    this.over = false;
    this.winner = null;
    this.logs = [];             // 房间内日志（服务端保留，用于重发）
  }

  // ---------------- 事件 & 日志 ----------------
  emit(type, playerId, data) {
    try { this.onEvent(type, playerId, data); } catch (e) { console.error('[emit error]', e); }
    if (type === 'error') console.log(`[game error] 玩家 ${playerId}: ${data}`);
  }
  emitState() { this.emit('state', null, this.publicState()); }
  log(text, cls = '') {
    const entry = { text, cls, t: Date.now() };
    this.logs.push(entry);
    if (this.logs.length > 300) this.logs.shift();
    this.emit('log', null, [entry]);
  }

  // ---------------- 队列 & 等待 ----------------
  push(fn) { this.queue.push(fn); this._drain(); }
  _drain() {
    if (this._draining) return;
    this._draining = true;
    while (this.queue.length && !this.waiting && !this.over) {
      const fn = this.queue.shift();
      try { fn(); } catch (e) {
        console.error('[game step error]', e);
        this.log('（游戏内部错误，请查看服务端日志）', 'error');
      }
    }
    this._draining = false;
  }
  waitFor(askDef) {
    this.ask = { playerId: askDef.playerId, type: askDef.type, data: askDef.data, resolve: askDef.resolve };
    this.waiting = true;
    this.emit('ask', askDef.playerId, { type: askDef.type, data: askDef.data });
    const timeout = askDef.timeout != null ? askDef.timeout : CONFIG.JUDGE_DURATION;
    const cur = this.ask;
    cur._t = setTimeout(() => {
      if (this.ask === cur) this.resolveAsk(cur.playerId, null);
    }, timeout);
  }
  resolveAsk(responderId, payload) {
    if (!this.ask || this.ask.playerId !== responderId) return false;
    clearTimeout(this.ask._t);
    const ask = this.ask;
    this.ask = null;
    this.waiting = false;
    this.emit('ask_end', responderId, null);
    try { ask.resolve(responderId, payload); } catch (e) { console.error('[ask resolve error]', e); }
    this._drain();
    return true;
  }
  clearAskIf(condition) {
    if (this.ask && condition(this.ask)) {
      clearTimeout(this.ask._t);
      const p = this.ask.playerId;
      this.ask = null; this.waiting = false;
      this.emit('ask_end', p, null);
    }
  }

  // ---------------- 开局 ----------------
  // prepare：分配身份/角色/起始手牌，确定先行者（不推进回合）
  prepare() {
    // 身份分配（测试模式下无身份）
    if (!this.testMode) {
      const cfg = IDENTITY_CONFIG[this.players.length];
      const pool = [];
      for (const key of ['main', 'loyal', 'rebel', 'spy']) {
        for (let i = 0; i < (cfg[key] || 0); i++) pool.push(key);
      }
      // Fisher–Yates
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      this.players.forEach((p, i) => {
        p.identityRevealed = false;
        p.identity = pool[i];
        if (p.identity === 'main') p.identityRevealed = true;
      });
    } else {
      // 测试模式：无身份，第一个玩家先行动
      this.players.forEach((p, i) => {
        p.identity = null;
        p.identityRevealed = false;
      });
    }

    // 角色候选：给每个玩家发两张不重复的角色卡
    const allCharKeys = Object.keys(CHARACTERS);
    // 洗牌
    for (let i = allCharKeys.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allCharKeys[i], allCharKeys[j]] = [allCharKeys[j], allCharKeys[i]];
    }
    let idx = 0;
    for (const p of this.players) {
      p._charChoices = [allCharKeys[idx++], allCharKeys[idx++]];
      p.char = null;
      p.maxHp = 0;
      p.hp = 0;
    }

    // 测试模式下：直接用预选的角色，跳过选角色弹窗
    if (this.testMode) {
      for (const p of this.players) {
        if (p.chosenChar && CHARACTERS[p.chosenChar]) {
          this.setChar(p, p.chosenChar);
        } else {
          // 没选的随机一个
          this.setChar(p, allCharKeys[Math.floor(Math.random() * allCharKeys.length)]);
        }
      }
    } else {
      // 正常模式：发送选角色请求给每个玩家
      for (const p of this.players) {
        if (p.isBot) {
          this.setChar(p, p._charChoices[0]);
        } else {
          this.emit('choose_char', p.id, { choices: p._charChoices });
        }
      }
    }

    // 检查是否所有玩家都选好了
    this._checkAllCharsChosen();
  }

  setChar(p, charId) {
    if (!CHARACTERS[charId]) return;
    p.char = CHARACTERS[charId];
    p.maxHp = p.char.maxHp;
    p.hp = p.maxHp;
    this.log(`${p.name} 选择了【${p.char.name}】。`, 'play');
    // 发送身份和角色信息给该玩家
    this.emit('identity', p.id, {
      identity: p.identity,
      char: { id: p.char.id, name: p.char.name, element: p.char.element, maxHp: p.maxHp, desc: p.char.desc, skills: p.char.skills },
    });
    this._checkAllCharsChosen();
  }

  _checkAllCharsChosen() {
    const allChosen = this.players.every(p => p.char !== null);
    if (!allChosen || this.phase !== 'prepare') return;
    // 所有人都选好了，进入正式开始
    this.phase = 'start';
    // 起始手牌
    this.players.forEach((p) => this.drawCards(p, CONFIG.START_HAND, '开局摸牌'));
    this.start();
  }

  start() {
    // 第一个玩家先行（测试模式下第一个玩家先行动）
    this.current = this.players.find((p) => p.identity === 'main') || this.players[0];
    this.log(`游戏开始！共 ${this.players.length} 人。`, 'start');
    this.players.forEach((p) => {
      const idStr = p.identity ? `（${p.identity}）` : '';
      this.log(`${p.name} 获得角色【${p.char.name}】${idStr}`, 'info');
    });
    this.emitState();
    this.push(() => this.beginTurn(this.current));
  }

  // ---------------- 回合流程 ----------------
  beginTurn(p) {
    if (this.over || !p.alive) return;
    // 【天星】效果：跳过下一次行动
    if (p._skipNextTurn) {
      p._skipNextTurn = false;
      this.log(`${p.name} 被【天星】击中，跳过本次行动！`, 'skill');
      // 直接找 p 的下一个玩家开始回合
      const n = this.players.length;
      const start = p.seat;
      for (let k = 1; k <= n; k++) {
        const next = this.players[(start + k) % n];
        if (next.alive) { this.beginTurn(next); return; }
      }
      return;
    }
    this.turnNo++;
    p.slashUsed = 0;
    // 只清除每回合的技能标记，整局技能用 _permanentUsed 单独记录
    p._skillFlags = {};
    // 温迪【黎明破晓之史】：回合开始时检查上一周期是否有伤害行为
    if (p.char && p.char.id === 'venti') {
      if (!p._ventiHasAction) {
        p._ventiBless = true;
        this.log(`${p.name} 触发【黎明破晓之史】！本回合攻击伤害+1！`, 'skill');
      }
      p._ventiHasAction = false; // 重置标记，开始新的周期
    }
    this.current = p;
    this.phase = 'prepare';
    this.log(`—— 第 ${this.turnNo} 回合 · ${p.name} 的回合开始 ——`, 'turn');
    this.emitState();
    applyHooks(p, this, 'onTurnStart');
    this.push(() => this.judgePhase(p));
  }

  // 判定阶段：处理延时锦囊（关禁闭、落雷）
  judgePhase(p) {
    if (this.over || !p.alive || p !== this.current) return;
    this.phase = 'judge';
    this.emitState();
    const zone = p.judgeZone || [];
    if (zone.length === 0) {
      this.push(() => this.drawPhase(p));
      return;
    }
    // 依次判定判定区的牌
    let i = 0;
    const step = () => {
      if (this.over || !p.alive || p !== this.current) return;
      if (i >= zone.length) {
        this.push(() => this.drawPhase(p));
        return;
      }
      const delayCard = zone[i++];
      const c = this.judge(p, CARD_META[delayCard.kind].name);
      if (delayCard.kind === 'leidian') {
        // 落雷：黑桃2~9 受3点雷电伤害，否则移到下家
        if (c && c.suit === 'spade' && c.rank >= 2 && c.rank <= 9) {
          this.log(`${p.name} 的【落雷】判定成功，受到 3 点雷电伤害！`, 'judge');
          this.discard.push(delayCard);
          p.judgeZone.splice(i - 1, 1);
          this.push(() => this.dealDamage(null, p, 3, '落雷'));
          setTimeout(() => this.push(step), 700);
        } else {
          this.log(`${p.name} 的【落雷】判定失败，移到下家判定区。`, 'judge');
          const next = this.nextAlive(p);
          if (next) {
            next.judgeZone = next.judgeZone || [];
            next.judgeZone.push(delayCard);
          }
          p.judgeZone.splice(i - 1, 1);
          setTimeout(() => this.push(step), 700);
        }
      } else if (delayCard.kind === 'guanbijing') {
        // 关禁闭：不是红桃则跳过出牌阶段
        const isHeart = c && (c.suit === 'heart' || c.suit === 'diamond');
        this.discard.push(delayCard);
        p.judgeZone.splice(i - 1, 1);
        if (!isHeart) {
          p._skipPlay = true;
          this.log(`${p.name} 的【关禁闭】判定失败，跳过出牌阶段！`, 'judge');
        } else {
          this.log(`${p.name} 的【关禁闭】判定成功（红），正常进行。`, 'judge');
        }
        setTimeout(() => this.push(step), 700);
      } else {
        this.push(step);
      }
    };
    this.push(step);
  }

  drawPhase(p) {
    if (this.over || !p.alive || p !== this.current) return;
    this.phase = 'draw';
    const skill = applyHooks(p, this, 'onDraw', {});
    const n = CONFIG.DRAW_COUNT + skill.bonus;
    this.log(`${p.name} 进入摸牌阶段，摸 ${n} 张牌。`);
    this.drawCards(p, n, '摸牌阶段');
    this.emitState();
    this.push(() => this.playPhase(p));
  }

  playPhase(p) {
    if (this.over || !p.alive || p !== this.current) return;
    if (p._skipPlay) {
      p._skipPlay = false;
      this.push(() => this.discardPhase(p));
      return;
    }
    this.phase = 'play';
    this.log(`${p.name} 进入出牌阶段。`, 'phase');
    this.emitState();
    clearTimeout(this._playTimer);
    this._playTimer = setTimeout(() => {
      if (!this.over && this.phase === 'play' && this.current === p && !p.isBot) {
        this.log(`（${p.name} 长时间未操作，自动结束回合）`, 'warn');
        this.onEndTurn(p);
      }
    }, CONFIG.PLAY_END_DURATION);
    // 测试模式下人偶不自动行动，等待玩家切换视角操作
    if (p.isBot && !this.testMode) require('./ai').aiPlayTurn(p, this);
  }

  onEndTurn(p) {
    clearTimeout(this._playTimer);
    if (this.over || !p || p.id !== (this.current && this.current.id) || this.phase !== 'play') return;
    this.log(`${p.name} 结束出牌阶段。`);
    this._skillDisabled = false; // 清除眼狩令
    p._wineBonus = 0; // 清除仙跳墙加成
    p._huTaoFire = false; // 清除胡桃火元素攻击
    p._geoAttack = false; // 清除诺艾尔护心铠（自己用的岩元素攻击效果）
    p._shield = 0; // 清除诺艾尔护心铠护盾（持续到该玩家行动结束）
    p._kaijin = false; // 清除心海海人化羽效果（持续到自己回合结束）
    p._ganyuBless = false; // 清除甘雨履虫效果（持续到自己回合结束）
    p._ventiBless = false; // 清除温迪黎明破晓之史效果（持续到自己回合结束）
    p._elementalCount = 0; // 清空/荧临时计数（保留共鸣层数跨回合）
    // p._resonance 保留，跨回合累积
    p._enchantedElem = null; // 清空/荧附魔（附魔不跨回合）
    // 清除本回合所有玩家的无敌状态
    for (const pl of this.players) pl._invincible = false;
    // 迈特凯【八门·死门】：回合结束直接死亡，无濒死
    if (p._gaiDeathGate) {
      p._gaiDeathGate = false;
      this.log(`${p.name} 的【八门·死门】效果结束，直接死亡！`, 'skill');
      this.kill(p, null, '八门·死门');
    }
    this.push(() => this.discardPhase(p));
  }

  // 出牌阶段主动弃牌（用于处理手牌，不限数量）
  discardInPlay(p, ids) {
    if (this.over || !p || p.id !== (this.current && this.current.id) || this.phase !== 'play' || !p.alive) {
      return this.emit('error', p.id, '现在不能弃牌');
    }
    const valid = Array.isArray(ids) && ids.length > 0 && ids.every((id) => p.hand.some((c) => c.id === id));
    if (!valid) return this.emit('error', p.id, '弃牌无效');
    this.discardCards(p, ids, '主动弃牌');
    this.log(`${p.name} 主动弃置了 ${ids.length} 张牌。`, 'play');
    this.emitState();
  }

  discardPhase(p) {
    if (this.over || !p.alive || p !== this.current) return;
    this.phase = 'discard';
    this.emitState();
    const limit = this.handLimit(p);
    const excess = p.hand.length - limit;
    if (excess <= 0) { this.push(() => this.endPhase(p)); return; }
    this.log(`${p.name} 进入弃牌阶段，手牌上限 ${limit}，需弃置 ${excess} 张牌。`);
    if (p.isBot) { require('./ai').aiDiscard(p, this, excess); return; }
    this.waitFor({
      type: 'discard', playerId: p.id,
      data: { count: excess, limit },
      resolve: (_rid, ids) => {
        const valid = Array.isArray(ids) && ids.length === excess &&
          ids.every((id) => p.hand.some((c) => c.id === id));
        if (valid) this.discardCards(p, ids, '弃牌阶段');
        else { this.discardRandom(p, excess, '弃牌阶段（超时自动弃置）'); }
        this.push(() => this.endPhase(p));
      },
    });
  }

  endPhase(p) {
    if (this.over) return;
    this.phase = 'end';
    this.log(`${p.name} 的回合结束。`);
    this.emitState();
    applyHooks(p, this, 'onTurnEnd');
    this.push(() => this.nextTurn());
  }

  nextTurn() {
    if (this.over) return;
    const n = this.players.length;
    const start = this.current.seat;
    for (let k = 1; k <= n; k++) {
      const p = this.players[(start + k) % n];
      if (p.alive) { this.beginTurn(p); return; }
    }
    // 只剩自己
    this.beginTurn(this.current);
  }

  // 当前行动角色在自己的回合中阵亡时，收尾该回合
  abortCurrentTurn() {
    if (this.over) return;
    clearTimeout(this._playTimer);
    this.phase = 'end';
    this.log(`${this.current.name} 已阵亡，其回合结束。`, 'warn');
    this.emitState();
    this.push(() => this.nextTurn());
  }

  // ---------------- 摸牌 / 弃牌 ----------------
  drawCards(p, n, reason) {
    for (let i = 0; i < n; i++) {
      if (this.deck.length === 0) {
        if (this.discard.length === 0) break; // 无牌可摸
        this.deck = this.shuffle(this.discard);
        this.discard = [];
        this.log('牌堆耗尽，弃牌堆重新洗入牌堆。', 'warn');
      }
      p.hand.push(this.deck.pop());
    }
    this.emit('hand', p.id, this.handMeta(p));
  }

  discardCards(p, ids, reason) {
    for (const id of ids) {
      const idx = p.hand.findIndex((c) => c.id === id);
      if (idx >= 0) this.discard.push(p.hand.splice(idx, 1)[0]);
    }
    this.emit('hand', p.id, this.handMeta(p));
  }
  discardRandom(p, n, reason) {
    for (let i = 0; i < n && p.hand.length; i++) {
      const idx = Math.floor(Math.random() * p.hand.length);
      this.discard.push(p.hand.splice(idx, 1)[0]);
    }
    this.emit('hand', p.id, this.handMeta(p));
  }
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  handLimit(p) {
    // 钟离【炊金馔玉】：手牌上限固定为6，不随血量改变
    if (p.char && p.char.id === 'zhongli') {
      return 6;
    }
    // 迈特凯【体术·无极限】：手牌上限无限
    if (p.char && p.char.id === 'gai') {
      return 999;
    }
    let limit = Math.max(0, p.hp);
    for (const skill of (p.char ? p.char.skills : [])) {
      const fn = skill.hooks && skill.hooks.onHandLimit;
      if (fn) {
        const r = fn({ player: p, game: this, base: limit });
        if (typeof r === 'number') limit = r;
      }
    }
    return limit;
  }
  slashLimit(p) {
    // 检查所有武器，有没有诸葛连弩
    for (const w of p.equip.weapon) {
      if (w.kind === 'crossbow') return 999;
    }
    let limit = CONFIG.SLASH_LIMIT;
    for (const skill of (p.char ? p.char.skills : [])) {
      const fn = skill.hooks && skill.hooks.onSlashLimit;
      if (fn) {
        const r = fn({ player: p, game: this, base: limit });
        if (typeof r === 'number') limit = r;
      }
    }
    return limit;
  }

  // ---------------- 出牌 ----------------
  playCard(p, cardId, targetIds = [], opts = {}) {
    if (this.over || !p || p.id !== (this.current && this.current.id) || this.phase !== 'play' || !p.alive) {
      return this.emit('error', p.id, '现在不能出牌');
    }
    const idx = p.hand.findIndex((c) => c.id === cardId);
    if (idx < 0) return this.emit('error', p.id, '你没有这张牌');
    const card = p.hand[idx];
    const meta = CARD_META[card.kind];

    switch (card.kind) {
      case 'slash': return this.playSlash(p, card, targetIds);
      case 'elemental': return this.playElemental(p, card, targetIds, opts);
      case 'peach': return this.playPeach(p, card, targetIds);
      case 'wine': return this.playWine(p, card);
      case 'wuzhong': return this.playWuzhong(p, card);
      case 'dismantle': return this.playDismantle(p, card, targetIds);
      case 'snatch': return this.playSnatch(p, card, targetIds);
      case 'nanman': return this.playNanman(p, card);
      case 'arrows': return this.playArrows(p, card);
      case 'garden': return this.playGarden(p, card);
      case 'duel': return this.playDuel(p, card, targetIds);
      case 'dimai': return this.playDimai(p, card);
      case 'yanshou': return this.playYanshou(p, card);
      case 'guanbijing': return this.playGuanbijing(p, card, targetIds);
      case 'leidian': return this.playLeidian(p, card);
      case 'liangren': return this.playLiangren(p, card, targetIds);
      case 'crossbow':
      case 'bagua':
      case 'ruin_guard':
      case 'wind_seed':
      case 'wind_field': return this.equipCard(p, card);
      case 'jink': return this.emit('error', p.id, '【闪避】只能作为响应牌使用');
      case 'food_egg':
        // 甘雨【天地交泰】：出牌阶段也可以用提瓦特煎蛋
        if (p.char && p.char.id === 'ganyu') {
          return this.playPeach(p, card, targetIds);
        }
        return this.emit('error', p.id, '【提瓦特煎蛋】只能在濒死救援时使用');
      case 'wuxie': return this.emit('error', p.id, '【庇护】只能在响应时使用');
      default: return this.emit('error', p.id, '未知卡牌');
    }
  }

  // ---------------- 主动技能 ----------------
  useSkill(p, skillId, targetIds = [], cardId = null) {
    if (this.over || !p || p.id !== (this.current && this.current.id) || this.phase !== 'play' || !p.alive) {
      return this.emit('error', p.id, '现在不能使用技能');
    }
    if (!p.char) return this.emit('error', p.id, '你没有选择角色');
    // 眼狩令：技能不生效（空/荧除外）
    if (this._skillDisabled && p.char.id !== 'traveler') {
      return this.emit('error', p.id, '【眼狩令】生效中，技能无法使用');
    }
    // 每回合一次的技能检查
    p._skillFlags = p._skillFlags || {};
    switch (skillId) {
      case 'hu_tao_2': // 引蝶来生
        if (p._skillFlags[skillId]) return this.emit('error', p.id, '本回合已使用过【引蝶来生】');
        let cost = 0;
        if (p.hp > 1) {
          cost = Math.max(1, Math.ceil(p.hp * 0.3));
          p.hp = Math.max(1, p.hp - cost);
        }
        p._huTaoFire = true; // 本回合普通攻击变火元素
        p._skillFlags[skillId] = true;
        this.log(`${p.name} 使用【引蝶来生】${cost > 0 ? `，扣除 ${cost} 点生命（${p.hp}/${p.maxHp}）` : ''}，本回合普通攻击变为火元素伤害！`, 'skill');
        this.emitState();
        return;
      case 'noelle_1': // 护心铠
        if (p._skillFlags[skillId]) return this.emit('error', p.id, '本回合已使用过【护心铠】');
        const tid = Array.isArray(targetIds) ? targetIds[0] : null;
        const t = this.players.find((x) => x.id === tid);
        if (!t || !t.alive) return this.emit('error', p.id, '请选择【护心铠】的目标');
        if (t.id === p.id) {
          // 目标是自己：下一次造成的伤害变为岩元素伤害，造成后回复1点生命
          p._geoAttack = true;
          p._skillFlags[skillId] = true;
          this.log(`${p.name} 对自己使用【护心铠】！下一次造成的伤害变为岩元素伤害，造成伤害后回复1点生命。`, 'skill');
        } else {
          // 目标是别人：抵挡1点伤害的护盾
          t._shield = (t._shield || 0) + 1;
          p._skillFlags[skillId] = true;
          this.log(`${p.name} 使用【护心铠】，为 ${t.name} 添加一个抵挡1点伤害的护盾。`, 'skill');
        }
        this.emitState();
        return;
      case 'noelle_2': // 全心全意
        if (p._permanentUsed && p._permanentUsed[skillId]) return this.emit('error', p.id, '整局游戏只能使用一次【全心全意】');
        const tid2 = Array.isArray(targetIds) ? targetIds[0] : null;
        const t2 = this.players.find((x) => x.id === tid2);
        if (!t2 || !t2.alive) return this.emit('error', p.id, '请选择【全心全意】的目标');
        t2._invincible = true;
        p._permanentUsed = p._permanentUsed || {};
        p._permanentUsed[skillId] = true;
        this.log(`${p.name} 使用【全心全意】！${t2.name} 本回合免疫所有伤害！`, 'skill');
        this.emitState();
        return;
      case 'kokomi_2': // 庙算无遗：选一张红色手牌当桃打出
        if (p._skillFlags[skillId]) return this.emit('error', p.id, '本回合已使用过【庙算无遗】');
        // 选目标
        const tidK = Array.isArray(targetIds) ? targetIds[0] : null;
        const tk = this.players.find((x) => x.id === tidK);
        if (!tk || !tk.alive) return this.emit('error', p.id, '请选择【庙算无遗】的治疗目标');
        if (tk.hp >= tk.maxHp) return this.emit('error', p.id, `${tk.name} 的体力已满，不能使用【庙算无遗】`);
        // 消耗指定的红色手牌
        const idxK = p.hand.findIndex(c => c.id === cardId);
        if (idxK < 0) return this.emit('error', p.id, '请选择一张红色花色的手牌');
        const usedCard = p.hand.splice(idxK, 1)[0];
        this.discard.push(usedCard);
        // 治疗
        tk.hp = Math.min(tk.maxHp, tk.hp + 1);
        p._skillFlags[skillId] = true;
        this.log(`${p.name} 使用【庙算无遗】，将【${usedCard.name}】当【甜甜花酿鸡】使用，为 ${tk.name} 回复1点生命（${tk.hp}/${tk.maxHp}）。`, 'skill');
        // 触发海人化羽效果
        if (tk.id !== p.id) {
          p._kaijin = true;
          this.log(`${p.name} 触发【海人化羽】！下一次攻击伤害提升并附加水元素效果。`, 'skill');
        }
        this.emit('hand', p.id, this.handMeta(p));
        this.emitState();
        return;
      case 'traveler_3': // 共鸣
        if ((p._resonance || 0) < 2) return this.emit('error', p.id, '共鸣层数不足（需要2层）');
        p._resonance = 0;
        if (p.isBot) {
          const elems = ['anemo', 'geo', 'electro', 'hydro', 'pyro', 'cryo', 'dendro'];
          p._enchantedElem = elems[Math.floor(Math.random() * elems.length)];
          this.log(`${p.name} 使用【共鸣】，下一次攻击附魔为【${p._enchantedElem}】元素！`, 'skill');
          this.emitState();
        } else {
          this.waitFor({
            type: 'choose_element', playerId: p.id,
            data: {},
            resolve: (_rid, chosenElem) => {
              p._enchantedElem = chosenElem || 'anemo';
              this.log(`${p.name} 使用【共鸣】，下一次攻击附魔为【${p._enchantedElem}】元素！`, 'skill');
              this.emitState();
            },
          });
        }
        return;
      case 'zhongli_2': // 地心：选弃3张牌，套3点护盾
        if (p._skillFlags[skillId]) return this.emit('error', p.id, '本回合已使用过【地心】');
        if (p.hand.length < 3) return this.emit('error', p.id, '手牌不足3张，无法使用【地心】');
        // 弹出选牌询问，让玩家选3张牌
        this.waitFor({
          playerId: p.id,
          type: 'choose_two_cards',
          data: { count: 3, desc: '【地心】请选择3张要弃置的手牌' },
          resolve: (_rid, cardIds) => {
            if (!Array.isArray(cardIds) || cardIds.length !== 3) return;
            // 弃掉选中的3张牌
            let discardedCount = 0;
            for (const cardId of cardIds) {
              const idx = p.hand.findIndex(c => c.id === cardId);
              if (idx >= 0) {
                const card = p.hand.splice(idx, 1)[0];
                this.discard.push(card);
                discardedCount++;
              }
            }
            if (discardedCount < 3) return;
            p._zhongliShield = 3; // 3点护盾
            p._skillFlags[skillId] = true;
            this.log(`${p.name} 使用【地心】，弃置3张牌，获得一个可以抵挡3点伤害的护盾！`, 'skill');
            this.emit('hand', p.id, this.handMeta(p));
            this.emitState();
          },
        });
        return;
      case 'zhongli_3': // 天星：选弃5张牌，指定一人跳过下回合
        if (p._skillFlags[skillId]) return this.emit('error', p.id, '本回合已使用过【天星】');
        if (p.hand.length < 5) return this.emit('error', p.id, '手牌不足5张，无法使用【天星】');
        const tidZ = Array.isArray(targetIds) ? targetIds[0] : null;
        const tz = this.players.find((x) => x.id === tidZ);
        if (!tz || !tz.alive) return this.emit('error', p.id, '请选择【天星】的目标');
        // 弹出选牌询问，让玩家选5张牌
        this.waitFor({
          playerId: p.id,
          type: 'choose_two_cards',
          data: { count: 5, desc: '【天星】请选择5张要弃置的手牌' },
          resolve: (_rid, cardIds) => {
            if (!Array.isArray(cardIds) || cardIds.length !== 5) return;
            // 弃掉选中的5张牌
            let discardedCount = 0;
            for (const cardId of cardIds) {
              const idx = p.hand.findIndex(c => c.id === cardId);
              if (idx >= 0) {
                const card = p.hand.splice(idx, 1)[0];
                this.discard.push(card);
                discardedCount++;
              }
            }
            if (discardedCount < 5) return;
            tz._skipNextTurn = true; // 跳过下一次行动
            p._skillFlags[skillId] = true;
            this.log(`${p.name} 使用【天星】，弃置5张牌，${tz.name} 将跳过下一次行动！`, 'skill');
            this.emit('hand', p.id, this.handMeta(p));
            this.emitState();
          },
        });
        return;
      case 'gai_3': // 八门·死门：主动开启，本回合伤害×4，回合结束直接死亡
        if (p._skillFlags[skillId]) return this.emit('error', p.id, '本回合已开启过【八门·死门】');
        p._gaiDeathGate = true; // 开启死门
        p._skillFlags[skillId] = true;
        this.log(`${p.name} 开启【八门·死门】！本回合所有伤害×4，回合结束时将直接死亡！`, 'skill');
        this.emitState();
        return;
      default:
        return this.emit('error', p.id, '未知技能');
    }
  }

  getTarget(p, targetIds) {
    const tid = Array.isArray(targetIds) ? targetIds[0] : null;
    const t = this.players.find((x) => x.id === tid);
    if (!t || !t.alive || t === p) return null;
    return t;
  }

  consumeCard(p, card, to = 'discard') {
    const idx = p.hand.findIndex((c) => c.id === card.id);
    if (idx < 0) return;
    p.hand.splice(idx, 1);
    if (to === 'discard') this.discard.push(card);
    this.emit('hand', p.id, this.handMeta(p));
  }

  // —— 普通攻击 ——
  playSlash(p, card, targetIds) {
    const t = this.getTarget(p, targetIds);
    if (!t) return this.emit('error', p.id, '请选择合法的【普通攻击】目标');
    if (p.slashUsed >= this.slashLimit(p)) return this.emit('error', p.id, '本回合已使用过【普通攻击】');
    if (!this.inRange(p, t)) return this.emit('error', p.id, '目标不在你的攻击范围内');

    // 温迪【弦发的苍风】：有黎明破晓之史效果时，先问是否触发
    if (p.char && p.char.id === 'venti' && p._ventiBless) {
      this.push(() => {
        this.waitFor({
          playerId: p.id,
          type: 'confirm_venti',
          data: { targetName: t.name },
          resolve: (_rid, val) => {
            if (val === true || val === 'yes') {
              // 触发弦发的苍风：取消伤害+1，打两个目标，每个1点
              const blessBackup = p._ventiBless;
              p._ventiBless = false;
              p.slashUsed++;
              this.consumeCard(p, card);
              this.log(`${p.name} 触发【弦发的苍风】！对 ${t.name} 使用【普通攻击】，请选择第二个攻击目标！`, 'play');
              this.afterCardPlayed(p, card);
              this.emitState();
              // 第一个目标先造成1点伤害
              this.push(() => this.askDodge(t, {
                source: p, amount: 1, cardName: '普通攻击',
                onHit: () => this.push(() => this.dealDamage(p, t, 1, '普通攻击')),
                onMiss: () => this.log(`${t.name} 成功闪避了【普通攻击】。`),
              }));
              // 问第二个目标
              this.push(() => {
                this.waitFor({
                  type: 'choose_target',
                  playerId: p.id,
                  data: { desc: '【弦发的苍风】请选择第二个攻击目标' },
                  resolve: (_rid2, targetId) => {
                    if (targetId) {
                      const extraTarget = this.players.find(x => x.id === targetId);
                      if (extraTarget && extraTarget.alive) {
                        this.log(`${p.name} 对 ${extraTarget.name} 使用【弦发的苍风】！`, 'skill');
                        this.push(() => this.askDodge(extraTarget, {
                          source: p, amount: 1, cardName: '弦发的苍风',
                          onHit: () => this.push(() => this.dealDamage(p, extraTarget, 1, '弦发的苍风')),
                          onMiss: () => this.log(`${extraTarget.name} 成功闪避了【弦发的苍风】。`),
                        }));
                      }
                    }
                    p._ventiBless = blessBackup; // 恢复效果，持续到回合结束
                  },
                });
              });
            } else {
              // 不触发，正常打
              this.doNormalSlash(p, card, t);
            }
          },
        });
      });
      return;
    }

    // 正常攻击
    this.doNormalSlash(p, card, t);
  }

  doNormalSlash(p, card, t) {
    p.slashUsed++;
    this.consumeCard(p, card);
    // 空/荧共鸣附魔：下一次普通攻击变成元素攻击
    const enchanted = p._enchantedElem;
    if (enchanted) {
      p._enchantedElem = null;
      this.log(`${p.name} 对 ${t.name} 使用【普通攻击】（${enchanted}元素附魔）。`, 'play');
    } else {
      this.log(`${p.name} 对 ${t.name} 使用【普通攻击】。`, 'play');
    }
    // 空/荧【共鸣】：攻击后叠加一层
    if (p.char && p.char.id === 'traveler') {
      p._resonance = (p._resonance || 0) + 1;
      if (p._resonance >= 2) this.log(`${p.name} 共鸣已满！可主动使用附魔元素。`, 'skill');
    }
    this.afterCardPlayed(p, card);
    this.emitState();
    const dmgBonus = p._wineBonus || 0;
    p._wineBonus = 0;
    this.push(() => this.askDodge(t, {
      source: p, amount: 1 + dmgBonus, cardName: '普通攻击',
      onHit: () => this.push(() => this.dealDamage(p, t, 1 + dmgBonus, '普通攻击')),
      onMiss: () => this.log(`${t.name} 成功闪避了【普通攻击】。`),
    }));
  }

  askDodge(target, ctx) {
    // 迈特凯【惊门·昼虎】：需要同时选两张闪避才能躲避
    if (ctx.source.char && ctx.source.char.id === 'gai') {
      // AI人偶自动判断：有没有两张闪避
      if (target.isBot) {
        const dodgeCards = target.hand.filter(c => c.kind === 'jink');
        if (dodgeCards.length >= 2) {
          // 自动用两张闪避
          for (let i = 0; i < 2; i++) {
            const idx = target.hand.findIndex(c => c.kind === 'jink');
            if (idx >= 0) {
              const card = target.hand.splice(idx, 1)[0];
              this.discard.push(card);
            }
          }
          this.log(`${target.name} 打出两张【闪避】，成功躲避【惊门·昼虎】！`, 'play');
          ctx.onMiss();
        } else {
          this.log(`${target.name} 闪避不足，未能躲避【惊门·昼虎】！`, 'play');
          ctx.onHit();
        }
        return;
      }
      // 玩家弹出选两张牌的询问
      this.waitFor({
        type: 'choose_two_cards',
        playerId: target.id,
        data: { count: 2, desc: '【惊门·昼虎】需要打出两张【闪避】才能躲避' },
        resolve: (_rid, cardIds) => {
          if (Array.isArray(cardIds) && cardIds.length === 2) {
            // 检查是不是两张都是闪避
            let dodgeCount = 0;
            for (const cid of cardIds) {
              const card = target.hand.find(c => c.id === cid);
              if (card && card.kind === 'jink') {
                this.consumeCard(target, card);
                dodgeCount++;
              }
            }
            if (dodgeCount === 2) {
              this.log(`${target.name} 打出两张【闪避】，成功躲避【惊门·昼虎】！`, 'play');
              ctx.onMiss();
            } else {
              this.log(`${target.name} 闪避数量不足，未能躲避【惊门·昼虎】！`, 'play');
              ctx.onHit();
            }
          } else {
            this.log(`${target.name} 未打出足够的【闪避】，未能躲避【惊门·昼虎】！`, 'play');
            ctx.onHit();
          }
        },
      });
      return;
    }
    // 捕风瓶判定：遍历所有防具
    let hasBagua = false;
    for (const armor of target.equip.armor) {
      if (armor.kind === 'bagua') {
        hasBagua = true;
        break;
      }
    }
    if (hasBagua) {
      const c = this.judge(target, '捕风瓶');
      if (c && isRed(c.suit)) {
        this.log(`${target.name} 的【捕风瓶】判定成功（${suitColor(c.suit) === '#e74c3c' ? '红' : '黑'}${rankText(c.rank)}），视为打出【闪避】。`, 'skill');
        ctx.onMiss();
        return;
      }
      if (c) this.log(`${target.name} 的【捕风瓶】判定失败，仍需打出【闪避】。`, 'skill');
      else this.log(`${target.name} 的【捕风瓶】无牌可判定，按失败处理。`, 'skill');
    }
    const step = () => {
      if (this.over || !target.alive) return;
      if (target.isBot) {
        const ok = require('./ai').aiDodge(target, this);
        if (ok) this.log(`${target.name} 打出【闪避】。`, 'play');
        ok ? ctx.onMiss() : ctx.onHit();
        return;
      }
      this.waitFor({
        type: 'dodge', playerId: target.id,
        data: { sourceName: ctx.source.name, cardName: ctx.cardName },
        resolve: (_rid, cardId) => {
          if (cardId) {
            this.consumeCard(target, target.hand.find((c) => c.id === cardId));
            this.log(`${target.name} 打出【闪避】。`, 'play');
            ctx.onMiss();
          } else {
            ctx.onHit();
          }
        },
      });
    };
    this.push(step);
  }

  // —— 元素攻击（继承普通攻击特性：每回合限一次、需闪避、有距离） ——
  playElemental(p, card, targetIds, opts = {}) {
    const t = this.getTarget(p, targetIds);
    if (!t) return this.emit('error', p.id, '请选择合法的【元素攻击】目标');
    if (p.slashUsed >= this.slashLimit(p)) return this.emit('error', p.id, '本回合已使用过攻击');
    if (!this.inRange(p, t)) return this.emit('error', p.id, '目标不在你的攻击范围内');
    p.slashUsed++;
    this.consumeCard(p, card);

    // 空/荧【共鸣】：攻击后叠加一层
    let elem = p._enchantedElem || (p.char ? p.char.element : 'none');
    if (p.char && p.char.id === 'traveler') {
      p._resonance = (p._resonance || 0) + 1;
      if (p._resonance >= 2) this.log(`${p.name} 共鸣已满！可主动使用附魔元素。`, 'skill');
    }
    // 消耗附魔
    p._enchantedElem = null;

    this.log(`${p.name} 对 ${t.name} 使用【元素攻击】（${elem}属性）。`, 'play');

    this.afterCardPlayed(p, card);
    this.emitState();
    this.push(() => this.askDodge(t, {
      source: p, amount: 1, cardName: '元素攻击',
      onHit: () => this.push(() => this.dealDamage(p, t, 1, '元素攻击')),
      onMiss: () => this.log(`${t.name} 成功闪避了【元素攻击】。`),
    }));

    // 甘雨【流天射术】：打完后询问是否消耗牌触发范围伤害
    if (p.char && p.char.id === 'ganyu' && p.hand.length >= (p._ganyuBless ? 1 : 2)) {
      const costCount = p._ganyuBless ? 1 : 2;
      this.push(() => {
        this.waitFor({
          playerId: p.id,
          type: 'confirm_ganyu',
          data: { targetName: t.name },
          resolve: (_rid, val) => {
            if (val === true || val === 'yes') {
              // 第二步：弹出选牌询问
              this.waitFor({
                playerId: p.id,
                type: 'choose_two_cards',
                data: { count: costCount, desc: '【流天射术】请选择' + costCount + '张要消耗的手牌' },
                resolve: (_rid2, cardIds) => {
                  if (!Array.isArray(cardIds) || cardIds.length !== costCount) return;
                  // 消耗选中的牌
                  let consumedCount = 0;
                  for (const cardId of cardIds) {
                    const idx = p.hand.findIndex(c => c.id === cardId);
                    if (idx >= 0) {
                      const card = p.hand.splice(idx, 1)[0];
                      this.discard.push(card);
                      consumedCount++;
                    }
                  }
                  if (consumedCount < costCount) return;
                  // 清除履虫标记
                  p._ganyuBless = false;
                  // 追加范围伤害
                  const idx = this.players.findIndex(x => x.id === t.id);
                  const left = this.players[(idx - 1 + this.players.length) % this.players.length];
                  const right = this.players[(idx + 1) % this.players.length];
                  const rangeTargets = [t, left, right].filter((v, i, arr) => v && v.alive && v.id !== p.id && arr.findIndex(x => x.id === v.id) === i);
                  this.log(`${p.name} 触发【流天射术】！消耗${costCount}张牌，对 ${rangeTargets.map(x => x.name).join('、')} 造成额外冰元素伤害！`, 'skill');
                  for (const target of rangeTargets) {
                    this.push(() => this.dealDamage(p, target, 1, '流天射术'));
                  }
                  this.emitState();
                },
              });
            }
          },
        });
      });
    }
  }

  // —— 甜甜花酿鸡 ——
  playPeach(p, card, targetIds = []) {
    const isKokomi = p.char && p.char.id === 'kokomi';
    // 心海【海月之誓】：可以选择治疗目标，默认自己
    let target = p;
    if (isKokomi && targetIds.length > 0) {
      const t = this.players.find((x) => x.id === targetIds[0]);
      if (t && t.alive) target = t;
    }
    if (target.hp >= target.maxHp) return this.emit('error', p.id, `${target.name} 的体力已满，不能使用【甜甜花酿鸡】`);
    this.consumeCard(p, card);
    target.hp = Math.min(target.maxHp, target.hp + 1);
    // 甘雨【履虫】：使用治疗牌后，下次流天射术只需要消耗一张牌
    if (p.char && p.char.id === 'ganyu') {
      p._ganyuBless = true;
      this.log(`${p.name} 触发【履虫】！下次【流天射术】只需消耗一张牌。`, 'skill');
    }
    // 心海【海人化羽】：对别人造成治疗后，标记下次攻击效果
    if (isKokomi && target.id !== p.id) {
      p._kaijin = true;
      this.log(`${p.name} 使用【甜甜花酿鸡】为 ${target.name} 回复 1 点体力（${target.hp}/${target.maxHp}），触发【海人化羽】！`, 'play');
    } else if (isKokomi) {
      this.log(`${p.name} 使用【甜甜花酿鸡】为自己回复 1 点体力（${p.hp}/${p.maxHp}）。`, 'play');
    } else {
      this.log(`${p.name} 使用【甜甜花酿鸡】，回复 1 点体力（${p.hp}/${p.maxHp}）。`, 'play');
    }
    this.afterCardPlayed(p, card);
    this.emitState();
  }

  // —— 仙跳墙：本回合下一张普通攻击伤害+1 ——
  playWine(p, card) {
    this.consumeCard(p, card);
    p._wineBonus = 1;
    this.log(`${p.name} 使用【仙跳墙】，本回合下一张【普通攻击】伤害+1。`, 'play');
    this.afterCardPlayed(p, card);
    this.emitState();
  }

  // —— 浓缩树脂 ——
  playWuzhong(p, card) {
    this.consumeCard(p, card);
    this.log(`${p.name} 使用【浓缩树脂】，摸两张牌。`, 'play');
    this.afterCardPlayed(p, card);
    this.drawCards(p, 2, '浓缩树脂');
    this.emitState();
  }

  // —— 史莱姆炸药桶 ——
  playDismantle(p, card, targetIds) {
    const t = this.getTarget(p, targetIds);
    if (!t) return this.emit('error', p.id, '请选择合法的【史莱姆炸药桶】目标');
    // 收集目标可选的牌：装备显示具体名称，手牌只有一个"随机一张手牌"选项
    const options = [];
    // 装备：逐件显示
    for (const zone of ['weapon', 'armor', 'plusOne', 'minusOne']) {
      for (const c of (t.equip[zone] || [])) {
        options.push({ zone, cardId: c.id, name: CARD_META[c.kind].name, zoneName: '装备' });
      }
    }
    // 手牌：只有一个随机选项
    if (t.hand.length > 0) {
      options.push({ zone: 'hand_random', cardId: null, name: '随机一张手牌', zoneName: '手牌' });
    }
    if (options.length === 0) return this.emit('error', p.id, '目标没有可弃置的牌');
    this.consumeCard(p, card);
    this.log(`${p.name} 对 ${t.name} 使用【史莱姆炸药桶】。`, 'play');
    this.afterCardPlayed(p, card);
    this.push(() => this.askWuxie(p, '史莱姆炸药桶', { target: t }, {
      onCancel: () => this.log('【史莱姆炸药桶】被【庇护】抵消。', 'play'),
      onPass: () => {
        // 询问玩家选哪张牌
        this.waitFor({
          type: 'select_card',
          playerId: p.id,
          data: {
            title: '选择要弃置的牌',
            targetName: t.name,
            options: options,
          },
          resolve: (_rid, payload) => {
            if (!payload) {
              // 超时默认随机选一张
              payload = options[Math.floor(Math.random() * options.length)];
            }
            // 处理选择
            if (payload.zone === 'hand_random') {
              // 随机弃置一张手牌
              const idx = Math.floor(Math.random() * t.hand.length);
              const discarded = t.hand.splice(idx, 1)[0];
              this.log(`${t.name} 的一张手牌被弃置。`);
            } else {
              // 从装备区域移除
              const idx = t.equip[payload.zone].findIndex(c => c.id === payload.cardId);
              if (idx >= 0) t.equip[payload.zone].splice(idx, 1);
              this.log(`${t.name} 的【${payload.name}】被弃置。`);
            }
            this.emitState();
          },
        });
      },
    }));
  }

  // —— 拾取 ——
  playSnatch(p, card, targetIds) {
    const t = this.getTarget(p, targetIds);
    if (!t) return this.emit('error', p.id, '请选择合法的【拾取】目标');
    if (!this.inRange(p, t)) return this.emit('error', p.id, '目标不在你的攻击范围内');
    // 收集目标可选的牌：装备显示具体名称，手牌只有一个"随机一张手牌"选项
    const options = [];
    // 装备：逐件显示
    for (const zone of ['weapon', 'armor', 'plusOne', 'minusOne']) {
      for (const c of (t.equip[zone] || [])) {
        options.push({ zone, cardId: c.id, name: CARD_META[c.kind].name, zoneName: '装备' });
      }
    }
    // 手牌：只有一个随机选项
    if (t.hand.length > 0) {
      options.push({ zone: 'hand_random', cardId: null, name: '随机一张手牌', zoneName: '手牌' });
    }
    if (options.length === 0) return this.emit('error', p.id, '目标没有可获得的牌');
    this.consumeCard(p, card);
    this.log(`${p.name} 对 ${t.name} 使用【拾取】。`, 'play');
    this.afterCardPlayed(p, card);
    this.push(() => this.askWuxie(p, '拾取', { target: t }, {
      onCancel: () => this.log('【拾取】被【庇护】抵消。', 'play'),
      onPass: () => {
        // 询问玩家选哪张牌
        this.waitFor({
          type: 'select_card',
          playerId: p.id,
          data: {
            title: '选择要获得的牌',
            targetName: t.name,
            options: options,
          },
          resolve: (_rid, payload) => {
            if (!payload) {
              // 超时默认随机选一张
              payload = options[Math.floor(Math.random() * options.length)];
            }
            // 处理选择
            let pickedCard = null;
            if (payload.zone === 'hand_random') {
              // 随机获得一张手牌
              const idx = Math.floor(Math.random() * t.hand.length);
              pickedCard = t.hand.splice(idx, 1)[0];
              this.log(`${p.name} 获得了 ${t.name} 的一张手牌。`, 'play');
            } else {
              // 从装备区域移除
              const idx = t.equip[payload.zone].findIndex(c => c.id === payload.cardId);
              if (idx >= 0) { pickedCard = t.equip[payload.zone][idx]; t.equip[payload.zone].splice(idx, 1); }
              this.log(`${p.name} 获得了 ${t.name} 的【${payload.name}】。`, 'play');
            }
            if (pickedCard) {
              p.hand.push(pickedCard);
              this.emit('hand', t.id, this.handMeta(t));
              this.emit('hand', p.id, this.handMeta(p));
            }
            this.emitState();
          },
        });
      },
    }));
  }

  // —— 深渊入侵 ——
  playNanman(p, card) {
    this.consumeCard(p, card);
    this.log(`${p.name} 使用【深渊入侵】！`, 'play');
    this.afterCardPlayed(p, card);
    this.push(() => this.askWuxie(p, '深渊入侵', null, {
      onCancel: () => this.log('【深渊入侵】被【庇护】抵消。', 'play'),
      onPass: () => {
        const others = this.players.filter((x) => x.alive && x.id !== p.id);
        this.chainPlayers(others, (target, next) => {
          const step = () => {
            if (this.over || !target.alive) { next(); return; }
            if (target.isBot) {
              const ok = require('./ai').aiSlashResponse(target, this);
              if (ok) this.log(`${target.name} 打出【普通攻击】。`, 'play');
              this.push(() => ok ? next() : this.damageThen(p, target, 1, '深渊入侵', next));
              return;
            }
            this.waitFor({
              type: 'slash_response', playerId: target.id,
              data: { sourceName: p.name, cardName: '深渊入侵' },
              resolve: (_rid, cardId) => {
                if (cardId) {
                  this.consumeCard(target, target.hand.find((c) => c.id === cardId));
                  this.log(`${target.name} 打出【普通攻击】。`, 'play');
                  next();
                } else {
                  this.damageThen(p, target, 1, '深渊入侵', next);
                }
              },
            });
          };
          this.push(step);
        });
      },
    }));
  }

  // —— 搜查令 ——
  playArrows(p, card) {
    this.consumeCard(p, card);
    this.log(`${p.name} 使用【搜查令】！`, 'play');
    this.afterCardPlayed(p, card);
    this.push(() => this.askWuxie(p, '搜查令', null, {
      onCancel: () => this.log('【搜查令】被【庇护】抵消。', 'play'),
      onPass: () => {
        const others = this.players.filter((x) => x.alive && x.id !== p.id);
        this.chainPlayers(others, (target, next) => {
          this.push(() => this.askDodge(target, {
            source: p, amount: 1, cardName: '搜查令',
            onHit: () => this.damageThen(p, target, 1, '搜查令', next),
            onMiss: () => next(),
          }));
        });
      },
    }));
  }

  // —— 七天神像 ——
  playGarden(p, card) {
    this.consumeCard(p, card);
    this.log(`${p.name} 使用【七天神像】，所有角色回复 1 点体力。`, 'play');
    this.afterCardPlayed(p, card);
    this.push(() => this.askWuxie(p, '七天神像', null, {
      onCancel: () => this.log('【七天神像】被【庇护】抵消。', 'play'),
      onPass: () => {
        for (const x of this.players) {
          if (!x.alive) continue;
          if (x.hp < x.maxHp) { x.hp = Math.min(x.maxHp, x.hp + 1); this.log(`${x.name} 回复 1 点体力（${x.hp}/${x.maxHp}）。`); }
        }
        this.emitState();
      },
    }));
  }

  // —— 御前决斗 ——
  playDuel(p, card, targetIds) {
    const t = this.getTarget(p, targetIds);
    if (!t) return this.emit('error', p.id, '请选择合法的【御前决斗】目标');
    this.consumeCard(p, card);
    this.log(`${p.name} 对 ${t.name} 使用【御前决斗】！`, 'play');
    this.afterCardPlayed(p, card);
    this.push(() => this.askWuxie(p, '御前决斗', { target: t }, {
      onCancel: () => this.log('【御前决斗】被【庇护】抵消。', 'play'),
      onPass: () => {
        // 目标先出普通攻击，双方交替
        let a = t;      // 当前需出普通攻击者
        let b = p;      // 对手（打不出时由 b 对 a 造成伤害）
        const step = () => {
          if (this.over || !a.alive || !b.alive) return;
          if (a.isBot) {
            const ok = require('./ai').aiSlashResponse(a, this);
            if (ok) { this.log(`${a.name} 打出【普通攻击】。`, 'play'); [a, b] = [b, a]; this.push(step); return; }
            this.push(() => this.dealDamage(b, a, 1, '御前决斗'));
            return;
          }
          this.waitFor({
            type: 'duel_slash', playerId: a.id,
            data: { fromName: b.name, cardName: '御前决斗' },
            resolve: (_rid, cardId) => {
              if (cardId) {
                this.consumeCard(a, a.hand.find((c) => c.id === cardId));
                this.log(`${a.name} 打出【普通攻击】。`, 'play');
                [a, b] = [b, a];
                this.push(step);
              } else {
                this.push(() => this.dealDamage(b, a, 1, '御前决斗'));
              }
            },
          });
        };
        this.push(step);
      },
    }));
  }

  // —— 地脉之花：翻出存活人数张牌，从你开始每人选一张 ——
  playDimai(p, card) {
    this.consumeCard(p, card);
    this.log(`${p.name} 使用【地脉之花】！`, 'play');
    this.afterCardPlayed(p, card);
    this.push(() => this.askWuxie(p, '地脉之花', null, {
      onCancel: () => this.log('【地脉之花】被【庇护】抵消。', 'play'),
      onPass: () => {
        const alive = this.players.filter((x) => x.alive);
        const n = alive.length;
        const pool = [];
        for (let i = 0; i < n; i++) {
          if (this.deck.length === 0) break;
          pool.push(this.deck.pop());
        }
        this.log(`地脉之花翻出 ${pool.length} 张牌。`, 'play');
        // 从 p 开始轮，每人选一张
        const order = this.aliveOrderFrom(p.id);
        let i = 0;
        const step = () => {
          if (this.over || pool.length === 0) return;
          if (i >= order.length) return;
          const player = order[i++];
          if (!player.alive) { this.push(step); return; }
          // AI 随机拿一张，人类暂用自动拿第一张（后续可改成 ask 选牌）
          const pick = pool.shift();
          player.hand.push(pick);
          this.emit('hand', player.id, this.handMeta(player));
          this.log(`${player.name} 获得了一张牌。`, 'play');
          setTimeout(() => this.push(step), 500);
        };
        this.push(step);
        this.emitState();
      },
    }));
  }

  // —— 眼狩令：本回合所有角色技能不生效 ——
  playYanshou(p, card) {
    this.consumeCard(p, card);
    this.log(`${p.name} 使用【眼狩令】！本回合所有角色的技能不生效。`, 'play');
    this.afterCardPlayed(p, card);
    this._skillDisabled = true;
    this.emitState();
  }

  // —— 关禁闭：延时锦囊，置于目标判定区 ——
  playGuanbijing(p, card, targetIds) {
    const t = this.getTarget(p, targetIds);
    if (!t) return this.emit('error', p.id, '请选择合法的【关禁闭】目标');
    this.consumeCard(p, card);
    this.log(`${p.name} 对 ${t.name} 使用【关禁闭】，置于其判定区。`, 'play');
    this.afterCardPlayed(p, card);
    t.judgeZone = t.judgeZone || [];
    t.judgeZone.push(card);
    this.emitState();
  }

  // —— 落雷：延时锦囊，置于自己判定区 ——
  playLeidian(p, card) {
    this.consumeCard(p, card);
    this.log(`${p.name} 使用【落雷】，置于自己判定区。`, 'play');
    this.afterCardPlayed(p, card);
    p.judgeZone = p.judgeZone || [];
    p.judgeZone.push(card);
    this.emitState();
  }

  // —— 两人三足：横置或重置一名角色 ——
  playLiangren(p, card, targetIds) {
    const t = this.getTarget(p, targetIds);
    if (!t) return this.emit('error', p.id, '请选择合法的【两人三足】目标');
    this.consumeCard(p, card);
    t.chained = !t.chained;
    this.log(`${p.name} 对 ${t.name} 使用【两人三足】：${t.chained ? '横置' : '重置'}。`, 'play');
    this.afterCardPlayed(p, card);
    this.emitState();
  }

  // —— 装备 ——
  equipCard(p, card) {
    const meta = CARD_META[card.kind];
    const slot = meta.slot;
    // 空/荧【双子】技能：每个栏可以装两件，其他角色只能装一件
    const maxCount = (p.char && p.char.id === 'traveler') ? 2 : 1;
    if (p.equip[slot].length >= maxCount) {
      // 替换最旧的
      const old = p.equip[slot].shift();
      if (old) this.discard.push(old);
    }
    const idx = p.hand.findIndex((c) => c.id === card.id);
    p.hand.splice(idx, 1);
    p.equip[slot].push(card);
    this.emit('hand', p.id, this.handMeta(p));
    this.log(`${p.name} 装备了【${meta.name}】。`, 'play');
    this.afterCardPlayed(p, card);
    this.emitState();
  }

  afterCardPlayed(p, card) {
    applyHooks(p, this, 'onPlay', { card });
    this.emit('hand', p.id, this.handMeta(p));
  }

  // ---------------- 无懈可击 ----------------
  askWuxie(usedById, trickName, trickTarget, handlers) {
    const order = this.aliveOrderFrom(usedById);
    let i = 0;
    const step = () => {
      if (this.over) return;
      if (i >= order.length) { handlers.onPass(); return; }
      const p = order[i++];
      if (!p.alive) { this.push(step); return; }
      // 手里没有庇护牌的直接跳过，不询问
      const hasWuxie = p.hand.some((c) => c.kind === 'wuxie');
      if (!hasWuxie) { this.push(step); return; }
      const targetsMe = trickTarget && trickTarget.id === p.id;
      if (p.isBot) {
        if (require('./ai').aiWuxie(p, this, { trickName, usedById, targetsMe })) {
          this.log(`${p.name} 打出【庇护】，抵消了【${trickName}】。`, 'play');
          handlers.onCancel();
          return;
        }
        setTimeout(() => this.push(step), 700);
        return;
      }
      this.waitFor({
        type: 'wuxie', playerId: p.id,
        data: { trickName, usedByName: this.players.find((x) => x.id === usedById)?.name || '', targetsMe },
        resolve: (_rid, cardId) => {
          if (cardId) {
            this.consumeCard(p, p.hand.find((c) => c.id === cardId));
            this.log(`${p.name} 打出【庇护】，抵消了【${trickName}】。`, 'play');
            handlers.onCancel();
          } else {
            this.push(step);
          }
        },
      });
    };
    this.push(step);
  }

  // ---------------- 判定 ----------------
  judge(p, reason) {
    if (this.deck.length === 0) {
      if (this.discard.length === 0) return null;
      this.deck = this.shuffle(this.discard);
      this.discard = [];
      this.log('牌堆耗尽，弃牌堆重新洗入牌堆。', 'warn');
    }
    const c = this.deck.pop();
    this.discard.push(c);
    const meta = CARD_META[c.kind];
    this.log(`【${reason}】判定：${c.suit === 'heart' || c.suit === 'diamond' ? '红' : '黑'}${rankText(c.rank)}（${meta.name}）。`, 'judge');
    return c;
  }

  // ---------------- 伤害 / 濒死 / 死亡 ----------------
  nextAlive(p) {
    const idx = this.players.findIndex((x) => x.id === p.id);
    for (let i = 1; i <= this.players.length; i++) {
      const x = this.players[(idx + i) % this.players.length];
      if (x.alive && x.id !== p.id) return x;
    }
    return null;
  }

  dealDamage(source, target, amount, cardName, isChain = false) {
    if (this.over || !target.alive) return;
    // 温迪【黎明破晓之史】：记录造成伤害或受到伤害
    if (source && source.char && source.char.id === 'venti') source._ventiHasAction = true;
    if (target && target.char && target.char.id === 'venti') target._ventiHasAction = true;
    // 无敌护盾（诺艾尔【全心全意】）
    if (target._invincible) {
      this.log(`${target.name} 处于【全心全意】的无敌状态，伤害被完全抵消！`, 'skill');
      return;
    }
    // 伤害来源的技能加成（如胡桃【血之灶火】、【引蝶来生】）
    let bonus = 0;
    if (source && source.char) {
      if (source.char.id === 'hu_tao' && source.hp <= Math.floor(source.maxHp / 2)) {
        bonus += 1;
        this.log(`${source.name} 的【血之灶火】触发：伤害+1！`, 'skill');
      }
      // 心海【海人化羽】：下次攻击伤害变为最大生命值的20%（向下取整，最小为1）
      if (source._kaijin) {
        const kaijinDmg = Math.max(1, Math.floor(source.maxHp * 0.2));
        bonus = kaijinDmg - amount; // 覆盖基础伤害
        source._kaijin = false;
        source._kaijinHeal = true; // 标记这次攻击后要回血
        this.log(`${source.name} 的【海人化羽】触发！本次水元素伤害变为 ${kaijinDmg} 点！`, 'skill');
      }
      // 温迪【黎明破晓之史】：攻击伤害+1
      if (source._ventiBless) {
        bonus += 1;
        this.log(`${source.name} 的【黎明破晓之史】触发：伤害+1！`, 'skill');
      }
      // 迈特凯【八门·死门】：所有伤害×4
      if (source._gaiDeathGate) {
        bonus = amount * 3; // 基础伤害1，×4就是加3
        this.log(`${source.name} 的【八门·死门】触发：伤害×4！`, 'skill');
      }
    }
    // 目标的防具效果：独眼小宝
    let hasRuinGuard = false;
    let isElementalDamage = cardName && (cardName.includes('元素') || cardName.includes('冰') || cardName.includes('火') || cardName.includes('水') || cardName.includes('风') || cardName.includes('岩') || cardName.includes('雷'));
    for (const armor of target.equip.armor) {
      if (armor.kind === 'ruin_guard') {
        hasRuinGuard = true;
        break;
      }
    }
    if (hasRuinGuard) {
      if (isElementalDamage) {
        // 元素伤害×2
        amount *= 2;
        this.log(`${target.name} 装备了【独眼小宝】，受到的元素伤害×2！`, 'skill');
      } else {
        // 无属性伤害免疫
        this.log(`${target.name} 装备了【独眼小宝】，免疫无属性伤害！`, 'skill');
        return;
      }
    }
    // 目标的技能减免
    const skill = applyHooks(target, this, 'onDamaged', { source, amount: amount + bonus, card: cardName });
    let dmg = amount + bonus - skill.reduce;
    // 普通护盾抵消（诺艾尔【护心铠】）
    if (target._shield && target._shield > 0) {
      target._shield -= 1;
      dmg = Math.max(0, dmg - 1);
      this.log(`${target.name} 的【护心铠】护盾抵消了1点伤害！`, 'skill');
    }
    // 钟离【地心】护盾：抵消伤害
    if (target._zhongliShield && target._zhongliShield > 0) {
      const shieldBlock = Math.min(target._zhongliShield, dmg);
      target._zhongliShield -= shieldBlock;
      dmg -= shieldBlock;
      if (shieldBlock > 0) {
        this.log(`${target.name} 的【地心】护盾抵消了${shieldBlock}点伤害！`, 'skill');
      }
    }
    if (dmg <= 0) {
      this.log(`${target.name} 受到的伤害被完全抵消。`, 'skill');
      return;
    }
    // 胡桃【幽蝶能留一缕芳】：首次致命伤害免死，整局一次
    if (target.char && target.char.id === 'hu_tao') {
      const key = 'hu_tao_3_used';
      target._permanentUsed = target._permanentUsed || {};
      if (!target._permanentUsed[key] && target.hp - dmg <= 0) {
        target._permanentUsed[key] = true;
        dmg = target.hp - 1; // 扣到剩1点
        this.log(`${target.name} 触发【幽蝶能留一缕芳】！首次致命伤害被抵消，保留1点生命！`, 'skill');
      }
    }
    target.hp -= dmg;
    this.log(`${target.name} 受到 ${dmg} 点伤害（来自 ${source ? source.name : '未知'} 的【${cardName}】），体力 ${Math.max(target.hp, 0)}/${target.maxHp}。`, 'damage');
    // 诺艾尔【护心铠】：自己用后下一次造成的伤害为岩元素伤害，造成后回复1点生命
    if (source && source._geoAttack) {
      source._geoAttack = false;
      source.hp = Math.min(source.maxHp, source.hp + 1);
      this.log(`${source.name} 的【护心铠】效果触发！本次伤害变为岩元素伤害，回复1点生命（${source.hp}/${source.maxHp}）。`, 'skill');
    }
    // 心海【海人化羽】：攻击造成有效伤害时回复1点生命
    if (source && source._kaijinHeal) {
      source._kaijinHeal = false;
      source.hp = Math.min(source.maxHp, source.hp + 1);
      this.log(`${source.name} 的【海人化羽】效果触发！攻击造成有效伤害，回复1点生命（${source.hp}/${source.maxHp}）。`, 'skill');
    }
    this.emitState();
    // 两人三足：横置角色受到伤害时，其他横置角色也受到伤害（连锁伤害不再触发连锁）
    if (target.chained && !isChain) {
      for (const other of this.players) {
        if (other.alive && other.chained && other.id !== target.id) {
          this.log(`${other.name} 因【两人三足】连锁受到 ${dmg} 点伤害。`, 'damage');
          this.push(() => this.dealDamage(source, other, dmg, cardName, true));
        }
      }
    }
    if (target.hp <= 0) this.enterDying(target, source, cardName);
  }

  // 造成伤害后必须继续 next；濒死链已先行入队，保证在 next 之前结算完毕
  damageThen(source, target, amount, cardName, next) {
    this.dealDamage(source, target, amount, cardName);
    this.push(next);
  }

  enterDying(target, source, cardName) {
    this.clearAskIf(() => true);
    this.phase = 'dying';
    this.log(`${target.name} 体力归零，进入濒死状态！`, 'dying');
    this.emitState();
    const order = this.aliveOrderFrom(target.id); // 濒死者优先
    let i = 0;
    const step = () => {
      if (this.over) return;
      if (target.hp > 0) {
        this.phase = 'play';
        this.log(`${target.name} 脱离濒死状态。`, 'dying');
        this.emitState();
        return;
      }
      if (i >= order.length) { this.kill(target, source, cardName); return; }
      const p = order[i++];
      if (!p.alive) { this.push(step); return; }
      if (p.isBot) {
        const ok = require('./ai').aiSave(p, this);
        if (ok) {
          this.log(`${p.name} 使用【提瓦特煎蛋】救援 ${target.name}（体力 ${target.hp + 1}/${target.maxHp}）。`, 'dying');
          target.hp += 1;
        }
        setTimeout(() => this.push(step), 700);
        return;
      }
      this.waitFor({
        type: 'save', playerId: p.id,
        data: { dyingId: target.id, dyingName: target.name, sourceName: source ? source.name : '', cardName },
        resolve: (_rid, cardId) => {
          // 甘雨【天地交泰】：甜甜花酿鸡也可以用来救人
          const card = p.hand.find((c) => c.id === cardId);
          if (card) {
            if (card.kind === 'food_egg' || (p.char && p.char.id === 'ganyu' && card.kind === 'peach')) {
              this.consumeCard(p, card);
              target.hp += 1;
              this.log(`${p.name} 使用【${card.name}】救援 ${target.name}（体力 ${target.hp}/${target.maxHp}）。`, 'dying');
            }
          }
          this.push(step);
        },
      });
    };
    this.push(step);
  }

  kill(player, source, cardName) {
    player.alive = false;
    player.hp = 0;
    player.identityRevealed = true;
    // 阵亡角色所有牌进入弃牌堆
    for (const c of player.hand) this.discard.push(c);
    player.hand = [];
    for (const w of player.equip.weapon) this.discard.push(w);
    player.equip.weapon = [];
    for (const a of player.equip.armor) this.discard.push(a);
    player.equip.armor = [];
    for (const p of player.equip.plusOne) this.discard.push(p);
    player.equip.plusOne = [];
    for (const m of player.equip.minusOne) this.discard.push(m);
    player.equip.minusOne = [];
    this.emit('hand', player.id, this.handMeta(player));
    this.log(`${player.name}（${IDENTITY_META[player.identity].name}）阵亡！`, 'death');
    this.emitState();

    // 奖惩：反贼死亡 → 击杀者摸 3；主公误杀忠臣 → 弃置所有牌
    if (player.identity === 'rebel' && source && source.alive) {
      this.log(`${source.name} 击杀反贼，摸三张牌作为奖励。`, 'reward');
      this.drawCards(source, 3, '击杀奖励');
      this.emitState();
    }
    if (player.identity === 'loyal' && source && source.identity === 'main' && source.alive) {
      this.log(`${source.name} 误杀忠臣，弃置所有手牌和装备牌。`, 'penalty');
      for (const c of source.hand) this.discard.push(c);
      source.hand = [];
      for (const w of source.equip.weapon) this.discard.push(w);
      source.equip.weapon = [];
      for (const a of source.equip.armor) this.discard.push(a);
      source.equip.armor = [];
      for (const p of source.equip.plusOne) this.discard.push(p);
      source.equip.plusOne = [];
      for (const m of source.equip.minusOne) this.discard.push(m);
      source.equip.minusOne = [];
      this.emit('hand', source.id, this.handMeta(source));
      this.emitState();
    }

    const winner = this.checkWinner();
    if (winner) { this.endGame(winner); return; }
    if (player === this.current) { this.push(() => this.abortCurrentTurn()); return; }
    // 非当前玩家阵亡：恢复出牌阶段，让当前玩家继续回合
    if (this.phase === 'dying') {
      this.phase = 'play';
      this.emitState();
    }
  }

  checkWinner() {
    const alive = this.players.filter((p) => p.alive);
    const main = alive.find((p) => p.identity === 'main');
    if (!main) {
      const rest = alive.filter((p) => p.identity !== 'main');
      if (rest.length === 1 && rest[0].identity === 'spy') {
        return { team: 'spy', text: '内奸胜利！', detail: '主公阵亡时场上仅剩内奸存活。' };
      }
      return { team: 'rebel', text: '反贼胜利！', detail: '主公阵亡，反贼达成目标。' };
    }
    const enemies = alive.filter((p) => p.identity === 'rebel' || p.identity === 'spy');
    if (enemies.length === 0) {
      return { team: 'main', text: '主公阵营胜利！', detail: '所有反贼与内奸均已阵亡。' };
    }
    return null;
  }

  endGame(winner) {
    if (this.over) return;
    this.over = true;
    this.winner = winner;
    clearTimeout(this._playTimer);
    this.clearAskIf(() => true);
    this.queue = [];
    for (const p of this.players) p.identityRevealed = true;
    this.emitState();
    this.log(`—— ${winner.text} ——`, 'winner');
    this.emit('game_over', null, {
      winner,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, charName: p.char ? p.char.name : '', identity: p.identity, alive: p.alive,
      })),
    });
  }

  // ---------------- 工具 ----------------
  aliveOrderFrom(idOrPlayer) {
    const ref = typeof idOrPlayer === 'string' ? this.players.find((p) => p.id === idOrPlayer) : idOrPlayer;
    const n = this.players.length;
    const start = ref ? ref.seat : 0;
    const order = [];
    for (let k = 0; k < n; k++) {
      const p = this.players[(start + k) % n];
      if (p.alive) order.push(p);
    }
    return order;
  }

  chainPlayers(list, fn) {
    let i = 0;
    const next = () => {
      if (this.over) return;
      if (i >= list.length) return;
      const p = list[i++];
      fn(p, next);
    };
    this.push(next);
  }

  inRange(a, b) {
    const alive = this.players.filter((p) => p.alive).map((p) => p.seat).sort((x, y) => x - y);
    const n = alive.length;
    if (n < 2) return true;
    const ia = alive.indexOf(a.seat);
    const ib = alive.indexOf(b.seat);
    let d = Math.min(Math.abs(ia - ib), n - Math.abs(ia - ib));
    // 计算攻击范围：取所有武器的最大范围
    let range = 1;
    for (const w of a.equip.weapon) {
      if (w.range && w.range > range) range = w.range;
    }
    // 温迪【高天之歌】：攻击时距离-1，防守时距离+1
    if (a.char && a.char.id === 'venti') d -= 1; // 温迪攻击别人，距离-1
    if (b.char && b.char.id === 'venti') d += 1; // 别人攻击温迪，距离+1
    // 迈特凯【惊门·昼虎】：攻击距离判定-2
    if (a.char && a.char.id === 'gai') d -= 2;
    // 风场（-1马）：攻击别人时距离-1
    d -= a.equip.minusOne.length;
    // 风种子（+1马）：别人攻击你时距离+1
    d += b.equip.plusOne.length;
    return d <= range;
  }

  randomCardOf(p) {
    const zones = [];
    for (const c of p.hand) zones.push({ card: c, zone: 'hand' });
    for (const w of p.equip.weapon) zones.push({ card: w, zone: 'weapon' });
    for (const a of p.equip.armor) zones.push({ card: a, zone: 'armor' });
    for (const p1 of p.equip.plusOne) zones.push({ card: p1, zone: 'plusOne' });
    for (const m of p.equip.minusOne) zones.push({ card: m, zone: 'minusOne' });
    if (!zones.length) return null;
    return zones[Math.floor(Math.random() * zones.length)];
  }

  discardCardFromZone(p, picked) {
    if (picked.zone === 'hand') {
      const idx = p.hand.findIndex((c) => c.id === picked.card.id);
      if (idx >= 0) this.discard.push(p.hand.splice(idx, 1)[0]);
      this.emit('hand', p.id, this.handMeta(p));
    } else {
      this.discard.push(picked.card);
      // 从装备数组里移除这张牌
      const idx = p.equip[picked.zone].findIndex(c => c.id === picked.card.id);
      if (idx >= 0) p.equip[picked.zone].splice(idx, 1);
    }
  }

  // ---------------- 对外数据 ----------------
  handMeta(p) {
    return p.hand.map((c) => {
      const m = CARD_META[c.kind];
      return { id: c.id, kind: c.kind, name: m.name, type: m.type, suit: c.suit, rank: c.rank,
        color: m.color, cls: m.cls, desc: m.desc, slot: m.slot || null, needTarget: m.needTarget || 'none' };
    });
  }

  publicState() {
    return {
      gameId: this.id,
      turnNo: this.turnNo,
      currentId: this.current ? this.current.id : null,
      phase: this.phase,
      deckCount: this.deck.length,
      over: this.over,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, seat: p.seat, isAI: p.isAI, isBot: p.isBot,
        alive: p.alive, hp: Math.max(p.hp, 0), maxHp: p.maxHp,
        charId: p.char ? p.char.id : null,
        charName: p.char ? p.char.name : '',
        element: p.char ? p.char.element : null,
        skills: p.char ? p.char.skills.map((s) => ({ id: s.id, name: s.name, desc: s.desc })) : [],
        usedSkills: [...Object.keys(p._skillFlags || {}).filter(k => p._skillFlags[k]), ...Object.keys(p._permanentUsed || {}).filter(k => p._permanentUsed[k])], // 已使用的技能id
        handCount: p.hand.length,
        handCards: this.testMode ? this.handMeta(p) : undefined, // 测试模式下发所有手牌详情
        equip: {
          weapon: p.equip.weapon.map(w => ({ kind: w.kind, name: CARD_META[w.kind].name })),
          armor: p.equip.armor.map(a => ({ kind: a.kind, name: CARD_META[a.kind].name })),
          plusOne: p.equip.plusOne.map(p1 => ({ kind: p1.kind, name: CARD_META[p1.kind].name })),
          minusOne: p.equip.minusOne.map(m => ({ kind: m.kind, name: CARD_META[m.kind].name })),
        },
        isCurrent: this.current ? this.current.id === p.id : false,
        phase: this.current && this.current.id === p.id ? this.phase : null,
        slashUsed: p.slashUsed,
        slashLimit: this.slashLimit(p),
        resonance: p._resonance || 0, // 空/荧共鸣层数
        enchantedElem: p._enchantedElem || null, // 空/荧附魔元素
        identityRevealed: p.identityRevealed,
        identity: p.identityRevealed ? p.identity : null,
        mainRevealed: p.identity === 'main',
        judgeZone: (p.judgeZone || []).map(c => ({ kind: c.kind, name: CARD_META[c.kind].name })),
      })),
    };
  }
}

module.exports = { Game };

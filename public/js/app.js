// ============================================================
// 原神杀 · 前端主逻辑（网络 + 状态 + 交互）
// ============================================================
'use strict';

const App = (() => {
  const { E, cardEl, otherPlayerEl, logLineEl, feedItemEl, toast, ID_NAMES, PHASE_NAMES, elementDot } = UI;

  let ws = null;

  const S = {
    screen: 'entry',          // entry | room | game
    myId: null,
    roomCode: null,
    isHost: false,
    testMode: false,          // 是否测试模式
    charChoices: [],         // 测试模式下每个位置选的角色
    players: [],              // 大厅玩家列表
    game: {
      state: null,            // 公开对局状态
      identity: null,         // 我的身份
      char: null,             // 我的角色
      hand: [],               // 我的手牌
      ask: null,              // 当前响应请求
      logs: [],
      over: false,
      winner: null,
      goPlayers: [],
    },
    sel: null,                // 主手牌选中的卡 id
    targetMode: false,
    validTargetIds: new Set(),
    selTargetIds: new Set(),
    ovSel: new Set(),         // 弹层选中的卡 id
    pendingSkillId: null,    // 待执行的技能 id
    ganyuSelectedCards: new Set(), // 甘雨流天射术选牌
    settings: { volume: 50, uiScale: 120 },
    bgm: null,                // 背景音乐对象
    currentBgmType: null,      // 'menu' | 'game'
  };

  // ---------------- 音效系统 ----------------
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  function playSound(type) {
    try {
      const ctx = getAudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      switch (type) {
        case 'select': // 选中牌：短音
          osc.frequency.value = 600;
          osc.type = 'sine';
          gain.gain.setValueAtTime(0.1, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.1);
          break;
        case 'play': // 出牌：稍长的音
          osc.frequency.value = 440;
          osc.type = 'triangle';
          gain.gain.setValueAtTime(0.15, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.2);
          break;
        case 'click': // 按钮点击：短音
          osc.frequency.value = 800;
          osc.type = 'sine';
          gain.gain.setValueAtTime(0.05, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.05);
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.05);
          break;
      }
    } catch {}
  }

  // ---------------- 设置与背景音乐 ----------------
  const MENU_BGM = 'music/HOYO-MiX - 柔风的欢愿 Que le vent soit doux.mp3';
  const GAME_BGMS = [
    'music/HOYO-MiX - 众水之诗 Ballad of Many Waters.mp3',
    'music/陈致逸 - Peaceful Hike (Qingce Daytime) 山风拂萝⾐ (轻策昼间).mp3',
    'music/HOYO-MiX - Euphoric Ride 逸兴欢跃.mp3',
    'music/陈致逸、HOYO-MiX - Angel\'s Share 天使的馈赠.mp3',
    'music/陈致逸 - Innocent Age 无虑无猜的岁月.mp3',
  ];

  function loadSettings() {
    try {
      const saved = localStorage.getItem('genshin_kill_settings');
      if (saved) S.settings = JSON.parse(saved);
    } catch {}
    applySettings();
  }

  function saveSettings() {
    localStorage.setItem('genshin_kill_settings', JSON.stringify(S.settings));
  }

  function applySettings() {
    // 音量
    if (S.bgm) S.bgm.volume = S.settings.volume / 100;
    // UI 比例
    document.body.className = document.body.className.replace(/ui-scale-\d+/g, '').trim();
    document.body.classList.add('ui-scale-' + S.settings.uiScale);
    // 更新滑块显示
    const volSlider = E('setting-volume');
    const volValue = E('setting-volume-value');
    if (volSlider) volSlider.value = S.settings.volume;
    if (volValue) volValue.textContent = S.settings.volume + '%';
    const scaleSlider = E('setting-ui-scale');
    const scaleValue = E('setting-ui-scale-value');
    if (scaleSlider) scaleSlider.value = S.settings.uiScale;
    if (scaleValue) scaleValue.textContent = S.settings.uiScale + '%';
  }

  function playBgm(type) {
    if (S.currentBgmType === type && S.bgm) return;
    S.currentBgmType = type;
    if (S.bgm) { S.bgm.pause(); S.bgm = null; }
    let src;
    if (type === 'menu') {
      src = MENU_BGM;
    } else {
      // 随机选一首游戏内音乐
      src = GAME_BGMS[Math.floor(Math.random() * GAME_BGMS.length)];
    }
    S.bgm = new Audio(src);
    S.bgm.volume = S.settings.volume / 100;
    S.bgm.loop = type === 'menu'; // 主界面循环，游戏内随机播放
    S.bgm.play().catch(() => {});
    // 游戏内音乐播放结束后随机切换下一首
    if (type === 'game') {
      S.bgm.onended = () => playBgm('game');
    }
  }

  function openSettings() {
    E('settings-modal').classList.remove('hidden');
    applySettings();
  }

  function closeSettings() {
    E('settings-modal').classList.add('hidden');
  }

  function initSettings() {
    loadSettings();
    // 设置按钮
    const btnSettings = E('btn-settings');
    if (btnSettings) btnSettings.onclick = openSettings;
    const btnSettingsEntry = E('btn-settings-entry');
    if (btnSettingsEntry) btnSettingsEntry.onclick = openSettings;
    E('settings-close').onclick = closeSettings;
    // 音量滑块
    E('setting-volume').oninput = (e) => {
      S.settings.volume = parseInt(e.target.value);
      E('setting-volume-value').textContent = S.settings.volume + '%';
      if (S.bgm) S.bgm.volume = S.settings.volume / 100;
      saveSettings();
    };
    // UI 比例滑块
    E('setting-ui-scale').oninput = (e) => {
      S.settings.uiScale = parseInt(e.target.value);
      applySettings();
      saveSettings();
    };
    // 图鉴按钮
    E('btn-codex').onclick = openCodex;
    E('codex-close').onclick = closeCodex;
    E('codex-detail-close').onclick = closeCodexDetail;
    E('codex-tab-char').onclick = () => { currentCodexTab = 'char'; updateCodexTabButtons(); renderCodexBody(); };
    E('codex-tab-card').onclick = () => { currentCodexTab = 'card'; updateCodexTabButtons(); renderCodexBody(); };
    E('codex-tab-identity').onclick = () => { currentCodexTab = 'identity'; updateCodexTabButtons(); renderCodexBody(); };
    // 公告按钮
    E('btn-announcement').onclick = () => E('announcement-modal').classList.remove('hidden');
    E('announcement-close').onclick = () => E('announcement-modal').classList.add('hidden');
    // 全屏按钮
    const toggleFullscreen = () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().then(() => {
          E('btn-fullscreen-entry').classList.add('btn-fullscreen-active');
          E('btn-fullscreen-game').classList.add('btn-fullscreen-active');
        });
      } else {
        document.exitFullscreen().then(() => {
          E('btn-fullscreen-entry').classList.remove('btn-fullscreen-active');
          E('btn-fullscreen-game').classList.remove('btn-fullscreen-active');
        });
      }
    };
    E('btn-fullscreen-entry').onclick = toggleFullscreen;
    E('btn-fullscreen-game').onclick = toggleFullscreen;
    // 监听全屏状态变化
    document.addEventListener('fullscreenchange', () => {
      const isFs = !!document.fullscreenElement;
      E('btn-fullscreen-entry').classList.toggle('btn-fullscreen-active', isFs);
      E('btn-fullscreen-game').classList.toggle('btn-fullscreen-active', isFs);
    });
    // 开始播放主界面音乐
    playBgm('menu');
  }

  // ---------------- 图鉴 ----------------
  let currentCodexTab = 'char';

  function openCodex() {
    E('codex-modal').classList.remove('hidden');
    updateCodexTabButtons();
    renderCodexBody();
  }

  function closeCodex() {
    E('codex-modal').classList.add('hidden');
  }

  function updateCodexTabButtons() {
    E('codex-tab-char').classList.toggle('btn-primary', currentCodexTab === 'char');
    E('codex-tab-card').classList.toggle('btn-primary', currentCodexTab === 'card');
    E('codex-tab-identity').classList.toggle('btn-primary', currentCodexTab === 'identity');
  }

  function openCodexDetail(title, desc) {
    E('codex-detail-title').textContent = title;
    // 按换行符分割技能，每个技能单独排版
    const lines = desc.split('\n');
    let html = '';
    for (const line of lines) {
      if (line.trim()) {
        // 把【技能名】部分加粗
        const formatted = line.replace(/【(.*?)】/, '<b style="color: var(--gold2);">【$1】</b>');
        html += '<div style="margin-bottom: 8px; line-height: 1.6;">' + formatted + '</div>';
      }
    }
    E('codex-detail-body').innerHTML = html;
    E('codex-detail-modal').classList.remove('hidden');
  }

  function closeCodexDetail() {
    E('codex-detail-modal').classList.add('hidden');
  }

  function renderCodexBody() {
    const body = E('codex-body');
    body.innerHTML = '';
    if (currentCodexTab === 'char') {
      // 显示所有角色卡片
      const chars = [
        { id: 'traveler', name: '空/荧', element: '无属性', skills: '【双子】每个装备栏可装备两件装备\n【无眼】不受到卡牌（眼狩令）的影响\n【共鸣】每第二次（普通攻击）可造成自选择的元素伤害' },
        { id: 'noelle', name: '诺艾尔', element: '岩元素', skills: '【护心铠】每回合可给一名角色一个抵挡一点伤害的护盾，持续到该玩家行动结束；若目标为自己，则效果变为下一次有效伤害变为岩元素伤害并为自己回复一点生命值，持续到自己回合结束\n【全心全意】整局游戏限一次，可在任意阶段（除伤害结算阶段）使用，为任意一名角色添加一个免疫所有伤害的护盾，持续到当前回合结束' },
        { id: 'kokomi', name: '珊瑚宫心海', element: '水元素', skills: '【海月之誓】心海的（甜甜花酿鸡）替换为治疗，可以自由选择治疗对象\n【庙算无遗】心海可以将红色花色牌当成（甜甜花酿鸡）使用\n【海人化羽】心海在造成治疗之后，下一次攻击变为水元素伤害并将基础值设立为自身最大生命值的20%（向下取整，最低为1），攻击造成有效攻击回复自身一点生命值' },
        { id: 'hu_tao', name: '胡桃', element: '火元素', skills: '【血之杜火】胡桃当前生命值低于或等于50%时，造成伤害+1\n【引蝶来生】每回合可以主动使用一次，立刻扣除当前生命值30%（向上取整）的生命值，最低剩余一点生命值则不会扣除，本回合所有（普通攻击）造成火元素伤害\n【幽蝶能留一缕芳】首次受到致命伤害不会死亡，保留一点生命值，每场游戏仅触发一次' },
        { id: 'ganyu', name: '甘雨', element: '冰元素', skills: '【流天射术】使用（元素攻击）时，可以主动消耗两张牌触发，攻击造成不可闪避的范围伤害，对选中目标及左右的目标造成一点冰元素伤害，对自己不造成伤害\n【天地交泰】（甜甜花酿鸡）和（提瓦特煎蛋）可以互通使用\n【履虫】使用（甜甜花酿鸡）和（提瓦特煎蛋）后下一次使用流天射术时只需要消耗一张牌' },
        { id: 'venti', name: '温迪', element: '风元素', skills: '【高天之歌】温迪始终被视为距离+1-1\n【黎明破晓之史】当温迪距离上一次行动开始至本次行动之间开始之间没有受到任何伤害也没有进行攻击，则本回合攻击的伤害+1\n【弦发的苍风】当黎明破晓之史处于激活状态时，温迪使用攻击可以选择同时指定两名角色作为攻击目标，但命中只造成1点伤害' },
        { id: 'zhongli', name: '钟离', element: '岩元素', skills: '【炊金馔玉】基础手牌上限为6张，不因血量改变而改变\n【地心】丢弃3张牌，为自己套一个可以抵挡3点伤害的护盾，持续到下一个自己回合开始\n【天星】丢弃5张牌，选定一名玩家作为目标，使其直接跳过下一次行动' },
        { id: 'gai', name: '乱入·迈特凯', element: '火元素', skills: '【体术·无极限】手牌上限始终为无限\n【惊门·昼虎】（普通攻击）需要两张（闪避）躲避，且攻击时距离判定-2\n【八门·死门】主动开启，迈特凯在本回合行动结束时直接死亡无濒死，本回合期间所有伤害*4' },
      ];
      const grid = document.createElement('div');
      grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 10px;';
      for (const c of chars) {
        const card = document.createElement('div');
        card.style.cssText = 'position: relative; width: 90px; height: 126px; background: linear-gradient(160deg, #2c3e50, #1a252f); border: 1px solid var(--gold); border-radius: 6px; cursor: pointer; padding: 6px; box-sizing: border-box;';
        card.innerHTML = '<div style="font-size: 12px; font-weight: bold; color: var(--gold2); text-align: center; margin-top: 40px;">' + c.name + '</div><div style="font-size: 10px; opacity: 0.7; text-align: center; margin-top: 6px;">[' + c.element + ']</div>';
        card.onclick = () => openCodexDetail(c.name, c.skills);
        grid.appendChild(card);
      }
      body.appendChild(grid);
    } else if (currentCodexTab === 'card') {
      // 手牌分类
      const categories = [
        {
          name: '基本牌',
          cardClass: 'c-slash',
          cards: [
            { name: '普通攻击', desc: '对距离内一名玩家造成1点伤害' },
            { name: '闪避', desc: '抵消一次普通攻击或元素攻击' },
            { name: '甜甜花酿鸡', desc: '回复1点体力' },
            { name: '提瓦特煎蛋', desc: '濒死时救援回复体力' },
            { name: '仙跳墙', desc: '本回合攻击伤害+1' },
            { name: '元素攻击', desc: '造成元素伤害，触发元素反应' },
          ]
        },
        {
          name: '锦囊牌',
          cardClass: 'c-trick',
          cards: [
            { name: '浓缩树脂', desc: '对所有其他玩家生效的锦囊' },
            { name: '史莱姆炸药桶', desc: '弃置目标一张牌' },
            { name: '拾取', desc: '获得目标一张牌' },
            { name: '深渊入侵', desc: '所有其他玩家需打出攻击否则受伤' },
            { name: '搜查令', desc: '查看目标手牌' },
            { name: '七天神像', desc: '全体回血' },
            { name: '御前决斗', desc: '与目标轮流打出攻击' },
            { name: '庇护', desc: '抵消锦囊效果' },
          ]
        },
        {
          name: '延时锦囊',
          cardClass: 'c-trick',
          cards: [
            { name: '关禁闭', desc: '判定非红桃则跳过出牌阶段' },
            { name: '落雷', desc: '判定黑桃则受到3点伤害' },
          ]
        },
        {
          name: '装备牌',
          cardClass: 'c-weapon',
          cards: [
            { name: '莎塔娜娅的苍银', desc: '武器：无限使用普通攻击' },
            { name: '捕风瓶', desc: '防具：需要闪避时进行判定' },
            { name: '独眼小宝', desc: '防具：免疫无属性伤害，元素伤害×2' },
            { name: '风种子', desc: '+1马：别人攻击你时距离+1' },
            { name: '风场', desc: '-1马：你攻击别人时距离-1' },
          ]
        }
      ];
      for (const cat of categories) {
        const catTitle = document.createElement('div');
        catTitle.style.cssText = 'font-size: 14px; font-weight: bold; color: #d4ac0d; margin: 12px 0 8px 0;';
        catTitle.textContent = cat.name;
        body.appendChild(catTitle);
        const grid = document.createElement('div');
        grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(70px, 1fr)); gap: 8px;';
        for (const c of cat.cards) {
          const card = document.createElement('div');
          card.style.cssText = 'position: relative; width: 70px; height: 98px; background: linear-gradient(160deg, #8b2f2f, #5c1f1f); border-radius: 6px; cursor: pointer; padding: 4px; box-sizing: border-box;';
          if (cat.cardClass === 'c-trick') {
            card.style.background = 'linear-gradient(160deg, #8a6d1d, #57430f)';
          } else if (cat.cardClass === 'c-weapon') {
            card.style.background = 'linear-gradient(160deg, #1f4e6b, #12313f)';
          }
          card.innerHTML = '<div style="font-size: 10px; font-weight: bold; color: #fff; text-align: center; margin-top: 30px; line-height: 1.3;">' + c.name + '</div>';
          card.onclick = () => openCodexDetail(c.name, c.desc);
          grid.appendChild(card);
        }
        body.appendChild(grid);
      }
    } else if (currentCodexTab === 'identity') {
      // 身份卡片
      const identities = [
        { name: '神明', desc: '主公：带领护卫消灭魔物和深渊教团' },
        { name: '护卫', desc: '忠臣：协助神明获胜' },
        { name: '魔物', desc: '反贼：杀死神明获胜' },
        { name: '深渊教团', desc: '内奸：最后存活获胜' },
      ];
      const grid = document.createElement('div');
      grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 10px;';
      for (const id of identities) {
        const card = document.createElement('div');
        card.style.cssText = 'position: relative; width: 90px; height: 126px; background: linear-gradient(160deg, #2c3e50, #1a252f); border: 1px solid var(--gold); border-radius: 6px; cursor: pointer; padding: 6px; box-sizing: border-box;';
        card.innerHTML = '<div style="font-size: 14px; font-weight: bold; color: var(--gold2); text-align: center; margin-top: 45px;">' + id.name + '</div>';
        card.onclick = () => openCodexDetail(id.name, id.desc);
        grid.appendChild(card);
      }
      body.appendChild(grid);
    }
  }

  // ---------------- 网络 ----------------
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host;
  }
  function connect() {
    ws = new WebSocket(wsUrl());
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      onMsg(m);
    };
    ws.onclose = () => toast('连接已断开，请刷新页面重进');
    ws.onerror = () => {};
  }
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  // ---------------- 消息分发 ----------------
  function onMsg(m) {
    switch (m.t) {
      case 'lobby':
        S.roomCode = m.roomCode; S.isHost = m.isHost;
        S.testMode = m.testMode || false;
        S.charChoices = [];
        S.players = m.players; S.screen = 'room';
        if (m.playerId) S.myId = m.playerId;
        showScreen('room'); renderRoom();
        break;
      case 'room_closed':
        toast(m.msg || '房间已解散');
        setTimeout(() => location.reload(), 900);
        break;
      case 'error':
        toast(m.msg); break;
      case 'game_start':
        S.screen = 'game';
        resetGameState();
        S.game.testMode = m.testMode || false;
        showScreen('game');
        renderAll();
        break;
      case 'choose_char':
        S.game.charChoices = m.choices;
        showCharSelect(m.choices);
        break;
      case 'identity':
        S.game.identity = m.identity;
        S.game.char = m.char;
        hideCharSelect();
        renderMe();
        break;
      case 'state':
        S.game.state = m.state;
        onStateRefresh();
        renderAll();
        break;
      case 'hand':
        S.game.hand = m.cards;
        renderHand(); renderOverlay();
        break;
      case 'ask':
        S.game.ask = m.ask;
        S.ovSel.clear();
        renderOverlay(); renderActionBar();
        break;
      case 'ask_end':
        S.game.ask = null; S.ovSel.clear();
        hideOverlay(); renderActionBar();
        break;
      case 'log':
        for (const e of m.entries) {
          S.game.logs.push(e);
          if (S.game.logs.length > 300) S.game.logs.shift();
        }
        renderFeed(); renderLogPanel();
        break;
      case 'game_over':
        S.game.over = true; S.game.winner = m.winner; S.game.goPlayers = m.players;
        renderGameOver();
        break;
      default: break;
    }
  }

  function resetGameState() {
    S.game = { state: null, identity: null, char: null, hand: [], ask: null, logs: [], over: false, winner: null, goPlayers: [] };
    clearInteraction();
    E('log-panel').classList.add('hidden');
    E('gameover').classList.add('hidden');
    hideOverlay();
  }

  function showScreen(name) {
    E('screen-entry').classList.toggle('hidden', name !== 'entry');
    E('screen-room').classList.toggle('hidden', name !== 'room');
    E('screen-game').classList.toggle('hidden', name !== 'game');
    // 切换背景音乐
    if (name === 'game') {
      playBgm('game');
    } else {
      playBgm('menu');
    }
  }

  function onStateRefresh() {
    const st = S.game.state;
    if (!st) return;
    if (st.over) return;
    const me = myPlayer();
    const isMyPlay = me && me.isCurrent && st.phase === 'play';
    if (!isMyPlay) clearInteraction();
  }

  // ---------------- 查询辅助 ----------------
  function myPlayer() {
    if (!S.game.state) return null;
    return S.game.state.players.find((p) => p.id === S.myId) || null;
  }
  function aliveSeats() { return S.game.state.players.filter((p) => p.alive).map((p) => p.seat).sort((a, b) => a - b); }
  function seatDist(aSeat, bSeat) {
    const s = aliveSeats();
    const n = s.length;
    if (n < 2) return 1;
    const ia = s.indexOf(aSeat), ib = s.indexOf(bSeat);
    return Math.min(Math.abs(ia - ib), n - Math.abs(ia - ib));
  }
  function inRange(me, other) {
    let d = seatDist(me.seat, other.seat);
    // 温迪【高天之歌】：攻击时距离-1，防守时距离+1
    if (me.charId === 'venti') d -= 1;
    if (other.charId === 'venti') d += 1;
    // 迈特凯【惊门·昼虎】：攻击距离判定-2
    if (me.charId === 'gai') d -= 2;
    // 风场（-1马）：你攻击别人时距离-1
    if (me.equip && me.equip.minusOne) d -= me.equip.minusOne.length;
    // 风种子（+1马）：别人攻击你时距离+1
    if (other.equip && other.equip.plusOne) d += other.equip.plusOne.length;
    // 计算攻击范围：取所有武器的最大范围
    let range = 1;
    if (me.equip && me.equip.weapon) {
      for (const w of me.equip.weapon) {
        if (w.kind === 'crossbow') range = 999; // 莎塔娜娅的苍银无限距离
      }
    }
    return d <= range;
  }
  function hasCards(p) {
    return p.handCount > 0
      || (p.equip.weapon && p.equip.weapon.length > 0)
      || (p.equip.armor && p.equip.armor.length > 0)
      || (p.equip.plusOne && p.equip.plusOne.length > 0)
      || (p.equip.minusOne && p.equip.minusOne.length > 0);
  }

  function canPlay(card) {
    const st = S.game.state;
    if (!st) return false;
    // 测试模式下，用当前行动玩家判断
    let actor = myPlayer();
    if (S.game.testMode && st.currentId) {
      const cur = st.players.find(p => p.id === st.currentId);
      if (cur) actor = cur;
    }
    if (!actor || !actor.isCurrent || st.phase !== 'play' || S.game.ask) return false;
    switch (card.kind) {
      case 'slash': return actor.slashUsed < actor.slashLimit && validTargets(card).length > 0;
      case 'elemental': return validTargets(card).length > 0;
      case 'peach':
        if (actor.charId === 'kokomi') return true;
        return actor.hp < actor.maxHp;
      case 'food_egg':
        // 甘雨【天地交泰】：提瓦特煎蛋也可以主动使用
        if (actor.charId === 'ganyu') return actor.hp < actor.maxHp;
        return false;
      case 'wine': return true;
      case 'wuzhong': case 'nanman': case 'arrows': case 'garden': case 'dimai': case 'yanshou': case 'leidian': case 'crossbow': case 'bagua': case 'ruin_guard': case 'wind_seed': case 'wind_field': return true;
      case 'dismantle': case 'snatch': case 'duel': case 'guanbijing': case 'liangren': return validTargets(card).length > 0;
      default: return false;
    }
  }

  function validTargets(card) {
    const st = S.game.state;
    if (!st) return [];
    // 测试模式下，用当前行动玩家判断
    let actor = myPlayer();
    if (S.game.testMode && st.currentId) {
      const cur = st.players.find(p => p.id === st.currentId);
      if (cur) actor = cur;
    }
    if (!actor) return [];
    const others = st.players.filter((p) => p.alive && p.id !== actor.id);
    // 测试模式下，选目标时先允许选所有其他存活玩家
    if (S.game.testMode) return others;
    if (card.kind === 'peach' && actor.charId === 'kokomi') {
      return st.players.filter((p) => p.alive);
    }
    switch (card.needTarget) {
      case 'range1': return others.filter((p) => inRange(actor, p));
      case 'anyOther': return others;
      case 'anyWithCards': return others.filter(hasCards);
      case 'range1WithCards': return others.filter((p) => inRange(actor, p) && hasCards(p));
      default: return [];
    }
  }

  function clearInteraction() {
    S.sel = null; S.targetMode = false; S.selTargetIds.clear(); S.validTargetIds.clear();
    S.pendingSkillId = null; // 清除技能待选状态
    S.ganyuSelectedCards.clear(); // 清除甘雨选牌状态
  }

  // ---------------- 渲染入口 ----------------
  function renderAll() {
    renderTopbar();
    renderOthers();
    renderMe();
    renderHand();
    renderActionBar();
    renderFeed();
    renderPhaseBanner();
  }

  function renderTopbar() {
    const st = S.game.state;
    E('tb-code').textContent = S.roomCode || '----';
    if (st) {
      const cur = st.players.find((p) => p.id === st.currentId);
      E('tb-turn').textContent = cur ? (cur.isCurrent ? '行动：' : '') + cur.name : '';
      E('tb-phase').textContent = PHASE_NAMES[st.phase] || st.phase;
      E('tb-deck').textContent = '牌堆 ' + st.deckCount;
    } else {
      E('tb-turn').textContent = '';
      E('tb-phase').textContent = '等待开始…';
      E('tb-deck').textContent = '';
    }
  }

  function renderOthers() {
    const wrap = E('others-row');
    wrap.innerHTML = '';
    const st = S.game.state;
    if (!st) return;
    const me = myPlayer();
    if (!me) return;

    // 获取所有存活玩家，按座位顺序排序
    const alivePlayers = st.players.filter(p => p.alive).sort((a, b) => a.seat - b.seat);
    // 找到自己在数组中的位置
    const myIdx = alivePlayers.findIndex(p => p.id === me.id);
    // 以自己为中心，顺时针排列其他玩家（从右边开始）
    const ordered = [];
    for (let i = 1; i < alivePlayers.length; i++) {
      const idx = (myIdx + i) % alivePlayers.length;
      ordered.push(alivePlayers[idx]);
    }

    // 渲染其他玩家
    for (const p of ordered) {
      const targetable = S.targetMode && S.validTargetIds.has(p.id);
      const selected = S.selTargetIds.has(p.id);
      const node = otherPlayerEl(p, st, {
        targetable, selected,
        onClick: () => onOtherClick(p),
      });
      wrap.appendChild(node);
    }
  }

  function onOtherClick(p) {
    if (!S.targetMode) { showCharDetail(p); return; }
    if (!S.validTargetIds.has(p.id)) { toast('该角色不能作为目标'); return; }
    const card = handById(S.sel);
    // 技能选目标都是单选，卡牌选目标根据 needTarget 判断
    const single = S.pendingSkillId ? true : (card && card.needTarget !== 'none');
    if (single) S.selTargetIds = new Set([p.id]);
    else { S.selTargetIds.has(p.id) ? S.selTargetIds.delete(p.id) : S.selTargetIds.add(p.id); }
    renderOthers();
    renderActionBar();
  }

  function elemName(elem) {
    const map = { anemo: '风', geo: '岩', electro: '雷', hydro: '水', pyro: '火', cryo: '冰', dendro: '草', none: '无' };
    return map[elem] || elem;
  }

  function renderMe() {
    const box = E('me-card');
    box.innerHTML = '';
    box.style.cursor = 'pointer';
    box.onclick = () => {
      const me = myPlayer();
      if (me) showCharDetail(me);
    };
    const st = S.game.state;
    const me = myPlayer();
    if (!st || !me) return;

    const charWrap = E('me-card').appendChild(UI.el('div', 'me-char'));
    const dot = elementDot(me.element, true);
    if (dot) charWrap.appendChild(dot);
    const nameWrap = UI.el('div');
    const elemMap = { anemo: '风', geo: '岩', electro: '雷', hydro: '水', pyro: '火', cryo: '冰', dendro: '草', none: '无' };
    nameWrap.appendChild(UI.el('div', 'me-char-name', (me.charName || '未分配角色') + ' [' + (elemMap[me.element] || '?') + ']'));
    const idTxt = S.game.identity ? (ID_NAMES[S.game.identity] || '?') : '';
    nameWrap.appendChild(UI.el('div', 'oc-id ' + (S.game.identity === 'main' ? 'id-main' : 'id-' + (S.game.identity || 'main')), idTxt || '身份未分配'));
    charWrap.appendChild(nameWrap);

    const hpWrap = UI.el('div', 'me-hp');
    const bar = UI.el('div', 'hp-bar');
    const pct = me.maxHp ? Math.max(0, (me.hp / me.maxHp) * 100) : 0;
    const fill = UI.el('div', 'hp-fill ' + (pct > 50 ? 'hp-high' : pct > 25 ? 'hp-mid' : 'hp-low'));
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    hpWrap.appendChild(bar);
    hpWrap.appendChild(UI.el('span', 'hp-num', me.hp + '/' + me.maxHp));
    box.appendChild(hpWrap);

    // 空/荧【共鸣】层数显示
    if (me.charId === 'traveler') {
      const reso = me.resonance || 0;
      const resoWrap = UI.el('div', 'me-resonance');
      resoWrap.style.cssText = 'font-size: 12px; opacity: 0.9; margin-top: 4px;';
      let txt = `共鸣：${reso}/2`;
      if (me.enchantedElem) txt += `（附魔：${elemName(me.enchantedElem)}）`;
      resoWrap.textContent = txt;
      box.appendChild(resoWrap);
    }

    const info = UI.el('div', 'me-info');
    info.appendChild(UI.el('span', '', '手牌 ' + S.game.hand.length));
    const eqTxt = [];
    if (me.equip.weapon && me.equip.weapon.length > 0) eqTxt.push('武:' + me.equip.weapon.map(w => w.name).join('+'));
    if (me.equip.armor && me.equip.armor.length > 0) eqTxt.push('防:' + me.equip.armor.map(a => a.name).join('+'));
    if (me.equip.plusOne && me.equip.plusOne.length > 0) eqTxt.push('+1:' + me.equip.plusOne.map(p => p.name).join('+'));
    if (me.equip.minusOne && me.equip.minusOne.length > 0) eqTxt.push('-1:' + me.equip.minusOne.map(m => m.name).join('+'));
    if (eqTxt.length) info.appendChild(UI.el('span', '', eqTxt.join(' ')));
    if (me.isCurrent) info.appendChild(UI.el('span', 'oc-phase', (PHASE_NAMES[st.phase] || st.phase)));
    box.appendChild(info);

    if (me.skills && me.skills.length) {
      const sk = UI.el('div', 'me-skills');
      sk.innerHTML = '';
      sk.appendChild(UI.el('span', '', '技能：'));
      for (const s of me.skills) {
        sk.appendChild(UI.el('b', '', s.name + ' '));
        sk.appendChild(document.createTextNode(s.desc + ' '));
      }
      box.appendChild(sk);
    }
  }

  function handById(id) {
    const st = S.game.state;
    // 测试模式下，从当前行动玩家的手牌里找
    if (S.game.testMode && st && st.currentId) {
      const cur = st.players.find(p => p.id === st.currentId);
      if (cur && cur.handCards) {
        return cur.handCards.find((c) => c.id === id) || null;
      }
    }
    return S.game.hand.find((c) => c.id === id) || null;
  }

  function renderHand() {
    const wrap = E('hand');
    wrap.innerHTML = '';
    const st = S.game.state;
    if (!st) return;
    // 测试模式下，显示当前行动玩家的手牌
    let handToShow = S.game.hand;
    let actionPlayer = myPlayer();
    if (S.game.testMode && st.currentId) {
      const currentP = st.players.find(p => p.id === st.currentId);
      if (currentP && currentP.handCards) {
        handToShow = currentP.handCards;
        actionPlayer = currentP;
      }
    }
    const me = myPlayer();
    const interactable = st && actionPlayer && actionPlayer.isCurrent && st.phase === 'play' && !S.game.ask;
    for (const c of handToShow) {
      const dim = !interactable || !canPlay(c);
      wrap.appendChild(cardEl(c, {
        sel: S.sel === c.id,
        dim: dim && !S.sel,
        onClick: () => onHandClick(c),
      }));
    }
  }

  function onHandClick(card) {
    playSound('select');
    // 甘雨【流天射术】：选择要消耗的两张手牌
    if (S.ganyuSelectCards) {
      if (S.ganyuSelectedCards.has(card.id)) {
        S.ganyuSelectedCards.delete(card.id);
      } else {
        S.ganyuSelectedCards.add(card.id);
      }
      E('action-hint').textContent = '【流天射术】请选择两张要消耗的手牌（已选' + S.ganyuSelectedCards.size + '/2）';
      renderHand();
      renderActionBar();
      return;
    }
    // 庙算无遗：选择要消耗的红色手牌
    if (S.pendingSkillId === 'kokomi_2') {
      const isRed = card.suit === 'heart' || card.suit === 'diamond';
      if (!isRed) { toast('庙算无遗只能选择红色花色（红桃/方块）的手牌'); return; }
      S.sel = card.id;
      // 进入选目标模式
      S.targetMode = true;
      S.selTargetIds = new Set();
      const st = S.game.state;
      // 只能选非满血的玩家作为治疗目标
      S.validTargetIds = new Set(st.players.filter(p => p.alive && p.hp < p.maxHp).map(p => p.id));
      E('action-hint').textContent = '选择【庙算无遗】的治疗目标（不能对满血角色使用）';
      renderHand();
      renderOthers();
      renderActionBar();
      return;
    }
    showCardDetail(card);
  }

  // ---------- 详情弹窗 ----------
  const SUIT_SYM = { spade: '♠', club: '♣', heart: '♥', diamond: '♦' };
  const TYPE_CN = { basic: '基本牌', trick: '锦囊牌', equip: '装备牌' };
  const RANK_SHOW = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

  function hideDetail() { E('detail-modal').classList.add('hidden'); }

  function showCardDetail(card) {
    const st = S.game.state;
    const me = myPlayer();
    // 测试模式下，用当前行动玩家判断
    let actor = me;
    if (S.game.testMode && st.currentId) {
      const cur = st.players.find(p => p.id === st.currentId);
      if (cur) actor = cur;
    }
    const myTurnPlay = st && actor && actor.isCurrent && st.phase === 'play' && !S.game.ask;
    const canUse = myTurnPlay && canPlay(card);

    E('detail-title').textContent = '【' + card.name + '】';
    E('detail-sub').textContent = (SUIT_SYM[card.suit] || '') + (RANK_SHOW[card.rank] || card.rank) + ' · ' + (TYPE_CN[card.type] || '');
    const body = E('detail-body');
    body.innerHTML = '';
    body.appendChild(UI.el('div', 'dm-section', card.desc || '（暂无说明）'));

    E('dm-use').classList.toggle('hidden', !canUse);
    E('dm-discard').classList.toggle('hidden', !myTurnPlay);
    E('dm-use').onclick = () => { hideDetail(); S.sel = card.id; useSelected(); };
    E('dm-discard').onclick = () => { hideDetail(); send({ t: 'play_discard', cards: [card.id] }); };
    E('detail-tabs').style.display = 'none'; // 卡牌详情隐藏标签切换
    E('detail-modal').classList.remove('hidden');
  }

  let currentDetailPlayer = null;
  let currentDetailTab = 'skills';

  function showCharDetail(p) {
    currentDetailPlayer = p;
    currentDetailTab = 'skills';
    E('detail-title').textContent = p.charName || '未选角色';
    const elm = UI.ELEMENTS[p.element] || '';
    E('detail-sub').textContent = (elm ? elm + '元素 · ' : '') + Math.max(p.hp, 0) + '/' + p.maxHp + ' 体力';
    updateDetailTabButtons();
    renderDetailBody();
    E('dm-use').classList.add('hidden');
    E('dm-discard').classList.add('hidden');
    E('detail-tabs').style.display = 'flex'; // 角色详情显示标签切换
    E('detail-modal').classList.remove('hidden');
  }

  function updateDetailTabButtons() {
    E('tab-skills').classList.toggle('btn-primary', currentDetailTab === 'skills');
    E('tab-equip').classList.toggle('btn-primary', currentDetailTab === 'equip');
    E('tab-effects').classList.toggle('btn-primary', currentDetailTab === 'effects');
  }

  function renderDetailBody() {
    const p = currentDetailPlayer;
    const body = E('detail-body');
    body.innerHTML = '';

    if (currentDetailTab === 'skills') {
      // 身份：自己永远知道自己的身份；别人仅在公开时显示
      let identityTxt;
      if (p.id === S.myId) identityTxt = S.game.identity ? (ID_NAMES[S.game.identity] || '?') : '?';
      else if (p.identityRevealed && p.identity) identityTxt = ID_NAMES[p.identity] || '?';
      else identityTxt = '未知身份';
      const idSec = UI.el('div', 'dm-section');
      idSec.appendChild(UI.el('div', 'dm-section-label', '身份'));
      idSec.appendChild(UI.el('span', '', identityTxt));
      body.appendChild(idSec);

      if (p.skills && p.skills.length) {
        for (const s of p.skills) {
          const sk = UI.el('div', 'dm-section');
          sk.appendChild(UI.el('div', 'dm-section-label', '技能'));
          sk.appendChild(UI.el('div', 'dm-skill-name', s.name));
          sk.appendChild(document.createTextNode(s.desc || ''));
          body.appendChild(sk);
        }
      } else {
        body.appendChild(UI.el('div', 'dm-section', '无技能'));
      }
    } else if (currentDetailTab === 'equip') {
      // 显示装备
      const equipSec = UI.el('div', 'dm-section');
      equipSec.appendChild(UI.el('div', 'dm-section-label', '已装备'));
      let hasEquip = false;
      for (const slot of ['weapon', 'armor', 'plusOne', 'minusOne']) {
        if (p.equip && p.equip[slot] && p.equip[slot].length > 0) {
          hasEquip = true;
          for (const e of p.equip[slot]) {
            equipSec.appendChild(UI.el('div', 'dm-skill-name', e.name));
          }
        }
      }
      if (!hasEquip) equipSec.appendChild(UI.el('span', '', '无装备'));
      body.appendChild(equipSec);
    } else if (currentDetailTab === 'effects') {
      // 显示身上的效果
      const effectSec = UI.el('div', 'dm-section');
      effectSec.appendChild(UI.el('div', 'dm-section-label', '身上效果'));
      let hasEffect = false;
      if (p.shield && p.shield > 0) {
        hasEffect = true;
        effectSec.appendChild(UI.el('div', 'dm-skill-name', '护心铠护盾'));
        effectSec.appendChild(UI.el('span', '', '抵挡1点伤害'));
      }
      if (p.zhongliShield && p.zhongliShield > 0) {
        hasEffect = true;
        effectSec.appendChild(UI.el('div', 'dm-skill-name', '地心护盾'));
        effectSec.appendChild(UI.el('span', '', '抵挡' + p.zhongliShield + '点伤害'));
      }
      if (p.invincible) {
        hasEffect = true;
        effectSec.appendChild(UI.el('div', 'dm-skill-name', '无敌'));
        effectSec.appendChild(UI.el('span', '', '本回合免疫所有伤害'));
      }
      if (!hasEffect) effectSec.appendChild(UI.el('span', '', '无特殊效果'));
      body.appendChild(effectSec);
    }
  }

  function renderActionBar() {
    const st = S.game.state;
    if (!st) return;
    // 测试模式下，用当前行动玩家判断
    let actor = myPlayer();
    if (S.game.testMode && st.currentId) {
      const cur = st.players.find(p => p.id === st.currentId);
      if (cur) actor = cur;
    }
    const canAct = actor && actor.isCurrent && st.phase === 'play' && !S.game.ask;
    // 测试模式下，从当前行动玩家的手牌里找选中的牌
    let selCard = handById(S.sel);
    if (!selCard && S.game.testMode && st.currentId && actor.handCards) {
      selCard = actor.handCards.find(c => c.id === S.sel) || null;
    }

    E('btn-use').classList.toggle('hidden', !(canAct && selCard && !S.targetMode));
    E('btn-discard1').classList.toggle('hidden', !(canAct && selCard && !S.targetMode));
    E('btn-cancel').classList.toggle('hidden', !(S.sel || S.targetMode || S.pendingSkillId));
    E('btn-target-confirm').classList.toggle('hidden', !S.targetMode);
    E('btn-self-use').classList.toggle('hidden', !S.targetMode);
    E('btn-cheat').classList.toggle('hidden', !(st && S.game.testMode)); // 只有测试模式才显示作弊按钮
    E('btn-end-turn').classList.toggle('hidden', !canAct || S.targetMode);

    // 甘雨选两张牌模式：确认按钮
    if (S.ganyuSelectCards) {
      E('btn-target-confirm').classList.remove('hidden');
      E('btn-self-use').classList.add('hidden');
    }

    // 庙算无遗流程提示
    if (S.pendingSkillId === 'kokomi_2' && !S.sel) {
      E('action-hint').textContent = '【庙算无遗】请选择一张红色花色（红桃/方块）的手牌';
    } else if (S.pendingSkillId === 'kokomi_2' && S.sel && S.targetMode) {
      E('action-hint').textContent = '【庙算无遗】请选择治疗目标（不能对满血角色使用）';
    }

    // 渲染技能按钮
    const skillBar = E('skill-bar');
    skillBar.innerHTML = '';
    if (canAct && actor && actor.skills && actor.skills.length > 0) {
      skillBar.classList.remove('hidden');
      // 主动技能列表
      const activeSkillIds = ['hu_tao_2', 'noelle_1', 'noelle_2', 'traveler_3', 'kokomi_2', 'zhongli_2', 'zhongli_3', 'gai_3'];
      const activeSkills = actor.skills.filter(s => activeSkillIds.includes(s.id));
      for (const sk of activeSkills) {
        const btn = document.createElement('button');
        btn.className = 'skill-btn';
        btn.textContent = sk.name;
        btn.title = sk.desc;
        // 判断技能是否已使用（冷却中）
        const used = actor.usedSkills && actor.usedSkills.includes(sk.id);
        btn.disabled = used;
        if (used) btn.style.opacity = '0.4';
        btn.onclick = () => {
          if (used) { toast('该技能本回合已使用过'); return; }
          // 庙算无遗：先选手牌，再选目标
          if (sk.id === 'kokomi_2') {
            S.pendingSkillId = sk.id;
            S.sel = null;
            E('action-hint').textContent = '请选择一张红色花色（红桃/方块）的手牌';
            renderHand();
            renderActionBar();
            return;
          }
          const needTarget = ['noelle_1', 'noelle_2', 'zhongli_3'].includes(sk.id);
          if (needTarget) {
            S.targetMode = true;
            S.selTargetIds = new Set();
            S.pendingSkillId = sk.id;
            // 诺艾尔技能可以选任何角色（包括自己）
            const st = S.game.state;
            S.validTargetIds = new Set(st.players.filter(p => p.alive).map(p => p.id));
            E('action-hint').textContent = '选择【' + sk.name + '】的目标（点击玩家牌，可对自己使用）';
            renderOthers();
            renderActionBar();
          } else {
            send({ t: 'skill', skillId: sk.id, targets: [] });
          }
        };
        skillBar.appendChild(btn);
      }
    } else {
      skillBar.classList.add('hidden');
    }

    const hint = E('action-hint');
    if (S.targetMode && S.pendingSkillId) {
      const count = S.selTargetIds.size;
      hint.textContent = '选择技能目标：已选 ' + count + ' 个（单选）';
      E('btn-target-confirm').disabled = count === 0;
      E('btn-target-confirm').textContent = '确认目标(' + count + ')';
      E('btn-target-confirm').onclick = () => {
        send({ t: 'skill', skillId: S.pendingSkillId, targets: Array.from(S.selTargetIds) });
        S.targetMode = false;
        S.pendingSkillId = null;
        S.selTargetIds = new Set();
      };
    } else if (S.targetMode && selCard) {
      const me = myPlayer();
      // 心海用桃也是单选
      const isKokomiPeach = selCard.kind === 'peach' && me && me.charId === 'kokomi';
      const need = selCard.needTarget;
      const single = need !== 'none' || isKokomiPeach;
      const count = S.selTargetIds.size;
      hint.textContent = '选择目标：' + (count ? '已选 ' + count + ' 个' : '点击上方玩家牌') + (single ? '（单选）' : '');
      E('btn-target-confirm').disabled = count === 0;
      E('btn-target-confirm').textContent = '确认目标(' + count + ')';
    } else if (canAct && selCard) {
      hint.textContent = '选中：【' + selCard.name + '】';
    } else if (canAct) {
      hint.textContent = '点击手牌使用，或使用技能，或结束回合';
    } else {
      hint.textContent = '';
    }
  }

  function renderPhaseBanner() {
    const st = S.game.state;
    const banner = E('phase-banner');
    const hintBox = E('center-hint');
    if (!st) { banner.textContent = ''; hintBox.textContent = ''; return; }
    const cur = st.players.find((p) => p.id === st.currentId);
    banner.textContent = (PHASE_NAMES[st.phase] || st.phase) + (cur ? ' · ' + cur.name : '');
    if (st.phase === 'dying') hintBox.textContent = '濒死救援中…';
    else if (S.targetMode) hintBox.textContent = '';
    else hintBox.textContent = '';
  }

  // ---------------- 操作：使用 / 弃置 / 目标 / 结束 ----------------
  function useSelected() {
    const card = handById(S.sel);
    if (!card) return;
    playSound('play');
    const me = myPlayer();
    // 心海【海月之誓】：甜甜花酿鸡需要选目标
    const needTarget = card.needTarget && card.needTarget !== 'none'
      || (card.kind === 'peach' && me && me.charId === 'kokomi');
    if (needTarget) {
      S.targetMode = true;
      S.validTargetIds = new Set(validTargets(card).map((p) => p.id));
      S.selTargetIds.clear();
      renderOthers(); renderActionBar();
      return;
    }
    send({ t: 'play', cardId: card.id, targets: [] });
    S.sel = null;
    renderHand(); renderActionBar();
  }

  function confirmTarget() {
    // 甘雨【流天射术】：选完两张牌后确认打出
    if (S.ganyuSelectCards) {
      if (S.ganyuSelectedCards.size !== 2) { toast('请选择两张手牌'); return; }
      send({
        t: 'play',
        cardId: S.ganyuCardId,
        targets: S.ganyuTargetIds,
        ganyuRange: true,
        ganyuCostCards: Array.from(S.ganyuSelectedCards),
      });
      S.ganyuSelectCards = false;
      S.ganyuSelectedCards.clear();
      S.ganyuCardId = null;
      S.ganyuTargetIds = [];
      S.sel = null; S.targetMode = false; S.selTargetIds.clear();
      renderHand(); renderOthers(); renderActionBar();
      return;
    }
    // 庙算无遗：发送 skill 消息，带上选中的牌和目标
    if (S.pendingSkillId === 'kokomi_2') {
      const targetId = Array.from(S.selTargetIds)[0];
      send({ t: 'skill', skillId: S.pendingSkillId, targets: [targetId], cardId: S.sel });
      S.sel = null; S.targetMode = false; S.selTargetIds.clear(); S.pendingSkillId = null;
      renderHand(); renderOthers(); renderActionBar();
      return;
    }
    const card = handById(S.sel);
    if (!card) return;
    // 甘雨【流天射术】：先正常打出元素攻击，后面服务端会再问是否触发
    send({ t: 'play', cardId: card.id, targets: Array.from(S.selTargetIds) });
    S.sel = null; S.targetMode = false; S.selTargetIds.clear();
    renderHand(); renderOthers(); renderActionBar();
  }

  function selfUse() {
    const st = S.game.state;
    if (!st) return;
    // 测试模式下，对当前行动玩家自己使用
    let me = myPlayer();
    if (S.game.testMode && st.currentId) {
      const cur = st.players.find(p => p.id === st.currentId);
      if (cur) me = cur;
    }
    if (!me) return;
    // 技能模式
    if (S.pendingSkillId) {
      // 庙算无遗需要带上选中的牌
      if (S.pendingSkillId === 'kokomi_2') {
        send({ t: 'skill', skillId: S.pendingSkillId, targets: [me.id], cardId: S.sel });
      } else {
        send({ t: 'skill', skillId: S.pendingSkillId, targets: [me.id] });
      }
      S.targetMode = false;
      S.pendingSkillId = null;
      S.sel = null;
      S.selTargetIds = new Set();
      renderActionBar();
      return;
    }
    // 卡牌模式
    const card = handById(S.sel);
    if (!card) return;
    send({ t: 'play', cardId: card.id, targets: [me.id] });
    S.sel = null; S.targetMode = false; S.selTargetIds.clear();
    renderHand(); renderOthers(); renderActionBar();
  }

  // ---------------- 作弊面板（测试模式） ----------------
  function openCheat() {
    const st = S.game.state;
    if (!st) return;
    const sel = E('cheat-target');
    sel.innerHTML = '';
    for (const p of st.players) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name}（${p.hp}/${p.maxHp}）`;
      sel.appendChild(opt);
    }
    E('cheat-modal').classList.remove('hidden');
  }

  function doCheat(action, amount) {
    const targetId = E('cheat-target').value;
    send({ t: 'cheat', action, targetId, amount });
  }

  function doCheatCard() {
    const targetId = E('cheat-target').value;
    const cardKind = E('cheat-card-kind').value;
    send({ t: 'cheat', action: 'add_card', targetId, cardKind });
  }

  // ---------------- 选角色（开局） ----------------
  function showCharSelect(choices) {
    const modal = E('char-select-modal');
    const box = E('char-select-options');
    box.innerHTML = '';
    // 角色信息映射
    const charInfo = {
      traveler: { name: '空/荧', element: 'none', hp: 4, desc: '双子旅人' },
      noelle: { name: '诺艾尔', element: 'geo', hp: 5, desc: '心护女仆' },
      kokomi: { name: '珊瑚宫心海', element: 'hydro', hp: 6, desc: '眠龙军师' },
      hu_tao: { name: '胡桃', element: 'pyro', hp: 5, desc: '往生堂主' },
      ganyu: { name: '甘雨', element: 'cryo', hp: 4, desc: '仙麟半仙' },
      venti: { name: '温迪', element: 'anemo', hp: 4, desc: '风色诗人' },
      zhongli: { name: '钟离', element: 'geo', hp: 6, desc: '岩王帝君' },
      gai: { name: '迈特凯', element: 'pyro', hp: 4, desc: '八门遁甲' },
    };
    for (const charId of choices) {
      const info = charInfo[charId] || { name: charId, element: 'none', hp: 4, desc: '' };
      const card = document.createElement('div');
      card.style.cssText = 'width: 140px; padding: 16px; background: var(--panel); border: 1px solid var(--gold); border-radius: 12px; cursor: pointer; text-align: center;';
      card.innerHTML = `
        <div style="font-size: 18px; font-weight: bold; margin-bottom: 8px;">${info.name}</div>
        <div style="font-size: 13px; opacity: 0.8; margin-bottom: 4px;">${elemName(info.element)}元素 · ${info.hp}hp</div>
        <div style="font-size: 12px; opacity: 0.7;">${info.desc}</div>
      `;
      card.onclick = () => {
        send({ t: 'choose_char', charId });
      };
      box.appendChild(card);
    }
    modal.classList.remove('hidden');
  }

  function hideCharSelect() {
    E('char-select-modal').classList.add('hidden');
  }

  function cancelAction() {
    clearInteraction();
    renderHand(); renderOthers(); renderActionBar();
  }

  function discardSelected() {
    const card = handById(S.sel);
    if (!card) return;
    send({ t: 'play_discard', cards: [card.id] });
    S.sel = null;
    renderHand(); renderActionBar();
  }

  // ---------------- 弹层（响应/弃牌） ----------------
  function askValidKinds() {
    const a = S.game.ask;
    if (!a) return [];
    switch (a.type) {
      case 'dodge': return ['jink'];
      case 'slash_response': case 'duel_slash': return ['slash', 'elemental'];
      case 'save':
        // 甘雨【天地交泰】：甜甜花酿鸡也可以用来救人
        let me = myPlayer();
        if (S.game.testMode && S.game.state && S.game.state.currentId) {
          me = S.game.state.players.find(p => p.id === S.game.state.currentId);
        }
        if (me && me.charId === 'ganyu') return ['food_egg', 'peach'];
        return ['food_egg'];
      case 'wuxie': return ['wuxie'];
      case 'discard': return null; // 全部可选
      default: return [];
    }
  }

  function renderOverlay() {
    const ov = E('overlay');
    const a = S.game.ask;
    if (!a) { ov.classList.add('hidden'); return; }
    ov.classList.remove('hidden');

    let title = '', desc = '';
    const validKinds = askValidKinds();
    if (a.type === 'dodge') { title = '需要打出【闪避】'; desc = a.data.sourceName + ' 对你使用【' + a.data.cardName + '】，请打出【闪避】抵消，或放弃。'; }
    else if (a.type === 'slash_response' || a.type === 'duel_slash') { title = '需要打出【普通攻击】'; desc = '响应【' + a.data.cardName + '】（来自 ' + (a.data.fromName || a.data.sourceName || '未知') + '），请打出【普通攻击】或【元素攻击】（元素攻击继承普通攻击机制），或放弃并受到 1 点伤害。'; }
    else if (a.type === 'save') { title = '濒死救援'; desc = a.data.dyingName + ' 体力归零，你可以使用【提瓦特煎蛋】救援（来自 ' + (a.data.sourceName || '未知') + ' 的伤害）。'; }
    else if (a.type === 'wuxie') { title = '是否使用【庇护】'; desc = a.data.usedByName + ' 使用了【' + a.data.trickName + '】，你可以打出【庇护】抵消其效果。'; }
    else if (a.type === 'discard') { title = '弃牌阶段'; desc = '手牌上限 ' + a.data.limit + '，请选择 ' + a.data.count + ' 张牌弃置。'; }
    else if (a.type === 'choose_element') { title = '【共鸣】选择元素'; desc = '你的【共鸣】触发了！选择本次攻击的元素类型：'; }
    else if (a.type === 'confirm_ganyu') { title = '【流天射术】'; desc = '是否消耗两张手牌，对 ' + a.data.targetName + ' 及左右相邻玩家造成额外冰元素伤害？'; }
    else if (a.type === 'confirm_venti') { title = '【弦发的苍风】'; desc = '是否触发【弦发的苍风】？将同时攻击两个目标，每个目标造成1点伤害（取消【黎明破晓之史】的伤害+1）'; }
    else if (a.type === 'choose_two_cards') { title = '选择消耗手牌'; desc = a.data.desc + '（已选' + S.ovSel.size + '/' + a.data.count + '）'; }
    else if (a.type === 'choose_target') { title = '选择攻击目标'; desc = a.data.desc; }
    else if (a.type === 'select_card') { title = a.data.title; desc = '选择 ' + a.data.targetName + ' 的一张牌：'; }

    E('overlay-title').textContent = title;
    E('overlay-desc').textContent = desc;

    const wrap = E('overlay-cards');
    wrap.innerHTML = '';

    // 选择目标模式：显示所有存活的其他玩家
    if (a.type === 'choose_target') {
      const players = S.game.state.players.filter(p => p.alive && p.id !== S.game.state.currentId);
      for (const p of players) {
        const btn = document.createElement('button');
        btn.className = 'skill-btn';
        btn.textContent = p.name;
        btn.style.cssText = 'padding: 12px 20px; font-size: 16px; margin: 4px; border-radius: 8px;';
        btn.onclick = () => {
          send({ t: 'respond', value: p.id });
          S.ovSel = new Set();
        };
        wrap.appendChild(btn);
      }
      E('btn-ov-ok').classList.add('hidden');
      E('btn-ov-cancel').classList.add('hidden');
      return;
    }

    // 选牌模式：显示目标的手牌和装备
    if (a.type === 'select_card') {
      for (const opt of a.data.options) {
        const btn = document.createElement('button');
        btn.className = 'skill-btn';
        btn.textContent = opt.name + '（' + opt.zoneName + '）';
        btn.style.cssText = 'padding: 12px 20px; font-size: 14px; margin: 4px; border-radius: 8px;';
        btn.onclick = () => {
          send({ t: 'respond', value: { zone: opt.zone, cardId: opt.cardId } });
          S.ovSel = new Set();
        };
        wrap.appendChild(btn);
      }
      E('btn-ov-ok').classList.add('hidden');
      E('btn-ov-cancel').classList.add('hidden');
      return;
    }

    // 选择元素模式：显示7个元素按钮
    if (a.type === 'choose_element') {
      const elems = [
        { id: 'anemo', name: '风', color: '#7fd8be' },
        { id: 'geo', name: '岩', color: '#c9a227' },
        { id: 'electro', name: '雷', color: '#b388ff' },
        { id: 'hydro', name: '水', color: '#4fc3f7' },
        { id: 'pyro', name: '火', color: '#ff8a65' },
        { id: 'cryo', name: '冰', color: '#81d4fa' },
        { id: 'dendro', name: '草', color: '#aed581' },
      ];
      for (const el of elems) {
        const btn = document.createElement('button');
        btn.className = 'skill-btn';
        btn.textContent = el.name;
        btn.style.cssText = 'padding: 12px 20px; font-size: 16px; margin: 4px; border-radius: 8px;';
        btn.onclick = () => {
          send({ t: 'respond', value: el.id });
          S.ovSel = new Set();
        };
        wrap.appendChild(btn);
      }
      E('btn-ov-ok').classList.add('hidden');
      E('btn-ov-cancel').classList.add('hidden');
      return;
    }

    E('btn-ov-ok').classList.remove('hidden');
    E('btn-ov-cancel').classList.remove('hidden');

    // 甘雨确认询问：不显示手牌，只显示按钮
    if (a.type === 'confirm_ganyu') {
      wrap.innerHTML = '';
      E('btn-ov-ok').textContent = '是';
      E('btn-ov-cancel').textContent = '否';
      return;
    }

    // 温迪确认询问：不显示手牌，只显示按钮
    if (a.type === 'confirm_venti') {
      wrap.innerHTML = '';
      E('btn-ov-ok').textContent = '是';
      E('btn-ov-cancel').textContent = '否';
      return;
    }

    if (a.type === 'discard' || a.type === 'choose_two_cards') {
      for (const c of S.game.hand) {
        wrap.appendChild(cardEl(c, {
          sel: S.ovSel.has(c.id),
          dim: false,
          onClick: (c2) => {
            S.ovSel.has(c2.id) ? S.ovSel.delete(c2.id) : S.ovSel.add(c2.id);
            renderOverlay();
          },
        }));
      }
      const ok = E('btn-ov-ok');
      ok.textContent = '确认(' + S.ovSel.size + '/' + a.data.count + ')';
      ok.disabled = S.ovSel.size !== a.data.count;
      E('btn-ov-cancel').textContent = '取消';
    } else {
      for (const c of S.game.hand) {
        const valid = validKinds.indexOf(c.kind) >= 0;
        wrap.appendChild(cardEl(c, {
          sel: S.ovSel.has(c.id),
          dim: !valid,
          onClick: (c2) => {
            if (validKinds.indexOf(c2.kind) < 0) { toast('不能使用这张牌响应'); return; }
            S.ovSel = new Set([c2.id]);
            renderOverlay();
          },
        }));
      }
      E('btn-ov-ok').textContent = '确认出牌';
      E('btn-ov-ok').disabled = S.ovSel.size === 0;
      E('btn-ov-cancel').textContent = '放弃';
    }
  }

  function overlayOk() {
    const a = S.game.ask;
    if (!a) return;
    // 甘雨确认询问：发送 true
    if (a.type === 'confirm_ganyu') {
      send({ t: 'respond', value: true });
      return;
    }
    // 温迪确认询问：发送 true
    if (a.type === 'confirm_venti') {
      send({ t: 'respond', value: true });
      return;
    }
    if (a.type === 'discard' || a.type === 'choose_two_cards') {
      if (S.ovSel.size !== a.data.count) { toast('还需选择 ' + (a.data.count - S.ovSel.size) + ' 张'); return; }
      send({ t: 'respond', value: Array.from(S.ovSel) });
    } else {
      const id = S.ovSel.values().next().value || null;
      send({ t: 'respond', value: id });
    }
  }

  function overlayCancel() {
    const a = S.game.ask;
    if (!a) return;
    // 甘雨确认询问：发送 false
    if (a.type === 'confirm_ganyu') {
      send({ t: 'respond', value: false });
      return;
    }
    send({ t: 'respond', value: null });
  }

  function hideOverlay() { E('overlay').classList.add('hidden'); }

  // ---------------- 日志 / 战绩 ----------------
  function renderFeed() {
    const wrap = E('play-feed');
    const recent = S.game.logs.slice(-4);
    wrap.innerHTML = '';
    for (const e of recent) wrap.appendChild(feedItemEl(e));
  }

  function renderLogPanel() {
    const list = E('log-list');
    const open = !E('log-panel').classList.contains('hidden');
    if (!open) return;
    list.innerHTML = '';
    for (const e of S.game.logs) list.appendChild(logLineEl(e));
    list.scrollTop = list.scrollHeight;
  }

  function renderRoom() {
    E('room-code').textContent = S.roomCode || '----';
    const wrap = E('room-players');
    wrap.innerHTML = '';
    for (const p of S.players) {
      const card = UI.el('div', 'rp-card');
      card.appendChild(UI.el('div', 'rp-name', p.name + (p.isHost ? '（房主）' : '')));
      const tag = UI.el('div', 'rp-tag');
      if (p.isHost) tag.appendChild(UI.el('span', 'rp-host', '房主'));
      if (p.isAI) tag.appendChild(UI.el('span', 'rp-ai', 'AI'));
      card.appendChild(tag);
      wrap.appendChild(card);
    }
    E('btn-start').disabled = S.players.length < 2;
    E('room-status').textContent = S.players.length < 2 ? '至少需要 2 名玩家才能开始（可补位 AI）' : '';

    // 测试模式：显示角色配置区域
    const charConfigBox = E('room-char-config');
    const charConfigList = E('char-config-list');
    if (S.testMode) {
      charConfigBox.classList.remove('hidden');
      charConfigList.innerHTML = '';
      const chars = [
        { id: 'traveler', name: '空/荧' },
        { id: 'noelle', name: '诺艾尔' },
        { id: 'kokomi', name: '珊瑚宫心海' },
        { id: 'hu_tao', name: '胡桃' },
        { id: 'ganyu', name: '甘雨' },
        { id: 'venti', name: '温迪' },
        { id: 'zhongli', name: '钟离' },
        { id: 'gai', name: '迈特凯' },
      ];
      // 为每个玩家位置生成选择框
      for (let i = 0; i < S.players.length; i++) {
        const p = S.players[i];
        const item = document.createElement('div');
        item.style.cssText = 'font-size: 13px;';
        const label = document.createElement('div');
        label.textContent = `${p.name}：`;
        const select = document.createElement('select');
        select.dataset.seat = i;
        select.innerHTML = '<option value="">随机</option>' + chars.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
        select.onchange = () => { S.charChoices[i] = select.value; };
        item.appendChild(label);
        item.appendChild(select);
        charConfigList.appendChild(item);
      }
    } else {
      charConfigBox.classList.add('hidden');
    }
  }

  function renderGameOver() {
    const w = S.game.winner;
    if (!w) return;
    E('go-title').textContent = w.text;
    E('go-detail').textContent = w.detail || '';
    const list = E('go-list');
    list.innerHTML = '';
    for (const p of S.game.goPlayers) {
      const line = UI.el('div', 'go-line');
      const left = UI.el('span');
      left.appendChild(UI.el('span', '', p.name + ' '));
      const idn = ID_NAMES[p.identity] || '?';
      left.appendChild(UI.el('span', 'oc-id ' + (p.identity === 'main' ? 'id-main' : 'id-' + p.identity), idn));
      line.appendChild(left);
      line.appendChild(UI.el('span', '', p.alive ? '存活' : '阵亡'));
      list.appendChild(line);
    }
    E('btn-restart').classList.toggle('hidden', !S.isHost);
    E('gameover').classList.remove('hidden');
  }

  // ---------------- 事件绑定 ----------------
  function bind() {
    const nameInput = E('input-name');
    nameInput.value = localStorage.getItem('gs_name') || '';
    nameInput.addEventListener('input', () => localStorage.setItem('gs_name', nameInput.value));

    E('btn-create').addEventListener('click', () => {
      const name = nameInput.value.trim();
      localStorage.setItem('gs_name', name);
      send({ t: 'create', name, testMode: false });
    });
    E('btn-test-mode').addEventListener('click', () => {
      const name = nameInput.value.trim();
      localStorage.setItem('gs_name', name);
      send({ t: 'create', name, testMode: true });
    });
    E('btn-join').addEventListener('click', () => {
      const name = nameInput.value.trim();
      const code = E('input-code').value.trim();
      localStorage.setItem('gs_name', name);
      send({ t: 'join', code, name });
    });

    E('btn-add-ai').addEventListener('click', () => send({ t: 'add_ai' }));
    E('btn-start').addEventListener('click', () => {
      send({ t: 'start', charChoices: S.testMode ? S.charChoices : [] });
    });
    E('btn-leave').addEventListener('click', () => { send({ t: 'leave' }); setTimeout(() => location.reload(), 300); });

    // 详情弹窗标签切换
    E('tab-skills').addEventListener('click', () => { currentDetailTab = 'skills'; updateDetailTabButtons(); renderDetailBody(); });
    E('tab-equip').addEventListener('click', () => { currentDetailTab = 'equip'; updateDetailTabButtons(); renderDetailBody(); });
    E('tab-effects').addEventListener('click', () => { currentDetailTab = 'effects'; updateDetailTabButtons(); renderDetailBody(); });

    // 暴露作弊函数到全局（供 HTML onclick 调用）
    window.doCheat = doCheat;
    window.doCheatCard = doCheatCard;

    E('btn-copy').addEventListener('click', copyCode);
    E('btn-copy2').addEventListener('click', copyCode);

    E('btn-use').addEventListener('click', useSelected);
    E('btn-discard1').addEventListener('click', discardSelected);
    E('btn-cancel').addEventListener('click', cancelAction);
    E('btn-target-confirm').addEventListener('click', confirmTarget);
    E('btn-self-use').addEventListener('click', selfUse);
    E('btn-end-turn').addEventListener('click', () => send({ t: 'end_turn' }));
    E('btn-cheat').addEventListener('click', openCheat);
    E('btn-cheat-close').addEventListener('click', () => E('cheat-modal').classList.add('hidden'));

    E('btn-ov-ok').addEventListener('click', overlayOk);
    E('btn-ov-cancel').addEventListener('click', overlayCancel);

    E('dm-close').addEventListener('click', hideDetail);

    E('btn-log').addEventListener('click', () => {
      const panel = E('log-panel');
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) renderLogPanel();
    });
    E('btn-log-close').addEventListener('click', () => E('log-panel').classList.add('hidden'));
    E('btn-quit').addEventListener('click', () => { send({ t: 'leave' }); setTimeout(() => location.reload(), 300); });

    E('btn-restart').addEventListener('click', () => send({ t: 'restart' }));
    E('btn-go-close').addEventListener('click', () => E('gameover').classList.add('hidden'));
  }

  function copyCode() {
    const code = S.roomCode || '';
    const done = () => toast('房间号已复制：' + code);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(() => fallbackCopy(code, done));
    } else fallbackCopy(code, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { toast('复制失败，请手动记录房间号'); }
    document.body.removeChild(ta);
  }

  return { init: () => { bind(); connect(); initSettings(); }, getState: () => S };
})();

document.addEventListener('DOMContentLoaded', () => App.init());

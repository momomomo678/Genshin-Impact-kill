// ============================================================
// 原神杀 · 前端 UI 构建模块（纯 DOM 工厂，不持有状态）
// ============================================================
'use strict';

const UI = (() => {
  const SUITS = { spade: '♠', club: '♣', heart: '♥', diamond: '♦' };
  const RANKS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const ELEMENTS = { wind: '风', fire: '火', water: '水', thunder: '雷', grass: '草', ice: '冰', rock: '岩' };
  const ID_NAMES = { main: '神明', loyal: '护卫', rebel: '魔物', spy: '深渊教团' };
  const PHASE_NAMES = {
    prepare: '准备阶段', judge: '判定阶段', draw: '摸牌阶段', play: '出牌阶段',
    discard: '弃牌阶段', end: '结束阶段', dying: '濒死状态',
  };

  const E = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function suitSym(suit) { return SUITS[suit] || '?'; }
  function rankText(rank) { return RANKS[rank] || rank; }
  function isRedSuit(suit) { return suit === 'heart' || suit === 'diamond'; }

  function elementDot(elm, big) {
    if (!elm) return null;
    return el('span', 'elm ' + (big ? 'elm-big ' : '') + 'e-' + elm, ELEMENTS[elm] || '?');
  }

  // ---------- 卡牌 ----------
  function cardEl(card, opts = {}) {
    const div = el('div', 'card ' + (card.cls || '') + (opts.sel ? ' sel' : '') + (opts.dim ? ' dim' : ''));
    div.dataset.id = card.id;
    const red = isRedSuit(card.suit);
    const corner = el('span', 'c-corner');
    corner.innerHTML =
      '<span class="c-suit" style="color:' + (red ? '#ff8a80' : '#d6d6d6') + '">' + suitSym(card.suit) + '</span>' +
      '<span class="c-rank" style="color:' + (red ? '#ff8a80' : '#d6d6d6') + '">' + rankText(card.rank) + '</span>';
    div.appendChild(corner);
    const name = el('span', 'c-name', card.name);
    div.appendChild(name);
    const type = el('span', 'c-type', card.type === 'equip' ? '装备' : (card.type === 'trick' ? '锦囊' : '基本'));
    div.appendChild(type);
    const num = el('span', 'c-num', card.id.slice(1));
    div.appendChild(num);
    if (opts.onClick) div.addEventListener('click', (ev) => { ev.stopPropagation(); opts.onClick(card); });
    return div;
  }

  // ---------- 玩家牌（他人） ----------
  function otherPlayerEl(p, state, opts = {}) {
    const div = el('div', 'other-card');
    if (!p.alive) div.classList.add('oc-dead');
    if (p.isCurrent) div.classList.add('cur');
    if (opts.targetable) div.classList.add('targetable');
    if (opts.selected) div.classList.add('target-selected');
    div.dataset.id = p.id;

    const top = el('div', 'oc-top');
    top.appendChild(el('span', 'oc-name', p.name));
    if (p.identityRevealed || p.mainRevealed) {
      const idn = p.identity || 'main';
      const cls = idn === 'main' ? 'id-main' : 'id-' + idn;
      top.appendChild(el('span', 'oc-id ' + cls, ID_NAMES[idn] || '?'));
    }
    div.appendChild(top);

    const charRow = el('div', 'oc-char');
    charRow.appendChild(elementDot(p.element, false));
    charRow.appendChild(el('span', '', p.charName || '未选角色'));
    // 元素属性文字
    const elemMap = { anemo: '风', geo: '岩', electro: '雷', hydro: '水', pyro: '火', cryo: '冰', dendro: '草', none: '无' };
    charRow.appendChild(el('span', 'oc-element', '[' + (elemMap[p.element] || '?') + ']'));
    div.appendChild(charRow);

    const hpRow = el('div', 'oc-hp');
    const bar = el('div', 'hp-bar');
    const pct = p.maxHp ? Math.max(0, (p.hp / p.maxHp) * 100) : 0;
    const fill = el('div', 'hp-fill ' + (pct > 50 ? 'hp-high' : pct > 25 ? 'hp-mid' : 'hp-low'));
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    hpRow.appendChild(bar);
    hpRow.appendChild(el('span', 'hp-num', p.hp + '/' + p.maxHp));
    div.appendChild(hpRow);

    const bot = el('div', 'oc-bot');
    const eqTxt = [];
    if (p.equip.weapon && p.equip.weapon.length > 0) eqTxt.push('武:' + p.equip.weapon.map(w => w.name).join('+'));
    if (p.equip.armor && p.equip.armor.length > 0) eqTxt.push('防:' + p.equip.armor.map(a => a.name).join('+'));
    if (p.equip.plusOne && p.equip.plusOne.length > 0) eqTxt.push('+1:' + p.equip.plusOne.map(p => p.name).join('+'));
    if (p.equip.minusOne && p.equip.minusOne.length > 0) eqTxt.push('-1:' + p.equip.minusOne.map(m => m.name).join('+'));
    bot.appendChild(el('span', '', '牌' + p.handCount + (eqTxt.length ? ' · ' + eqTxt.join(' ') : '')));
    // 显示延时锦囊牌
    if (p.judgeZone && p.judgeZone.length > 0) {
      const delayTxt = p.judgeZone.map(c => c.name).join('、');
      bot.appendChild(el('span', 'oc-delay', '延时:' + delayTxt));
    }
    if (p.isCurrent && state && state.phase) {
      bot.appendChild(el('span', 'oc-phase', PHASE_NAMES[state.phase] || state.phase));
    }
    if (!p.alive) bot.appendChild(el('span', 'oc-dead-tag', '阵亡'));
    div.appendChild(bot);

    if (opts.onClick) div.addEventListener('click', (ev) => { ev.stopPropagation(); opts.onClick(p); });
    return div;
  }

  function logLineEl(entry) {
    return el('div', 'log-line ' + (entry.cls || ''), entry.text);
  }

  function feedItemEl(entry) {
    return el('div', 'feed-item ' + (entry.cls || ''), entry.text);
  }

  function toast(msg, ms = 2400) {
    const t = E('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), ms);
  }

  return {
    E, el, suitSym, rankText, elementDot, cardEl, otherPlayerEl,
    logLineEl, feedItemEl, toast, ID_NAMES, PHASE_NAMES, ELEMENTS,
  };
})();

// ============================================================
// 原神杀 · 卡牌注册表
// ------------------------------------------------------------
// 以后你要补充自定义手牌（新锦囊、新装备、原神主题牌），
// 只需：1) 在 CARD_META 里注册一个新 kind；2) 在 DECK 列表里加入
// [kind, suit, rank] 条目。game.js 的效果逻辑在 playCard / resolve 中
// 按 kind 分支，新增效果时在其中添加分支即可。
// ============================================================
'use strict';

let _id = 0;
const nextId = () => 'c' + (++_id);

// 花色与点数显示
const SUIT_INFO = {
  spade:   { sym: '♠', color: '#222' },
  club:    { sym: '♣', color: '#222' },
  heart:   { sym: '♥', color: '#e74c3c' },
  diamond: { sym: '♦', color: '#e74c3c' },
};
const RANK_TEXT = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

function rankText(r) { return RANK_TEXT[r] || String(r); }
function suitColor(suit) { return SUIT_INFO[suit].color; }
function isRed(suit) { return suit === 'heart' || suit === 'diamond'; }

// 卡牌类型：basic=基本牌 trick=锦囊 equip=装备 delay=延时锦囊
const CARD_META = {
  // —— 基本牌 ——
  slash:      { name: '普通攻击', type: 'basic', cls: 'c-slash',     color: '#b03a2e', needTarget: 'range1', desc: '对射程内一名角色使用，目标需打出【闪避】否则受到1点伤害。每回合限一次。' },
  jink:       { name: '闪避',   type: 'basic', cls: 'c-jink',      color: '#1e8449', needTarget: 'none',  desc: '响应牌：抵消【普通攻击】。' },
  peach:      { name: '甜甜花酿鸡', type: 'basic', cls: 'c-peach', color: '#d81b60', needTarget: 'none',  desc: '回复1点体力（仅自己，出牌阶段使用）。' },
  food_egg:   { name: '提瓦特煎蛋', type: 'basic', cls: 'c-peach', color: '#e67e22', needTarget: 'none',  desc: '响应牌：濒死时使用，救一名濒死的角色并回复1点生命。' },
  wine:       { name: '仙跳墙', type: 'basic', cls: 'c-peach', color: '#f1c40f', needTarget: 'none',  desc: '出牌阶段对自己使用，本回合下一张【普通攻击】伤害+1。' },
  elemental:  { name: '元素攻击', type: 'basic', cls: 'c-slash', color: '#9b59b6', needTarget: 'range1', desc: '对射程内一名角色使用，目标需打出【闪避】否则受到1点伤害（伤害属性为自身元素）。' },

  // —— 锦囊牌 ——
  wuzhong:    { name: '浓缩树脂', type: 'trick', cls: 'c-trick', color: '#b7950b', needTarget: 'none', desc: '摸两张牌。' },
  dismantle:  { name: '史莱姆炸药桶', type: 'trick', cls: 'c-trick', color: '#b7950b', needTarget: 'anyWithCards', desc: '弃置目标角色的一张牌（手牌或装备）。' },
  snatch:     { name: '拾取', type: 'trick', cls: 'c-trick', color: '#b7950b', needTarget: 'range1WithCards', desc: '获得射程内一名角色的一张牌。' },
  nanman:     { name: '深渊入侵', type: 'trick', cls: 'c-trick', color: '#b7950b', needTarget: 'none', desc: '除你以外的所有角色需打出【普通攻击】，否则受到1点伤害。' },
  arrows:     { name: '搜查令', type: 'trick', cls: 'c-trick', color: '#b7950b', needTarget: 'none', desc: '除你以外的所有角色需打出【闪避】，否则受到1点伤害。' },
  garden:     { name: '七天神像', type: 'trick', cls: 'c-trick', color: '#b7950b', needTarget: 'none', desc: '所有角色回复1点体力。' },
  duel:       { name: '御前决斗', type: 'trick', cls: 'c-trick', color: '#b7950b', needTarget: 'anyOther', desc: '目标先打出【普通攻击】，双方交替打出【普通攻击】，先打不出者受到1点伤害。' },
  wuxie:      { name: '庇护', type: 'trick', cls: 'c-trick', color: '#b7950b', needTarget: 'none', desc: '响应牌：抵消一张锦囊牌的效果。' },
  dimai:      { name: '地脉之花', type: 'trick', cls: 'c-trick', color: '#8e44ad', needTarget: 'none', desc: '牌堆顶翻出存活人数张牌，从你开始每人依次选择一张获得。' },
  yanshou:    { name: '眼狩令', type: 'trick', cls: 'c-trick', color: '#2c3e50', needTarget: 'none', desc: '所有角色的技能在本回合内不生效。' },

  // —— 延时锦囊 ——
  guanbijing: { name: '关禁闭', type: 'delay', cls: 'c-trick', color: '#7f8c8d', needTarget: 'anyOther', desc: '延时锦囊：置于目标判定区，目标下次判定阶段判定，若不是红桃则跳过其出牌阶段。' },
  leidian:    { name: '落雷', type: 'delay', cls: 'c-trick', color: '#9b59b6', needTarget: 'none', desc: '延时锦囊：置于自己判定区，判定阶段判定，若为黑桃2~9则受到3点雷电伤害，否则移到下家判定区。' },
  liangren:   { name: '两人三足', type: 'trick', cls: 'c-trick', color: '#16a085', needTarget: 'anyOther', desc: '横置或重置一名角色。横置角色受到伤害时，其他横置角色也受到同来源的伤害。' },

  // —— 装备牌 ——
  crossbow:   { name: '莎塔娜娅的苍银', type: 'equip', cls: 'c-weapon', color: '#1f618d', slot: 'weapon', range: 1, needTarget: 'none', desc: '装备后，出牌阶段使用【普通攻击】无次数限制。' },
  bagua:      { name: '捕风瓶', type: 'equip', cls: 'c-armor', color: '#148f77', slot: 'armor', needTarget: 'none', desc: '需要打出【闪避】时，可判定：红牌视为打出【闪避】。' },
  ruin_guard: { name: '独眼小宝', type: 'equip', cls: 'c-armor', color: '#7f8c8d', slot: 'armor', needTarget: 'none', desc: '免疫所有无属性伤害，但受到的元素伤害×2。' },
  wind_seed:  { name: '风种子', type: 'equip', cls: 'c-horse', color: '#7fd8be', slot: 'plusOne', needTarget: 'none', desc: '别人攻击你时，敌我距离+1。' },
  wind_field: { name: '风场', type: 'equip', cls: 'c-horse', color: '#aed581', slot: 'minusOne', needTarget: 'none', desc: '你攻击别人时，敌我距离-1。' },
};

// 牌堆构成：[kind, suit, rank]
const DECK = [
  // —— 基本牌：普通攻击 x14 ——
  ['slash', 'spade', 7], ['slash', 'spade', 8], ['slash', 'spade', 9], ['slash', 'spade', 10],
  ['slash', 'spade', 11], ['slash', 'club', 2], ['slash', 'club', 3], ['slash', 'club', 4],
  ['slash', 'club', 5], ['slash', 'club', 6], ['slash', 'club', 7], ['slash', 'club', 8],
  ['slash', 'club', 9], ['slash', 'club', 10],
  // —— 基本牌：闪避 x10 ——
  ['jink', 'heart', 2], ['jink', 'heart', 5], ['jink', 'heart', 6], ['jink', 'heart', 13],
  ['jink', 'diamond', 2], ['jink', 'diamond', 5], ['jink', 'diamond', 6], ['jink', 'diamond', 13],
  ['jink', 'heart', 13], ['jink', 'diamond', 13],
  // —— 基本牌：甜甜花酿鸡 x6 ——
  ['peach', 'heart', 3], ['peach', 'heart', 4], ['peach', 'heart', 7],
  ['peach', 'heart', 8], ['peach', 'heart', 9], ['peach', 'heart', 12],
  // —— 基本牌：提瓦特煎蛋 x4 ——
  ['food_egg', 'heart', 6], ['food_egg', 'heart', 12], ['food_egg', 'diamond', 3], ['food_egg', 'diamond', 9],
  // —— 基本牌：仙跳墙 x3 ——
  ['wine', 'spade', 3], ['wine', 'heart', 'A'], ['wine', 'diamond', 5],
  // —— 基本牌：元素攻击 x4（普通攻击的1/4） ——
  ['elemental', 'spade', 5], ['elemental', 'heart', 5], ['elemental', 'diamond', 7], ['elemental', 'club', 8],
  // —— 锦囊：浓缩树脂 x3 ——
  ['wuzhong', 'spade', 7], ['wuzhong', 'spade', 11], ['wuzhong', 'spade', 13],
  // —— 锦囊：史莱姆炸药桶 x4 ——
  ['dismantle', 'spade', 3], ['dismantle', 'spade', 4], ['dismantle', 'spade', 12], ['dismantle', 'club', 3],
  // —— 锦囊：拾取 x4 ——
  ['snatch', 'spade', 3], ['snatch', 'spade', 4], ['snatch', 'spade', 11], ['snatch', 'club', 4],
  // —— 锦囊：深渊入侵 x3 ——
  ['nanman', 'spade', 7], ['nanman', 'spade', 13], ['nanman', 'club', 7],
  // —— 锦囊：搜查令 x3 ——
  ['arrows', 'spade', 14], ['arrows', 'club', 14], ['arrows', 'club', 13],
  // —— 锦囊：七天神像 x1 ——
  ['garden', 'heart', 14],
  // —— 锦囊：御前决斗 x2 ——
  ['duel', 'spade', 14], ['duel', 'club', 14],
  // —— 锦囊：无懈可击 x3 ——
  ['wuxie', 'spade', 13], ['wuxie', 'club', 13], ['wuxie', 'diamond', 13],
  // —— 锦囊：地脉之花 x2 ——
  ['dimai', 'club', 12], ['dimai', 'heart', 12],
  // —— 锦囊：眼狩令 x1 ——
  ['yanshou', 'spade', 12],
  // —— 延时锦囊：关禁闭 x2 ——
  ['guanbijing', 'spade', 6], ['guanbijing', 'club', 6],
  // —— 延时锦囊：落雷 x1 ——
  ['leidian', 'spade', 1],
  // —— 锦囊：两人三足 x2 ——
  ['liangren', 'heart', 10], ['liangren', 'diamond', 11],
  // —— 装备：莎塔娜娅的苍银 x1 ——
  ['crossbow', 'club', 14],
  // —— 装备：捕风瓶 x1 ——
  ['bagua', 'spade', 2],
  // —— 装备：独眼小宝 x1 ——
  ['ruin_guard', 'club', 2],
  // —— 装备：风种子 x1 ——
  ['wind_seed', 'heart', 'K'],
  // —— 装备：风场 x1 ——
  ['wind_field', 'diamond', 'Q'],
];

// 构建一副洗好的牌堆（可多次调用）
function buildDeck() {
  const list = [];
  for (const [kind, suit, rank] of DECK) {
    list.push({ id: nextId(), kind, suit, rank });
  }
  // Fisher–Yates 洗牌
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

module.exports = {
  CARD_META, SUIT_INFO, RANK_TEXT, buildDeck,
  rankText, suitColor, isRed,
};

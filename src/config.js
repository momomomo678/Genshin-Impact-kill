// ============================================================
// 原神杀 · 全局配置
// 想调整人数上限、默认摸牌数、端口等，改这里即可。
// ============================================================
'use strict';

const CONFIG = {
  PORT: process.env.PORT || 3000,          // 服务器端口（樱花映射/局域网联机时开放此端口）
  MIN_PLAYERS: 2,                          // 开局最少人数
  MAX_PLAYERS: 8,                          // 开局最多人数
  DEFAULT_FILL_AI: 4,                      // 房主一键“补位AI”后默认总人数
  DRAW_COUNT: 2,                           // 摸牌阶段摸牌数
  START_HAND: 4,                           // 起始手牌数
  SLASH_LIMIT: 2,                          // 每回合可使用的【杀】次数
  JUDGE_DURATION: 90000,                   // 人类玩家响应超时（毫秒），超时视为放弃
  PLAY_END_DURATION: 180000,               // 出牌阶段空闲超时（毫秒），超时自动结束回合
  HEARTBEAT_MS: 30000,                     // WebSocket 心跳间隔
};

// 身份配置：人数 -> { main:主公 loyal:忠臣 rebel:反贼 spy:内奸 }
// 2~8 人都有对应配置，超出范围由 server.js 拒绝开局。
const IDENTITY_CONFIG = {
  2: { main: 1, loyal: 0, rebel: 1, spy: 0 },
  3: { main: 1, loyal: 1, rebel: 1, spy: 0 },
  4: { main: 1, loyal: 1, rebel: 1, spy: 1 },
  5: { main: 1, loyal: 1, rebel: 2, spy: 1 },
  6: { main: 1, loyal: 1, rebel: 3, spy: 1 },
  7: { main: 1, loyal: 2, rebel: 3, spy: 1 },
  8: { main: 1, loyal: 2, rebel: 4, spy: 1 },
};

// 身份展示元数据（后续可补充卡面设计字段）
const IDENTITY_META = {
  main:  { name: '主公', color: '#c0392b', cls: 'id-main' },
  loyal: { name: '忠臣', color: '#7d3c98', cls: 'id-loyal' },
  rebel: { name: '反贼', color: '#1e8449', cls: 'id-rebel' },
  spy:   { name: '内奸', color: '#b9770e', cls: 'id-spy' },
};

// 元素展示（原神特性预留：元素 / 元素反应）
const ELEMENT_META = {
  wind:     { name: '风', color: '#27ae60' },
  fire:     { name: '火', color: '#e74c3c' },
  water:    { name: '水', color: '#2980b9' },
  thunder:  { name: '雷', color: '#8e44ad' },
  grass:    { name: '草', color: '#16a085' },
  ice:      { name: '冰', color: '#5dade2' },
  rock:     { name: '岩', color: '#a04000' },
};

module.exports = { CONFIG, IDENTITY_CONFIG, IDENTITY_META, ELEMENT_META };

// 原神杀 · 4 人 AI 模拟局（带卡局诊断）
// 用法：node test/simulate.js
'use strict';

const { Game } = require('../src/game');

const meta = [0, 1, 2, 3].map((i) => ({ id: 'ai' + i, name: 'AI角色' + (i + 1), seat: i, isAI: true, isBot: true }));
const logs = [];
const game = new Game(meta, (type, pid, data) => {
  if (type === 'log') logs.push(...data.map((e) => e.text));
});

game.start();

let checks = 0;
let lastTurn = 0;
let stallCount = 0;
const timer = setInterval(() => {
  checks++;
  if (game.turnNo !== lastTurn) { lastTurn = game.turnNo; stallCount = 0; }
  else stallCount++;
  if (checks % 20 === 0) console.log(`  ...第 ${game.turnNo} 回合，阶段 ${game.phase}`);
  if (stallCount >= 25) {
    clearInterval(timer);
    console.log('!!! 检测到卡局（25 秒无回合推进）');
    console.log(`当前回合 ${game.turnNo}，阶段 ${game.phase}，等待=${game.waiting}，ask=${JSON.stringify(game.ask && { t: game.ask.type, p: game.ask.playerId })}`);
    console.log('--- 最后 20 条日志 ---');
    console.log(logs.slice(-20).join('\n'));
    process.exit(1);
  }
  if (game.over || checks > 600) {
    clearInterval(timer);
    if (game.over) {
      console.log('========================================');
      console.log('对局结束：' + game.winner.text);
      console.log('总回合数：' + game.turnNo);
      console.log('胜负详情：' + game.winner.detail);
      console.log('--- 最后 15 条日志 ---');
      console.log(logs.slice(-15).join('\n'));
      process.exit(0);
    } else {
      clearInterval(timer);
      console.log('超时未结束');
      process.exit(1);
    }
  }
}, 1000);

// ============================================================
// 原神杀 · 角色（武将）注册表
// ------------------------------------------------------------
//   id      角色唯一标识（英文小写，如 'zhongli'）
//   name    角色名（如 钟离）
//   element 元素：anemo/geo/electro/dendro/hydro/pyro/cryo/none
//   maxHp   体力上限
//   desc    一句话介绍
//   skills  技能数组，每个技能：
//     id    技能标识
//     name  技能名
//     desc  技能描述文案
//     hooks 技能钩子：
//       onDraw / onHandLimit / onSlashLimit / onDamaged / onPlay / onTurnStart / onTurnEnd
// ============================================================
'use strict';

const CHARACTERS = {
  // —— 正式角色 ——
  traveler: {
    id: 'traveler',
    name: '空/荧',
    element: 'none',
    maxHp: 4,
    desc: '旅人座命之座。穿越星海的旅人，在提瓦特寻找失散的亲人。',
    skills: [
      {
        id: 'traveler_1',
        name: '双子',
        desc: '每个装备栏可装备两件装备。',
        hooks: {},
      },
      {
        id: 'traveler_2',
        name: '无眼',
        desc: '你不受【眼狩令】的影响。',
        hooks: {},
      },
      {
        id: 'traveler_3',
        name: '共鸣',
        desc: '每第二次【普通攻击】可造成自选择的元素伤害。',
        hooks: {},
      },
    ],
  },

  noelle: {
    id: 'noelle',
    name: '诺艾尔',
    element: 'geo',
    maxHp: 5,
    desc: '心护座命之座。永远在女仆岗位上尽职尽责的骑士。',
    skills: [
      {
        id: 'noelle_1',
        name: '护心铠',
        desc: '每回合限一次，你可以为一名角色添加一个抵挡1点伤害的护盾（持续到该玩家行动结束）。若目标为自己，则变为：下一次受到的有效伤害变为岩元素伤害，并为自己回复1点生命（持续到自己回合结束）。',
        hooks: {},
      },
      {
        id: 'noelle_2',
        name: '全心全意',
        desc: '整局游戏限一次，你可以在任意阶段（除伤害结算阶段）使用，为任意一名角色添加一个免疫所有伤害的护盾，持续到当前回合结束。',
        hooks: {},
      },
    ],
  },

  kokomi: {
    id: 'kokomi',
    name: '珊瑚宫心海',
    element: 'hydro',
    maxHp: 6,
    desc: '眠龙座命之座。海祇岛的现人神巫女，擅长谋略与治疗。',
    skills: [
      {
        id: 'kokomi_1',
        name: '海月之誓',
        desc: '你的【甜甜花酿鸡】可以自由选择治疗目标（不再只能对自己使用）。',
        hooks: {},
      },
      {
        id: 'kokomi_2',
        name: '庙算无遗',
        desc: '主动释放：选择一张红色花色（红桃/方块）的手牌，将其当作【甜甜花酿鸡】打出。',
        hooks: {},
      },
      {
        id: 'kokomi_3',
        name: '海人化羽',
        desc: '你对别人造成治疗效果后，获得【海人化羽】效果：下一次攻击变为水元素伤害，伤害值为自身最大生命值的20%（向下取整，最低为1）；攻击造成有效伤害时回复自身1点生命值。',
        hooks: {},
      },
    ],
  },

  hu_tao: {
    id: 'hu_tao',
    name: '胡桃',
    element: 'pyro',
    maxHp: 5,
    desc: '引蝶座命之座。往生堂第七十七代堂主，执掌葬仪，古灵精怪。',
    skills: [
      {
        id: 'hu_tao_1',
        name: '血之灶火',
        desc: '当你的生命值低于或等于50%时，你造成的伤害+1。',
        hooks: {},
      },
      {
        id: 'hu_tao_2',
        name: '引蝶来生',
        desc: '每回合限一次，你可以主动使用：扣除当前生命值30%（向上取整，最低剩余1点生命则不扣），本回合所有【普通攻击】变为火元素伤害。',
        hooks: {},
      },
      {
        id: 'hu_tao_3',
        name: '幽蝶能留一缕芳',
        desc: '你首次受到致命伤害时不会死亡，保留1点生命值。每场游戏仅触发一次。',
        hooks: {},
      },
    ],
  },
  // —— 新角色 ——
  ganyu: {
    id: 'ganyu', name: '甘雨', element: 'cryo', maxHp: 4,
    desc: '仙麟座·半仙之身，流天射术贯通敌阵。',
    skills: [
      {
        id: 'ganyu_1',
        name: '流天射术',
        desc: '使用【元素攻击】时，可主动消耗两张牌触发：攻击不可闪避，对选中目标及左右相邻目标各造成1点冰元素伤害（不对自己造成伤害）。',
        hooks: {},
      },
      {
        id: 'ganyu_2',
        name: '天地交泰',
        desc: '【甜甜花酿鸡】和【提瓦特煎蛋】可以互通使用。',
        hooks: {},
      },
      {
        id: 'ganyu_3',
        name: '履虫',
        desc: '使用【甜甜花酿鸡】或【提瓦特煎蛋】后，下一次【流天射术】只需消耗一张牌。',
        hooks: {},
      },
    ],
  },
  venti: {
    id: 'venti', name: '温迪', element: 'anemo', maxHp: 4,
    desc: '歌仙座·风色诗人，高天之歌引领自由之风。',
    skills: [
      {
        id: 'venti_1',
        name: '高天之歌',
        desc: '温迪始终被视为距离+1（别人攻击你时距离+1）、攻击时距离-1。',
        hooks: {},
      },
      {
        id: 'venti_2',
        name: '黎明破晓之史',
        desc: '若你距离上一次行动开始至本次行动开始之间：未受到任何伤害、也未进行攻击，则本回合攻击伤害+1。',
        hooks: {},
      },
      {
        id: 'venti_3',
        name: '弦发的苍风',
        desc: '当【黎明破晓之史】激活时，你使用攻击可以同时指定两名目标，但每个目标只受到1点伤害。',
        hooks: {},
      },
    ],
  },
  zhongli: {
    id: 'zhongli', name: '钟离', element: 'geo', maxHp: 6,
    desc: '岩王帝君·尘世契约，地心之盾坚不可摧。',
    skills: [
      {
        id: 'zhongli_1',
        name: '炊金馔玉',
        desc: '你的手牌上限始终为6张，不随生命值改变。',
        hooks: {},
      },
      {
        id: 'zhongli_2',
        name: '地心',
        desc: '主动弃置3张牌，为自己添加一个可抵挡3点伤害的护盾，持续到下一个自己回合开始。',
        hooks: {},
      },
      {
        id: 'zhongli_3',
        name: '天星',
        desc: '主动弃置5张牌，选定一名玩家：使其直接跳过下一次行动回合。',
        hooks: {},
      },
    ],
  },
  gai: {
    id: 'gai', name: '乱入·迈特凯', element: 'pyro', maxHp: 4,
    desc: '八门遁甲·青春热血，惊门昼虎势不可挡。',
    skills: [
      {
        id: 'gai_1',
        name: '体术·无极限',
        desc: '你的手牌上限始终为无限。',
        hooks: {},
      },
      {
        id: 'gai_2',
        name: '惊门·昼虎',
        desc: '你的【普通攻击】需要两张【闪避】才能躲避，且攻击距离判定-2。',
        hooks: {},
      },
      {
        id: 'gai_3',
        name: '八门·死门',
        desc: '主动开启：本回合期间你造成的所有伤害×4，本回合行动结束时你直接死亡（无濒死阶段）。',
        hooks: {},
      },
    ],
  },
};

// 技能钩子调度：按技能顺序合并各技能返回结果
function applyHooks(player, game, hookName, args = {}) {
  const merged = { bonus: 0, reduce: 0, damageBonus: 0 };
  // 眼狩令：本回合所有技能不生效（空/荧的【无眼】除外）
  if (game._skillDisabled && player.char && player.char.id !== 'traveler') return merged;
  const char = player.char;
  if (!char) return merged;
  for (const skill of char.skills) {
    const fn = skill.hooks && skill.hooks[hookName];
    if (fn) {
      try {
        const res = fn({ player, game, ...args });
        if (res && res.bonus) merged.bonus += res.bonus;
        if (res && res.reduce) merged.reduce += res.reduce;
        if (res && res.damageBonus) merged.damageBonus += res.damageBonus;
      } catch (e) {
        console.error(`[skill error] ${char.id}.${skill.id}.${hookName}`, e);
      }
    }
  }
  return merged;
}

module.exports = { CHARACTERS, applyHooks };

/* ============================================================
 * 晶核守卫 · 权威模拟层（纯逻辑，无 DOM / 无渲染）
 * 所有玩家操作都以「命令」进入 sim.apply()，状态全部保存在 sim.s
 * 这样后续做 4 人联机时：服务器(或主机)跑 Sim，客户端只发命令、收快照/事件。
 * ============================================================ */
(function (root) {
'use strict';

const T = 2.4;            // 网格边长（一个陷阱格）
const WALL_H = 6.4;       // 墙高 / 天花板高度
const PLAT_H = 0.38;      // 2×2 炮台平台抬高的高度（玩家可直接走上去）
const FLY_Y = 3.1;        // 飞行怪高度
const TILE = { WALL: 0, LANE: 1, FLOOR: 2, PAD: 3, BASE: 4, SPAWN: 5 };
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/* ---------- 难度 ---------- */
const DIFFS = {
  normal: { name: '普通', hp: 1.0, gold: 1.0 },
  hard: { name: '困难', hp: 1.45, gold: 0.95 },
  hell: { name: '炼狱', hp: 2.05, gold: 0.9 },
};

/* ---------- 怪物 ----------
 * body/head: [相对脚底的高度, 命中球半径]
 */
const MON = {
  grunt: { name: '赛博格步兵', hp: 140, spd: 3.4, core: 5, bounty: 16, dps: 30, melee: 10, r: 0.45, body: [0.82, 0.4], head: [1.55, 0.48] },
  runner: { name: '疾行猎犬', hp: 85, spd: 6.2, core: 3, bounty: 14, dps: 20, melee: 8, r: 0.45, body: [0.55, 0.5], head: [0.72, 0.24, 0.7] },
  brute: { name: '重装赛博格', hp: 950, spd: 2.3, armor: 0.3, core: 15, bounty: 55, dps: 90, melee: 25, r: 0.8, knockRes: 0.5, body: [1.2, 0.58], head: [2.25, 0.7] },
  flyer: { name: '浮游无人机', hp: 110, spd: 4.4, core: 5, bounty: 20, fly: true, r: 0.5, body: [0, 0.6], head: [0.05, 0.28] },
  bomber: { name: '自爆蜘蛛', hp: 190, spd: 4.0, core: 20, bounty: 24, bomb: true, r: 0.55, body: [0.55, 0.55], head: [0.68, 0.22, 0.5] },
  elite: { name: '狂猩赛博格', hp: 4200, spd: 2.7, armor: 0.2, core: 40, bounty: 400, dps: 130, melee: 35, r: 1.1, knockRes: 1, slowRes: 0.5, elite: true, body: [1.85, 0.95], head: [2.62, 0.42, 0.72] },
  healer: { name: '修复无人机', hp: 160, spd: 3.8, core: 5, bounty: 32, fly: true, heal: 30, r: 0.5, body: [0, 0.6], head: [0.05, 0.28] },
  boss: { name: '泰坦·终焉', hp: 20000, spd: 1.5, armor: 0.2, core: 999, bounty: 0, dps: 300, melee: 40, r: 2.0, knockRes: 1, slowRes: 0.6, boss: true, body: [3.1, 1.9], head: [5.68, 0.62, 0.1] },
  // —— 新敌人 ——
  stalker: { name: '幽影刺客', hp: 340, spd: 4.4, core: 6, bounty: 30, dps: 40, melee: 14, r: 0.45, stealth: true, body: [0.75, 0.37], head: [1.43, 0.44] },
  burrower: { name: '钻地虫', hp: 520, spd: 3.0, armor: 0.1, core: 8, bounty: 34, dps: 40, r: 0.6, burrow: true, body: [0.5, 0.6], head: [0.55, 0.36, 0.55] },
  sapper: { name: '骇客工兵', hp: 420, spd: 2.8, core: 6, bounty: 42, dps: 25, melee: 8, r: 0.5, hack: true, body: [0.75, 0.37], head: [1.43, 0.44] },
  gunner: { name: '火线射手', hp: 300, spd: 2.6, core: 5, bounty: 30, dps: 25, r: 0.5, ranged: { range: 16, dmg: 6, rate: 1.6, acc: 0.65 }, body: [0.86, 0.42], head: [1.63, 0.5] },
  mite: { name: '噬晶蛛', hp: 55, spd: 5.6, core: 2, bounty: 4, dps: 10, melee: 4, r: 0.32, body: [0.3, 0.35], head: [0.33, 0.17, 0.3] },
  siege: { name: '攻城机甲·破城者', hp: 15000, spd: 1.35, armor: 0.3, core: 999, bounty: 0, dps: 320, melee: 40, r: 2.0, knockRes: 1, slowRes: 0.6, boss: true, body: [1.4, 1.55], head: [2.62, 0.72, 0.2] },
  colossus: { name: '熔炉巨像', hp: 21000, spd: 1.5, armor: 0.15, core: 999, bounty: 0, dps: 320, melee: 45, r: 2.1, knockRes: 1, slowRes: 0.6, burnImmune: true, boss: true, body: [3.2, 2.0], head: [5.93, 0.62, 0.15] },
  brood: { name: '深渊母巢', hp: 15000, spd: 1.6, armor: 0.1, core: 999, bounty: 0, dps: 260, melee: 35, r: 2.0, knockRes: 1, slowRes: 0.6, boss: true, split: 'broodling', body: [2.1, 1.6], head: [1.6, 0.66, 1.4] },
  broodling: { name: '母巢裂体', hp: 4000, spd: 2.1, armor: 0.1, core: 60, bounty: 160, dps: 160, melee: 30, r: 1.3, knockRes: 1, slowRes: 0.4, elite: true, brood: true, body: [1.26, 0.96], head: [0.96, 0.42, 0.84] },
};
const BOSS_TIP = {
  boss: '泰坦会周期性释放 EMP 瘫痪附近陷阱、召唤援军、践踏周围玩家',
  siege: '破城者会炮击远处的炮台和磁暴塔使其瘫痪，靠近它的玩家会被践踏',
  colossus: '巨像走过的地面化作熔岩：熔岩上的地面陷阱停止工作，玩家踩上去会被灼伤；它还会朝玩家喷出火浪',
  brood: '母巢不断孵化噬晶蛛，被击破后分裂成两只母巢裂体',
};

/* ---------- 陷阱（参考逆战：地面 / 墙壁 / 天花板 / 炮台 / 阻挡）---------- */
const TRAPS = [
  { id: 'slow', key: '1', name: '减速器', cat: 'floor', cost: 90, slow: [0.4, 0.5, 0.58, 0.65],
    desc: '地面 · 踩上的怪物大幅减速，延长受击时间' },
  { id: 'spike', key: '2', name: '毒刺陷阱', cat: 'floor', cost: 120, cd: 1.2, dmg: [50, 85, 130, 190], poison: [12, 20, 30, 44],
    desc: '地面 · 周期弹出毒刺，附带中毒持续伤害' },
  { id: 'push', key: '3', name: '弹板陷阱', cat: 'floor', cost: 170, cd: [3.6, 3.2, 2.8, 2.4], push: [7, 8, 9, 10], dmg: [20, 35, 55, 80],
    desc: '地面 · 把怪物弹回上游，让它们再吃一遍伤害' },
  { id: 'tesla', key: '4', name: '自修复磁暴塔', cat: 'floor', block: true, cost: 220, hp: [1500, 2300, 3400, 5000], regen: 0.025,
    cd: 0.6, range: 4.2, dmg: [30, 50, 78, 115], chains: 3,
    desc: '地面 · 阻挡类，堵路并电击周围敌人，持续自我修复' },
  { id: 'sentry', key: '5', name: '岗哨机枪', cat: 'pad', cost: 260, cd: 0.25, range: [16, 17, 18, 19], dmg: [22, 36, 56, 82],
    desc: '炮台位 · 对地对空，优先射击最接近水晶的敌人' },
  { id: 'aa', key: '6', name: '防空导弹', cat: 'pad', cost: 240, cd: 1.4, range: [24, 25, 26, 28], dmg: [150, 250, 380, 560], splash: 2.6,
    desc: '炮台位 · 只打空中单位，追踪导弹带溅射' },
  { id: 'laser', key: '7', name: '激光发射器', cat: 'wall', cost: 150, cd: 0.2, dmg: [12, 20, 31, 46],
    desc: '墙壁 · 光束横贯通道，命中光束上所有敌人' },
  { id: 'flame', key: '8', name: '火焰发射器', cat: 'wall', cost: 200, cd: 0.3, dmg: [12, 20, 31, 46], burn: [22, 36, 55, 80],
    desc: '墙壁 · 喷火覆盖整条横线，附带灼烧' },
  { id: 'crusher', key: '9', name: '粉碎锤', cat: 'ceil', cost: 300, cd: [3.0, 2.8, 2.6, 2.4], dmg: [260, 430, 650, 950], stun: 0.8,
    desc: '天花板 · 重锤砸地，3×3 范围重伤并眩晕地面敌人' },
];
const TRAP = {}; TRAPS.forEach(t => { TRAP[t.id] = t; });
// 满级进阶：Lv3 → Lv4 时二选一
const EVO = {
  slow: { a: { name: '冰封力场', desc: '每秒有 35% 几率把格子上的敌人冻住 1 秒' }, b: { name: '迟滞矩阵', desc: '减速范围扩大到周围 3×3 格' } },
  spike: { a: { name: '剧毒刺', desc: '中毒伤害翻倍，中毒的敌人死亡时毒素扩散给周围敌人' }, b: { name: '穿甲刺', desc: '弹刺伤害 ×1.6 并无视护甲' } },
  push: { a: { name: '弹射器', desc: '击退距离 +40%，敌人滞空更久（空中连击窗口更长）' }, b: { name: '连弹板', desc: '冷却减半，击退距离 ×0.7' } },
  tesla: { a: { name: '链式闪电', desc: '电弧可同时连锁 6 个目标' }, b: { name: '麻痹线圈', desc: '伤害 ×1.2，每次电击麻痹敌人 0.35 秒' } },
  sentry: { a: { name: '双联机枪', desc: '射速翻倍' }, b: { name: '侦测穿甲弹', desc: '伤害 ×1.6，并让射程内的隐身敌人现形' } },
  aa: { a: { name: '集束导弹', desc: '一次齐射 3 枚导弹分别追踪不同目标（单发伤害 ×0.7）' }, b: { name: '对地模式', desc: '也能攻击地面敌人，爆炸波及地面' } },
  laser: { a: { name: '过载激光', desc: '伤害 ×1.6' }, b: { name: '棱镜光束', desc: '光束延长到 6 格，并减速被照射的敌人' } },
  flame: { a: { name: '凝固汽油', desc: '灼烧时间延长到 5 秒，灼烧伤害 ×1.4' }, b: { name: '蓝焰', desc: '伤害 ×1.4，对精英和 BOSS 再 +50%' } },
  crusher: { a: { name: '重锤', desc: '伤害 ×1.5，眩晕延长到 1.6 秒' }, b: { name: '连击锤', desc: '冷却缩短 40%' } },
};
// 突变词缀（可选，叠加提升难度）
const MUTATORS = [
  { id: 'swift', name: '疾行', desc: '敌人移速 +25%', w: 0.25 },
  { id: 'armored', name: '重甲', desc: '所有敌人护甲 +20%', w: 0.25 },
  { id: 'horde', name: '狂潮', desc: '每波敌人数量 +30%', w: 0.3 },
  { id: 'austerity', name: '拮据', desc: '陷阱造价 +25%，击杀赏金 +25%', w: 0.15 },
  { id: 'regen', name: '再生', desc: '敌人 2 秒没受伤就开始回血', w: 0.2 },
  { id: 'skies', name: '遮天', desc: '飞行敌人数量翻倍', w: 0.2 },
  { id: 'champions', name: '精英化', desc: '12% 的普通敌人变成金色精英：血量 ×2.5、赏金 ×3', w: 0.25 },
  { id: 'glass', name: '玻璃大炮', desc: '玩家枪械伤害 ×2，但生命值减半', w: 0.1 },
  { id: 'blackout', name: '熄灯', desc: '基地断电：视野更暗，小地图不显示敌人', w: 0.15 },
];
const MUT = {}; MUTATORS.forEach(m => { MUT[m.id] = m; });
// 局外天赋：通关得星，星星点天赋（team = 由房主 / 单机玩家提供的全队效果）
const TALENTS = [
  { id: 'startGold', name: '启动资金', max: 3, team: true, desc: r => `开局金币 +${80 * r}` },
  { id: 'engineer', name: '工程学', max: 3, team: true, desc: r => `陷阱造价与升级费用 -${3 * r}%` },
  { id: 'crystal', name: '强化水晶', max: 3, team: true, desc: r => `水晶生命 +${10 * r}` },
  { id: 'prep', name: '快速部署', max: 1, team: true, desc: r => `第一波前的布防时间 +${15 * r} 秒` },
  { id: 'gunDmg', name: '枪械专精', max: 3, desc: r => `枪械伤害 +${8 * r}%` },
  { id: 'vitality', name: '战地急救', max: 2, desc: r => `生命上限 +${20 * r}` },
  { id: 'energy', name: '能量回路', max: 2, desc: r => `轨道打击充能速度 +${20 * r}%` },
  { id: 'grenade', name: '弹药扩容', max: 1, desc: r => `手雷上限 +${r}` },
];
const tl = (t, id) => Math.max(0, Math.min((TALENTS.find(x => x.id === id) || { max: 0 }).max, (t && t[id]) | 0));
// 职业（每名玩家各选一个）
const CLASSES = [
  { id: 'assault', name: '突击兵', short: '突', desc: '枪械伤害 +20%，换弹快 30%，手雷 +1' },
  { id: 'engineer', name: '工程师', short: '工', desc: '自己建造与升级陷阱便宜 10%，战斗中拆除返还 90%' },
  { id: 'support', name: '支援兵', short: '援', desc: '轨道打击充能 +40%；10 米内的队友受伤后也能持续回血' },
  { id: 'scout', name: '侦察兵', short: '侦', desc: '移速 +15%，让 12 米内的隐身敌人现形，狙击枪伤害 +25%' },
];
const CLS = {}; CLASSES.forEach(c => { CLS[c.id] = c; });
// 每日挑战：按日期生成固定的地图 / 难度 / 突变组合
function dailySpec(dateStr) {
  let h = 2166136261;
  for (const ch of 'jhsw' + dateStr) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const rnd = () => { h ^= h << 13; h >>>= 0; h ^= h >> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
  const maps = MAP_LIST.map(m => m.id);
  const map = maps[Math.floor(rnd() * maps.length)];
  const diff = rnd() < 0.55 ? 'normal' : 'hard';
  const pool = MUTATORS.map(m => m.id), mut = [];
  while (mut.length < 3) { const id = pool.splice(Math.floor(rnd() * pool.length), 1)[0]; mut.push(id); }
  return { date: dateStr, map, diff, mut, seed: Math.floor(rnd() * 1e9) };
}
// 地图机关：跑到控制台旁按 F 启动
const DEVICE = {
  cryo: { name: '冷冻喷淋', cd: 45, dur: 4, desc: '冻结汇合口的地面敌人 4 秒（可触发碎冰联动）' },
  gate: { name: '落闸门', cd: 50, dur: 6, desc: '放下闸门挡住主干道 6 秒，敌人会在闸前堆积' },
  vent: { name: '熔炉喷火口', cd: 40, dur: 5, desc: '地面喷出烈焰 5 秒，灼烧经过的地面敌人' },
  gravity: { name: '重力井', cd: 45, dur: 6, desc: '把主干道上空的飞行敌人拉到地面 6 秒，地面陷阱也能打到它们' },
};
// 科研舱：终端旁按 F 研究全队科技（花共享金币，本局有效）；补给柜按 F 补满生命 / 手雷 / 弹药
const TECH = [
  { id: 'overclock', name: '陷阱超频', short: '超频', cost: [400, 800, 1300], desc: r => `所有陷阱与机关伤害 +${8 * r}%` },
  { id: 'armor', name: '水晶装甲', short: '装甲', cost: [300, 600, 950], desc: r => `水晶生命上限 +${15 * r}（每级研究时立即回复 15 点）` },
  { id: 'salvage', name: '战利品回收', short: '回收', cost: [350, 700, 1100], desc: r => `击杀赏金 +${10 * r}%` },
  { id: 'ammo', name: '弹药工艺', short: '弹药', cost: [300, 600, 950], desc: r => `全队枪械与手雷伤害 +${12 * r}%` },
  { id: 'repair', name: '纳米维修', short: '维修', cost: [300, 600, 950], desc: r => `磁暴塔与通道炮台每秒多回 ${r}% 耐久，瘫痪时间 -${20 * r}%` },
];
const TECH_BY = {}; TECH.forEach(t => { TECH_BY[t.id] = t; });
const TECH_MAX = 3;
const SUPPLY_CD = 50, LAB_REACH = 3.6;
// 元素联动
const COMBOS = [
  { id: 'shatter', name: '碎冰', desc: '粉碎锤砸中被减速或冻住的敌人，伤害 ×2' },
  { id: 'ignite', name: '爆燃', desc: '火焰点燃中毒的敌人会引发爆炸（范围伤害），消耗毒素' },
  { id: 'air', name: '空中连击', desc: '被弹板击飞的敌人在空中受到的陷阱伤害 +40%' },
];
const UPG_MUL = [0.8, 1.2, 1.6];   // Lv1→2, 2→3, 3→4
const MAX_LV = 4;
// 炮台类放在怪物通道上时的耐久（会挡路并被攻击）
const LANE_HP = { sentry: [900, 1400, 2000, 2800], aa: [800, 1250, 1800, 2500] };
const CAT_NAME = { floor: '地面', pad: '炮台位', wall: '墙壁', ceil: '天花板' };

/* ---------- 武器 / 技能 ----------
 * 每名玩家开局只有脉冲步枪；其余武器用（全队共享的）金币在军械库购买，本局有效。
 * maxHit：单次射击对单个目标的理论伤害上限（主机校验队友上报的命中用）
 */
const WEAPONS = [
  { id: 'rifle', key: '1', name: '脉冲步枪', cost: 0, dmg: 15, rps: 8.5, mag: 30, reload: 1.9, spread: 0.006, bloom: 0.12, head: 2.2, kick: 0.4,
    desc: '全自动，射速快，什么场合都能用' },
  { id: 'shotgun', key: '2', name: '裂变霰弹枪', cost: 600, dmg: 13, pellets: 9, rps: 1.6, mag: 8, reload: 2.3, spread: 0.065, bloom: 0, head: 1.5, near: 7, far: 17, kick: 1,
    desc: '9 颗弹丸近距离爆发，守在汇合口最好用' },
  { id: 'sniper', key: '3', name: '电磁狙击枪', cost: 850, dmg: 200, rps: 0.9, mag: 5, reload: 2.6, spread: 0.03, adsSpread: 0, bloom: 0, head: 2.5, pierce: 3, kick: 1,
    desc: '右键开镜零散布，一枪贯穿 3 个目标，专打精英与 BOSS' },
  { id: 'rocket', key: '4', name: '蜂巢火箭筒', cost: 1200, dmg: 240, splash: 3.4, rps: 0.7, mag: 3, reload: 3.2, proj: 40, spread: 0.004, bloom: 0, kick: 1,
    desc: '火箭弹范围爆炸，地面和空中目标都能炸' },
];
const WPN = {}; WEAPONS.forEach(w => { WPN[w.id] = w; w.maxHit = w.dmg * (w.head || 1) * (w.pellets || 1); });
const SKILL = {
  nade: { name: '电浆手雷', max: 2, recharge: 14, dmg: 260, r: 3.6, fuse: 1.6 },
  ult: { name: '轨道打击', dmg: 1100, r: 5.5, delay: 1.3, stun: 1.6 },
};

/* ---------- 波次 DSL ----------
 * g(类型, 总数, 出怪口, 间隔, 开始时间)
 * 出怪口：'A' / 'AB' / '*'（所有已开启的出怪口轮流出），总数按出怪口平均分配
 */
const g = (t, n, lane, gap, at) => ({ t, n, lane, gap, at });

/* ---------- 地图 ----------
 * lanes：每个出怪口一条完整折线（终点都是水晶），折线经过的格子 ±1 挖成 3 格宽通道
 * laneFrom：该出怪口从第几波开始启用（中途开启新出怪口）
 * rooms：玩家专用区域 [x0,z0,x1,z1,类型]；pads：炮台位；base：水晶房间
 */
const ST_M = [[18, 16], [18, 21], [8, 21], [8, 27], [20, 27]];
const FT_M = [[20, 17], [20, 21], [13, 21], [13, 26], [20, 26], [20, 30]];
const MAPS = {
  station: {
    id: 'station', order: 1, name: '空间站·中枢', sub: '双路汇合', w: 37, h: 32, gold: 1100, theme: 'station',
    desc: '两条路线在中段汇合后蛇形通向水晶。经典入门图，适合在汇合口堵路集火。',
    lanes: {
      A: [[4, 2], [4, 10], [12, 10], [12, 16]].concat(ST_M),
      B: [[32, 2], [32, 10], [24, 10], [24, 16]].concat(ST_M),
    },
    laneNames: { A: '左路', B: '右路' },
    rooms: [[15, 2, 21, 7, TILE.FLOOR], [18, 8, 18, 9, TILE.FLOOR], [14, 10, 22, 10, TILE.FLOOR], [18, 11, 18, 14, TILE.FLOOR]],
    base: [16, 24, 23, 30], doors: [[19, 23, 20, 23]],
    pads: [[6, 6], [2, 8], [8, 8], [9, 12], [10, 14], [14, 14], [15, 14], [30, 6], [34, 8], [28, 8], [27, 12], [26, 14], [22, 14], [21, 14],
      [16, 18], [20, 18], [20, 21], [13, 19], [11, 23], [14, 23], [6, 23], [10, 24], [12, 25], [11, 29], [14, 29]],
    spawns: [[19, 24], [20, 25], [18, 25], [21, 24]], focus: [18.5, 16.5], foci: [[18.5, 17.5]],
    devices: [{ type: 'cryo', lever: [20, 23], area: [15, 15, 21, 20] }],
    platforms: [[15, 18], [20, 18], [10, 24], [13, 23], [6, 7], [29, 7]],
    // 科研舱：term/sup = [格x, 格z, 靠墙方向]；racks = 5 台服务器机柜（对应 5 项科技）
    labs: [{ holo: [18.5, 5], term: [18, 2, 3], sup: [15, 4, 2], racks: [[21, 3, 0], [21, 4, 0], [21, 5, 0], [21, 6, 0], [21, 7, 0]] }],
    waves: [
      { name: '先头部队', groups: [g('grunt', 6, 'A', 1.6, 0), g('grunt', 6, 'B', 1.6, 4)] },
      { name: '疾行突袭', groups: [g('grunt', 7, 'A', 1.4, 0), g('grunt', 7, 'B', 1.4, 2), g('runner', 4, 'A', 0.9, 12), g('runner', 4, 'B', 0.9, 14)] },
      { name: '重装来袭', tip: '重装赛博格护甲厚、免疫一半击退', groups: [g('grunt', 8, 'A', 1.3, 0), g('grunt', 8, 'B', 1.3, 1), g('brute', 2, 'A', 5, 10), g('brute', 1, 'B', 5, 14)] },
      { name: '空中威胁', tip: '浮游无人机无视地面陷阱，需要防空导弹、岗哨机枪或墙壁陷阱', groups: [g('grunt', 8, 'A', 1.2, 0), g('grunt', 8, 'B', 1.2, 0), g('flyer', 5, 'A', 1.5, 8), g('flyer', 5, 'B', 1.5, 10)] },
      { name: '狂猩出笼', tip: '精英「狂猩赛博格」半血后狂暴，攻速与移速大增', groups: [g('grunt', 8, 'A', 1.1, 0), g('grunt', 8, 'B', 1.1, 0), g('runner', 5, 'A', 0.8, 10), g('runner', 5, 'B', 0.8, 10), g('elite', 1, 'A', 0, 18)] },
      { name: '自爆潮', tip: '自爆蜘蛛遇到阻挡会引爆，击杀它会炸伤周围怪物', groups: [g('runner', 12, 'A', 0.6, 0), g('runner', 12, 'B', 0.6, 2), g('bomber', 4, 'A', 2, 8), g('bomber', 4, 'B', 2, 10)] },
      { name: '钢铁洪流', tip: '火线射手会停下来射击玩家，别站在它们的视线里硬拼', groups: [g('grunt', 10, 'A', 1, 0), g('grunt', 10, 'B', 1, 0), g('brute', 4, 'A', 4, 6), g('brute', 4, 'B', 4, 8), g('gunner', 2, 'A', 3, 10), g('gunner', 2, 'B', 3, 11), g('flyer', 7, 'A', 1.2, 14), g('flyer', 7, 'B', 1.2, 16)] },
      { name: '全面进攻', tip: '幽影刺客会隐身，炮台锁定不到它；踩到减速器、受到攻击或靠近玩家时才会现形', groups: [g('stalker', 3, 'A', 2, 3), g('stalker', 3, 'B', 2, 4), g('runner', 10, 'A', 0.6, 0), g('runner', 10, 'B', 0.6, 0), g('bomber', 6, 'A', 1.6, 6), g('bomber', 6, 'B', 1.6, 7), g('brute', 3, 'A', 4, 12), g('brute', 3, 'B', 4, 14), g('flyer', 5, 'A', 1, 18), g('flyer', 5, 'B', 1, 20)] },
      { name: '双王', tip: '两只狂猩分别从两路出现；骇客工兵会骇入附近陷阱让它瘫痪，优先击杀', groups: [g('sapper', 2, 'A', 4, 4), g('sapper', 2, 'B', 4, 6), g('grunt', 12, 'A', 0.9, 0), g('grunt', 12, 'B', 0.9, 0), g('brute', 5, 'A', 3.5, 5), g('brute', 5, 'B', 3.5, 6), g('flyer', 8, 'A', 1, 12), g('flyer', 8, 'B', 1, 12), g('elite', 1, 'A', 0, 20), g('elite', 1, 'B', 0, 26)] },
      { name: '终焉降临', boss: true, tip: 'BOSS 会周期性释放 EMP 瘫痪附近陷阱，并召唤援军', groups: [g('grunt', 10, 'A', 1, 0), g('grunt', 10, 'B', 1, 0), g('flyer', 5, 'A', 1.2, 6), g('flyer', 5, 'B', 1.2, 6), g('boss', 1, 'A', 0, 12), g('brute', 3, 'B', 4, 16), g('runner', 8, 'A', 0.6, 30), g('runner', 8, 'B', 0.6, 30)] },
    ],
  },
  fortress: {
    id: 'fortress', order: 2, name: '三岔要塞', sub: '三门合围', w: 41, h: 34, gold: 1300, goldMul: 1.1, theme: 'fortress',
    desc: '西、北、东三道城门同时出怪，在中央十字口汇合。北门路线最绕，西门最直。',
    lanes: {
      A: [[3, 9], [9, 9], [9, 17], [20, 17]].concat(FT_M.slice(1)),
      B: [[20, 2], [20, 6], [14, 6], [14, 12], [20, 12], [20, 17]].concat(FT_M.slice(1)),
      C: [[37, 9], [32, 9], [32, 13], [26, 13], [26, 17], [20, 17]].concat(FT_M.slice(1)),
    },
    laneNames: { A: '西门', B: '北门', C: '东门' },
    rooms: [[2, 13, 6, 15, TILE.FLOOR], [7, 14, 7, 14, TILE.FLOOR]],
    base: [16, 28, 24, 32], doors: [],
    pads: [[18, 19], [22, 19], [17, 15], [23, 15], [11, 23], [15, 23], [17, 24], [22, 26], [7, 12], [11, 14], [16, 9], [12, 9], [29, 11], [24, 15], [34, 11], [11, 19], [27, 19], [16, 4], [18, 14]],
    spawns: [[17, 30], [23, 30], [17, 29], [23, 29]], focus: [20.5, 19], foci: [[20.5, 19.5]],
    devices: [{ type: 'gate', lever: [18, 19], area: [19, 19, 21, 20] }],
    platforms: [[15, 14], [23, 14], [22, 19], [16, 23]],
    labs: [{ holo: [4.5, 14.5], term: [4, 13, 3], sup: [2, 14, 2], racks: [[2, 15, 1], [3, 15, 1], [4, 15, 1], [5, 15, 1], [6, 15, 1]] }],
    waves: [
      { name: '三门叩关', groups: [g('grunt', 15, '*', 1.5, 0)] },
      { name: '疾行突袭', groups: [g('grunt', 15, '*', 1.3, 0), g('runner', 9, '*', 0.8, 12)] },
      { name: '重装来袭', tip: '重装赛博格护甲厚、免疫一半击退', groups: [g('grunt', 18, '*', 1.1, 0), g('brute', 3, '*', 4, 10)] },
      { name: '空中威胁', tip: '浮游无人机无视地面陷阱；火线射手会远程射击玩家', groups: [g('grunt', 15, '*', 1.1, 0), g('flyer', 12, '*', 1.4, 8), g('gunner', 3, '*', 3, 12)] },
      { name: '狂猩出笼', tip: '狂猩从北门出现', groups: [g('grunt', 18, '*', 1.1, 0), g('runner', 12, '*', 0.8, 10), g('elite', 1, 'B', 0, 18)] },
      { name: '自爆潮', tip: '骇客工兵会骇入附近陷阱让它瘫痪 10 秒，优先击杀', groups: [g('runner', 30, '*', 0.6, 0), g('bomber', 9, '*', 2, 8), g('sapper', 3, '*', 4, 10)] },
      { name: '维修部队', tip: '修复无人机会持续治疗周围怪物，优先击落', groups: [g('grunt', 18, '*', 1, 0), g('brute', 6, '*', 4, 6), g('healer', 3, '*', 3, 10)] },
      { name: '钢铁洪流', tip: '幽影刺客隐身潜入，减速器能让它现形', groups: [g('grunt', 21, '*', 0.9, 4), g('brute', 9, '*', 3.5, 0), g('flyer', 15, '*', 1.2, 10), g('stalker', 6, '*', 2, 12)] },
      { name: '混编突击', tip: '钻地虫会钻入地下越过一段陷阱，期间无敌', groups: [g('runner', 21, '*', 0.6, 0), g('bomber', 12, '*', 1.6, 6), g('healer', 6, '*', 2.5, 12), g('flyer', 9, '*', 1, 18), g('burrower', 3, '*', 3, 8)] },
      { name: '三王', tip: '三只狂猩分别从三道门出现', groups: [g('grunt', 24, '*', 0.9, 0), g('brute', 6, '*', 3.5, 6), g('elite', 3, '*', 6, 14), g('healer', 3, '*', 3, 16), g('gunner', 6, '*', 2.5, 10)] },
      { name: '决战前夜', groups: [g('brute', 12, '*', 3, 0), g('flyer', 18, '*', 1, 0), g('bomber', 12, '*', 1.4, 8), g('runner', 18, '*', 0.6, 20), g('sapper', 3, '*', 4, 12)] },
      { name: '破城', boss: true, tip: '攻城机甲「破城者」从北门压境，会炮击远处的炮台和磁暴塔；西门有狂猩策应', groups: [g('grunt', 24, '*', 1, 0), g('flyer', 12, '*', 1.2, 6), g('siege', 1, 'B', 0, 12), g('brute', 6, '*', 4, 16), g('healer', 2, '*', 3, 24), g('gunner', 3, '*', 3, 20), g('elite', 1, 'A', 0, 45)] },
    ],
  },
  furnace: {
    id: 'furnace', order: 3, name: '熔炉核心', sub: '四角夹击', w: 41, h: 41, gold: 1700, goldMul: 1.35, bossMul: 0.85, theme: 'furnace',
    desc: '水晶位于熔炉正中。四个角落各有一道出怪口，两两汇合后从南北两侧逼近；南侧两口会在中途开启。',
    lanes: {
      A: [[3, 3], [3, 11], [10, 11], [10, 5], [20, 5], [20, 9], [14, 9], [14, 13], [20, 13], [20, 20]],
      B: [[37, 3], [37, 11], [30, 11], [30, 5], [20, 5], [20, 9], [14, 9], [14, 13], [20, 13], [20, 20]],
      C: [[3, 37], [3, 29], [10, 29], [10, 35], [20, 35], [20, 31], [26, 31], [26, 27], [20, 27], [20, 20]],
      D: [[37, 37], [37, 29], [30, 29], [30, 35], [20, 35], [20, 31], [26, 31], [26, 27], [20, 27], [20, 20]],
    },
    laneFrom: { C: 4, D: 6 },
    laneNames: { A: '西北', B: '东北', C: '西南', D: '东南' },
    rooms: [[8, 17, 13, 23, TILE.FLOOR], [14, 20, 15, 20, TILE.FLOOR]],
    base: [16, 16, 24, 24], doors: [],
    pads: [[12, 11], [16, 11], [18, 11], [22, 7], [22, 9], [22, 13], [22, 15], [17, 15], [28, 29], [24, 29], [22, 29], [18, 33], [18, 31], [18, 27], [18, 25], [23, 25],
      [5, 7], [12, 8], [15, 7], [35, 7], [28, 8], [25, 7], [5, 33], [12, 32], [15, 33], [35, 33], [28, 32], [25, 33]],
    spawns: [[18, 18], [22, 22], [18, 22], [22, 18]], focus: [17, 11], foci: [[17.5, 11.5], [23.5, 29.5]],
    devices: [{ type: 'vent', lever: [22, 13], area: [13, 12, 21, 14], tag: '北' }, { type: 'vent', lever: [18, 27], area: [19, 26, 27, 28], tag: '南' }],
    platforms: [[22, 7], [22, 14], [17, 32], [17, 25]],
    labs: [{ holo: [11, 20.5], term: [8, 20, 2], sup: [10, 23, 1], racks: [[9, 17, 3], [10, 17, 3], [11, 17, 3], [12, 17, 3], [13, 17, 3]] }],
    waves: [
      { name: '北方来客', groups: [g('grunt', 14, '*', 1.4, 0)] },
      { name: '疾行突袭', groups: [g('grunt', 14, '*', 1.2, 0), g('runner', 8, '*', 0.8, 10)] },
      { name: '重装来袭', tip: '钻地虫会钻入地下越过一段陷阱，期间无敌且不受地面陷阱影响', groups: [g('grunt', 16, '*', 1.1, 0), g('brute', 3, '*', 4, 10), g('burrower', 4, '*', 3, 6)] },
      { name: '南门洞开', tip: '西南出怪口开启，南侧也需要布防', groups: [g('grunt', 16, '*', 1, 0), g('flyer', 9, '*', 1.4, 6)] },
      { name: '狂猩出笼', tip: '幽影刺客隐身，炮台锁定不到它；减速器、攻击或靠近都能让它现形', groups: [g('grunt', 18, '*', 1, 0), g('runner', 12, '*', 0.7, 10), g('stalker', 4, '*', 2, 6), g('elite', 1, 'A', 0, 18)] },
      { name: '四面楚歌', tip: '东南出怪口开启，四个方向同时进攻', groups: [g('runner', 28, '*', 0.6, 0), g('bomber', 8, '*', 2, 8)] },
      { name: '维修部队', tip: '骇客工兵会骇入附近陷阱让它瘫痪，优先击杀', groups: [g('grunt', 20, '*', 1, 4), g('brute', 6, '*', 4, 0), g('healer', 4, '*', 3, 8), g('sapper', 4, '*', 4, 10)] },
      { name: '钢铁洪流', groups: [g('grunt', 20, '*', 0.9, 0), g('flyer', 16, '*', 1.2, 0), g('brute', 6, '*', 3.5, 10)] },
      { name: '双王', groups: [g('bomber', 12, '*', 1.4, 0), g('runner', 20, '*', 0.6, 8), g('healer', 2, '*', 3, 12), g('elite', 2, 'AB', 12, 20), g('gunner', 6, '*', 2.5, 4), g('burrower', 6, '*', 3, 14)] },
      { name: '熔流', groups: [g('grunt', 24, '*', 0.8, 4), g('brute', 8, '*', 3, 0), g('flyer', 12, '*', 1, 0), g('healer', 4, '*', 2.5, 10), g('stalker', 6, '*', 2, 8)] },
      { name: '狂猩巢穴', tip: '四只狂猩从四个角落轮番冲出', groups: [g('runner', 24, '*', 0.5, 0), g('elite', 4, '*', 10, 10), g('bomber', 8, '*', 1.4, 14)] },
      { name: '熔炉巨像', boss: true, tip: '熔炉巨像从西北压境，走过的地面化作熔岩；东南有狂猩策应', groups: [g('grunt', 20, '*', 1, 0), g('flyer', 12, '*', 1.2, 6), g('colossus', 1, 'A', 0, 16), g('brute', 4, '*', 4, 14), g('healer', 2, '*', 3, 24), g('elite', 1, 'D', 0, 40)] },
    ],
  },
  abyss: {
    id: 'abyss', order: 4, name: '深渊回廊', sub: '五门逐开', w: 48, h: 31, gold: 1500, goldMul: 1.1, theme: 'abyss',
    desc: '五道出怪口随波次陆续开启：北、南两路汇入上下支线，西侧直道最后开启，全部在主干道汇合冲向东侧水晶。',
    lanes: {
      A: [[3, 3], [12, 3], [12, 7], [24, 7], [24, 15], [44, 15]],
      B: [[20, 2], [20, 7], [24, 7], [24, 15], [44, 15]],
      C: [[3, 27], [12, 27], [12, 23], [24, 23], [24, 15], [44, 15]],
      D: [[20, 28], [20, 23], [24, 23], [24, 15], [44, 15]],
      E: [[3, 15], [44, 15]],
    },
    laneFrom: { B: 3, D: 5, E: 8 },
    laneNames: { A: '西北', B: '北', C: '西南', D: '南', E: '西侧直道' },
    rooms: [[30, 6, 36, 9, TILE.FLOOR], [33, 10, 33, 13, TILE.FLOOR], [30, 21, 36, 24, TILE.FLOOR], [33, 17, 33, 20, TILE.FLOOR]],
    base: [39, 10, 46, 20], doors: [],
    pads: [[27, 13], [30, 13], [36, 13], [27, 17], [30, 17], [36, 17], [22, 11], [26, 11], [22, 19], [26, 19], [6, 5], [16, 5], [16, 9], [6, 25], [16, 21], [16, 25],
      [8, 13], [8, 17], [16, 13], [16, 17], [18, 5], [22, 5], [18, 25], [22, 25]],
    spawns: [[41, 12], [41, 18], [42, 11], [42, 19]], focus: [30.5, 15.5], foci: [[29.5, 15.5]],
    devices: [{ type: 'gravity', lever: [33, 11], area: [27, 14, 37, 16] }],
    platforms: [[21, 9], [21, 20], [28, 12], [28, 17], [34, 12], [34, 17]],
    labs: [
      { holo: [33.5, 8.3], term: [30, 7, 2], sup: [36, 7, 0], racks: [[31, 6, 3], [32, 6, 3], [33, 6, 3], [34, 6, 3], [35, 6, 3]] },
      { holo: [33.5, 22.7], term: [30, 23, 2], sup: [36, 23, 0], racks: [[31, 24, 1], [32, 24, 1], [33, 24, 1], [34, 24, 1], [35, 24, 1]] },
    ],
    waves: [
      { name: '深渊低语', groups: [g('grunt', 12, '*', 1.5, 0)] },
      { name: '疾行突袭', groups: [g('grunt', 14, '*', 1.2, 0), g('runner', 8, '*', 0.8, 10)] },
      { name: '北门开启', tip: '北侧出怪口开启；噬晶蛛又小又快', groups: [g('grunt', 18, '*', 1.1, 0), g('brute', 3, '*', 4, 10), g('mite', 12, '*', 0.4, 6)] },
      { name: '空中威胁', groups: [g('grunt', 15, '*', 1.1, 0), g('flyer', 12, '*', 1.4, 8)] },
      { name: '南门开启', tip: '南侧出怪口开启，狂猩从西北出现', groups: [g('grunt', 20, '*', 1, 0), g('runner', 16, '*', 0.7, 8), g('elite', 1, 'A', 0, 18)] },
      { name: '自爆潮', tip: '幽影刺客隐身，炮台锁定不到它；减速器、攻击或靠近都能让它现形', groups: [g('runner', 30, '*', 0.6, 0), g('bomber', 10, '*', 2, 8), g('stalker', 6, '*', 2, 4)] },
      { name: '维修部队', tip: '骇客工兵会骇入附近陷阱让它瘫痪，优先击杀', groups: [g('grunt', 20, '*', 1, 4), g('brute', 8, '*', 4, 0), g('healer', 4, '*', 3, 8), g('sapper', 4, '*', 4, 10)] },
      { name: '深渊之门', tip: '西侧直道开启！这条路最短，疾行猎犬会直扑主干道', groups: [g('runner', 30, '*', 0.5, 0), g('grunt', 20, '*', 1, 0), g('flyer', 10, '*', 1.2, 10)] },
      { name: '钢铁洪流', tip: '钻地虫会钻入地下越过一段陷阱', groups: [g('brute', 10, '*', 3.5, 0), g('flyer', 20, '*', 1, 6), g('bomber', 10, '*', 1.5, 12), g('burrower', 6, '*', 2.5, 4)] },
      { name: '双王', groups: [g('grunt', 30, '*', 0.8, 0), g('healer', 5, '*', 2.5, 10), g('elite', 2, 'AC', 0, 18), g('gunner', 6, '*', 2.5, 6)] },
      { name: '自爆狂潮', groups: [g('bomber', 20, '*', 1.2, 0), g('runner', 30, '*', 0.5, 6), g('brute', 10, '*', 3, 14)] },
      { name: '遮天蔽日', groups: [g('grunt', 30, '*', 0.8, 4), g('flyer', 30, '*', 0.9, 0), g('healer', 5, '*', 2.5, 6), g('mite', 20, '*', 0.3, 10)] },
      { name: '狂猩巢穴', groups: [g('brute', 15, '*', 3, 0), g('elite', 3, '*', 6, 10), g('bomber', 10, '*', 1.4, 16), g('sapper', 4, '*', 4, 6), g('stalker', 6, '*', 2, 12)] },
      { name: '决战前夜', groups: [g('runner', 40, '*', 0.4, 0), g('flyer', 20, '*', 1, 8), g('brute', 10, '*', 3, 14), g('healer', 5, '*', 2, 18), g('burrower', 6, '*', 2.5, 4), g('gunner', 6, '*', 2.5, 10)] },
      { name: '深渊母巢', boss: true, tip: '深渊母巢从西北压境，不断孵化噬晶蛛，击破后分裂成两只母巢裂体；西南有狂猩策应', groups: [g('grunt', 30, '*', 0.9, 0), g('flyer', 15, '*', 1.1, 6), g('brood', 1, 'A', 0, 10), g('brute', 8, '*', 3.5, 16), g('healer', 3, '*', 3, 20), g('elite', 1, 'C', 0, 50)] },
    ],
  },
};
const MAP_LIST = Object.values(MAPS).sort((a, b) => a.order - b.order);

/* 无尽模式：剧本波次结束后按波数生成（只依赖波数，预告与实际一致） */
function genWave(n, lanes) {
  const k = n;
  const gr = [g('grunt', 14 + k * 2, '*', 0.8, 0)];
  if (k % 2 === 0) gr.push(g('runner', 10 + k * 2, '*', 0.5, 6));
  if (k % 3 !== 1) gr.push(g('flyer', 6 + k, '*', 1, 10));
  gr.push(g('brute', 2 + Math.floor(k / 2), '*', 3, 4));
  if (k % 3 === 0) gr.push(g('bomber', 6 + k, '*', 1.2, 12));
  if (k >= 6) gr.push(g('healer', 2 + Math.floor(k / 4), '*', 2.5, 14));
  if (k % 4 === 0) gr.push(g('elite', 1 + Math.floor(k / 8), '*', 6, 18));
  if (k % 4 === 1) gr.push(g('stalker', 4 + k, '*', 1.6, 6));
  if (k % 4 === 2) gr.push(g('burrower', 3 + Math.floor(k / 2), '*', 2.5, 8));
  if (k % 4 === 3) gr.push(g('gunner', 3 + Math.floor(k / 2), '*', 2.5, 6));
  if (k >= 8 && k % 2) gr.push(g('sapper', 2 + Math.floor(k / 5), '*', 4, 10));
  if (k % 3 === 2) gr.push(g('mite', 10 + k * 2, '*', 0.3, 2));
  const boss = k % 5 === 0;
  const BT = ['boss', 'siege', 'colossus', 'brood'];
  if (boss) gr.push(g(BT[Math.floor(k / 5) % 4], 1 + Math.floor(k / 15), '*', 25, 12));
  return { name: boss ? `无尽 · 泰坦 ${k}` : `无尽 · 第 ${k} 波`, boss, groups: gr, endless: true };
}

/* ---------- 工具 ---------- */
function buildMap(def) {
  const W = def.w, H = def.h;
  const grid = new Uint8Array(W * H);
  const inb = (x, z) => x > 0 && z > 0 && x < W - 1 && z < H - 1;
  const rect = (x0, z0, x1, z1, t, onlyWall) => {
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
        if (inb(x, z) && (!onlyWall || grid[z * W + x] === TILE.WALL)) grid[z * W + x] = t;
  };
  for (const r of def.rooms) rect(r[0], r[1], r[2], r[3], r[4]);
  for (const lane in def.lanes) {
    const pts = def.lanes[lane];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      rect(Math.min(a[0], b[0]) - 1, Math.min(a[1], b[1]) - 1, Math.max(a[0], b[0]) + 1, Math.max(a[1], b[1]) + 1, TILE.LANE);
    }
  }
  // 出怪口房间：沿第一段方向 3 格深、5 格宽
  for (const lane in def.lanes) {
    const [a, b] = def.lanes[lane];
    const dx = Math.sign(b[0] - a[0]), dz = Math.sign(b[1] - a[1]);
    if (dx) rect(a[0] - 1, a[1] - 2, a[0] + 1, a[1] + 2, TILE.SPAWN); else rect(a[0] - 2, a[1] - 1, a[0] + 2, a[1] + 1, TILE.SPAWN);
    void dz;
  }
  const B = def.base; rect(B[0], B[1], B[2], B[3], TILE.BASE);
  for (const d of def.doors) rect(d[0], d[1], d[2], d[3], TILE.FLOOR);
  def.pads.forEach(([x, z]) => rect(x, z, x, z, TILE.PAD, true));
  // 2×2 炮台平台：四周一圈墙体打通成空地，保证射击视野
  for (const [x, z] of def.platforms || []) {
    rect(x - 1, z - 1, x + 2, z + 2, TILE.FLOOR, true);
    for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
      const i = (z + dz) * W + x + dx, t = grid[i];
      if (inb(x + dx, z + dz) && (t === TILE.WALL || t === TILE.FLOOR || t === TILE.PAD)) grid[i] = TILE.PAD;
    }
  }
  return grid;
}

function makePath(tilePts) {
  const pts = tilePts.map(([x, z]) => ({ x: (x + 0.5) * T, z: (z + 0.5) * T }));
  const segs = []; let L = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) continue;
    segs.push({ ax: a.x, az: a.z, dx: (b.x - a.x) / len, dz: (b.z - a.z) / len, len, start: L });
    L += len;
  }
  return { pts, segs, len: L };
}
function pathAt(p, d, out) {
  if (d < 0) d = 0; if (d > p.len) d = p.len;
  let s = p.segs[p.segs.length - 1];
  for (let i = 0; i < p.segs.length; i++) { if (d <= p.segs[i].start + p.segs[i].len) { s = p.segs[i]; break; } }
  const u = d - s.start;
  out.x = s.ax + s.dx * u; out.z = s.az + s.dz * u; out.dx = s.dx; out.dz = s.dz;
  return out;
}
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tc = lx * dx + ly * dy + lz * dz;
  if (tc < 0) return -1;
  const d2 = lx * lx + ly * ly + lz * lz - tc * tc;
  if (d2 > r * r) return -1;
  return tc - Math.sqrt(r * r - d2);
}
const lvv = (v, lv) => Array.isArray(v) ? v[lv - 1] : v;

/* ============================================================ */
class Sim {
  constructor(opts) {
    opts = opts || {};
    const mapId = (opts.state && opts.state.map) || opts.map || 'station';
    this.def = MAPS[mapId] || MAPS.station;
    this.W = this.def.w; this.H = this.def.h;
    this.grid = buildMap(this.def);
    this.plat = new Set();
    for (const [x, z] of this.def.platforms || []) for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) this.plat.add((z + dz) * this.W + x + dx);
    this.lanes = Object.keys(this.def.lanes);
    this.paths = {}; this.spawnDir = {};
    for (const l of this.lanes) {
      this.paths[l] = makePath(this.def.lanes[l]);
      const sg = this.paths[l].segs[0]; this.spawnDir[l] = { dx: sg.dx, dz: sg.dz };
    }
    const pA = this.paths[this.lanes[0]].pts;
    this.crystalPos = { x: pA[pA.length - 1].x, y: 0, z: pA[pA.length - 1].z };
    this.spawnPos = {}; for (const l of this.lanes) this.spawnPos[l] = this.paths[l].pts[0];
    this.waves = this.def.waves;
    this.events = [];
    this._tmp = { x: 0, z: 0, dx: 0, dz: 0 };
    this._tmp2 = { x: 0, z: 0, dx: 0, dz: 0 };
    this._bk = new Map();
    this._mById = new Map();
    this.s = opts.state ? opts.state : this._newState(opts.difficulty || 'normal', opts.seed || 1234567, this.def.id, !!opts.endless, opts.mut, opts.tal, opts.daily);
    this._rebuildOcc();
  }

  _newState(diff, seed, map, endless, mut, tal, daily) {
    const T0 = tal || {}, cmax = 100 + 10 * tl(T0, 'crystal');
    return {
      tick: 0, time: 0, phase: 'build', timer: 45 + 15 * tl(T0, 'prep'), wave: 0, diff, map, endless,
      mut: (mut || []).filter(id => MUT[id]), tal: { startGold: tl(T0, 'startGold'), engineer: tl(T0, 'engineer'), crystal: tl(T0, 'crystal'), prep: tl(T0, 'prep') }, daily: daily || null,
      gold: this.def.gold + 80 * tl(T0, 'startGold'), crystal: { hp: cmax, max: cmax },
      players: {}, monsters: [], traps: [], proj: [], spawnQ: [], strikes: [], shells: [], lava: {},
      devices: (this.def.devices || []).map(() => ({ cd: 0, act: 0 })),
      tech: Object.fromEntries(TECH.map(t => [t.id, 0])),
      nextId: 1, rng: seed >>> 0, bossId: 0,
      stats: { kills: 0, leaks: 0, dmgGun: 0, dmgTrap: 0, built: 0, spent: 0, startTime: 0 },
    };
  }
  serialize() { return JSON.stringify(this.s); }

  hasMut(id) { return this.s.mut && this.s.mut.includes(id); }
  techLv(id) { return (this.s.tech && this.s.tech[id]) | 0; }
  techCost(id) { const t = TECH_BY[id], lv = this.techLv(id); return t && lv < TECH_MAX ? t.cost[lv] : Infinity; }
  // 瘫痪时间系数（纳米维修）
  disMul() { return 1 - 0.2 * this.techLv('repair'); }
  // 科研舱物件的世界坐标：贴着 dir 方向的墙摆放，朝向房间内
  labObj(o) {
    const d = DIRS[o[2] & 3];
    return { x: (o[0] + 0.5 + d[0] * 0.28) * T, z: (o[1] + 0.5 + d[1] * 0.28) * T, dx: -d[0], dz: -d[1], yaw: Math.atan2(-d[0], -d[1]) };
  }
  // 玩家附近的科研终端 / 补给柜（返回科研舱下标，-1 表示不在附近）
  nearLab(p, key, reach) {
    const labs = this.def.labs || [];
    let best = -1, bd = reach || LAB_REACH;
    labs.forEach((lb, i) => { const w = this.labObj(lb[key]), d = Math.hypot(p.x - w.x, p.z - w.z); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  trapCost(type, pid) {
    const p = pid && this.s.players[pid];
    return Math.round(TRAP[type].cost * (this.hasMut('austerity') ? 1.25 : 1) * (1 - 0.03 * ((this.s.tal && this.s.tal.engineer) || 0)) * (p && p.cls === 'engineer' ? 0.9 : 1));
  }
  mutScore() { return 1 + (this.s.mut || []).reduce((a, id) => a + (MUT[id] ? MUT[id].w : 0), 0); }

  /* ---------- 地图 / 波次查询 ---------- */
  laneFrom(l) { return (this.def.laneFrom && this.def.laneFrom[l]) || 1; }
  laneActive(l, wave) { return this.laneFrom(l) <= Math.max(1, wave); }
  activeLanes(wave) { return this.lanes.filter(l => this.laneActive(l, wave)); }
  totalWaves() { return this.s.endless ? Infinity : this.waves.length; }
  waveDef(w) {
    w = Math.max(1, w | 0);
    if (w <= this.waves.length || !this.s.endless) return this.waves[Math.min(w, this.waves.length) - 1];
    const d = genWave(w - this.waves.length + 6, this.lanes), k = w - this.waves.length;
    d.name = d.boss ? `无尽第 ${k} 轮 · 泰坦来袭` : `无尽第 ${k} 轮`;
    return d;
  }
  // 把一波展开成「时间 + 类型 + 出怪口」列表
  expandWave(w) {
    const W = this.waveDef(w), act = this.activeLanes(w), q = [];
    const horde = this.hasMut('horde') ? 1.3 : 1, skies = this.hasMut('skies') ? 2 : 1;
    for (const gr of W.groups) {
      let ls = gr.lane === '*' ? act : gr.lane.split('').filter(l => act.includes(l));
      if (!ls.length) ls = act;
      const md = MON[gr.t], n = md.boss || md.elite ? gr.n : Math.round(gr.n * horde * (md.fly ? skies : 1));
      const gap = n > gr.n ? gr.gap * gr.n / n : gr.gap;
      for (let i = 0; i < n; i++) q.push({ type: gr.t, lane: ls[i % ls.length], time: gr.at + Math.floor(i / ls.length) * gap });
    }
    return q.sort((a, b) => a.time - b.time);
  }
  previewWave(w) {
    const agg = {};
    for (const q of this.expandWave(w)) { const a = agg[q.type] || (agg[q.type] = { n: 0, lanes: [] }); a.n++; if (!a.lanes.includes(q.lane)) a.lanes.push(q.lane); }
    const opened = this.lanes.filter(l => this.laneFrom(l) === w && w > 1);
    return { def: this.waveDef(w), agg, opened };
  }

  rand() {
    let t = (this.s.rng = (this.s.rng + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  ev(type, data) { const e = data || {}; e.type = type; this.events.push(e); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  /* ---------- 地图查询 ---------- */
  tileAt(x, z) { if (x < 0 || z < 0 || x >= this.W || z >= this.H) return TILE.WALL; return this.grid[z * this.W + x]; }
  solid(x, z) { return this.tileAt(x, z) === TILE.WALL; }
  idxOf(wx, wz) { return Math.floor(wz / T) * this.W + Math.floor(wx / T); }

  // 网格 DDA 射线：返回第一个命中的 地面 / 天花板 / 墙面
  raycast(ox, oy, oz, dx, dy, dz, maxD) {
    let tx = Math.floor(ox / T), tz = Math.floor(oz / T);
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const ax = Math.abs(dx) < 1e-9, az = Math.abs(dz) < 1e-9;
    let tMaxX = ax ? Infinity : ((tx + (dx > 0 ? 1 : 0)) * T - ox) / dx;
    let tMaxZ = az ? Infinity : ((tz + (dz > 0 ? 1 : 0)) * T - oz) / dz;
    const tdX = ax ? Infinity : T / Math.abs(dx), tdZ = az ? Infinity : T / Math.abs(dz);
    const tFloor = dy < -1e-9 ? -oy / dy : Infinity;
    const tCeil = dy > 1e-9 ? (WALL_H - oy) / dy : Infinity;
    const tPlane = Math.min(tFloor, tCeil);
    for (let i = 0; i < 300; i++) {
      const tExit = Math.min(tMaxX, tMaxZ);
      if (tPlane <= tExit) {
        if (tPlane > maxD) return null;
        return { kind: tPlane === tFloor ? 'floor' : 'ceil', x: tx, z: tz, t: tPlane, px: ox + dx * tPlane, py: oy + dy * tPlane, pz: oz + dz * tPlane };
      }
      if (tExit > maxD) return null;
      let dir;
      if (tMaxX < tMaxZ) { tx += sx; tMaxX += tdX; dir = sx > 0 ? 0 : 2; }
      else { tz += sz; tMaxZ += tdZ; dir = sz > 0 ? 1 : 3; }
      if (this.solid(tx, tz)) {
        return { kind: 'wall', x: tx - DIRS[dir][0], z: tz - DIRS[dir][1], dir, t: tExit, px: ox + dx * tExit, py: oy + dy * tExit, pz: oz + dz * tExit };
      }
    }
    return null;
  }

  /* ---------- 地图机关 ---------- */
  deviceWorld(dv) { return { x: (dv.lever[0] + 0.5) * T, z: (dv.lever[1] + 0.5) * T }; }
  inArea(a, tx, tz) { return tx >= a[0] && tx <= a[2] && tz >= a[1] && tz <= a[3]; }
  _updateDevices(dt) {
    const s = this.s, defs = this.def.devices || [];
    defs.forEach((dv, i) => {
      const st = s.devices[i];
      if (st.cd > 0) st.cd = Math.max(0, st.cd - dt);
      if (st.act <= 0) return;
      st.act = Math.max(0, st.act - dt);
      st.tick = (st.tick || 0) - dt;
      const pulse = st.tick <= 0;
      if (pulse) st.tick = 0.25;
      for (const m of s.monsters) {
        if (m.dead || m.burrow) continue;
        const tx = Math.floor(m.x / T), tz = Math.floor(m.z / T);
        if (!this.inArea(dv.area, tx, tz)) continue;
        const md = MON[m.type];
        if (dv.type === 'cryo' && !md.fly) {
          m.slowAmt = Math.max(m.slowAmt, 0.7); m.slowT = Math.max(m.slowT, 0.5);
          if (!md.boss) { m.stunT = Math.max(m.stunT, 0.15); m.frozenT = 0.3; }
        } else if (dv.type === 'vent' && !md.fly && pulse) {
          this.damage(m, 45, 'trap');
          if (!md.burnImmune) { m.burnDps = Math.max(m.burnT > 0 ? m.burnDps : 0, 30); m.burnT = 3; }
        } else if (dv.type === 'gravity') {
          if (md.fly) m.pullT = 0.3;
          m.slowAmt = Math.max(m.slowAmt, 0.5); m.slowT = Math.max(m.slowT, 0.4);
        }
      }
    });
  }

  /* ---------- 陷阱位 ---------- */
  slotFromHit(cat, hit) {
    if (!hit) return null;
    const tt = this.tileAt(hit.x, hit.z);
    if (cat === 'floor') return hit.kind === 'floor' && tt === TILE.LANE ? { kind: 'floor', x: hit.x, z: hit.z } : null;
    if (cat === 'pad') return hit.kind === 'floor' && (tt === TILE.PAD || tt === TILE.FLOOR || tt === TILE.LANE) ? { kind: 'floor', x: hit.x, z: hit.z } : null;
    if (cat === 'wall') return hit.kind === 'wall' && tt === TILE.LANE ? { kind: 'wall', x: hit.x, z: hit.z, dir: hit.dir } : null;
    if (cat === 'ceil') return hit.kind === 'ceil' && tt === TILE.LANE ? { kind: 'ceil', x: hit.x, z: hit.z } : null;
    return null;
  }
  slotKey(slot) {
    const i = slot.z * this.W + slot.x;
    return slot.kind === 'wall' ? 'w' + (i * 4 + slot.dir) : (slot.kind === 'ceil' ? 'c' + i : 'f' + i);
  }
  trapAtSlot(slot) { return this.occ.get(this.slotKey(slot)) || null; }
  _rebuildOcc() {
    this.occ = new Map();
    for (const tr of this.s.traps) this.occ.set(this.slotKey(tr), tr);
  }
  trapWorld(tr) {
    const cx = (tr.x + 0.5) * T, cz = (tr.z + 0.5) * T;
    if (tr.kind === 'wall') { const d = DIRS[tr.dir]; return { x: cx + d[0] * T * 0.5, y: 1.5, z: cz + d[1] * T * 0.5 }; }
    if (tr.kind === 'ceil') return { x: cx, y: WALL_H, z: cz };
    return { x: cx, y: this.plat.has(tr.z * this.W + tr.x) ? PLAT_H : 0, z: cz };
  }
  // 某处地面高度（炮台平台略高于地面）
  groundAt(x, z) {
    const tx = Math.floor(x / T), tz = Math.floor(z / T);
    return tx >= 0 && tz >= 0 && tx < this.W && tz < this.H && this.plat.has(tz * this.W + tx) ? PLAT_H : 0;
  }
  wallLine(x, z, dir, n) {
    const d = DIRS[dir], out = [];
    for (let k = 0; k < (n || 4); k++) {
      const tx = x - d[0] * k, tz = z - d[1] * k;
      if (this.solid(tx, tz)) break;
      out.push(tz * this.W + tx);
    }
    return out;
  }
  // 所有可放置某类陷阱的位置（给 AI / 预览高亮）
  listSlots(cat) {
    const out = [];
    for (let z = 0; z < this.H; z++) for (let x = 0; x < this.W; x++) {
      const t = this.tileAt(x, z);
      if (cat === 'floor' || cat === 'ceil') { if (t === TILE.LANE) out.push({ kind: cat, x, z }); }
      else if (cat === 'pad') { if (t === TILE.PAD || t === TILE.FLOOR) out.push({ kind: 'floor', x, z }); }
      else if (cat === 'wall' && t === TILE.LANE) {
        for (let d = 0; d < 4; d++) if (this.solid(x + DIRS[d][0], z + DIRS[d][1])) out.push({ kind: 'wall', x, z, dir: d });
      }
    }
    return out;
  }

  laneTurret(type, slot) { return TRAP[type].cat === 'pad' && slot.kind === 'floor' && this.tileAt(slot.x, slot.z) === TILE.LANE; }
  isBlocker(tr) { return TRAP[tr.type].block || !!tr.lane; }
  upgradeCost(tr, pid) { return tr.lv >= MAX_LV ? 0 : Math.round(this.trapCost(tr.type, pid) * UPG_MUL[tr.lv - 1]); }
  refundOf(tr, pid) { const p = pid && this.s.players[pid]; return Math.round(tr.invested * (this.s.phase === 'build' ? 1 : p && p.cls === 'engineer' ? 0.9 : 0.8)); }

  canBuild(pid, type, slot) {
    const def = TRAP[type], s = this.s;
    if (!def) return { ok: false, reason: '未知陷阱' };
    if (s.phase !== 'build' && s.phase !== 'wave') return { ok: false, reason: '' };
    if (!slot) {
      return { ok: false, reason: '对准' + CAT_NAME[def.cat] + (def.cat === 'pad' ? '（琥珀色炮台平台 / 空地；放在通道上会挡路并被攻击）' : '（怪物通道）') };
    }
    if (this.trapAtSlot(slot)) return { ok: false, reason: '该位置已有陷阱' };
    if (slot.kind === 'floor' && (this.def.devices || []).some(dv => dv.lever[0] === slot.x && dv.lever[1] === slot.z)) return { ok: false, reason: '这里是机关控制台' };
    const p = s.players[pid];
    if (p) {
      const w = this.trapWorld(slot);
      if (Math.hypot(w.x - p.x, w.z - p.z) > 20) return { ok: false, reason: '距离太远' };
    }
    if (def.block || this.laneTurret(type, slot)) {
      // 阻挡类不能压在玩家脚下
      for (const id in s.players) {
        const q = s.players[id];
        if (!q.dead && Math.floor(q.x / T) === slot.x && Math.floor(q.z / T) === slot.z) return { ok: false, reason: '不能放在玩家脚下' };
      }
    }
    const cost = this.trapCost(type, pid);
    if (s.gold < cost) return { ok: false, reason: '金币不足', cost };
    return { ok: true, cost };
  }

  /* ---------- 玩家 ---------- */
  addPlayer(pid, name, remote, tal, cls) {
    const s = this.s;
    if (s.players[pid]) return s.players[pid];
    const used = Object.values(s.players).map(q => q.slot);
    if (used.length >= 4) return null;
    let n = 0; while (used.includes(n)) n++;
    const SP = this.def.spawns, sp = SP[n % SP.length];
    const p = {
      id: pid, name: name || ('玩家' + (n + 1)), slot: n, remote: !!remote, life: 0, ready: false,
      x: (sp[0] + 0.5) * T, y: 0, z: (sp[1] + 0.5) * T, vx: 0, vy: 0, vz: 0, ox: 0, oy: 0, oz: 0,
      yaw: 0, pitch: 0, hp: 100, maxHp: 100, dead: false, respawnT: 0, ground: true,
      ammo: 30, mag: 30, reloadT: 0, fireCd: 0, bloom: 0, lastHurt: -99, kills: 0, dmg: 0,
      wpn: 'rifle', guns: ['rifle'], ammoBy: { rifle: 30 }, nades: SKILL.nade.max, nadeT: 0, energy: 0, supT: 0,
      input: { mx: 0, mz: 0, jump: false, sprint: false, fire: false, reload: false, ads: false, yaw: 0, pitch: 0 },
    };
    p.hp = 0;
    p.ox = p.x; p.oy = p.y; p.oz = p.z;
    p.cls = CLS[cls] ? cls : 'assault';
    this.setTalents(p, tal);
    s.players[pid] = p;
    this.ev('pjoin', { pid, name: p.name });
    return p;
  }
  setTalents(p, tal) {
    const T0 = tal || {};
    p.tal = { gunDmg: tl(T0, 'gunDmg'), vitality: tl(T0, 'vitality'), energy: tl(T0, 'energy'), grenade: tl(T0, 'grenade') };
    p.maxHp = Math.round((100 + 20 * p.tal.vitality) * (this.hasMut('glass') ? 0.5 : 1)); p.hp = Math.min(p.hp, p.maxHp);
    if (!p.dead && p.hp <= 0) p.hp = p.maxHp;
    p.nadeMax = SKILL.nade.max + p.tal.grenade + (p.cls === 'assault' ? 1 : 0);
  }
  gunMul(p) { return (1 + 0.08 * ((p.tal && p.tal.gunDmg) || 0)) * (1 + 0.12 * this.techLv('ammo')) *(this.hasMut('glass') ? 2 : 1) * (p.cls === 'assault' ? 1.2 : 1) * (p.cls === 'scout' && p.wpn === 'sniper' ? 1.25 : 1); }
  setClass(p, cls) { if (!CLS[cls] || p.cls === cls) return; p.cls = cls; this.setTalents(p, p.tal); }
  removePlayer(pid) {
    const p = this.s.players[pid];
    if (!p) return;
    delete this.s.players[pid];
    this.ev('pleave', { pid, name: p.name });
    this._checkReady();
  }
  _respawn(p) {
    const SP = this.def.spawns, sp = SP[p.slot % SP.length];
    p.x = p.ox = (sp[0] + 0.5) * T; p.z = p.oz = (sp[1] + 0.5) * T; p.y = p.oy = 0;
    p.vx = p.vy = p.vz = 0; p.hp = p.maxHp; p.dead = false; p.ammo = p.mag; p.reloadT = 0; p.life++;
    for (const g of p.guns) p.ammoBy[g] = WPN[g].mag;
    this.ev('respawn', { pid: p.id });
  }
  hurtPlayer(p, dmg, src, sx, sz) {
    if (p.dead || this.s.phase === 'victory' || this.s.phase === 'defeat') return;
    p.hp -= dmg; p.lastHurt = this.s.time;
    this.ev('phurt', { pid: p.id, dmg, src, sx, sz });
    if (p.hp <= 0) { p.hp = 0; p.dead = true; p.respawnT = 5; this.ev('pdead', { pid: p.id }); }
  }

  /* ---------- 命令入口 ---------- */
  apply(cmd) {
    const s = this.s, p = s.players[cmd.pid];
    switch (cmd.t) {
      case 'input': if (p) Object.assign(p.input, cmd); return { ok: true };
      // 远程玩家：位置由其客户端预测后上报（合作模式信任客户端）
      case 'pos': {
        if (!p || p.dead || cmd.life !== p.life) return { ok: false };
        p.x = cmd.x; p.y = Math.max(0, cmd.y); p.z = cmd.z; p.yaw = cmd.yaw; p.pitch = cmd.pitch;
        p.input.fire = !!cmd.fire; p.input.yaw = cmd.yaw; p.input.pitch = cmd.pitch;
        if (cmd.wpn && p.guns.includes(cmd.wpn)) p.wpn = cmd.wpn;
        return { ok: true };
      }
      case 'use': {
        const dv = this.def.devices && this.def.devices[cmd.dev], st = s.devices[cmd.dev];
        if (!p || p.dead || !dv || !st) return { ok: false };
        const w = this.deviceWorld(dv);
        if (Math.hypot(p.x - w.x, p.z - w.z) > 3.4) return { ok: false, reason: '离控制台太远' };
        if (st.act > 0) return { ok: false, reason: '机关运行中' };
        if (st.cd > 0) return { ok: false, reason: `机关冷却中 ${Math.ceil(st.cd)} 秒` };
        const D = DEVICE[dv.type];
        st.act = D.dur; st.cd = D.cd + D.dur;
        this.ev('devUse', { i: cmd.dev, pid: p.id });
        return { ok: true };
      }
      // 科研终端：花全队金币研究科技
      case 'research': {
        const t = TECH_BY[cmd.tech];
        if (!p || p.dead || !t) return { ok: false };
        if (s.phase !== 'build' && s.phase !== 'wave') return { ok: false };
        if (this.nearLab(p, 'term', LAB_REACH + 0.8) < 0) return { ok: false, reason: '离科研终端太远' };
        const lv = this.techLv(t.id);
        if (lv >= TECH_MAX) return { ok: false, reason: `${t.name} 已研究到满级` };
        const cost = t.cost[lv];
        if (s.gold < cost) return { ok: false, reason: `金币不足，需要 ${cost}` };
        s.gold -= cost; s.stats.spent += cost;
        if (!s.tech) s.tech = {};
        s.tech[t.id] = lv + 1;
        if (t.id === 'armor') { s.crystal.max += 15; s.crystal.hp = Math.min(s.crystal.max, s.crystal.hp + 15); }
        this.ev('research', { pid: p.id, tech: t.id, lv: lv + 1 });
        return { ok: true, lv: lv + 1 };
      }
      // 补给柜：补满生命、手雷与全部弹匣，额外充能 25%
      case 'resupply': {
        if (!p || p.dead) return { ok: false };
        if (this.nearLab(p, 'sup', LAB_REACH + 0.8) < 0) return { ok: false, reason: '离补给柜太远' };
        if (p.supT > 0) return { ok: false, reason: `补给柜冷却中 ${Math.ceil(p.supT)} 秒` };
        p.supT = SUPPLY_CD;
        p.hp = p.maxHp; p.nades = p.nadeMax || SKILL.nade.max; p.nadeT = 0;
        p.energy = Math.min(100, p.energy + 25);
        for (const g of p.guns) p.ammoBy[g] = WPN[g].mag;
        p.ammo = p.mag; p.reloadT = 0;
        this.ev('resupply', { pid: p.id });
        return { ok: true };
      }
      case 'wpn': {
        if (!p || !p.guns.includes(cmd.w)) return { ok: false };
        this.switchWeapon(p, cmd.w);
        return { ok: true };
      }
      case 'buy': {
        const W = WPN[cmd.w];
        if (!p || !W) return { ok: false, reason: '未知武器' };
        if (p.guns.includes(cmd.w)) { this.switchWeapon(p, cmd.w); return { ok: true, owned: true }; }
        if (s.phase !== 'build' && s.phase !== 'wave') return { ok: false };
        if (s.gold < W.cost) return { ok: false, reason: '金币不足' };
        s.gold -= W.cost; s.stats.spent += W.cost;
        p.guns.push(cmd.w); p.ammoBy[cmd.w] = W.mag;
        this.switchWeapon(p, cmd.w);
        this.ev('buy', { pid: p.id, w: cmd.w });
        return { ok: true };
      }
      // 火箭弹：本机由 weapon() 触发；队友上报发射方向，由主机生成弹体
      case 'rocket': {
        if (!p || p.dead || !p.guns.includes('rocket') || !Array.isArray(cmd.o) || !Array.isArray(cmd.d)) return { ok: false };
        if (s.time - (p.rocketT || -9) < 1 / WPN.rocket.rps * 0.7) return { ok: false };
        p.rocketT = s.time;
        this._launchRocket(p, cmd.o, cmd.d);
        return { ok: true };
      }
      case 'nade': {
        if (!p || p.dead || p.nades < 1) return { ok: false, reason: '手雷充能中' };
        const o = Array.isArray(cmd.o) ? cmd.o : [p.x, p.y + 1.5, p.z], d = Array.isArray(cmd.d) ? cmd.d : [-Math.sin(p.yaw), 0, -Math.cos(p.yaw)];
        if (p.nades >= (p.nadeMax || SKILL.nade.max)) p.nadeT = SKILL.nade.recharge;
        p.nades--;
        const L = Math.hypot(d[0], d[1], d[2]) || 1;
        s.proj.push({ id: s.nextId++, kind: 'nade', owner: p.id, x: +o[0], y: +o[1], z: +o[2], vx: d[0] / L * 15, vy: d[1] / L * 15 + 3.5, vz: d[2] / L * 15, life: SKILL.nade.fuse });
        this.ev('throw', { pid: p.id });
        return { ok: true };
      }
      case 'ult': {
        if (!p || p.dead || p.energy < 100) return { ok: false, reason: '能量不足' };
        const x = +cmd.x, z = +cmd.z;
        if (!Number.isFinite(x) || !Number.isFinite(z)) return { ok: false };
        p.energy = 0;
        s.strikes.push({ x, z, t: SKILL.ult.delay, owner: p.id });
        this.ev('strikeCall', { pid: p.id, x, z, delay: SKILL.ult.delay });
        return { ok: true };
      }
      // 远程玩家的命中结算：客户端按自己看到的画面判定命中，主机只结算伤害
      case 'dmg': {
        if (!p || !Array.isArray(cmd.h)) return { ok: false };
        let n = 0;
        const cap = (WPN[p.wpn] || WPN.rifle).maxHit * this.gunMul(p);
        for (const h of cmd.h.slice(0, 40)) {
          const m = this._mById.get(h[0]) || s.monsters.find(q => q.id === h[0]);
          if (!m || m.dead) continue;
          const shots = Math.max(1, Math.min(12, h[2] | 0));
          this.damage(m, Math.max(0, Math.min(+h[1] || 0, shots * cap)), 'gun', cmd.pid);
          n++;
        }
        return { ok: true, n };
      }
      case 'build': {
        const r = this.canBuild(cmd.pid, cmd.trap, cmd.slot);
        if (!r.ok) return r;
        const def = TRAP[cmd.trap], sl = cmd.slot;
        const tr = {
          id: s.nextId++, type: cmd.trap, kind: sl.kind, x: sl.x, z: sl.z, dir: sl.dir || 0, lv: 1, owner: cmd.pid,
          invested: r.cost, cd: 0.4, activeT: 0, fireT: -9, disT: 0, hurtT: 0, tgt: 0, scanT: 0, aimYaw: 0, targets: [], br: '',
          idx: sl.z * this.W + sl.x,
        };
        if (def.block) { tr.hp = tr.maxHp = def.hp[0]; }
        if (this.laneTurret(cmd.trap, sl)) { tr.lane = true; tr.hp = tr.maxHp = LANE_HP[cmd.trap][0]; }
        if (sl.kind === 'wall') tr.line = this.wallLine(sl.x, sl.z, sl.dir);
        const w = this.trapWorld(tr); tr.wx = w.x; tr.wy = w.y; tr.wz = w.z;
        s.traps.push(tr); this.occ.set(this.slotKey(tr), tr);
        s.gold -= r.cost; s.stats.built++; s.stats.spent += r.cost;
        this.ev('build', { id: tr.id, trap: tr.type, pid: cmd.pid, x: tr.wx, y: tr.wy, z: tr.wz });
        return { ok: true, id: tr.id };
      }
      case 'upgrade': {
        const tr = s.traps.find(t => t.id === cmd.id);
        if (!tr) return { ok: false, reason: '陷阱不存在' };
        if (tr.lv >= MAX_LV) return { ok: false, reason: '已满级' };
        if (tr.lv === MAX_LV - 1 && cmd.br !== 'a' && cmd.br !== 'b') return { ok: false, reason: '需要选择进阶方向', evo: true };
        const c = this.upgradeCost(tr, cmd.pid);
        if (s.gold < c) return { ok: false, reason: '金币不足' };
        s.gold -= c; tr.invested += c; s.stats.spent += c; tr.lv++;
        if (tr.lv === MAX_LV) { tr.br = cmd.br; if (tr.type === 'laser' && tr.br === 'b') tr.line = this.wallLine(tr.x, tr.z, tr.dir, 6); }
        const def = TRAP[tr.type];
        if (def.block || tr.lane) { const nm = (tr.lane ? LANE_HP[tr.type] : def.hp)[tr.lv - 1]; tr.hp = tr.hp / tr.maxHp * nm; tr.maxHp = nm; }
        this.ev('upgrade', { id: tr.id, lv: tr.lv, br: tr.br, trap: tr.type, x: tr.wx, y: tr.wy, z: tr.wz });
        return { ok: true };
      }
      case 'sell': {
        const i = s.traps.findIndex(t => t.id === cmd.id);
        if (i < 0) return { ok: false, reason: '陷阱不存在' };
        const tr = s.traps[i], refund = this.refundOf(tr, cmd.pid);
        s.traps.splice(i, 1); this.occ.delete(this.slotKey(tr));
        s.gold += refund;
        this.ev('sell', { id: tr.id, refund, x: tr.wx, y: tr.wy, z: tr.wz });
        return { ok: true, refund };
      }
      case 'ready': {
        if (s.phase !== 'build') return { ok: false };
        if (!p) return Object.keys(s.players).length ? { ok: false } : this._startEarly();
        p.ready = cmd.on === undefined ? true : !!cmd.on;
        this.ev('pready', { pid: p.id, on: p.ready });
        return this._checkReady() || { ok: true, waiting: true, ...this.readyCount() };
      }
    }
    return { ok: false };
  }

  readyCount() {
    const ps = Object.values(this.s.players);
    return { n: ps.filter(q => q.ready).length, of: ps.length };
  }
  // 全员准备 → 提前开战（单人时按 G 即开战）
  _checkReady() {
    const s = this.s, rc = this.readyCount();
    if (s.phase !== 'build' || !rc.of || rc.n < rc.of) return null;
    return this._startEarly();
  }
  _startEarly() {
    const bonus = Math.floor(Math.max(0, this.s.timer)) * 3;
    this.s.gold += bonus; this._startWave(bonus);
    return { ok: true, bonus };
  }

  /* ---------- 主循环 ---------- */
  step(dt) {
    const s = this.s;
    if (s.phase === 'victory' || s.phase === 'defeat') return;
    s.tick++; s.time += dt;
    this._mById.clear();
    for (const m of s.monsters) this._mById.set(m.id, m);

    if (s.phase === 'build') {
      s.timer -= dt;
      if (s.timer <= 0) this._startWave(0);
    } else if (s.phase === 'wave') {
      while (s.spawnQ.length && s.spawnQ[0].time <= s.time) {
        const q = s.spawnQ.shift();
        this._spawn(q.type, q.lane, 0);
      }
    }
    for (const id in s.players) this._updatePlayer(s.players[id], dt);
    this._buildBuckets();
    this._updateTraps(dt);
    this._updateProj(dt);
    this._updateStrikes(dt);
    this._updateShells(dt);
    this._updateLava(dt);
    this._updateDevices(dt);
    this._updateMonsters(dt);
    this._reap();

    if (s.crystal.hp <= 0 && s.phase !== 'defeat') {
      s.crystal.hp = 0; s.phase = 'defeat'; this.ev('defeat');
      return;
    }
    if (s.phase === 'wave' && !s.spawnQ.length && !s.monsters.length) this._waveClear();
  }

  _startWave(bonus) {
    const s = this.s;
    s.wave++;
    const W = this.waveDef(s.wave);
    const q = this.expandWave(s.wave).map(e => ({ type: e.type, lane: e.lane, time: s.time + 2 + e.time }));
    s.spawnQ = q; s.phase = 'wave'; s.timer = 0;
    for (const id in s.players) s.players[id].ready = false;
    if (s.wave === 1) s.stats.startTime = s.time;
    const opened = this.lanes.filter(l => this.laneFrom(l) === s.wave && s.wave > 1);
    if (opened.length) this.ev('laneOpen', { lanes: opened, names: opened.map(l => this.def.laneNames[l] || l) });
    this.ev('waveStart', { wave: s.wave, total: this.totalWaves(), name: W.name, tip: W.tip || '', boss: !!W.boss, bonus: bonus || 0, count: q.length });
  }
  _waveClear() {
    const s = this.s;
    if (!s.endless && s.wave >= this.waves.length) {
      s.phase = 'victory'; this.ev('victory');
      return;
    }
    const bonus = Math.round((200 + 70 * Math.min(s.wave, 20)) * DIFFS[s.diff].gold * (this.def.goldMul || 1));
    s.gold += bonus; s.phase = 'build'; s.timer = 30;
    if (s.endless && s.wave >= this.waves.length) s.stats.endlessBest = s.wave;
    this.ev('waveClear', { wave: s.wave, bonus });
  }

  _spawn(type, lane, d) {
    const def = MON[type], s = this.s, tmp = this._tmp;
    const extra = s.wave > this.waves.length ? Math.pow(1.06, s.wave - this.waves.length) : 1;
    const hpMul = def.boss ? DIFFS[s.diff].hp * extra * (this.def.bossMul || 1) : DIFFS[s.diff].hp * (1 + 0.13 * (Math.max(1, s.wave) - 1)) * extra;
    const off = def.fly ? (this.rand() * 2 - 1) * 0.5 * T : (this.rand() * 2 - 1) * Math.max(0, 0.78 * T - def.r * 0.7);
    const path = this.paths[lane];
    pathAt(path, d, tmp);
    const x = tmp.x - tmp.dz * off, z = tmp.z + tmp.dx * off, y = def.fly ? FLY_Y : 0;
    const m = {
      id: s.nextId++, type, lane, d, off, x, y, z, ox: x, oy: y, oz: z, fx: tmp.dx, fz: tmp.dz,
      hp: def.hp * hpMul, maxHp: def.hp * hpMul, slowAmt: 0, slowT: 0, poisonT: 0, poisonDps: 0, burnT: 0, burnDps: 0,
      stunT: 0, launchT: 0, hitT: 0, atkT: 1, state: 'move', enraged: false, dead: false, leaked: false,
      seed: this.rand() * 100, born: s.time,
    };
    if (def.boss) { m.empT = 9; m.sumT = 14; m.stompT = 6; m.artT = 5; m.lavaT = 0; m.waveT = 7; m.broodT = 3; s.bossId = m.id; this.ev('boss', { id: m.id, mtype: type, lane, laneName: this.def.laneNames[lane] || lane }); }
    if (this.hasMut('champions') && !def.boss && !def.elite && this.rand() < 0.12) { m.champ = true; m.hp = m.maxHp = m.maxHp * 2.5; }
    if (def.stealth) { m.cloak = true; m.revealT = 0; }
    if (def.burrow) { m.burrow = false; m.burrowT = 0; m.burrowCd = 2 + this.rand() * 2; }
    if (def.hack) { m.hackT = 0; m.hackId = 0; m.hackCd = 2; }
    if (def.ranged) { m.shootCd = 1; m.scanT = 0; m.aimId = null; m.aiming = false; m.ax = 0; m.az = 1; }
    if (def.brood) m.broodT = 4;
    if (def.heal) { m.healT = 1; m.healAmt = def.heal * hpMul; }
    s.monsters.push(m); this._mById.set(m.id, m);
    this.ev('spawn', { id: m.id, mtype: type, lane, x, z, d });
    return m;
  }

  damage(m, amt, src, pid, pierce) {
    if (m.dead || amt <= 0 || m.burrow) return 0;
    const def = MON[m.type];
    if (def.stealth) m.revealT = Math.max(m.revealT, 1.2);
    const armor = Math.min(0.6, (def.armor || 0) + (this.hasMut('armored') ? 0.2 : 0));
    let a = amt * (pierce ? 1 : 1 - armor);
    m.lastHitT = this.s.time;
    // 空中连击：被弹板击飞时受到的陷阱伤害 +40%
    if (src === 'trap' && m.launchT > 0 && !def.fly) {
      a *= 1.4;
      if (!(m.airFx > this.s.time)) { m.airFx = this.s.time + 0.8; this.ev('combo', { k: 'air', x: m.x, y: m.y + def.body[0], z: m.z }); }
    }
    if (src === 'trap') a *= 1 + 0.08 * this.techLv('overclock');
    m.hp -= a; m.hitT = 0.12;
    if (src === 'gun') this.s.stats.dmgGun += a; else this.s.stats.dmgTrap += a;
    if (pid) { const p = this.s.players[pid]; if (p) { p.dmg += a; if (src === 'gun') p.energy = Math.min(100, p.energy + a * 0.012 * (1 + 0.2 * ((p.tal && p.tal.energy) || 0) + (p.cls === 'support' ? 0.4 : 0)) / (this.hasMut('glass') ? 2 : 1)); } }
    if (m.hp <= 0) { m.hp = 0; m.dead = true; m.killer = pid || null; }
    return a;
  }

  _reap() {
    const s = this.s;
    let w = 0;
    for (let i = 0; i < s.monsters.length; i++) {
      const m = s.monsters[i];
      if (!m.dead) { s.monsters[w++] = m; continue; }
      const def = MON[m.type];
      if (!m.leaked) {
        const bounty = Math.round(def.bounty * DIFFS[s.diff].gold * (this.def.goldMul || 1) * (this.hasMut('austerity') ? 1.25 : 1) * (m.champ ? 3 : 1) * (1 + 0.1 * this.techLv('salvage')));
        s.gold += bounty; s.stats.kills++;
        if (m.killer && s.players[m.killer]) { s.players[m.killer].kills++; s.players[m.killer].energy = Math.min(100, s.players[m.killer].energy + 2); }
        for (const id in s.players) s.players[id].energy = Math.min(100, s.players[id].energy + 0.4);
        this.ev('kill', { id: m.id, mtype: m.type, x: m.x, y: m.y, z: m.z, fx: m.fx, fz: m.fz, bounty, pid: m.killer, launch: m.launchT > 0 });
        if (def.bomb && !m.exploded) this._bomberBlast(m, false);
        if (m.poisonSpread && m.poisonT > 0) {
          for (const o of s.monsters) if (!o.dead && o !== m && Math.hypot(o.x - m.x, o.z - m.z) < 2.6) { o.poisonDps = Math.max(o.poisonDps || 0, m.poisonDps); o.poisonT = 3; o.poisonSpread = true; }
          this.ev('combo', { k: 'spread', x: m.x, y: 0.6, z: m.z });
        }
        if (def.split) {
          for (const k of [-1, 1]) {
            const c = this._spawn(def.split, m.lane, Math.max(0, m.d - 1.5 - (k > 0 ? 2 : 0)));
            c.hp = c.maxHp = m.maxHp * 0.3; c.off = k * 0.7;
          }
          this.ev('split', { x: m.x, z: m.z });
        }
      }
    }
    s.monsters.length = w;
    if (s.bossId && !s.monsters.some(m => m.id === s.bossId)) { const nb = s.monsters.find(m => MON[m.type].boss); s.bossId = nb ? nb.id : 0; }
  }

  _buildBuckets() {
    const bk = this._bk; bk.clear();
    for (const m of this.s.monsters) {
      if (m.dead) continue;
      const i = this.idxOf(m.x, m.z);
      let a = bk.get(i); if (!a) { a = []; bk.set(i, a); }
      a.push(m);
    }
  }
  _ground(idx, out) {
    const a = this._bk.get(idx); if (!a) return out;
    for (const m of a) if (!m.dead && (!MON[m.type].fly || m.pullT > 0) && m.launchT <= 0 && !m.burrow) out.push(m);
    return out;
  }
  _all(idx, out) {
    const a = this._bk.get(idx); if (!a) return out;
    for (const m of a) if (!m.dead && !m.burrow) out.push(m);
    return out;
  }
  _los(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, L = Math.hypot(dx, dy, dz);
    if (L < 0.01) return true;
    const h = this.raycast(ax, ay, az, dx / L, dy / L, dz / L, L);
    return !h || h.t >= L - 0.3;
  }
  _pickTarget(tr, R, ground, air) {
    const cand = [];
    const hx = tr.wx, hy = 1.7, hz = tr.wz;
    for (const m of this.s.monsters) {
      if (m.dead || !this.canLock(m)) continue;
      const f = MON[m.type].fly;
      if ((f && !air) || (!f && !ground)) continue;
      const cy = m.y + MON[m.type].body[0];
      const d = Math.hypot(m.x - hx, cy - hy, m.z - hz);
      if (d > R) continue;
      cand.push({ m, rem: this.paths[m.lane].len - m.d, cy });
    }
    cand.sort((a, b) => a.rem - b.rem);
    for (let i = 0; i < cand.length && i < 6; i++) {
      const c = cand[i];
      if (this._los(hx, hy, hz, c.m.x, c.cy, c.m.z)) return c.m;
    }
    return null;
  }

  _updateTraps(dt) {
    const s = this.s, list = [];
    for (const tr of s.traps) {
      const def = TRAP[tr.type], lv = tr.lv, br = lv >= MAX_LV ? tr.br : '';
      tr.activeT = Math.max(0, tr.activeT - dt);
      if (tr.hackT > 0) tr.hackT -= dt;
      if (def.block || tr.lane) {
        tr.hurtT = Math.max(0, tr.hurtT - dt);
        tr.hp = Math.min(tr.maxHp, tr.hp + tr.maxHp * ((def.regen || 0.01) + 0.01 * this.techLv('repair')) * dt * (tr.hurtT > 0 ? 0.4 : 1));
      }
      if (tr.disT > 0) { tr.disT -= dt; continue; }
      tr.cd -= dt;
      list.length = 0;
      switch (tr.type) {
        case 'slow': {
          if (br === 'b') { for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!this.solid(tr.x + dx, tr.z + dz)) this._ground((tr.z + dz) * this.W + tr.x + dx, list); }
          else this._ground(tr.idx, list);
          const amt = def.slow[lv - 1] * (br === 'b' ? 0.85 : 1);
          for (const m of list) { m.slowAmt = Math.max(m.slowAmt, amt); m.slowT = 0.9; if (m.revealT !== undefined) m.revealT = Math.max(m.revealT, 1.5); }
          if (list.length) tr.activeT = 0.3;
          if (br === 'a' && tr.cd <= 0 && list.length) {
            tr.cd = 1;
            let n = 0;
            for (const m of list) if (!MON[m.type].boss && this.rand() < 0.35) { m.stunT = Math.max(m.stunT, 1); m.frozenT = 1; n++; }
            if (n) this.ev('trap', { kind: 'freeze', id: tr.id, x: tr.wx, y: 0.3, z: tr.wz });
          }
          break;
        }
        case 'spike': {
          if (tr.cd > 0) break;
          this._ground(tr.idx, list);
          if (!list.length) { tr.cd = 0; break; }
          const pd = def.poison[lv - 1] * (br === 'a' ? 2 : 1);
          for (const m of list) {
            this.damage(m, def.dmg[lv - 1] * (br === 'b' ? 1.6 : 1), 'trap', null, br === 'b');
            m.poisonDps = m.poisonT > 0 ? Math.max(m.poisonDps, pd) : pd;
            m.poisonT = 3;
            if (br === 'a') m.poisonSpread = true;
          }
          tr.cd = def.cd; tr.fireT = s.time;
          this.ev('trap', { kind: 'spike', id: tr.id, x: tr.wx, y: 0.2, z: tr.wz });
          break;
        }
        case 'push': {
          if (tr.cd > 0) break;
          this._ground(tr.idx, list);
          const ms = list.filter(m => (MON[m.type].knockRes || 0) < 1);
          if (!ms.length) { tr.cd = 0; break; }
          const pm = br === 'a' ? 1.4 : br === 'b' ? 0.7 : 1;
          for (const m of ms) {
            m.d = Math.max(0, m.d - def.push[lv - 1] * pm * (1 - (MON[m.type].knockRes || 0)));
            m.launchT = br === 'a' ? 0.9 : 0.6; m.launchMax = m.launchT;
            this.damage(m, def.dmg[lv - 1], 'trap');
          }
          tr.cd = def.cd[lv - 1] * (br === 'b' ? 0.5 : 1); tr.fireT = s.time;
          this.ev('trap', { kind: 'push', id: tr.id, x: tr.wx, y: 0.3, z: tr.wz });
          break;
        }
        case 'tesla': {
          if (tr.cd > 0) break;
          const cand = [];
          for (const m of s.monsters) {
            if (m.dead || !this.canLock(m)) continue;
            const d = Math.hypot(m.x - tr.wx, (m.y + MON[m.type].body[0]) - 2.2, m.z - tr.wz);
            if (d <= def.range + MON[m.type].r) cand.push({ m, d });
          }
          if (!cand.length) { tr.cd = 0; tr.targets = []; break; }
          cand.sort((a, b) => a.d - b.d);
          tr.targets = [];
          const chains = br === 'a' ? 6 : def.chains;
          for (let i = 0; i < cand.length && i < chains; i++) {
            this.damage(cand[i].m, def.dmg[lv - 1] * (br === 'b' ? 1.2 : 1), 'trap');
            if (br === 'b' && !MON[cand[i].m.type].boss) cand[i].m.stunT = Math.max(cand[i].m.stunT, 0.35);
            tr.targets.push(cand[i].m.id);
          }
          tr.cd = def.cd; tr.fireT = s.time;
          this.ev('trap', { kind: 'tesla', id: tr.id, x: tr.wx, y: tr.wy + 2.2, z: tr.wz });
          break;
        }
        case 'sentry': {
          tr.scanT -= dt;
          const R = def.range[lv - 1];
          if (br === 'b') for (const m of s.monsters) if (m.cloak !== undefined && !m.dead && Math.hypot(m.x - tr.wx, m.z - tr.wz) < R) { m.revealT = Math.max(m.revealT, 0.5); m.cloak = false; }
          let tgt = tr.tgt ? this._mById.get(tr.tgt) : null;
          if (tgt && (tgt.dead || Math.hypot(tgt.x - tr.wx, tgt.z - tr.wz) > R)) tgt = null;
          if (!tgt || tr.scanT <= 0) { tgt = this._pickTarget(tr, R, true, true); tr.tgt = tgt ? tgt.id : 0; tr.scanT = 0.3; }
          if (!tgt) { if (tr.cd < 0) tr.cd = 0; break; }
          tr.aimYaw = Math.atan2(-(tgt.x - tr.wx), -(tgt.z - tr.wz));
          if (tr.cd <= 0) {
            this.damage(tgt, def.dmg[lv - 1] * (br === 'b' ? 1.6 : 1), 'trap');
            tr.cd = def.cd * (br === 'a' ? 0.5 : 1); tr.fireT = s.time;
            this.ev('tshot', { id: tr.id, x: tgt.x, y: tgt.y + MON[tgt.type].body[0], z: tgt.z });
          }
          break;
        }
        case 'aa': {
          if (tr.cd > 0) break;
          const tgts = [];
          if (br === 'a') {
            const R = def.range[lv - 1];
            for (const m of s.monsters) if (!m.dead && this.canLock(m) && MON[m.type].fly && Math.hypot(m.x - tr.wx, m.z - tr.wz) < R) tgts.push(m);
            tgts.sort((a, b) => (this.paths[a.lane].len - a.d) - (this.paths[b.lane].len - b.d)); tgts.length = Math.min(3, tgts.length);
            while (tgts.length && tgts.length < 3) tgts.push(tgts[0]);
          } else { const t0 = this._pickTarget(tr, def.range[lv - 1], br === 'b', true); if (t0) tgts.push(t0); }
          if (!tgts.length) { tr.cd = 0; break; }
          const tgt = tgts[0];
          tr.aimYaw = Math.atan2(-(tgt.x - tr.wx), -(tgt.z - tr.wz));
          tgts.forEach((t1, i) => {
            const dx = t1.x - tr.wx, dz = t1.z - tr.wz, L = Math.hypot(dx, dz) || 1;
            s.proj.push({ id: s.nextId++, x: tr.wx, y: tr.wy + 2.2, z: tr.wz, vx: dx / L * 6 + (i - 1) * 2, vy: 14, vz: dz / L * 6 + (i - 1) * 2, tgt: t1.id, dmg: def.dmg[lv - 1] * (br === 'a' ? 0.7 : br === 'b' && !MON[t1.type].fly ? 0.8 : 1), splash: def.splash, life: 4, ground: br === 'b' });
          });
          tr.cd = def.cd; tr.fireT = s.time;
          this.ev('trap', { kind: 'aa', id: tr.id, x: tr.wx, y: tr.wy + 2.2, z: tr.wz });
          break;
        }
        case 'laser':
        case 'flame': {
          if (tr.cd > 0) break;
          for (const i of tr.line) this._all(i, list);
          if (!list.length) { tr.cd = 0; break; }
          for (const m of list) {
            const md = MON[m.type];
            let dm = def.dmg[lv - 1];
            if (tr.type === 'laser' && br === 'a') dm *= 1.6;
            if (tr.type === 'flame' && br === 'b') dm *= (md.elite || md.boss) ? 2.1 : 1.4;
            this.damage(m, dm, 'trap');
            if (tr.type === 'laser' && br === 'b') { m.slowAmt = Math.max(m.slowAmt, 0.25); m.slowT = Math.max(m.slowT, 0.4); }
            if (def.burn && !md.burnImmune) {
              const bd = def.burn[lv - 1] * (br === 'a' ? 1.4 : 1);
              m.burnDps = m.burnT > 0 ? Math.max(m.burnDps, bd) : bd; m.burnT = br === 'a' ? 5 : 2.5;
              // 爆燃：点燃中毒的敌人
              if (m.poisonT > 0 && !(m.igniteCd > s.time)) {
                m.igniteCd = s.time + 2; m.poisonT = 0;
                const boomD = 60 + def.dmg[lv - 1] * 3;
                for (const o of s.monsters) if (!o.dead && Math.hypot(o.x - m.x, o.z - m.z) < 2.4) this.damage(o, boomD, 'trap');
                this.ev('combo', { k: 'ignite', x: m.x, y: m.y + md.body[0], z: m.z });
              }
            }
          }
          tr.cd = def.cd; tr.activeT = 0.35;
          if (s.time - tr.fireT > 0.9) { tr.fireT = s.time; this.ev('trap', { kind: tr.type, id: tr.id, x: tr.wx, y: tr.wy, z: tr.wz }); }
          break;
        }
        case 'crusher': {
          if (tr.cd > 0) break;
          for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
            if (this.solid(tr.x + dx, tr.z + dz)) continue;
            this._ground((tr.z + dz) * this.W + tr.x + dx, list);
          }
          if (!list.length) { tr.cd = 0; break; }
          let shat = false;
          for (const m of list) {
            // 碎冰：减速或冻住的敌人受到双倍伤害
            const ice = m.slowAmt > 0 || m.frozenT > 0;
            if (ice) shat = true;
            this.damage(m, def.dmg[lv - 1] * (br === 'a' ? 1.5 : 1) * (ice ? 2 : 1), 'trap');
            m.stunT = Math.max(m.stunT, br === 'a' ? 1.6 : def.stun);
          }
          if (shat) this.ev('combo', { k: 'shatter', x: tr.wx, y: 1, z: tr.wz });
          tr.cd = def.cd[lv - 1] * (br === 'b' ? 0.6 : 1); tr.fireT = s.time;
          this.ev('trap', { kind: 'crusher', id: tr.id, x: tr.wx, y: 0.1, z: tr.wz });
          break;
        }
      }
    }
  }

  _launchRocket(p, o, d) {
    const L = Math.hypot(d[0], d[1], d[2]) || 1, sp = WPN.rocket.proj;
    this.s.proj.push({ id: this.s.nextId++, kind: 'rocket', owner: p.id, x: +o[0], y: +o[1], z: +o[2], vx: d[0] / L * sp, vy: d[1] / L * sp, vz: d[2] / L * sp, life: 3 });
    this.ev('rocket', { pid: p.id });
  }
  // 范围爆炸：地面与空中目标都会受伤，边缘伤害减半
  _blast(x, y, z, r, dmg, pid, stun) {
    for (const m of this.s.monsters) {
      if (m.dead) continue;
      const d = Math.hypot(m.x - x, (m.y + MON[m.type].body[0]) - y, m.z - z) - MON[m.type].r;
      if (d > r) continue;
      this.damage(m, dmg * (1 - 0.5 * Math.max(0, d) / r), pid ? 'gun' : 'trap', pid || null);
      if (stun) m.stunT = Math.max(m.stunT, stun);
    }
  }
  _updatePlayerProj(p, dt) {
    const s = this.s;
    p.life -= dt;
    if (p.kind === 'rocket') {
      const sp = Math.hypot(p.vx, p.vy, p.vz) || 1, step = sp * dt;
      const h = this.raycast(p.x, p.y, p.z, p.vx / sp, p.vy / sp, p.vz / sp, step);
      let hitT = h ? h.t : Infinity;
      for (const m of s.monsters) {
        if (m.dead) continue;
        const def = MON[m.type];
        const t = raySphere(p.x, p.y, p.z, p.vx / sp, p.vy / sp, p.vz / sp, m.x, m.y + def.body[0], m.z, def.body[1] + 0.25);
        if (t >= 0 && t < hitT && t <= step) hitT = t;
      }
      if (hitT <= step || p.life <= 0) {
        const t = Math.min(hitT, step);
        p.x += p.vx / sp * t; p.y += p.vy / sp * t; p.z += p.vz / sp * t;
        const W = WPN.rocket, ow = s.players[p.owner];
        this._blast(p.x, p.y, p.z, W.splash, W.dmg * (ow ? this.gunMul(ow) : 1), p.owner);
        this.ev('boom', { x: p.x, y: p.y, z: p.z, r: W.splash, small: false });
        return false;
      }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      return true;
    }
    // 手雷：重力 + 反弹，引信结束爆炸
    p.vy -= 20 * dt;
    const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;
    if (this.solid(Math.floor(nx / T), Math.floor(p.z / T))) p.vx = -p.vx * 0.45; else p.x = nx;
    if (this.solid(Math.floor(p.x / T), Math.floor(nz / T))) p.vz = -p.vz * 0.45; else p.z = nz;
    p.y = ny;
    if (p.y < 0.15) { p.y = 0.15; p.vy = Math.abs(p.vy) * 0.35; p.vx *= 0.6; p.vz *= 0.6; }
    if (p.y > WALL_H - 0.2) { p.y = WALL_H - 0.2; p.vy = -Math.abs(p.vy) * 0.3; }
    if (p.life <= 0) {
      const N = SKILL.nade;
      this._blast(p.x, p.y + 0.5, p.z, N.r, N.dmg * (1 + 0.12 * this.techLv('ammo')), p.owner);
      this.ev('boom', { x: p.x, y: p.y + 0.3, z: p.z, r: N.r, small: false });
      return false;
    }
    return true;
  }
  _updateStrikes(dt) {
    const s = this.s, U = SKILL.ult;
    for (const k of s.strikes) {
      k.t -= dt;
      if (k.t <= 0) {
        this._blast(k.x, 1.5, k.z, U.r, U.dmg, k.owner, U.stun);
        for (const m of s.monsters) if (!m.dead && MON[m.type].fly && Math.hypot(m.x - k.x, m.z - k.z) < U.r) this.damage(m, U.dmg * 0.5, 'gun', k.owner);
        this.ev('strike', { pid: k.owner, x: k.x, z: k.z, r: U.r });
      }
    }
    s.strikes = s.strikes.filter(k => k.t > 0);
  }
  _updateProj(dt) {
    const s = this.s;
    let w = 0;
    for (const p of s.proj) {
      if (p.kind === 'rocket' || p.kind === 'nade') { if (this._updatePlayerProj(p, dt)) s.proj[w++] = p; continue; }
      p.life -= dt;
      const t = this._mById.get(p.tgt);
      if (t && !t.dead) {
        const ty = t.y + MON[t.type].body[0];
        const dx = t.x - p.x, dy = ty - p.y, dz = t.z - p.z, L = Math.hypot(dx, dy, dz) || 1;
        const sp = 30, k = Math.min(1, dt * 5);
        p.vx += (dx / L * sp - p.vx) * k; p.vy += (dy / L * sp - p.vy) * k; p.vz += (dz / L * sp - p.vz) * k;
        if (L < 1.0) p.life = 0;
      } else { p.vy -= 2 * dt; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y > WALL_H - 0.2 || p.y < 0.1) p.life = Math.min(p.life, 0);
      if (p.life <= 0) {
        for (const m of s.monsters) {
          if (m.dead || (!MON[m.type].fly && !p.ground)) continue;
          const d = Math.hypot(m.x - p.x, m.y - p.y, m.z - p.z);
          if (m.id === p.tgt && d < 2.5) this.damage(m, p.dmg, 'trap');
          else if (d < p.splash) this.damage(m, p.dmg * 0.5, 'trap');
        }
        this.ev('boom', { x: p.x, y: p.y, z: p.z, r: 1.6, small: true });
        continue;
      }
      s.proj[w++] = p;
    }
    s.proj.length = w;
  }

  _blockerAhead(m, def, path) {
    if (m.burrow) return null;
    const t2 = this._tmp2;
    pathAt(path, Math.min(path.len, m.d + def.r + 0.6), t2);
    const px = t2.x - t2.dz * m.off, pz = t2.z + t2.dx * m.off;
    const devs = this.def.devices;
    if (devs) for (let i = 0; i < devs.length; i++) {
      if (devs[i].type !== 'gate' || !(this.s.devices[i].act > 0)) continue;
      const a = devs[i].area, mt = [Math.floor(m.x / T), Math.floor(m.z / T)];
      if (this.inArea(a, Math.floor(px / T), Math.floor(pz / T)) && !this.inArea(a, mt[0], mt[1])) return this._gateObj || (this._gateObj = { gate: true, hp: 1, atkN: 0 });
    }
    const tr = this.occ.get('f' + this.idxOf(px, pz));
    return tr && this.isBlocker(tr) && tr.hp > 0 ? tr : null;
  }
  _hurtTrap(tr, amt) {
    tr.hp -= amt; tr.hurtT = 0.5;
    if (tr.hp <= 0) {
      const i = this.s.traps.indexOf(tr);
      if (i >= 0) this.s.traps.splice(i, 1);
      this.occ.delete(this.slotKey(tr));
      this.ev('trapBroken', { id: tr.id, trap: tr.type, x: tr.wx, y: tr.wy, z: tr.wz });
    }
  }
  _bomberBlast(m, suicide) {
    const s = this.s;
    m.exploded = true;
    this.ev('boom', { x: m.x, y: 0.6, z: m.z, r: 3.2 });
    if (suicide) {
      for (const tr of s.traps.slice()) {
        if (!this.isBlocker(tr)) continue;
        if (Math.hypot(tr.wx - m.x, tr.wz - m.z) < 3.4) this._hurtTrap(tr, 600);
      }
    } else {
      for (const o of s.monsters) {
        if (o === m || o.dead) continue;
        if (Math.hypot(o.x - m.x, o.z - m.z) < 3.2) this.damage(o, 140, 'trap');
      }
    }
    for (const id in s.players) {
      const p = s.players[id];
      if (!p.dead && Math.hypot(p.x - m.x, p.z - m.z) < 3.6) this.hurtPlayer(p, 30, 'boom', m.x, m.z);
    }
  }

  _updateMonsters(dt) {
    const s = this.s, tmp = this._tmp;
    // 上一帧停下（被堵 / 排队）的地面怪：后面的怪会排在它们身后
    const stopped = this._stopped || (this._stopped = []);
    stopped.length = 0;
    for (const m of s.monsters) if (!m.dead && (m.state === 'block' || m.state === 'queue')) stopped.push(m);
    for (const tr of s.traps) tr.atkN = 0;
    for (const m of s.monsters) {
      if (m.dead) continue;
      const def = MON[m.type];
      m.ox = m.x; m.oy = m.y; m.oz = m.z;
      m.hitT = Math.max(0, m.hitT - dt);
      if (m.frozenT > 0) m.frozenT -= dt;
      if (m.poisonT > 0) { m.poisonT -= dt; this.damage(m, m.poisonDps * dt, 'trap', null, true); }
      if (m.burnT > 0) { m.burnT -= dt; this.damage(m, m.burnDps * dt, 'trap', null, true); }
      if (m.dead) continue;
      if (m.slowT > 0) { m.slowT -= dt; if (m.slowT <= 0) m.slowAmt = 0; }
      if (def.elite && !m.enraged && m.hp < m.maxHp * 0.5) { m.enraged = true; this.ev('enrage', { id: m.id, x: m.x, z: m.z }); }
      let spd = def.spd * (m.enraged ? 1.6 : 1) * (1 - m.slowAmt * (1 - (def.slowRes || 0))) * (this.hasMut('swift') ? 1.25 : 1) * (m.champ ? 0.9 : 1);
      if (this.hasMut('regen') && s.time - (m.lastHitT || 0) > 2 && m.hp < m.maxHp) m.hp = Math.min(m.maxHp, m.hp + m.maxHp * 0.015 * dt);
      if (m.stunT > 0) { m.stunT -= dt; spd = 0; }
      if (m.launchT > 0) m.launchT -= dt;
      const path = this.paths[m.lane];
      m.state = 'move';
      // 隐身：靠近玩家 4.5 米内会暴露
      if (def.stealth) {
        m.revealT = Math.max(0, m.revealT - dt);
        for (const id in s.players) { const q = s.players[id]; if (!q.dead && Math.hypot(q.x - m.x, q.z - m.z) < (q.cls === 'scout' ? 12 : 4.5)) { m.revealT = Math.max(m.revealT, 0.4); break; } }
        m.cloak = m.revealT <= 0;
      }
      // 钻地：前方 3 米有地面陷阱或阻挡时钻入地下，无敌并加速
      if (def.burrow) {
        if (m.burrow) {
          m.burrowT -= dt; spd = def.spd * 1.8; m.stunT = 0; m.slowAmt = 0;
          if (m.burrowT <= 0) { m.burrow = false; m.burrowCd = 6; this.ev('surface', { id: m.id, x: m.x, z: m.z }); }
        } else {
          m.burrowCd -= dt;
          if (m.burrowCd <= 0 && m.stunT <= 0 && m.launchT <= 0) {
            const t2 = this._tmp2;
            for (let a = 1; a <= 3; a += 1) {
              pathAt(path, Math.min(path.len, m.d + a), t2);
              const tr = this.occ.get('f' + this.idxOf(t2.x - t2.dz * m.off, t2.z + t2.dx * m.off));
              if (tr) { m.burrow = true; m.burrowT = 2.6; m.poisonT = 0; m.burnT = 0; this.ev('burrow', { id: m.id, x: m.x, z: m.z }); break; }
            }
          }
        }
      }
      // 骇客：在附近陷阱旁引导 2.2 秒，使其瘫痪 10 秒
      if (def.hack) {
        if (m.hackT > 0) {
          const tr = s.traps.find(t => t.id === m.hackId);
          if (!tr || m.stunT > 0 || m.launchT > 0) { m.hackT = 0; m.hackCd = 2; }
          else {
            m.hackT -= dt; spd = 0; m.state = 'hack';
            if (m.hackT <= 0) { tr.disT = Math.max(tr.disT, 10 * this.disMul()); tr.hackT = 10 * this.disMul(); m.hackCd = 7; this.ev('hacked', { id: tr.id, trap: tr.type, x: tr.wx, y: tr.wy, z: tr.wz }); }
          }
        } else {
          m.hackCd -= dt;
          if (m.hackCd <= 0) {
            m.hackCd = 0.5;
            let best = null, bd = 3.4;
            for (const tr of s.traps) { if (tr.disT > 0) continue; const d = Math.hypot(tr.wx - m.x, tr.wz - m.z); if (d < bd) { bd = d; best = tr; } }
            if (best) { m.hackT = 2.2; m.hackId = best.id; m.state = 'hack'; spd = 0; this.ev('hackStart', { id: m.id, tr: best.id }); }
          }
        }
      }
      // 远程射手：发现玩家就减速射击
      if (def.ranged) {
        const R = def.ranged;
        m.scanT -= dt; m.shootCd -= dt;
        if (m.scanT <= 0) {
          m.scanT = 0.3; m.aimId = null;
          let bd = R.range;
          for (const id in s.players) {
            const q = s.players[id];
            if (q.dead) continue;
            const d = Math.hypot(q.x - m.x, q.z - m.z);
            if (d < bd && this._los(m.x, m.y + 1.4, m.z, q.x, q.y + 1.3, q.z)) { bd = d; m.aimId = id; }
          }
        }
        const q = m.aimId && s.players[m.aimId];
        m.aiming = !!(q && !q.dead && m.stunT <= 0);
        if (m.aiming) {
          spd *= 0.25;
          const dx = q.x - m.x, dz = q.z - m.z, L = Math.hypot(dx, dz) || 1; m.ax = dx / L; m.az = dz / L;
          if (m.shootCd <= 0) {
            m.shootCd = 1 / R.rate;
            const hit = this.rand() < R.acc;
            if (hit) this.hurtPlayer(q, R.dmg, 'gunner', m.x, m.z);
            this.ev('mshot', { id: m.id, x: m.x, y: m.y + 1.4, z: m.z, tx: q.x + (hit ? 0 : (this.rand() - 0.5) * 2), ty: q.y + 1.2, tz: q.z + (hit ? 0 : (this.rand() - 0.5) * 2), hit });
          }
        }
      }
      if (def.brood) {
        m.broodT -= dt;
        if (m.broodT <= 0) { m.broodT = 6; for (let i = 0; i < 2; i++) this._spawn('mite', m.lane, Math.max(0, m.d - 1 - i)); }
      }
      if (!def.fly && m.launchT <= 0) {
        const blk = this._blockerAhead(m, def, path);
        if (blk) {
          m.state = 'block';
          if (def.bomb) { m.leaked = true; m.dead = true; this._bomberBlast(m, true); continue; }
          // 同一座阻挡最多被 4 只怪同时攻击
          if (!blk.gate && m.stunT <= 0 && blk.atkN < 4) { blk.atkN++; this._hurtTrap(blk, def.dps * dt * (m.enraged ? 1.5 : 1)); }
          spd = 0;
        } else if (!def.boss) {
          for (const o of stopped) {
            if (o === m || o.dead) continue;
            const dx = o.x - m.x, dz = o.z - m.z;
            const fwd = dx * m.fx + dz * m.fz;
            if (fwd <= 0.05) continue;
            const need = MON[o.type].r + def.r;
            if (fwd < need * 1.05 && Math.abs(dx * m.fz - dz * m.fx) < need * 0.85) { m.state = 'queue'; spd = 0; break; }
          }
        }
      }
      m.d = Math.min(path.len, m.d + spd * dt);
      pathAt(path, m.d, tmp);
      const tx = tmp.x - tmp.dz * m.off, tz = tmp.z + tmp.dx * m.off;
      const k = 1 - Math.exp(-dt * 9);
      m.x += (tx - m.x) * k; m.z += (tz - m.z) * k;
      m.fx = tmp.dx; m.fz = tmp.dz;
      if (def.fly) {
        if (m.pullT > 0) { m.pullT -= dt; m.y += (0.7 - m.y) * Math.min(1, dt * 6); }
        else m.y += (FLY_Y + Math.sin(s.time * 2 + m.seed) * 0.25 - m.y) * Math.min(1, dt * 4);
      }
      else if (m.launchT > 0) m.y = Math.sin((1 - m.launchT / (m.launchMax || 0.6)) * Math.PI) * 2.2;
      else m.y = 0;

      if (m.d >= path.len - 1.7 - def.r * 0.5) {
        m.dead = true; m.leaked = true;
        s.crystal.hp = Math.max(0, s.crystal.hp - def.core);
        s.stats.leaks++;
        this.ev('core', { dmg: def.core, mtype: m.type, x: m.x, y: m.y, z: m.z, hp: m.hp, maxHp: m.maxHp });
        continue;
      }
      if (def.melee) {
        m.atkT -= dt;
        if (m.atkT <= 0) {
          for (const id in s.players) {
            const p = s.players[id];
            if (p.dead) continue;
            if (Math.hypot(p.x - m.x, p.z - m.z) < def.r + 0.9 && Math.abs(p.y - m.y) < 2.2) {
              this.hurtPlayer(p, def.melee * (m.enraged ? 1.5 : 1), m.type, m.x, m.z);
              m.atkT = 1.1; this.ev('mhit', { id: m.id });
              break;
            }
          }
          if (m.atkT <= 0) m.atkT = 0.2;
        }
      }
      if (def.boss) {
        if (m.type === 'siege') this._siegeAI(m, dt);
        else if (m.type === 'colossus') this._colossusAI(m, dt);
        else if (m.type === 'brood') this._broodAI(m, dt);
        else this._bossAI(m, dt);
      }
      if (def.heal) {
        m.healT -= dt;
        if (m.healT <= 0) {
          m.healT = 1;
          const ids = [];
          for (const o of s.monsters) {
            if (o === m || o.dead || o.hp >= o.maxHp || MON[o.type].heal) continue;
            if (Math.hypot(o.x - m.x, o.z - m.z) > 5.5) continue;
            o.hp = Math.min(o.maxHp, o.hp + m.healAmt * (MON[o.type].boss ? 0.3 : 1));
            ids.push(o.id);
          }
          if (ids.length) this.ev('heal', { id: m.id, x: m.x, y: m.y, z: m.z, ids: ids.slice(0, 6) });
        }
      }
    }
  }

  _stomp(m, dt, every, r, dmg) {
    m.stompT -= dt;
    if (m.stompT > 0) return;
    m.stompT = every;
    this.ev('stomp', { x: m.x, z: m.z, r });
    for (const id in this.s.players) { const p = this.s.players[id]; if (!p.dead && Math.hypot(p.x - m.x, p.z - m.z) < r) this.hurtPlayer(p, dmg, 'stomp', m.x, m.z); }
  }
  // 破城者：炮击远处的炮台 / 磁暴塔（没有就打玩家）
  _siegeAI(m, dt) {
    const s = this.s;
    this._stomp(m, dt, 8, 6, 30);
    m.artT -= dt;
    if (m.artT > 0) return;
    m.artT = 7;
    const cand = s.traps.filter(t => (TRAP[t.type].cat === 'pad' || t.type === 'tesla') && Math.hypot(t.wx - m.x, t.wz - m.z) < 28).sort((a, b) => Math.hypot(a.wx - m.x, a.wz - m.z) - Math.hypot(b.wx - m.x, b.wz - m.z));
    const tgts = cand.slice(0, 3).map(t => [t.wx, t.wz]);
    if (!tgts.length) for (const id in s.players) { const q = s.players[id]; if (!q.dead && Math.hypot(q.x - m.x, q.z - m.z) < 28) { tgts.push([q.x, q.z]); break; } }
    for (const [x, z] of tgts) {
      const tx = x + (this.rand() - 0.5) * 1.2, tz = z + (this.rand() - 0.5) * 1.2;
      s.shells.push({ x: m.x, z: m.z, tx, tz, t: 1.3 });
      this.ev('shellFire', { x: m.x, z: m.z, tx, tz, t: 1.3 });
    }
  }
  _updateShells(dt) {
    const s = this.s;
    for (const sh of s.shells) {
      sh.t -= dt;
      if (sh.t > 0) continue;
      for (const tr of s.traps.slice()) {
        if (Math.hypot(tr.wx - sh.tx, tr.wz - sh.tz) > 2.6) continue;
        tr.disT = Math.max(tr.disT, 6 * this.disMul());
        if (this.isBlocker(tr)) this._hurtTrap(tr, 500);
      }
      for (const id in s.players) { const p = s.players[id]; if (!p.dead && Math.hypot(p.x - sh.tx, p.z - sh.tz) < 3) this.hurtPlayer(p, 25, 'shell', sh.tx, sh.tz); }
      this.ev('boom', { x: sh.tx, y: 0.4, z: sh.tz, r: 2.6, small: false });
    }
    s.shells = s.shells.filter(sh => sh.t > 0);
  }
  // 熔炉巨像：留下熔岩、向玩家喷火浪
  _colossusAI(m, dt) {
    const s = this.s;
    this._stomp(m, dt, 9, 6, 30);
    m.lavaT -= dt;
    if (m.lavaT <= 0) {
      m.lavaT = 0.4;
      const cx = Math.floor(m.x / T), cz = Math.floor(m.z / T);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!this.solid(cx + dx, cz + dz)) s.lava[(cz + dz) * this.W + cx + dx] = 12;
    }
    m.waveT -= dt;
    if (m.waveT <= 0) {
      m.waveT = 9;
      let tgt = null, bd = 15;
      for (const id in s.players) { const q = s.players[id]; const d = Math.hypot(q.x - m.x, q.z - m.z); if (!q.dead && d < bd) { bd = d; tgt = q; } }
      if (tgt) {
        const yaw = Math.atan2(tgt.x - m.x, tgt.z - m.z);
        this.ev('fwave', { x: m.x, z: m.z, yaw });
        for (const id in s.players) {
          const q = s.players[id]; if (q.dead) continue;
          const dx = q.x - m.x, dz = q.z - m.z, d = Math.hypot(dx, dz);
          let da = Math.atan2(dx, dz) - yaw; while (da > Math.PI) da -= Math.PI * 2; while (da < -Math.PI) da += Math.PI * 2;
          if (d < 15 && Math.abs(da) < 0.6) this.hurtPlayer(q, 35, 'fwave', m.x, m.z);
        }
      }
    }
  }
  _updateLava(dt) {
    const s = this.s;
    let any = false;
    for (const k in s.lava) { s.lava[k] -= dt; if (s.lava[k] <= 0) delete s.lava[k]; else any = true; }
    if (!any) return;
    for (const tr of s.traps) if (tr.kind === 'floor' && TRAP[tr.type].cat === 'floor' && s.lava[tr.idx]) tr.disT = Math.max(tr.disT, 0.3);
    for (const id in s.players) {
      const p = s.players[id];
      if (p.dead || p.y > 0.3 || !s.lava[this.idxOf(p.x, p.z)]) continue;
      p.lavaAcc = (p.lavaAcc || 0) + 18 * dt;
      if (p.lavaAcc >= 6) { p.lavaAcc -= 6; this.hurtPlayer(p, 6, 'lava', p.x, p.z); }
    }
  }
  // 深渊母巢：持续孵化噬晶蛛
  _broodAI(m, dt) {
    this._stomp(m, dt, 8, 6, 25);
    m.broodT -= dt;
    if (m.broodT <= 0) {
      m.broodT = 4.5;
      for (let i = 0; i < 3; i++) this._spawn('mite', m.lane, Math.max(0, m.d - 1 - i * 0.8));
      this.ev('summon', { x: m.x, z: m.z, brood: true });
    }
  }
  _bossAI(m, dt) {
    const s = this.s;
    m.empT -= dt; m.sumT -= dt; m.stompT -= dt;
    if (m.empT <= 0) {
      m.empT = 14;
      let n = 0;
      for (const tr of s.traps) if (Math.hypot(tr.wx - m.x, tr.wz - m.z) < 9) { tr.disT = 3.5 * this.disMul(); n++; }
      this.ev('emp', { x: m.x, z: m.z, r: 9, n });
    }
    if (m.sumT <= 0) {
      m.sumT = 16;
      for (let i = 0; i < 4; i++) this._spawn('grunt', m.lane, Math.max(0, m.d - 3 - i * 1.2));
      this.ev('summon', { x: m.x, z: m.z });
    }
    if (m.stompT <= 0) {
      m.stompT = 7;
      this.ev('stomp', { x: m.x, z: m.z, r: 7 });
      for (const id in s.players) {
        const p = s.players[id];
        if (!p.dead && Math.hypot(p.x - m.x, p.z - m.z) < 7) this.hurtPlayer(p, 30, 'stomp', m.x, m.z);
      }
    }
  }

  /* ---------- 玩家移动 / 射击 ---------- */
  _updatePlayer(p, dt) {
    const s = this.s;
    p.ox = p.x; p.oy = p.y; p.oz = p.z;
    if (p.supT > 0) p.supT = Math.max(0, p.supT - dt);
    if (p.dead) {
      p.respawnT -= dt;
      if (p.respawnT <= 0) this._respawn(p);
      return;
    }
    let aura = false;
    for (const id in s.players) { const q = s.players[id]; if (q !== p && q.cls === 'support' && !q.dead && Math.hypot(q.x - p.x, q.z - p.z) < 10) { aura = true; break; } }
    if (s.time - p.lastHurt > 4) p.hp = Math.min(p.maxHp, p.hp + 12 * dt * (aura ? 2 : 1));
    else if (aura) p.hp = Math.min(p.maxHp, p.hp + 8 * dt);
    const NM = p.nadeMax || SKILL.nade.max;
    if (p.nades < NM) { p.nadeT -= dt; if (p.nadeT <= 0) { p.nades++; p.nadeT = p.nades < NM ? SKILL.nade.recharge : 0; } }
    if (p.remote) return;
    this.movePlayer(p, dt);
    if (this.weapon(p, dt)) this._fire(p);
  }
  switchWeapon(p, w) {
    if (p.wpn === w || !WPN[w]) return;
    p.ammoBy[p.wpn] = p.ammo;
    p.wpn = w; p.mag = WPN[w].mag;
    p.ammo = p.ammoBy[w] === undefined ? p.mag : p.ammoBy[w];
    p.reloadT = 0; p.fireCd = Math.max(p.fireCd, 0.35); p.bloom = 0;
    this.ev('wswitch', { pid: p.id, w });
  }
  // 移动（主机与客户端预测共用）
  movePlayer(p, dt) {
    const inp = p.input;
    p.yaw = inp.yaw; p.pitch = Math.max(-1.5, Math.min(1.5, inp.pitch));
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
    let wx = fx * inp.mz + rx * inp.mx, wz = fz * inp.mz + rz * inp.mx;
    const wl = Math.hypot(wx, wz); if (wl > 1) { wx /= wl; wz /= wl; }
    const spd = (inp.sprint && inp.mz > 0 ? 9.6 : 6.4) * (p.cls === 'scout' ? 1.15 : 1);
    const acc = Math.min(1, dt * (p.ground ? 14 : 4));
    p.vx += (wx * spd - p.vx) * acc; p.vz += (wz * spd - p.vz) * acc;
    if (inp.jump && p.ground) { p.vy = 7.4; p.ground = false; this.ev('jump', { pid: p.id }); }
    p.vy -= 22 * dt; p.y += p.vy * dt;
    p.x += p.vx * dt; this._collide(p);
    p.z += p.vz * dt; this._collide(p);
    // 地面：平台台阶可以直接走上去；走下台阶时贴地，不会“掉下去”
    const g = this.groundAt(p.x, p.z);
    if (p.y <= g || (p.ground && p.vy <= 0 && p.y - g < PLAT_H + 0.05)) { p.y = g; p.vy = 0; p.ground = true; }
    else p.ground = false;
  }
  // 武器节奏：返回本帧是否开火
  weapon(p, dt) {
    const inp = p.input, W = WPN[p.wpn] || WPN.rifle;
    let fired = false;
    p.fireCd -= dt; p.bloom = Math.max(0, p.bloom - dt * 2.5);
    if (p.reloadT > 0) {
      p.reloadT -= dt * (p.cls === 'assault' ? 1.3 : 1);
      if (p.reloadT <= 0) { p.reloadT = 0; p.ammo = p.mag; this.ev('reloaded', { pid: p.id }); }
    } else if ((inp.reload && p.ammo < p.mag) || p.ammo <= 0) {
      p.reloadT = W.reload; this.ev('reload', { pid: p.id, w: p.wpn });
    }
    // 换弹中按开火：霰弹 / 狙击 / 火箭可以打断换弹（剩余子弹 > 0）
    if (inp.fire && p.reloadT > 0 && p.ammo > 0 && W.id !== 'rifle') p.reloadT = 0;
    if (inp.fire && p.reloadT <= 0 && p.ammo > 0 && p.fireCd <= 0) {
      p.fireCd = Math.max(0, p.fireCd) + 1 / W.rps;
      p.ammo--;
      p.bloom = Math.min(1, p.bloom + W.bloom);
      fired = true;
    }
    if (p.fireCd < 0) p.fireCd = 0;
    return fired;
  }
  _collide(p) {
    const r = 0.36;
    for (let it = 0; it < 2; it++) {
      const cx = Math.floor(p.x / T), cz = Math.floor(p.z / T);
      for (let z = cz - 1; z <= cz + 1; z++) for (let x = cx - 1; x <= cx + 1; x++) {
        if (!this.solid(x, z)) continue;
        const nx = Math.max(x * T, Math.min(p.x, (x + 1) * T));
        const nz = Math.max(z * T, Math.min(p.z, (z + 1) * T));
        const dx = p.x - nx, dz = p.z - nz, d = Math.hypot(dx, dz);
        if (d < r) {
          if (d > 1e-6) { p.x = nx + dx / d * r; p.z = nz + dz / d * r; }
          else { p.x = (cx + 0.5) * T; p.z = (cz + 0.5) * T; }
        }
      }
    }
  }
  // 一次开火的全部弹道（霰弹多颗、狙击贯穿）：返回命中列表与弹道终点
  traceFire(p, rnd) {
    const W = WPN[p.wpn] || WPN.rifle, hits = [], ends = [];
    const n = W.pellets || 1;
    let spread = W.spread + p.bloom * 0.03;
    if (W.adsSpread !== undefined && p.input.ads) spread = W.adsSpread;
    for (let i = 0; i < n; i++) {
      const r = this.traceShot(p, rnd, spread, W.pierce || 1);
      ends.push(r);
      for (const h of r.hits) {
        let dmg = W.dmg * (h.head ? (W.head || 1) : 1) * this.gunMul(p);
        if (W.near) { const d = h.t; dmg *= d <= W.near ? 1 : d >= W.far ? 0.35 : 1 - 0.65 * (d - W.near) / (W.far - W.near); }
        hits.push({ m: h.m, head: h.head, dmg, x: h.x, y: h.y, z: h.z });
      }
    }
    return { hits, ends, w: W };
  }
  // 射线判定（不结算伤害）：rnd 为散布随机源；pierce 为最多贯穿目标数
  traceShot(p, rnd, spreadIn, pierce) {
    const s = this.s, R = rnd || (() => this.rand());
    const ox = p.x, oy = p.y + 1.62, oz = p.z;
    const spread = spreadIn === undefined ? 0.006 + p.bloom * 0.03 : spreadIn;
    const yaw = p.yaw + (R() - 0.5) * spread * 2, pitch = p.pitch + (R() - 0.5) * spread * 2;
    const cp = Math.cos(pitch);
    const dx = -Math.sin(yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(yaw) * cp;
    const wall = this.raycast(ox, oy, oz, dx, dy, dz, 150);
    const wallT = wall ? wall.t : 150, cand = [];
    for (const m of s.monsters) {
      if (m.dead || !this.targetable(m)) continue;
      const def = MON[m.type];
      const hf = def.head[2] || 0;
      const th = raySphere(ox, oy, oz, dx, dy, dz, m.x + m.fx * hf, m.y + def.head[0], m.z + m.fz * hf, def.head[1]);
      const tb = raySphere(ox, oy, oz, dx, dy, dz, m.x, m.y + def.body[0], m.z, def.body[1]);
      let t = Infinity, head = false;
      if (tb > 0 && tb < wallT) t = tb;
      if (th > 0 && th < wallT) { t = Math.min(t, th); head = true; }
      if (t < Infinity) cand.push({ m, head, t });
    }
    cand.sort((a, b) => a.t - b.t);
    const hits = cand.slice(0, pierce || 1).map(c => ({ m: c.m, head: c.head, t: c.t, x: ox + dx * c.t, y: oy + dy * c.t, z: oz + dz * c.t }));
    const last = (pierce || 1) > 1 || !hits.length ? wallT : hits[0].t;
    const best = hits.length ? hits[0].m : null, head = hits.length ? hits[0].head : false;
    return { best, head, wall: (pierce || 1) > 1 || !hits.length ? wall : null, hits, ex: ox + dx * last, ey: oy + dy * last, ez: oz + dz * last, dx, dy, dz };
  }
  // 本机 / 主机自己开火：结算伤害并发事件
  _fire(p) {
    const W = WPN[p.wpn] || WPN.rifle;
    if (W.proj) {
      const cp = Math.cos(p.pitch), d = [-Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp];
      this._launchRocket(p, [p.x + d[0] * 0.6, p.y + 1.5 + d[1] * 0.6, p.z + d[2] * 0.6], d);
      this.ev('shot', { pid: p.id, w: W.id, x: p.x + d[0] * 30, y: p.y + 1.5 + d[1] * 30, z: p.z + d[2] * 30, hit: false, wall: false, hk: '', dir: -1, mtype: '' });
      return;
    }
    const r = this.traceFire(p), agg = new Map();
    for (const h of r.hits) {
      const dealt = this.damage(h.m, h.dmg, 'gun', p.id);
      const a = agg.get(h.m) || { dmg: 0, head: false, x: h.x, y: h.y, z: h.z };
      a.dmg += dealt; a.head = a.head || h.head; agg.set(h.m, a);
    }
    for (const [m, a] of agg) this.ev('hit', { pid: p.id, id: m.id, mtype: m.type, x: a.x, y: a.y, z: a.z, dmg: Math.round(a.dmg), head: a.head, kill: m.dead, w: W.id });
    for (const e of r.ends) this.ev('shot', { pid: p.id, w: W.id, x: e.ex, y: e.ey, z: e.ez, hit: !!e.best, wall: !!e.wall, hk: e.wall ? e.wall.kind : '', dir: e.wall && e.wall.kind === 'wall' ? e.wall.dir : -1, mtype: e.best ? e.best.type : '' });
  }
  // 玩家可以射击隐身单位（看得到虚影），但炮台锁定不到；钻地中两者都不行
  targetable(m) { return !m.burrow; }
  canLock(m) { return !m.cloak && !m.burrow; }

}

const api = { TECH, TECH_BY, TECH_MAX, SUPPLY_CD, LANE_HP, raySphere, WEAPONS, WPN, SKILL, BOSS_TIP, EVO, COMBOS, DEVICE, MUTATORS, MUT, TALENTS, CLASSES, CLS, dailySpec, Sim, T, WALL_H, PLAT_H, FLY_Y, TILE, DIRS, MON, TRAPS, TRAP, MAPS, MAP_LIST, DIFFS, MAX_LV, CAT_NAME, pathAt, lvv, genWave };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.TD = api;
})(typeof window !== 'undefined' ? window : globalThis);

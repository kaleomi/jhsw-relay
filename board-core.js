/* 晶核守卫 · 无尽模式排行榜（Cloudflare 与 Node 两个版本共用）
 * 分数由服务器按上报的波次 / 击杀 / 水晶血量 / 难度 / 突变重新计算，客户端无法直接改分。
 */
export const MAPS = ['station', 'fortress', 'furnace', 'abyss', 'outpost', 'canyon'];
const DIFF_MUL = { normal: 1, hard: 1.4, hell: 1.9 };
const MUT_W = { swift: 0.25, armored: 0.25, horde: 0.3, austerity: 0.15, regen: 0.2, skies: 0.2, champions: 0.25, glass: 0.1, blackout: 0.15 };
export const KEEP = 50;

const clampInt = (v, a, b) => Math.max(a, Math.min(b, Math.floor(+v || 0)));
export function cleanName(n) {
  return String(n || '').replace(/[\u0000-\u001f\u007f<>&"'`\\\u200b-\u200f\u2028-\u202e]/g, '').trim().slice(0, 12) || '无名特工';
}
export function scoreOf(e) {
  const mut = e.mut.reduce((a, id) => a + (MUT_W[id] || 0), 1);
  return Math.round((e.wave * 1000 + e.kills * 2 + e.hp * 5) * DIFF_MUL[e.diff] * mut);
}
// 校验并整理一条上报；不合法返回 null
export function sanitize(o) {
  if (!o || typeof o !== 'object') return null;
  if (!MAPS.includes(o.map) || !DIFF_MUL[o.diff]) return null;
  const e = {
    map: o.map, diff: o.diff,
    wave: clampInt(o.wave, 1, 999), kills: clampInt(o.kills, 0, 200000), hp: clampInt(o.hp, 0, 200),
    n: clampInt(o.n, 1, 4), name: cleanName(o.name),
    mut: Array.isArray(o.mut) ? [...new Set(o.mut.filter(id => MUT_W[id] !== undefined))].slice(0, 9) : [],
    t: Date.now(),
  };
  // 击杀数不可能远超波次规模（粗略防作弊）
  e.kills = Math.min(e.kills, e.wave * 400);
  e.score = scoreOf(e);
  return e;
}
// 插入并返回 { list, rank }（rank 从 1 开始，未上榜为 0）
export function insert(list, e) {
  list = Array.isArray(list) ? list.slice() : [];
  list.push(e);
  list.sort((a, b) => b.score - a.score || a.t - b.t);
  list = list.slice(0, KEEP);
  return { list, rank: list.indexOf(e) + 1 };
}
export const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };

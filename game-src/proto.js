/* ============================================================
 * 晶核守卫 · 联机协议（纯函数，可在 node 中测试）
 *
 * 主机权威：主机运行 Sim，按 ~12Hz 把快照拆成若干 ≤4KiB 的消息广播；
 * 客户端维护一个只渲染、不推进的「镜像 Sim」，把快照应用进去，
 * 再在每帧做平滑插值。客户端自己的移动 / 射击在本地预测，
 * 通过 presence 上报位置与命令（命令带序号，主机回 ack + 结果）。
 *
 * 快照（JSON）：
 *   { g: 局 id, q: 序号, k: 分片下标, n: 分片数,
 *     h: 头部, st: 统计, p: 玩家, tt: 磁暴连线, pj: 导弹, e: 事件, r: 命令回执,   ← 仅第 0 片
 *     tr: 陷阱(base64 分块), m: 怪物(base64 分块) }
 * ============================================================ */
(function (root) {
'use strict';
const TD = root.TD || (typeof require === 'function' ? require('./sim.js') : null);
const { MON, TRAP, TRAPS, DIRS, WEAPONS, WPN, TECH } = TD;
const VERSION = 14;
const WIDS = WEAPONS.map(w => w.id), PJK = ['aa', 'rocket', 'nade', 'mb'];
const LIMIT = 3900;                       // 平台单条消息上限 4096 字节，留余量
const MTYPES = Object.keys(MON), TTYPES = TRAPS.map(t => t.id);
const PHASES = ['build', 'wave', 'victory', 'defeat'];
const STATES = ['move', 'block', 'queue', 'hack'];
const MREC = 13, TREC = 12;               // 单条记录字节数
const TAU = Math.PI * 2;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
const angB = a => ((Math.round(a / TAU * 256) % 256) + 256) % 256;
const bAng = b => b / 256 * TAU;
const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const bytes = o => { const s = JSON.stringify(o); return enc ? enc.encode(s).length : Buffer.byteLength(s); };

function b64enc(u8) {
  if (typeof btoa === 'function') { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  return Buffer.from(u8).toString('base64');
}
function b64dec(str) {
  if (!str) return new Uint8Array(0);
  if (typeof atob === 'function') { const s = atob(str), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  return new Uint8Array(Buffer.from(str, 'base64'));
}

/* ---------------- 记录打包 ---------------- */
function packMonsters(list) {
  const u = new Uint8Array(list.length * MREC);
  let o = 0;
  for (const m of list) {
    const id = m.id & 0xffffff;
    u[o] = id & 255; u[o + 1] = (id >> 8) & 255; u[o + 2] = (id >> 16) & 255;
    u[o + 3] = MTYPES.indexOf(m.type);
    u[o + 4] = (m.slowAmt > 0 ? 1 : 0) | (m.poisonT > 0 ? 2 : 0) | (m.burnT > 0 ? 4 : 0) | (m.stunT > 0 ? 8 : 0) | (m.enraged ? 16 : 0) | (m.hitT > 0 ? 32 : 0) | (m.launchT > 0 ? 64 : 0) | (m.cloak ? 128 : 0);
    u[o + 12] = Math.max(0, STATES.indexOf(m.state)) | (m.burrow ? 4 : 0) | (m.aiming ? 8 : 0) | (m.frozenT > 0 ? 16 : 0) | (m.champ ? 32 : 0) | (m.shield > 0 ? 64 : 0);
    const x = clamp(Math.round(m.x * 100), 0, 65535), z = clamp(Math.round(m.z * 100), 0, 65535);
    u[o + 5] = x & 255; u[o + 6] = x >> 8; u[o + 7] = z & 255; u[o + 8] = z >> 8;
    u[o + 9] = clamp(Math.round(m.y * 28), 0, 255);
    u[o + 10] = m.aiming ? angB(Math.atan2(m.ax, m.az)) : angB(Math.atan2(m.fx, m.fz));
    u[o + 11] = clamp(Math.ceil(m.hp / m.maxHp * 255), 0, 255);
    o += MREC;
  }
  return u;
}
function packTraps(list, time) {
  const u = new Uint8Array(list.length * TREC);
  let o = 0;
  for (const tr of list) {
    const id = tr.id & 0xffffff, def = TRAP[tr.type];
    u[o] = id & 255; u[o + 1] = (id >> 8) & 255; u[o + 2] = (id >> 16) & 255;
    u[o + 3] = TTYPES.indexOf(tr.type);
    u[o + 4] = tr.x; u[o + 5] = tr.z;
    u[o + 6] = (tr.dir & 3) | ((tr.lv - 1) << 2) | (tr.disT > 0 ? 16 : 0) | (tr.activeT > 0 ? 32 : 0) | (tr.br === 'a' ? 64 : tr.br === 'b' ? 128 : 0);
    u[o + 7] = def.block || tr.lane ? clamp(Math.ceil(tr.hp / tr.maxHp * 255), 0, 255) : 255;
    u[o + 8] = angB(tr.aimYaw || 0);
    u[o + 9] = clamp(Math.round((time - tr.fireT) / 0.02), 0, 255);
    const inv = clamp(Math.round(tr.invested), 0, 65535);
    u[o + 10] = inv & 255; u[o + 11] = inv >> 8;
    o += TREC;
  }
  return u;
}

/* ---------------- 事件 ---------------- */
// 字段表：pid 字段按玩家槽位编码；Infinity 编码为 -1
const SCHEMA = {
  kill: ['id', 'mtype', 'x', 'y', 'z', 'fx', 'fz', 'bounty', 'pid', 'launch'],
  core: ['dmg', 'mtype', 'x', 'y', 'z'],
  build: ['id', 'trap', 'pid', 'x', 'y', 'z'],
  upgrade: ['id', 'lv', 'x', 'y', 'z', 'br', 'trap'],
  combo: ['k', 'x', 'y', 'z'],
  devUse: ['i', 'pid'],
  sell: ['id', 'refund', 'x', 'y', 'z'],
  trap: ['kind', 'id', 'x', 'y', 'z'],
  tshot: ['id', 'x', 'y', 'z'],
  boom: ['x', 'y', 'z', 'r', 'small'],
  trapBroken: ['id', 'trap', 'x', 'y', 'z'],
  heal: ['id', 'x', 'y', 'z', 'ids'],
  emp: ['x', 'z', 'r', 'n'],
  summon: ['x', 'z', 'brood', 'drop'],
  stomp: ['x', 'z', 'r'],
  enrage: ['id', 'x', 'z'],
  phurt: ['pid', 'dmg', 'sx', 'sz'],
  pdead: ['pid'],
  respawn: ['pid'],
  spawn: ['id', 'lane', 'd'],
  waveStart: ['wave', 'total', 'name', 'tip', 'boss', 'bonus', 'count'],
  waveClear: ['wave', 'bonus'],
  boss: ['id', 'mtype', 'lane', 'laneName'],
  burrow: ['id', 'x', 'z'], surface: ['id', 'x', 'z'], hacked: ['id', 'trap', 'x', 'y', 'z'], hackStart: ['id', 'tr'],
  mshot: ['id', 'x', 'y', 'z', 'tx', 'ty', 'tz', 'hit'], boltHit: ['x', 'y', 'z'], shellFire: ['x', 'z', 'tx', 'tz', 't', 'k', 'y'], rail: ['id', 'x', 'y', 'z', 'x2', 'y2', 'z2', 'n'], aura: ['id', 'x', 'z', 'r', 'n'], shieldBreak: ['id', 'x', 'y', 'z'], blink: ['id', 'x', 'z', 'x2', 'z2'], fwave: ['x', 'z', 'yaw'], split: ['x', 'z'],
  bossPhase: ['id', 'phase', 'x', 'z'],
  laneOpen: ['lanes', 'names'],
  victory: [], defeat: [],
  pjoin: ['name'], pleave: ['name'], pready: ['pid', 'on'],
  buy: ['pid', 'w'], throw: ['pid'], rocket: ['pid'],
  strikeCall: ['pid', 'x', 'z', 'delay'], strike: ['pid', 'x', 'z', 'r'],
  research: ['pid', 'tech', 'lv'], resupply: ['pid'],
};
// 高频装饰事件只发一次，其余事件在后续快照里重复两次以抵抗丢包（客户端按序号去重）
const ONCE = new Set(['trap', 'tshot', 'spawn', 'heal', 'rocket', 'throw', 'mshot', 'boltHit', 'hackStart', 'combo', 'rail', 'aura', 'shieldBreak']);
const encVal = v => typeof v === 'number' ? (v === Infinity ? -1 : r2(v)) : typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v;

class EventOut {
  constructor() { this.sn = 0; this.q = []; }
  push(e, slotOf) {
    const sch = SCHEMA[e.type];
    if (!sch) return;
    const a = [++this.sn, e.type];
    for (const f of sch) a.push(f === 'pid' ? (e.pid ? slotOf(e.pid) : -1) : encVal(e[f]));
    this.q.push({ a, left: ONCE.has(e.type) ? 1 : 3 });
    if (this.q.length > 400) this.q.splice(0, this.q.length - 400);
  }
  // 取出不超过 budget 字节的事件；超出的留到下一帧
  take(budget) {
    const out = []; let used = 2;
    for (const it of this.q) {
      const b = bytes(it.a) + 1;
      if (used + b > budget) break;
      used += b; out.push(it.a); it.left--;
    }
    this.q = this.q.filter(it => it.left > 0);
    return out;
  }
}
function decodeEvent(a, pidOfSlot) {
  const type = a[1], sch = SCHEMA[type];
  if (!sch) return null;
  const e = { type, sn: a[0] };
  sch.forEach((f, i) => {
    let v = a[i + 2];
    if (f === 'pid') v = v >= 0 ? (pidOfSlot(v) || null) : null;
    else if (f === 'total' && v === -1) v = Infinity;
    e[f] = v;
  });
  return e;
}

/* ---------------- 主机：编码快照 ---------------- */
function encodeSnap(sim, o) {
  const s = sim.s, slotOf = pid => (s.players[pid] ? s.players[pid].slot : -1);
  const boss = s.bossId ? s.monsters.find(m => m.id === s.bossId) : null;
  const h = [sim.def.id, s.diff, s.endless ? 1 : 0, PHASES.indexOf(s.phase), s.wave, r2(s.timer), s.gold, r2(s.crystal.hp), s.crystal.max,
    s.bossId || 0, boss ? Math.ceil(boss.hp) : 0, boss ? Math.ceil(boss.maxHp) : 0, boss && boss.empT !== undefined ? r2(boss.empT) : 0, s.spawnQ.length, r2(s.time)];
  const st = [s.stats.kills, s.stats.leaks, Math.round(s.stats.dmgGun), Math.round(s.stats.dmgTrap), s.stats.built, s.stats.spent, r2(s.stats.startTime), s.stats.endlessBest || 0];
  const p = Object.values(s.players).map(q => [q.id, q.slot, q.name, r2(q.x), r2(q.y), r2(q.z), r3(q.yaw), r3(q.pitch), Math.ceil(q.hp), q.maxHp,
    (q.dead ? 1 : 0) | (q.input.fire && !q.dead && (q.remote || (q.ammo > 0 && q.reloadT <= 0)) ? 2 : 0) | (q.ready ? 4 : 0) | (q.ground ? 8 : 0),
    r2(q.respawnT), q.kills, Math.round(q.dmg), q.life || 0,
    q.guns.reduce((m, g) => m | (1 << WIDS.indexOf(g)), 0), WIDS.indexOf(q.wpn), Math.floor(q.energy), q.nades, r2(q.nadeT), q.cls || 'assault', q.nadeMax || 2, Math.ceil(q.supT || 0), r2(q.invT || 0), q.mount || 0]);
  const tt = [];
  for (const tr of s.traps) if (tr.type === 'tesla' && s.time - tr.fireT < 0.16 && tr.targets && tr.targets.length) tt.push([tr.id, ...tr.targets]);
  const pj = [];
  for (const q of s.proj) pj.push(Math.max(0, PJK.indexOf(q.kind || 'aa')), Math.round(q.x * 10), Math.round(q.y * 10), Math.round(q.z * 10), Math.round(q.vx * 10), Math.round(q.vy * 10), Math.round(q.vz * 10));
  const lv = [];
  for (const k in s.lava) lv.push(+k, Math.ceil(s.lava[k]));
  const dv = (s.devices || []).map(d => [Math.ceil(d.cd), Math.round(d.act * 10)]);
  const cf = { mut: s.mut || [], tal: s.tal || {}, daily: s.daily || null };
  const tc = TECH.map(t => (s.tech && s.tech[t.id]) | 0);
  const head = { g: o.gid, q: o.seq, k: 0, n: 1, h, st, p, tt, pj, lv, dv, cf, tc, r: o.acks || {}, e: [], tr: '', m: '' };
  // 事件：最多占用 ~1100 字节
  const baseB = bytes(head);
  head.e = o.events ? o.events.take(Math.min(1100, LIMIT - baseB - 200)) : [];
  // 陷阱、怪物二进制拼在一起后按容量切片
  const trU = packTraps(s.traps, s.time), mU = packMonsters(s.monsters);
  // base64：每 3 字节 → 4 字符；每片每种数据最多一块
  const parts = [head];
  let room = LIMIT - bytes(head) - 24;
  const add = (u, rec, key) => {
    let i = 0;
    while (i < u.length) {
      let part = parts[parts.length - 1], max = Math.floor(Math.floor(room / 4) * 3 / rec);
      if (max <= 0 || part[key]) {
        part = { g: o.gid, q: o.seq, k: parts.length, n: 1, tr: '', m: '' }; parts.push(part);
        room = LIMIT - bytes(part) - 24; max = Math.floor(Math.floor(room / 4) * 3 / rec);
      }
      const take = Math.min((u.length - i) / rec, max) * rec;
      part[key] = b64enc(u.subarray(i, i + take));
      room -= Math.ceil(take / 3) * 4;
      i += take;
    }
  };
  add(trU, TREC, 'tr');
  add(mU, MREC, 'm');
  for (const pt of parts) pt.n = parts.length;
  return parts;
}

/* ---------------- 客户端：拼装分片 ---------------- */
class Assembler {
  constructor() { this.g = null; this.q = -1; this.parts = []; this.got = 0; }
  add(msg) {
    if (!msg || typeof msg.q !== 'number' || typeof msg.k !== 'number' || !(msg.n >= 1 && msg.n <= 16)) return null;
    if (msg.g !== this.g) { this.g = msg.g; this.q = -1; }
    if (msg.q < this.q) return null;
    if (msg.q > this.q) { this.q = msg.q; this.parts = new Array(msg.n); this.got = 0; }
    if (this.parts[msg.k]) return null;
    this.parts[msg.k] = msg; this.got++;
    if (this.got < msg.n || !this.parts[0]) return null;
    const full = Object.assign({}, this.parts[0]);
    full.tr = this.parts.map(x => x.tr || '').filter(Boolean);
    full.m = this.parts.map(x => x.m || '').filter(Boolean);
    this.q += 0.5;   // 同一序号不再重复应用
    return full;
  }
}
function concatB64(list) {
  const arrs = list.map(b64dec), n = arrs.reduce((a, b) => a + b.length, 0), u = new Uint8Array(n);
  let o = 0; for (const a of arrs) { u.set(a, o); o += a.length; }
  return u;
}

/* ---------------- 客户端：把快照应用到镜像 Sim ---------------- */
// ctx: { pid: 本机玩家 id, now: 本地时钟（秒）, noEvents: 后台时丢弃特效事件 }
function applySnap(sim, snap, ctx) {
  const s = sim.s, h = snap.h, now = ctx.now;
  const info = { first: !sim._mirror, phase0: s.phase, wave0: s.wave };
  sim._mirror = true;
  // 时钟：首次直接对齐，之后缓慢追赶主机时间
  const ht = h[14];
  if (info.first || Math.abs(ht - s.time) > 1.5) s.time = ht; else s.time += (ht - s.time) * 0.1;
  const t = s.time;
  s.phase = PHASES[h[3]] || 'build'; s.wave = h[4]; s.timer = h[5]; s.gold = h[6];
  s.crystal.hp = h[7]; s.crystal.max = h[8]; s.bossId = h[9];
  s.spawnQ.length = h[13];
  const st = snap.st || [];
  Object.assign(s.stats, { kills: st[0] | 0, leaks: st[1] | 0, dmgGun: st[2] || 0, dmgTrap: st[3] || 0, built: st[4] | 0, spent: st[5] | 0, startTime: st[6] || 0 });
  if (st[7]) s.stats.endlessBest = st[7];

  // 玩家
  const seenP = new Set((snap.p || []).map(a => a[0])), slotPid = {};
  for (const pid in s.players) if (!seenP.has(pid)) delete s.players[pid];
  for (const a of snap.p || []) {
    const [pid, slot, name, x, y, z, yaw, pitch, hp, maxHp, fl, respawnT, kills, dmg, life, gmask, widx, energy, nades, nadeT, cls, nadeMax, supT, invT, mount] = a;
    slotPid[slot] = pid;
    let q = s.players[pid];
    const dead = !!(fl & 1);
    if (!q) {
      q = sim.addPlayer(pid, name, pid !== ctx.pid);
      if (!q) continue;
      sim.events.length && sim.events[sim.events.length - 1].type === 'pjoin' && sim.events.pop();
      q.x = q.ox = x; q.y = q.oy = y; q.z = q.oz = z; q.yaw = yaw; q.pitch = pitch; q.life = life;
      q.input.yaw = yaw; q.input.pitch = pitch;
      q.rx = x; q.ry = y; q.rz = z; q.ryaw = yaw;
    }
    q.slot = slot; q.name = name; q.hp = hp; q.maxHp = maxHp; q.respawnT = respawnT; q.kills = kills; q.dmg = dmg; q.ready = !!(fl & 4);
    q.guns = WIDS.filter((w, i) => gmask & (1 << i)); if (!q.guns.length) q.guns = ['rifle'];
    for (const g of q.guns) if (q.ammoBy[g] === undefined) q.ammoBy[g] = WPN[g].mag;
    q.energy = energy || 0; q.nades = nades | 0; q.nadeT = nadeT || 0; q.nadeMax = nadeMax || 2;
    q.supT = supT || 0; q.invT = invT || 0;
    if (pid === ctx.pid) q.hostMount = mount || 0; else q.mount = mount || 0;
    if (pid !== ctx.pid && typeof cls === 'string') q.cls = cls;
    if (pid !== ctx.pid && WIDS[widx]) q.wpn = WIDS[widx];
    if (pid === ctx.pid) {
      // 本机：位置由本地预测；复活或主机强制改位时才以主机为准
      if ((q.dead && !dead) || q.life !== life) {
        q.x = q.ox = x; q.y = q.oy = y; q.z = q.oz = z; q.vx = q.vy = q.vz = 0; q.ammo = q.mag; q.reloadT = 0;
        info.respawned = true;
      }
      q.dead = dead; q.life = life;
    } else {
      q.dead = dead; q.life = life;
      q.x = x; q.y = y; q.z = z; q.yaw = yaw; q.pitch = pitch; q.fire = !!(fl & 2); q.ground = !!(fl & 8);
    }
  }
  info.inGame = seenP.has(ctx.pid);

  // 陷阱
  const trU = concatB64(snap.tr || []), oldT = new Map(s.traps.map(tr => [tr.id, tr]));
  const traps = []; let changed = trU.length / TREC !== s.traps.length;
  for (let o = 0; o + TREC <= trU.length; o += TREC) {
    const id = trU[o] | (trU[o + 1] << 8) | (trU[o + 2] << 16), type = TTYPES[trU[o + 3]], def = TRAP[type];
    if (!def) continue;
    let tr = oldT.get(id);
    const b6 = trU[o + 6], lv = ((b6 >> 2) & 3) + 1;
    if (!tr) {
      changed = true;
      const x = trU[o + 4], z = trU[o + 5], dir = b6 & 3;
      tr = { id, type, br: '', kind: TD.kindOfCat(def.cat), x, z, dir, lv, owner: null, invested: def.cost, cd: 0, activeT: 0, fireT: -99, disT: 0, hurtT: 0, tgt: 0, scanT: 0, aimYaw: 0, targets: [], idx: z * sim.W + x };
      if (tr.kind === 'wall') tr.line = sim.wallLine(x, z, dir);
      if (sim.laneTurret(type, tr)) tr.lane = true;
      const w = sim.trapWorld(tr); tr.wx = w.x; tr.wy = w.y; tr.wz = w.z;
    }
    tr.lv = lv;
    const br = b6 & 64 ? 'a' : b6 & 128 ? 'b' : '';
    if (br !== tr.br) { tr.br = br; if (tr.kind === 'wall') tr.line = sim.wallLine(tr.x, tr.z, tr.dir, tr.type === 'laser' && br === 'b' ? 6 : 4); }
    tr.disT = b6 & 16 ? 1 : 0;
    tr.activeT = b6 & 32 ? 0.3 : 0;
    if (def.block || tr.lane) { tr.maxHp = (tr.lane ? TD.LANE_HP[type] : def.hp)[lv - 1]; tr.hp = trU[o + 7] / 255 * tr.maxHp; }
    tr.aimYaw = bAng(trU[o + 8]);
    const age = trU[o + 9];
    if (age < 255) { const ft = t - age * 0.02; if (Math.abs(ft - tr.fireT) > 0.05) tr.fireT = ft; } else tr.fireT = -99;
    tr.invested = trU[o + 10] | (trU[o + 11] << 8);
    traps.push(tr);
  }
  s.traps = traps;
  if (changed) sim._rebuildOcc();
  for (const a of snap.tt || []) { const tr = traps.find(x => x.id === a[0]); if (tr) tr.targets = a.slice(1); }

  // 怪物
  const mU = concatB64(snap.m || []), oldM = sim._mById, list = [], hostDt = sim._lastHT === undefined ? 0.08 : Math.max(0.02, ht - sim._lastHT);
  sim._lastHT = ht;
  for (let o = 0; o + MREC <= mU.length; o += MREC) {
    const id = mU[o] | (mU[o + 1] << 8) | (mU[o + 2] << 16), type = MTYPES[mU[o + 3]];
    if (!type) continue;
    const x = (mU[o + 5] | (mU[o + 6] << 8)) / 100, z = (mU[o + 7] | (mU[o + 8] << 8)) / 100, y = mU[o + 9] / 28;
    let m = oldM.get(id);
    if (!m) {
      m = { id, type, lane: '', d: 0, off: 0, x, y, z, ox: x, oy: y, oz: z, tx: x, ty: y, tz: z, vx: 0, vz: 0, fx: 0, fz: 1, hp: 255, maxHp: 255, slowAmt: 0, slowT: 0, poisonT: 0, burnT: 0, stunT: 0, launchT: 0, hitT: 0, atkT: 0, state: 'move', enraged: false, dead: false, leaked: false, seed: (id * 7.31) % 100, born: t };
    } else {
      m.vx = clamp((x - m.tx) / hostDt, -14, 14); m.vz = clamp((z - m.tz) / hostDt, -14, 14);
      if (Math.hypot(x - m.tx, z - m.tz) > 4) { m.x = m.ox = x; m.z = m.oz = z; m.vx = m.vz = 0; }
    }
    m.tx = x; m.ty = y; m.tz = z; m.tAt = now;
    const f = mU[o + 4], f2 = mU[o + 12];
    m.state = STATES[f2 & 3] || 'move';
    m.slowAmt = f & 1 ? 0.4 : 0; m.poisonT = f & 2 ? 1 : 0; m.burnT = f & 4 ? 1 : 0; m.stunT = f & 8 ? 1 : 0; m.enraged = !!(f & 16); m.launchT = f & 64 ? 0.3 : 0;
    m.cloak = !!(f & 128); m.burrow = !!(f2 & 4); m.aiming = !!(f2 & 8); m.frozenT = f2 & 16 ? 0.3 : 0; m.champ = !!(f2 & 32); m.shield = f2 & 64 ? 1 : 0;
    if (f & 32) m.hitT = 0.12;
    const a = bAng(mU[o + 10]);
    if (m.aiming) { m.ax = Math.sin(a); m.az = Math.cos(a); } else { m.fx = Math.sin(a); m.fz = Math.cos(a); }
    m.hp = mU[o + 11]; m.maxHp = 255;
    if (id === s.bossId && h[11]) { m.hp = h[10]; m.maxHp = h[11]; m.empT = h[12]; }
    list.push(m);
  }
  // 被移除的怪留存片刻（BOSS 死亡演出要用）
  const gone = sim._gone || (sim._gone = new Map());
  const keep = new Set(list.map(m => m.id));
  for (const [id, m] of oldM) if (!keep.has(id)) gone.set(id, Object.assign({}, m, { goneAt: now }));
  for (const [id, m] of gone) if (now - m.goneAt > 3) gone.delete(id);
  s.monsters = list;
  sim._mById.clear(); for (const m of list) sim._mById.set(m.id, m);
  sim._buildBuckets();

  // 导弹
  const pj = snap.pj || [];
  s.proj = [];
  for (let i = 0; i + 6 < pj.length; i += 7) s.proj.push({ kind: PJK[pj[i]] || 'aa', x: pj[i + 1] / 10, y: pj[i + 2] / 10, z: pj[i + 3] / 10, vx: pj[i + 4] / 10, vy: pj[i + 5] / 10, vz: pj[i + 6] / 10 });

  // 科技
  if (Array.isArray(snap.tc)) { if (!s.tech) s.tech = {}; TECH.forEach((t, i) => { s.tech[t.id] = snap.tc[i] | 0; }); }
  // 机关
  (snap.dv || []).forEach((d, i) => { if (s.devices[i]) { s.devices[i].cd = d[0]; s.devices[i].act = d[1] / 10; } });
  // 熔岩
  s.lava = {};
  const lv = snap.lv || [];
  for (let i = 0; i + 1 < lv.length; i += 2) s.lava[lv[i]] = lv[i + 1];
  // 事件（序号去重）
  const seen = sim._seenEv || (sim._seenEv = new Set());
  for (const a of snap.e || []) {
    if (!Array.isArray(a) || seen.has(a[0])) continue;
    seen.add(a[0]);
    if (ctx.noEvents) continue;
    const e = decodeEvent(a, sl => slotPid[sl]);
    if (e) sim.events.push(e);
  }
  if (seen.size > 3000) { const arr = [...seen].sort((x, y) => x - y); for (const v of arr.slice(0, 1500)) seen.delete(v); }
  info.result = snap.r && ctx.peer ? snap.r[ctx.peer] : null;
  return info;
}

/* ---------------- 客户端：每帧平滑 ---------------- */
function smoothMirror(sim, dt, now, pid) {
  const s = sim.s, k = 1 - Math.exp(-dt * 13), k2 = 1 - Math.exp(-dt * 16);
  for (const m of s.monsters) {
    const age = clamp(now - (m.tAt || now), 0, 0.22);
    const gx = m.tx + m.vx * age, gz = m.tz + m.vz * age;
    m.x += (gx - m.x) * k; m.z += (gz - m.z) * k; m.y += (m.ty - m.y) * k2;
    m.ox = m.x; m.oy = m.y; m.oz = m.z;
    if (m.hitT > 0) m.hitT = Math.max(0, m.hitT - dt);
  }
  for (const id in s.players) {
    if (id === pid) continue;
    const q = s.players[id];
    q.ox = q.x; q.oy = q.y; q.oz = q.z;
  }
  for (const q of s.proj) { q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt; }
  s.time += dt;
  if (s.phase === 'build') s.timer = Math.max(0, s.timer - dt);
  for (const k in s.lava) s.lava[k] -= dt;
  for (const id in s.players) { const q = s.players[id]; if (q.supT > 0) q.supT = Math.max(0, q.supT - dt); if (q.invT > 0) q.invT = Math.max(0, q.invT - dt); }
  for (const d of s.devices || []) { if (d.act > 0) d.act = Math.max(0, d.act - dt); else if (d.cd > 0) d.cd = Math.max(0, d.cd - dt); }
}

const api = { VERSION, LIMIT, encodeSnap, applySnap, smoothMirror, Assembler, EventOut, bytes, MTYPES, TTYPES, PHASES };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.TDNet = api;
})(typeof window !== 'undefined' ? window : globalThis);

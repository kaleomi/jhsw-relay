// 多地图校验：ASCII 地图 + 结构检查 + 脚本机器人跑平衡
const TD = require('./sim.js');
const { Sim, TILE, T, TRAP, MAP_LIST } = TD;
const only = process.argv[2];

function ascii(sim) {
  const ch = { 0: '#', 1: '.', 2: '_', 3: 'o', 4: 'B', 5: 'S' };
  const mark = new Map();
  const tmp = { x: 0, z: 0, dx: 0, dz: 0 };
  for (const l of sim.lanes) { const p = sim.paths[l]; for (let d = 0; d <= p.len; d += 0.6) { TD.pathAt(p, d, tmp); const i = Math.floor(tmp.z / T) * sim.W + Math.floor(tmp.x / T); const v = mark.get(i); mark.set(i, v && v !== l ? '+' : l); } }
  let out = '    ' + Array.from({ length: sim.W }, (_, i) => i % 10).join('') + '\n';
  for (let z = 0; z < sim.H; z++) { let r = String(z).padStart(3) + ' '; for (let x = 0; x < sim.W; x++) { const i = z * sim.W + x, t = sim.tileAt(x, z); r += (t === TILE.LANE && mark.has(i)) ? mark.get(i) : ch[t]; } out += r + '\n'; }
  return out;
}
function checks(sim) {
  const errs = [];
  const tmp = { x: 0, z: 0, dx: 0, dz: 0 };
  for (const l of sim.lanes) {
    const p = sim.paths[l];
    for (let d = 0; d <= p.len; d += 0.3) { TD.pathAt(p, d, tmp); const t = sim.tileAt(Math.floor(tmp.x / T), Math.floor(tmp.z / T)); if (t === TILE.WALL) { errs.push(`lane ${l} 穿墙 d=${d.toFixed(1)}`); break; } }
    const e = p.pts[p.pts.length - 1];
    if (Math.hypot(e.x - sim.crystalPos.x, e.z - sim.crystalPos.z) > 0.01) errs.push(`lane ${l} 终点不是水晶`);
  }
  for (const [x, z] of sim.def.pads) {
    const t = sim.tileAt(x, z);
    if (t !== TILE.PAD) errs.push(`pad ${x},${z} 被覆盖为 ${t}`);
    else { let adj = false; for (const [dx, dz] of TD.DIRS) if (sim.tileAt(x + dx, z + dz) === TILE.LANE) adj = true; if (!adj) errs.push(`pad ${x},${z} 不贴通道`); }
  }
  for (const [x, z] of sim.def.spawns) if (sim.tileAt(x, z) === TILE.WALL) errs.push(`玩家出生点 ${x},${z} 在墙里`);
  // 科研舱：物件必须在可走的地面上、背后贴墙，且从玩家出生点走得到；不能和怪物通道相连
  const reach = new Set(), q = [sim.def.spawns[0].slice()];
  const walk = (x, z) => { const t = sim.tileAt(x, z); return t === TILE.FLOOR || t === TILE.BASE || t === TILE.LANE || t === TILE.PAD; };
  while (q.length) { const [x, z] = q.pop(), k = z * sim.W + x; if (reach.has(k) || !walk(x, z)) continue; reach.add(k); for (const [dx, dz] of TD.DIRS) q.push([x + dx, z + dz]); }
  (sim.def.labs || []).forEach((lb, i) => {
    for (const o of [lb.term, lb.sup, ...lb.racks]) {
      const t = sim.tileAt(o[0], o[1]), d = TD.DIRS[o[2]];
      if (t !== TILE.FLOOR) errs.push(`科研舱${i} 物件 ${o} 不在空地上（${t}）`);
      if (!sim.solid(o[0] + d[0], o[1] + d[1])) errs.push(`科研舱${i} 物件 ${o} 背后不是墙`);
      if (!reach.has(o[1] * sim.W + o[0])) errs.push(`科研舱${i} 物件 ${o} 走不到`);
    }
    if (lb.racks.length !== TD.TECH.length) errs.push(`科研舱${i} 机柜数量不对`);
  });
  if (!(sim.def.labs || []).length) errs.push('没有科研舱');
  return errs;
}

function run(mapId, opts) {
  const sim = new Sim({ map: mapId, difficulty: opts.diff || 'normal', seed: opts.seed || 42 });
  sim.addPlayer('p1');
  const p = sim.s.players.p1;
  const foci = sim.def.foci.map(([x, z]) => ({ x: x * T, z: z * T }));
  const near = (sl, f) => { const w = sim.trapWorld(sl); return Math.hypot(w.x - f.x, w.z - f.z); };
  const slots = {};
  for (const c of ['floor', 'pad', 'wall', 'ceil']) slots[c] = sim.listSlots(c);
  let fOverride = null;
  const build = (type, fi, filter) => {
    const def = TRAP[type], f = fOverride || foci[fi % foci.length];
    const list = slots[def.cat].filter(sl => !sim.trapAtSlot(sl) && (!filter || filter(sl))).sort((a, b) => near(a, f) - near(b, f));
    for (const sl of list.slice(0, 40)) {
      const w = sim.trapWorld(sl); p.x = w.x + T * 2; p.z = w.z;
      const r = sim.apply({ t: 'build', pid: 'p1', trap: type, slot: sl });
      if (r.ok) return true;
      if (r.reason === '金币不足') return false;
    }
    return null;
  };
  // 阻挡行：focus 处路径的垂直方向三格
  const blockRow = fi => {
    const f = foci[fi % foci.length]; let best = null;
    const tmp = { x: 0, z: 0, dx: 0, dz: 0 };
    for (const l of sim.lanes) { const pth = sim.paths[l]; for (let d = 0; d < pth.len; d += 0.5) { TD.pathAt(pth, d, tmp); const dd = Math.hypot(tmp.x - f.x, tmp.z - f.z); if (!best || dd < best.dd) best = { dd, x: tmp.x, z: tmp.z, dx: tmp.dx, dz: tmp.dz }; } }
    const out = [];
    for (const k of [-1, 0, 1]) out.push({ kind: 'floor', x: Math.floor((best.x - best.dz * k * T) / T), z: Math.floor((best.z + best.dx * k * T) / T) });
    return out;
  };
  const rows = foci.map((_, i) => blockRow(i));
  const strat = () => {
    const nf = foci.length;
    // 科研：从第 3 波起按顺序研究（留 300 金币底）
    if (opts.tech && sim.s.wave >= 2) {
      const w = sim.labObj(sim.def.labs[0].term); p.x = w.x + w.dx; p.z = w.z + w.dz;
      for (const id of opts.tech) { if (sim.techCost(id) + 300 <= sim.s.gold && sim.apply({ t: 'research', pid: 'p1', tech: id }).ok) continue; break; }
    }
    // 下一波有 BOSS：把新增陷阱集中到 BOSS 路线经过的焦点
    fOverride = null;
    const pv = sim.previewWave(sim.s.wave + 1);
    if (pv.agg.boss && nf > 1) {
      const bl = pv.agg.boss.lanes[0], pth = sim.paths[bl], tmp = { x: 0, z: 0, dx: 0, dz: 0 };
      let best = null;
      for (const f of foci) { let dmin = 1e9; for (let d = 0; d < pth.len; d += 1) { TD.pathAt(pth, d, tmp); dmin = Math.min(dmin, Math.hypot(tmp.x - f.x, tmp.z - f.z)); } if (!best || dmin < best.d) best = { f, d: dmin }; }
      fOverride = best.f;
    }
    const want = [['tesla', 3 * nf], ['slow', 2 * nf], ['laser', 4 * nf], ['spike', 2 * nf], ['crusher', nf], ['aa', 2 * nf], ['sentry', nf], ['laser', 8 * nf], ['flame', 3 * nf], ['crusher', 2 * nf], ['spike', 4 * nf], ['sentry', 2 * nf], ['aa', 3 * nf], ['flame', 5 * nf], ['laser', 12 * nf], ['crusher', 4 * nf], ['laser', 20 * nf], ['flame', 10 * nf], ['spike', 8 * nf], ['crusher', 6 * nf], ['laser', 30 * nf]];
    const cnt = t => sim.s.traps.filter(x => x.type === t).length;
    const upgradeRound = (cap) => {
      let progress = true;
      while (progress) {
        progress = false;
        for (const tt of ['tesla', 'laser', 'crusher', 'aa', 'sentry', 'spike', 'flame', 'slow']) {
          const tr = sim.s.traps.filter(x => x.type === tt && x.lv < cap).sort((a, b) => a.lv - b.lv)[0];
          if (tr && sim.s.gold >= sim.upgradeCost(tr) && sim.apply({ t: 'upgrade', pid: 'p1', id: tr.id, br: process.env.BR || (tr.id % 2 ? 'a' : 'b') }).ok) progress = true;
        }
      }
    };
    outer: for (const [t, k] of want) {
      if (t === 'aa' && sim.s.wave < 3) continue;
      let guard = 0;
      while (cnt(t) < k && guard++ < 30) {
        if (t === 'tesla') {
          const fi = cnt(t) % nf; const sl = rows[fi].find(x => !sim.trapAtSlot(x)) || rows.flat().find(x => !sim.trapAtSlot(x)); if (!sl) break;
          const w = sim.trapWorld(sl); p.x = w.x + T * 3; p.z = w.z + T * 3;
          const r = sim.apply({ t: 'build', pid: 'p1', trap: 'tesla', slot: sl });
          if (!r.ok) { if (r.reason === '金币不足') break outer; break; }
          continue;
        }
        const r = build(t, cnt(t));
        if (r === false) break outer; if (r === null) break;
      }
      if (sim.s.traps.length >= 12 * nf) upgradeRound(sim.s.wave < 6 ? 2 : 3);
    }
    upgradeRound(4);
    // 余钱继续沿通道铺墙面/天花板陷阱
    let k = 0;
    while (sim.s.gold > 700 && k++ < 40) { const t = ['laser', 'flame', 'crusher', 'laser'][k % 4]; if (build(t, k) !== true) break; }
    upgradeRound(4);
  };
  const log = [];
  const dt = 1 / 30; let guard = 0;
  while (sim.s.phase !== 'victory' && sim.s.phase !== 'defeat' && guard++ < 30 * 60 * 90) {
    if (sim.s.phase === 'build') {
      if (opts.traps !== false) strat();
      const sp = sim.def.spawns[0]; p.x = (sp[0] + 0.5) * T; p.z = (sp[1] + 0.5) * T;
      sim.apply({ t: 'ready', pid: 'p1' });
    }
    // 近似玩家技能：每 60 秒一次轨道打击砸向最靠前的怪群
    if (opts.ult && sim.s.phase === 'wave') {
      p.energy = Math.min(100, p.energy + 100 / 60 * dt);
      if (p.energy >= 100) {
        let best = null, br = 1e9;
        for (const m of sim.s.monsters) { if (m.dead) continue; const rem = sim.paths[m.lane].len - m.d; if (rem < br) { br = rem; best = m; } }
        if (best) sim.apply({ t: 'ult', pid: 'p1', x: best.x, z: best.z });
      }
    }
    if (opts.gun && sim.s.phase === 'wave') {
      let best = null, br = 1e9;
      for (const m of sim.s.monsters) { if (m.dead) continue; const rem = sim.paths[m.lane].len - m.d; if (rem < br) { br = rem; best = m; } }
      if (best) sim.damage(best, opts.gun * dt, 'gun', 'p1', true);
    }
    sim.step(dt);
    for (const e of sim.drainEvents()) {
      if (e.type === 'waveClear' || e.type === 'victory' || e.type === 'defeat') log.push(`W${sim.s.wave} ${e.type} hp=${sim.s.crystal.hp} gold=${sim.s.gold} traps=${sim.s.traps.length}`);
      if (e.type === 'core' && (e.mtype === 'boss' || e.mtype === 'elite')) log.push(`  leak ${e.mtype} ${e.hp | 0}/${e.maxHp | 0}`);
      if (e.type === 'laneOpen') log.push(`  laneOpen ${e.lanes}`);
    }
    if (opts.endless && sim.s.wave >= opts.endless) break;
  }
  return { sim, log };
}

module.exports = { run };
if (require.main === module) for (const def of MAP_LIST) {
  if (only && def.id !== only) continue;
  const sim = new Sim({ map: def.id });
  console.log(`===== ${def.name} (${def.id}) ${sim.W}x${sim.H} lanes ${sim.lanes.join('')} waves ${sim.waves.length}`);
  if (process.env.ASCII) console.log(ascii(sim));
  const errs = checks(sim); console.log(errs.length ? 'ERR ' + errs.join('; ') : '结构检查通过');
  for (const l of sim.lanes) process.stdout.write(`${l}:${sim.paths[l].len.toFixed(0)} `); console.log();
  if (process.env.NOBAL) continue;
  let r = run(def.id, { traps: false }); console.log('无陷阱:', r.log.slice(-1)[0]);
  for (const diff of ['normal', 'hard', 'hell']) {
    r = run(def.id, { diff, gun: 60, ult: !process.env.NOULT, tech: process.env.TECH ? process.env.TECH.split(',') : null });
    const last = r.log.filter(l => /victory|defeat/.test(l)).pop();
    const leaks = r.log.filter(l => l.includes('leak')).length;
    console.log(`${diff}: ${last} | 精英/BOSS漏 ${leaks} | dmgTrap ${(r.sim.s.stats.dmgTrap / 1000) | 0}k`);
    if (process.env.V) console.log(r.log.join('\n'));
  }
}

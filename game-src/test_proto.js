// 联机协议往返测试：主机 Sim → 快照分片 → (乱序/丢包) → 组装 → 镜像 Sim，对比状态
const TD = require('./sim.js');
const N = require('./proto.js');
const { Sim, T, TRAP } = TD;
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL', msg); } };

function setup(map, diff) {
  const host = new Sim({ map, difficulty: diff, seed: 9, endless: true });
  host.addPlayer('H', '房主');
  host.addPlayer('C1', '小红', true);
  host.s.gold = 1e6;
  // 随机铺满陷阱
  let k = 0;
  for (const cat of ['floor', 'wall', 'ceil', 'pad']) {
    for (const sl of host.listSlots(cat)) {
      if (k++ % 3) continue;
      const types = TD.TRAPS.filter(t => t.cat === cat);
      const t = types[k % types.length];
      const p = host.s.players.H, w = host.trapWorld(sl); p.x = w.x + 1; p.z = w.z + 1;
      const r = host.apply({ t: 'build', pid: 'H', trap: t.id, slot: sl });
      if (r.ok && k % 2) host.apply({ t: 'upgrade', pid: 'H', id: r.id });
    }
  }
  return host;
}

for (const [map, extraMon] of [['station', 0], ['abyss', 0], ['furnace', 260]]) {
  const host = setup(map, 'hell');
  const mirror = new Sim({ map, difficulty: 'hell', endless: true });
  const ev = new N.EventOut(), asm = new N.Assembler();
  host.apply({ t: 'ready', pid: 'H' }); host.apply({ t: 'ready', pid: 'C1' });
  let seq = 0, maxParts = 0, maxBytes = 0, drops = 0, applied = 0, evRecv = 0, evSent = 0;
  for (let i = 0; i < extraMon; i++) host._spawn(['grunt', 'runner', 'flyer', 'brute'][i % 4], host.lanes[i % host.lanes.length], (i * 1.7) % 60);
  const evTypes = {};
  for (let tick = 0; tick < 60 * 90; tick++) {
    if (tick === 120) {
      const lb = host.def.labs[0], H = host.s.players.H, C = host.s.players.C1;
      let w = host.labObj(lb.term); H.x = w.x + w.dx; H.z = w.z + w.dz;
      ok(host.apply({ t: 'research', pid: 'H', tech: 'overclock' }).ok && host.apply({ t: 'research', pid: 'H', tech: 'repair' }).ok, `${map} research`);
      w = host.labObj(lb.sup); C.x = w.x + w.dx; C.z = w.z + w.dz; C.dead = false;
      ok(host.apply({ t: 'resupply', pid: 'C1' }).ok, `${map} resupply`);
    }
    host.step(1 / 60);
    for (const e of host.drainEvents()) { ev.push(e, pid => host.s.players[pid] ? host.s.players[pid].slot : -1); if (N.EventOut && e.type) evSent++; }
    if (host.s.phase === 'build') { host.apply({ t: 'ready', pid: 'H' }); host.apply({ t: 'ready', pid: 'C1' }); }
    if (tick % 5) continue;
    const parts = N.encodeSnap(host, { gid: 'g1', seq: ++seq, events: ev, acks: { C1: [3, [[3, { ok: true }]]] } });
    maxParts = Math.max(maxParts, parts.length);
    for (const p of parts) { const b = N.bytes(p); maxBytes = Math.max(maxBytes, b); ok(b <= 4096, `${map} part too big ${b}`); }
    // 乱序 + 5% 丢包
    const order = parts.slice().sort(() => Math.random() - 0.5);
    let full = null;
    for (const p of order) { if (Math.random() < 0.05) { drops++; continue; } const f = asm.add(JSON.parse(JSON.stringify(p))); if (f) full = f; }
    if (!full) continue;
    applied++;
    const info = N.applySnap(mirror, full, { pid: 'C1', now: tick / 60, peer: 'C1' });
    for (const e of mirror.drainEvents()) { evRecv++; evTypes[e.type] = (evTypes[e.type] || 0) + 1; }
    // 对比
    const hs = host.s, ms = mirror.s;
    ok(ms.monsters.length === hs.monsters.length, `${map} monsters ${ms.monsters.length} vs ${hs.monsters.length}`);
    ok(ms.traps.length === hs.traps.length, `${map} traps`);
    ok(ms.gold === hs.gold && ms.wave === hs.wave && ms.phase === hs.phase, `${map} header`);
    for (const m of hs.monsters) {
      const mm = mirror._mById.get(m.id & 0xffffff);
      if (!mm) { ok(false, `${map} missing mon ${m.id}`); break; }
      if (Math.abs(mm.tx - m.x) > 0.011 || Math.abs(mm.tz - m.z) > 0.011 || mm.type !== m.type) { ok(false, `${map} mon pos ${m.id}`); break; }
    }
    for (const tr of hs.traps) {
      const t2 = ms.traps.find(x => x.id === tr.id);
      if (!t2 || t2.lv !== tr.lv || t2.type !== tr.type || Math.abs(t2.wx - tr.wx) > 1e-6 || t2.invested !== Math.round(tr.invested)) { ok(false, `${map} trap ${tr.id}`); break; }
      if (mirror.trapAtSlot(tr) !== t2) { ok(false, `${map} occ ${tr.id}`); break; }
    }
    ok(info.inGame && Object.keys(ms.players).length === 2, `${map} players`);
    ok(JSON.stringify(ms.tech) === JSON.stringify(hs.tech), `${map} tech ${JSON.stringify(ms.tech)}`);
    ok(Math.abs((ms.players.C1.supT || 0) - (hs.players.C1.supT || 0)) <= 1.5, `${map} supT ${ms.players.C1.supT} ${hs.players.C1.supT} ${tick}`);
    ok(info.result && info.result[0] === 3, `${map} acks`);
    N.smoothMirror(mirror, 1 / 12, tick / 60 + 0.05, 'C1');
    if (hs.phase === 'defeat' || hs.phase === 'victory') break;
  }
  console.log(`${map}: wave ${host.s.wave} ${host.s.phase} snaps ${seq} applied ${applied} drops ${drops} maxParts ${maxParts} maxBytes ${maxBytes} traps ${host.s.traps.length} events sent ${evSent} recv ${evRecv}`);
  console.log('   ', Object.entries(evTypes).map(([k, v]) => k + ':' + v).join(' '));
}
console.log(fails ? `${fails} 项失败` : '协议往返测试全部通过');

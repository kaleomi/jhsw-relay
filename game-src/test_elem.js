// 克制系统与新内容的无头测试：node test_elem.js
const TD = require('./sim.js');
const { Sim, T, MON } = TD;
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL', msg); } else console.log('ok  ', msg); };
const mk = () => { const s = new Sim({ map: 'station', difficulty: 'normal', seed: 3 }); s.addPlayer('p1'); s.s.gold = 99999; return s; };
const lane = s => s.lanes[0];
const place = (s, type, kind) => {
  const p = s.s.players.p1;
  for (const sl of s.listSlots(TD.TRAP[type].cat)) {
    const w = s.trapWorld(Object.assign({ type }, sl)); p.x = w.x + T * 2; p.z = w.z;
    const r = s.apply({ t: 'build', pid: 'p1', trap: type, slot: sl });
    if (r.ok) return s.s.traps[s.s.traps.length - 1];
  }
  return null;
};
// 把怪放到陷阱格上，不让它走
const pin = (s, m, x, z) => { m.x = x; m.z = z; m.ox = x; m.oz = z; m.stunT = 99; };

// 1) 克制倍率
{
  const s = mk(); const m = s._spawn('magma', lane(s), 5); m.hp = m.maxHp = 1e6;
  s._src = 'flame'; ok(s.damage(m, 100, 'trap') === 0, '熔岩傀儡免疫火焰');
  s._src = 'frost'; ok(Math.abs(s.damage(m, 100, 'trap') - 170) < 1, '熔岩傀儡吃寒冰 ×2（扣护甲后 170）');
  ok(s.events.some(e => e.type === 'immune'), '免疫时发 immune 事件');
  const b = s._spawn('boss', lane(s), 5); b.hp = b.maxHp = 1e6; s._src = 'laser';
  ok(Math.abs(s.damage(b, 100, 'trap') - 80 * 1.25) < 1, 'BOSS 的克制只算一半（重甲吃能量 ×1.25）');
}
// 2) 急冻喷口：连续喷中冻住
{
  const s = mk(); const tr = place(s, 'frost'); ok(!!tr, '能放急冻喷口');
  const m = s._spawn('grunt', lane(s), 5); m.hp = m.maxHp = 1e6; pin(s, m, tr.wx, tr.wz); m.stunT = 0; m.state = 'move';
  let froze = false;
  for (let i = 0; i < 30 * 8; i++) { m.x = tr.wx; m.z = tr.wz; m.d = 5; s.step(1 / 30); for (const e of s.drainEvents()) if (e.type === 'freeze') froze = true; }
  ok(froze, '急冻喷口把普通怪冻住');
  const f = s._spawn('frostguard', lane(s), 5); f.hp = f.maxHp = 1e6;
  ok(!s._chill(f, 5) && !(f.frozenT > 0), '寒霜卫兵免疫冰冻');
}
// 3) 酸蚀池：挂腐蚀，护甲减半、受伤提高
{
  const s = mk(); const tr = place(s, 'acid'); ok(!!tr, '能放酸蚀池');
  const m = s._spawn('brute', lane(s), 5); m.hp = m.maxHp = 1e6;
  for (let i = 0; i < 30; i++) { m.x = tr.wx; m.z = tr.wz; m.stunT = 1; s.step(1 / 30); }
  ok(m.acidT > 0, '踩酸池挂上腐蚀');
  s._src = 'crusher'; const a = s.damage(m, 100, 'trap');
  ok(Math.abs(a - 100 * 0.85 * 0.75 * 1.25) < 1, `腐蚀时护甲减半、伤害 +25%（${a.toFixed(1)}）`);
}
// 4) 电弧网：打得到空中，对机械 ×1.5
{
  const s = mk(); const tr = place(s, 'arc'); ok(!!tr && tr.line && tr.line.length > 0, '能放电弧网');
  const i0 = tr.line[1] || tr.line[0], x = (i0 % s.W + 0.5) * T, z = (Math.floor(i0 / s.W) + 0.5) * T;
  const m = s._spawn('swarm', lane(s), 5); m.hp = m.maxHp = 1e6;
  let hp0 = m.hp;
  for (let i = 0; i < 30; i++) { m.x = x; m.z = z; s.step(1 / 30); }
  ok(m.hp < hp0, '电弧网电到空中的蜂群');
}
// 5) 孢子巨兽：没烧死就裂开，烧死不裂
{
  const s = mk(); const m = s._spawn('sporer', lane(s), 8); s._src = 'crusher'; s.damage(m, 1e7, 'trap', null, true); s._reap();
  ok(s.s.monsters.filter(o => o.type === 'spore').length === 4, '孢子巨兽裂成 4 个孢子');
  const s2 = mk(); const m2 = s2._spawn('sporer', lane(s2), 8); s2._src = 'flame'; s2.damage(m2, 1e7, 'trap', null, true); s2._reap();
  ok(s2.s.monsters.filter(o => o.type === 'spore').length === 0, '被火烧死的孢子巨兽不会裂开');
}
// 6) 重盾推土者：正面挡枪
{
  const s = mk(); const p = s.s.players.p1; const m = s._spawn('juggernaut', lane(s), 8); m.hp = m.maxHp = 1e6;
  p.x = m.x + m.fx * 6; p.z = m.z + m.fz * 6; const front = s.damage(m, 100, 'gun', 'p1');
  p.x = m.x - m.fx * 6; p.z = m.z - m.fz * 6; const back = s.damage(m, 100, 'gun', 'p1');
  ok(front < back * 0.3, `重盾正面挡枪（正面 ${front.toFixed(0)} / 背后 ${back.toFixed(0)}）`);
}
// 7) 武器：电弧枪跳跃、喷枪射程、冰霜射线冻结
{
  const s = mk(); const p = s.s.players.p1; s.apply({ t: 'buy', pid: 'p1', w: 'arcgun' });
  ok(p.wpn === 'arcgun', '买到电弧枪');
  const a = s._spawn('grunt', lane(s), 8), others = [1, 2, 3].map(k => s._spawn('grunt', lane(s), 8 + k * 1.2));
  for (const m of [a, ...others]) { m.hp = m.maxHp = 1e6; }
  p.x = a.x + a.fx * 8; p.z = a.z + a.fz * 8; p.y = 0;
  p.yaw = Math.atan2(-(a.x - p.x), -(a.z - p.z)); p.pitch = Math.atan2(MON.grunt.body[0] - 1.62, Math.hypot(a.x - p.x, a.z - p.z)); p.bloom = 0;
  const r = s.traceFire(p, () => 0.5);
  ok(r.hits.length >= 3 && r.hits.some(h => h.chain), `电弧枪跳到附近敌人（命中 ${r.hits.length}）`);
  s.apply({ t: 'buy', pid: 'p1', w: 'flamer' });
  p.x = a.x + a.fx * 20; p.z = a.z + a.fz * 20; p.yaw = Math.atan2(-(a.x - p.x), -(a.z - p.z)); p.pitch = Math.atan2(MON.grunt.body[0] - 1.62, 20);
  ok(s.traceFire(p, () => 0.5).hits.length === 0, '烈焰喷枪打不到 20 米外');
  s.apply({ t: 'buy', pid: 'p1', w: 'cryo' });
  let froze = false; for (let i = 0; i < 20; i++) { s.damage(a, 10, 'gun', 'p1'); if (a.frozenT > 0) froze = true; }
  ok(froze, '冰霜射线连续命中把敌人冻住');
}
console.log(fails ? `${fails} 项失败` : '克制系统测试全部通过');
process.exit(fails ? 1 : 0);

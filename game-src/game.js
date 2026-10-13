/* ============================================================
 * 晶核守卫 · 客户端（第一人称输入、渲染、特效、音效、HUD）
 * 单机：命令直接交给 Sim；联机：见「网络层」，房主权威 + 快照广播，
 * 队友端维护镜像 Sim，渲染代码两端通用。
 * ============================================================ */
(function () {
'use strict';
const TD = window.TD;
const { Sim, T, WALL_H, PLAT_H, FLY_Y, TILE, DIRS, MON, TRAPS, TRAP, MAPS, MAP_LIST, DIFFS, MAX_LV, CAT_NAME, pathAt, WEAPONS, WPN, SKILL, EVO, COMBOS, DEVICE, MUTATORS, MUT, TALENTS, CLASSES, CLS, dailySpec } = TD;
const $ = id => document.getElementById(id);
const canvas = $('view');
const STEP = 1 / 60;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const rnd = (a, b) => a + Math.random() * (b - a);

let E = null;
try { E = Engine.create(canvas); } catch (err) { console.error(err); }
if (!E) {
  $('menuErr').hidden = false;
  $('menuErr').textContent = '当前浏览器不支持 WebGL2，无法运行游戏。请使用最新版 Chrome / Edge / Firefox / Safari。';
  return;
}

/* ---------------- 模型资源（构建时烘焙，见 tools/bake.py） ---------------- */
const ASSETS = {};
(function loadAssets() {
  const src = window.TD_ASSETS;
  if (!src) return;
  const dec = (b64, T) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new T(u8.buffer); };
  for (const name in src) {
    const a = src[name];
    try {
      E.addMesh(name, { pos: dec(a.pos, Float32Array), nrm: dec(a.nrm, Int8Array), col: dec(a.col, Uint8Array), jnt: dec(a.jnt, Uint8Array), wgt: dec(a.wgt, Uint8Array), idx: dec(a.idx, a.i32 ? Uint32Array : Uint16Array), bones: dec(a.bones, Uint16Array), nb: a.nb, nf: a.nf });
      ASSETS[name] = { clips: a.clips, info: a.info };
    } catch (err) { console.warn('模型加载失败', name, err); }
  }
  try { delete window.TD_ASSETS; } catch (e) { window.TD_ASSETS = null; }
})();
const hasModel = n => !!ASSETS[n];
// 选择动画帧：t 为片段内时间（秒）；循环片段取模，非循环片段停在最后一帧
function animClip(asset, clip, t) {
  const A = ASSETS[asset], C = A && (A.clips[clip] || A.clips.bind);
  if (!C) { E.anim(); return; }
  if (C.n <= 1 || !C.dur) { E.anim(C.row, C.row, 0); return; }
  if (C.loop) {
    let f = ((t / C.dur) % 1 + 1) % 1 * C.n;
    const i = Math.floor(f) % C.n, j = (i + 1) % C.n;
    E.anim(C.row + i, C.row + j, f - Math.floor(f));
  } else {
    const f = clamp(t * 30, 0, C.n - 1), i = Math.floor(f), j = Math.min(C.n - 1, i + 1);
    E.anim(C.row + i, C.row + j, f - i);
  }
}
function animStatic(asset) { const A = ASSETS[asset]; if (A) { const C = A.clips.bind || Object.values(A.clips)[0]; E.anim(C.row, C.row, 0); } }

/* ---------------- 设置 ---------------- */
const settings = { sens: 1.0, vol: 0.7, music: 0.5, bloom: true, fov: 75, autoReady: false, keys: {}, tb: { pos: {}, scale: 1, alpha: 1 } };
try { Object.assign(settings, JSON.parse(localStorage.getItem('jhsw-settings') || '{}')); } catch (e) { /* 无存储 */ }
if (!settings.keys || typeof settings.keys !== 'object') settings.keys = {};
if (!settings.tb || typeof settings.tb !== 'object') settings.tb = { pos: {}, scale: 1, alpha: 1 };
if (!settings.tb.pos) settings.tb.pos = {};
/* ---------- 按键绑定：动作以默认键位命名，玩家改键后按「实际按键 → 默认键位」翻译 ---------- */
const KEY_ACTIONS = [
  ['KeyW', '前进'], ['KeyS', '后退'], ['KeyA', '左移'], ['KeyD', '右移'], ['Space', '跳跃'], ['ShiftLeft', '冲刺'],
  ['KeyR', '换弹'], ['KeyQ', '步枪 / 切换武器'], ['KeyC', '手雷'], ['KeyZ', '轨道打击'], ['KeyB', '军械库'], ['KeyF', '互动（机关 / 科研舱）'],
  ['KeyE', '升级陷阱'], ['KeyX', '拆除陷阱'], ['KeyG', '准备 / 提前开战'], ['KeyT', '标记'], ['KeyV', '快捷消息'], ['KeyM', '大地图'], ['KeyH', '图鉴'], ['KeyP', '暂停'],
];
const KEY_FIXED = new Set(['Enter', 'NumpadEnter', 'Escape', 'Tab', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'F1']);
let keyInv = new Map(), keyAway = new Set();
function rebuildKeys() {
  keyInv = new Map(); keyAway = new Set();
  for (const [act] of KEY_ACTIONS) {
    const b = settings.keys[act];
    if (b && b !== act) { keyInv.set(b, act); keyAway.add(act); }
  }
  for (const b of keyInv.keys()) keyAway.delete(b);   // 被别的动作占用的默认键，以占用者为准
}
rebuildKeys();
function remapKey(code) {
  if (keyInv.has(code)) return keyInv.get(code);
  if (keyAway.has(code)) return null;
  if (code === 'ShiftRight' && keyAway.has('ShiftLeft')) return null;
  return code;
}
function keyOf(act) { return settings.keys[act] || act; }
function keyName(code) {
  if (!code) return '—';
  const N = { Space: '空格', ShiftLeft: '左 Shift', ShiftRight: '右 Shift', ControlLeft: '左 Ctrl', ControlRight: '右 Ctrl', AltLeft: '左 Alt', AltRight: '右 Alt', Tab: 'Tab', CapsLock: 'Caps', Enter: '回车', Backspace: '退格', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Mouse3: '鼠标中键', Mouse4: '鼠标侧键 1', Mouse5: '鼠标侧键 2' };
  if (N[code]) return N[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return '小键盘 ' + code.slice(6);
  return code;
}
function saveSettings() { try { localStorage.setItem('jhsw-settings', JSON.stringify(settings)); } catch (e) { /* 忽略 */ } }

/* ============================================================
 * 网络层
 * 单机：命令直接交给 Sim。
 * 联机（claude.ai 房间通道）：房主运行权威 Sim，按 ~12Hz 广播快照；
 * 队友在本地预测自己的移动与射击，通过 presence 上报位置和带序号的命令。
 * ============================================================ */
let PID = 'p1';
const NP = window.TDNet;
const MP = {
  room: null, status: 'init', connected: false, me: null, lobbyPeers: [],
  role: 'solo',              // solo | host | client
  game: null, code: '', gid: null, hostPeer: null, hostPres: null, unsub: [],
  roster: [], full: [], pres: new Map(), lastSeq: new Map(), results: new Map(),
  ev: null, seq: 0, lastSnap: 0, lastParts: 1, sentAd: '', sentHost: '',
  asm: null, pending: [], cmdSeq: 0, dmgBuf: new Map(), lastPres: 0, sentPres: '',
  name: '', err: '', joining: false, lastSnapAt: 0,
};
try { MP.name = (localStorage.getItem('jhsw-nick') || '').slice(0, 12); } catch (e) { /* 无存储 */ }
if (!MP.name) MP.name = '特工' + Math.floor(100 + Math.random() * 900);
const NET_CMDS = new Set(['build', 'upgrade', 'sell', 'ready', 'dmg', 'buy', 'rocket', 'nade', 'ult', 'use', 'research', 'resupply']);
const cleanName = v => String(v || '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').trim().slice(0, 12);
const r2n = v => Math.round(v * 100) / 100, r3n = v => Math.round(v * 1000) / 1000;
const TEAM_COL = [[0.37, 0.89, 1], [1, 0.71, 0.28], [0.42, 0.94, 0.64], [0.85, 0.55, 1]];
const TEAM_CSS = ['#5fe3ff', '#ffb547', '#6cf0a4', '#d98cff'];

// 统一命令入口：单机 / 房主同步执行；队友排队上报，结果异步回调
function netCmd(cmd, cb) {
  cmd.pid = PID;
  if (MP.role !== 'client') { const r = sim ? sim.apply(cmd) : { ok: false }; if (cb) cb(r); return r; }
  const c = Object.assign({}, cmd); delete c.pid;
  MP.pending.push({ seq: ++MP.cmdSeq, cmd: c, cb, t: performance.now() });
  if (MP.pending.length > 24) MP.pending.splice(0, MP.pending.length - 24);
  clientPresence(true);
  return { ok: true, pending: true };
}
const LocalNet = { get sim() { return sim; }, send(cmd) { return netCmd(cmd); } };

/* ---------- 房间通道 ---------- */
// 联机通道：自建中转服务器（同源部署 / 手动填写的地址）优先，其次 claude.ai 房间服务
const HAS_CLAUDE = !!(window.claude && typeof window.claude.use === 'function');
function savedServer() { try { return localStorage.getItem('jhsw-server') || ''; } catch (e) { return ''; } }
function relayBase() {
  if (window.__RELAY_SAME_ORIGIN && /^https?:$/.test(location.protocol)) return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  if (HAS_CLAUDE) return '';
  return window.JHSWRelay ? JHSWRelay.normalize(savedServer() || window.__RELAY_DEFAULT || '') : '';
}
async function initRoom() {
  try {
    const relay = relayBase();
    MP.via = relay ? 'relay' : HAS_CLAUDE ? 'claude' : 'none'; MP.server = relay;
    if (!relay && !HAS_CLAUDE) throw new Error('no transport');
    const room = relay ? JHSWRelay.connect(relay) : await window.claude.use('room');
    if (!room) throw new Error('no room');
    if (room.ready) room.ready.catch(() => {});
    MP.room = room; MP.status = 'on';
    room.onConnection(c => { MP.connected = c; renderMP(); }, err => { MP.status = 'off'; MP.err = err && err.code; renderMP(); });
    room.onPeers(ch => {
      MP.lobbyPeers = ch.peers;
      const me = ch.peers.find(p => p.sameTab);
      if (me && !MP.me) MP.me = me.peer;
      renderMP();
    }, err => { MP.status = 'off'; MP.err = err && err.code; renderMP(); });
  } catch (e) { MP.status = 'off'; }
  renderMP();
}
// 更换服务器地址：断开旧连接后重新初始化
function setServer(addr) {
  const base = window.JHSWRelay ? JHSWRelay.normalize(addr) : '';
  if (addr && !base) { mpNote('服务器地址格式不对，例如 jhsw-relay.你的名字.workers.dev', true); return; }
  try { localStorage.setItem('jhsw-server', addr ? base : ''); } catch (e) { /* 无存储 */ }
  if (MP.role !== 'solo') leaveRoom(true);
  if (MP.room && MP.room.leave) MP.room.leave().catch(() => {});
  Object.assign(MP, { room: null, me: null, status: 'init', connected: false, lobbyPeers: [] });
  mpNote(base ? '正在连接 ' + base.replace(/^wss?:\/\//, '') + ' …' : '');
  initRoom();
}
function myPeer() {
  if (MP.me) return MP.me;
  const me = MP.room && MP.room.peers().find(p => p.sameTab);
  if (me) MP.me = me.peer;
  return MP.me;
}
function roomCode() { const A = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)]; return s; }
function setNick(v) { MP.name = cleanName(v) || MP.name; try { localStorage.setItem('jhsw-nick', MP.name); } catch (e) { /* 无存储 */ } if (MP.role === 'host') hostPresence(); else if (MP.role === 'client') clientPresence(true); }

// 房间密码摘要（不在网络上传明文）：FNV-1a 双 32 位 → 16 位十六进制
function pwKey(code, pw) {
  if (!pw) return '';
  const str = 'jhsw:' + code + ':' + pw;
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); a = Math.imul(a ^ c, 16777619) >>> 0; b = Math.imul(b ^ c, 0x5bd1e995) >>> 0; b ^= b >>> 13; }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
async function createRoom() {
  if (!MP.room || MP.role !== 'solo' || MP.joining) return;
  const me = myPeer();
  if (!me) { mpNote('还没连上联机服务，请稍候再试', true); return; }
  MP.joining = true; renderMP();
  const code = roomCode();
  const pw = ($('roomPw').value || '').trim().slice(0, 16), key = pwKey(code, pw);
  try {
    const g = await MP.room.join('jhsw-' + code, { pw: key });
    // 先试发一条，确认有权限广播快照
    try { await g.emit('snap', { hi: 1 }); }
    catch (e) {
      await g.leave().catch(() => {});
      MP.joining = false;
      mpNote(e && e.code === 'not_permitted' ? '你对这个页面只有查看权限，不能当房主，但可以加入别人的房间。' : '创建房间失败，请稍后再试', true);
      renderMP(); return;
    }
    Object.assign(MP, { game: g, role: 'host', code, roster: [], full: [], deny: [], pw, pk: key, gid: null, hostPeer: me, ev: new NP.EventOut(), sentAd: '', sentHost: '' });
    MP.pres.clear(); MP.lastSeq.clear(); MP.results.clear();
    PID = me;
    MP.unsub.push(g.onPeers(hostPeers, err => roomLost(err)));
    hostPresence(); lobbyAd();
    mpNote(pw ? `房间已创建（密码：${pw}），把密码告诉队友。也可以直接开始，中途有人加入会出现在你的出生点。` : '房间已创建，等待队友加入。也可以直接开始，中途有人加入会出现在你的出生点。');
  } catch (e) { mpNote('创建房间失败：' + ((e && e.code) || '网络错误'), true); }
  MP.joining = false; renderMP();
}
async function joinRoom(code, hostPeer, pw) {
  if (!MP.room || MP.role !== 'solo' || MP.joining) return;
  const key = pwKey(code, (pw || '').trim());
  const me = myPeer();
  if (!me) { mpNote('还没连上联机服务，请稍候再试', true); return; }
  MP.joining = true; renderMP();
  try {
    const g = await MP.room.join('jhsw-' + code, { pw: key });
    Object.assign(MP, { game: g, role: 'client', code, hostPeer, pk: key, pwFor: '', hostPres: null, gid: null, asm: new NP.Assembler(), pending: [], sentPres: '', lastSnapAt: 0 });
    MP.dmgBuf.clear();
    PID = me;
    MP.unsub.push(g.on('snap', onSnapMsg, err => roomLost(err)));
    MP.unsub.push(g.onPeers(clientPeers, err => roomLost(err)));
    clientPresence(true);
    mpNote('已加入房间，等待房主开始游戏…');
    setTimeout(() => { if (MP.role === 'client' && MP.code === code && !MP.hostPres) { leaveRoom(); mpNote('没有找到房主，房间可能已解散', true); } }, 8000);
  } catch (e) { mpNote(e && e.code === 'bad_password' ? '房间密码不对' : e && e.code === 'room_full' ? '房间已满' : '加入失败：' + ((e && e.code) || '网络错误'), true); }
  MP.joining = false; renderMP();
}
function roomLost(err) {
  if (MP.role === 'solo') return;
  const wasPlaying = mode !== 'menu';
  leaveRoom(true);
  mpNote('与房间的连接中断' + (err && err.code ? `（${err.code}）` : ''), true);
  if (wasPlaying) toMenu();
}
async function leaveRoom(silent) {
  const g = MP.game, role = MP.role;
  for (const u of MP.unsub) { try { u(); } catch (e) { /* 忽略 */ } }
  MP.unsub = [];
  Object.assign(MP, { game: null, role: 'solo', code: '', gid: null, hostPeer: null, hostPres: null, roster: [], full: [], deny: [], pw: '', pk: '', asm: null, pending: [] });
  PID = 'p1';
  if (role === 'host' && MP.room) MP.room.presence({ ad: null }).catch(() => {});
  if (g) g.leave().catch(() => {});
  if (!silent) mpNote('');
  refreshSel(); renderMP();
}

/* ---------- 房主 ---------- */
function hostPeers(ch) {
  peerSignals(ch.peers);
  const me = myPeer();
  for (const p of ch.peers) if (!p.isMe && p.kind === 'viewer') MP.pres.set(p.peer, p.presence || {});
  for (const p of ch.left) {
    MP.pres.delete(p.peer);
    const i = MP.roster.indexOf(p.peer);
    if (i >= 0) { MP.roster.splice(i, 1); if (sim && MP.gid) sim.removePlayer(p.peer); }
    MP.full = MP.full.filter(x => x !== p.peer);
    MP.deny = (MP.deny || []).filter(x => x !== p.peer);
  }
  for (const p of ch.peers) {
    if (p.peer === me || p.isMe || p.kind !== 'viewer') continue;
    const pr = p.presence || {};
    if (pr.v !== NP.VERSION || pr.host) continue;
    if (MP.pk && pr.pk !== MP.pk) { if (!MP.deny.includes(p.peer)) MP.deny.push(p.peer); continue; }
    if (!MP.roster.includes(p.peer) && !MP.full.includes(p.peer)) {
      if (MP.roster.length < 3) {
        MP.roster.push(p.peer);
        if (sim && MP.gid && mode !== 'menu') sim.addPlayer(p.peer, cleanName(pr.n) || '队友', true, pr.tal, pr.cls);
      } else MP.full.push(p.peer);
    }
    if (sim && MP.gid && sim.s.players[p.peer]) sim.s.players[p.peer].name = cleanName(pr.n) || '队友';
  }
  hostPresence(); lobbyAd(); renderMP();
}
function hostPresence() {
  if (MP.role !== 'host' || !MP.game) return;
  const gc = gameCfg();
  const pr = { v: NP.VERSION, host: 1, n: MP.name, code: MP.code, pg: MP.ping || null, qc: MP.qc || null, ch: MP.ch || null, cfg: { m: gc.map, d: gc.diff, e: gc.endless ? 1 : 0, mo: selMode, mut: gc.mut, dl: gc.daily || '' }, ph: MP.gid && mode !== 'menu' ? 'play' : 'lobby', gid: MP.gid, roster: [myPeer(), ...MP.roster], full: MP.full, deny: MP.deny || [], lk: MP.pk ? 1 : 0 };
  const key = JSON.stringify(pr);
  if (key === MP.sentHost) return;
  MP.sentHost = key;
  MP.game.presence(pr).catch(() => {});
}
function lobbyAd() {
  if (MP.role !== 'host' || !MP.room) return;
  const s = sim && MP.gid && mode !== 'menu' ? sim.s : null;
  const gc = gameCfg();
  const ad = { v: NP.VERSION, c: MP.code, n: MP.name, m: gc.map, d: gc.diff, e: gc.endless ? 1 : 0, mo: selMode, mu: gc.mut.length, p: 1 + MP.roster.length, ph: s ? 'play' : 'lobby', w: s ? s.wave : 0, lk: MP.pk ? 1 : 0 };
  const key = JSON.stringify(ad);
  if (key === MP.sentAd) return;
  MP.sentAd = key;
  MP.room.presence({ ad }).catch(() => {});
}
function hostStartGame() {
  if (MP.role !== 'host') return;
  const gc = gameCfg();
  const S = new Sim({ map: gc.map, endless: gc.endless, difficulty: gc.diff, seed: gc.seed, mut: gc.mut, tal: PROG.team(), daily: gc.daily });
  S.addPlayer(PID, MP.name, false, PROG.personal(), selCls);
  for (const peer of MP.roster) { const pr = MP.pres.get(peer) || {}; S.addPlayer(peer, cleanName(pr.n) || '队友', true, pr.tal, pr.cls); }
  S.drainEvents();
  MP.gid = 'g' + Math.floor(Math.random() * 1e9).toString(36);
  MP.ev = new NP.EventOut(); MP.results.clear(); MP.lastSnap = 0;
  beginPlay(S, true);
  hostPresence(); lobbyAd();
}
// 每个模拟步之前：应用队友的位置与命令
function hostPump() {
  for (const peer of MP.roster) {
    const pr = MP.pres.get(peer), p = sim.s.players[peer];
    if (!pr || !p || pr.gid !== MP.gid) continue;
    const n = cleanName(pr.n); if (n && n !== p.name) p.name = n;
    if (pr.cls && pr.cls !== p.cls && sim.s.wave === 0) sim.setClass(p, pr.cls);
    const st = pr.s;
    if (Array.isArray(st) && st.length >= 7 && st.slice(0, 5).every(Number.isFinite)) {
      sim.apply({ t: 'pos', pid: peer, x: clamp(st[0], 0, sim.W * T), y: clamp(st[1], 0, WALL_H), z: clamp(st[2], 0, sim.H * T), yaw: st[3], pitch: clamp(st[4], -1.5, 1.5), fire: !!(st[5] & 1), life: st[6], wpn: WEAPONS[st[7] | 0] ? WEAPONS[st[7] | 0].id : 'rifle', mount: st[8] | 0 });
    }
    if (!Array.isArray(pr.c)) continue;
    let last = MP.lastSeq.get(peer) || 0;
    for (const it of pr.c) {
      if (!Array.isArray(it)) continue;
      const seq = it[0], cmd = it[1];
      if (!(seq > last) || !cmd || typeof cmd !== 'object') continue;
      last = seq;
      if (!NET_CMDS.has(cmd.t)) continue;
      const r = sim.apply(Object.assign({}, cmd, { pid: peer }));
      if (cmd.t !== 'dmg') {
        const res = MP.results.get(peer) || [];
        res.push([seq, { ok: !!r.ok, reason: r.reason || '', refund: r.refund || 0, bonus: r.bonus || 0, n: r.n || 0, of: r.of || 0, waiting: !!r.waiting }]);
        while (res.length > 6) res.shift();
        MP.results.set(peer, res);
      }
    }
    MP.lastSeq.set(peer, last);
  }
}
function hostCollect() {
  const slotOf = pid => (sim.s.players[pid] ? sim.s.players[pid].slot : -1);
  for (const e of sim.events) MP.ev.push(e, slotOf);
}
function hostSend(force) {
  if (MP.role !== 'host' || !MP.game || !MP.gid || !sim) return;
  const now = performance.now();
  const hz = MP.lastParts > 1 ? Math.max(6, 24 / MP.lastParts) : 12;
  if (!force && now - MP.lastSnap < 1000 / hz) return;
  MP.lastSnap = now;
  if (!MP.roster.length) { MP.ev.q.length = 0; return; }
  const acks = {};
  for (const peer of MP.roster) acks[peer] = [MP.lastSeq.get(peer) || 0, MP.results.get(peer) || []];
  let parts;
  try { parts = NP.encodeSnap(sim, { gid: MP.gid, seq: ++MP.seq, events: MP.ev, acks }); }
  catch (e) { console.warn('快照编码失败', e); return; }
  MP.lastParts = parts.length;
  for (const p of parts) MP.game.emit('snap', p).catch(err => { if (err && err.code === 'not_permitted') { mpNote('没有广播权限，联机已停止', true); } });
  lobbyAd();
}

/* ---------- 队友（客户端） ---------- */
function clientPeers(ch) {
  peerSignals(ch.peers);
  const host = ch.peers.find(p => p.peer === MP.hostPeer) || ch.peers.find(p => p.presence && p.presence.host === 1 && !p.isMe);
  if (!host) {
    if (MP.hostPres && ch.left.some(p => p.peer === MP.hostPeer)) {
      const wasPlaying = mode !== 'menu';
      leaveRoom(true); mpNote('房主已离开，房间解散', true);
      if (wasPlaying) toMenu();
    }
    return;
  }
  const pr = host.presence || {};
  if (!pr.host) return;
  MP.hostPeer = host.peer;
  if (pr.v !== NP.VERSION) { leaveRoom(true); mpNote('房主的游戏版本和你不一样，请双方都刷新页面后再试', true); return; }
  MP.hostPres = pr;
  if (Array.isArray(pr.full) && pr.full.includes(myPeer())) { leaveRoom(true); mpNote('房间已满（最多 4 人）', true); return; }
  if (Array.isArray(pr.deny) && pr.deny.includes(myPeer())) { const c = MP.code; leaveRoom(true); MP.pwFor = c; mpNote('房间密码不对', true); return; }
  // 房主回到大厅：队友也回到大厅
  if (pr.ph === 'lobby' && MP.gid && mode !== 'menu') { MP.gid = null; toMenu(); mpNote('房主已返回大厅'); }
  // 只有房主状态或成员变化时才刷新菜单（队友 presence 每秒更新多次）
  const key = JSON.stringify(pr) + ch.peers.map(p => p.peer + ':' + (p.presence && p.presence.n)).join(',');
  if (key !== MP.hostKey) { MP.hostKey = key; refreshSel(); }
}
function onSnapMsg(msg) {
  if (MP.role !== 'client' || msg.isMe || (MP.hostPeer && msg.peer !== MP.hostPeer)) return;
  const d = msg.data;
  if (!d || d.hi) return;
  const full = MP.asm.add(d);
  if (!full) return;
  MP.lastSnapAt = performance.now();
  if (full.g !== MP.gid || !sim || !sim._mirror) {
    // 新的一局：自己在玩家列表里才进入
    if (!Array.isArray(full.p) || !full.p.some(a => a[0] === PID)) return;
    if (MP.hostPres && MP.hostPres.ph === 'lobby' && full.g !== MP.hostPres.gid) return;
    const h = full.h;
    if (!MAPS[h[0]]) return;
    const cf = full.cf || {};
    const S = new Sim({ map: h[0], difficulty: DIFFS[h[1]] ? h[1] : 'normal', endless: !!h[2], seed: 1, mut: cf.mut, tal: cf.tal, daily: cf.daily });
    MP.gid = full.g; MP.pending = []; MP.dmgBuf.clear();
    NP.applySnap(S, full, { pid: PID, now: timeNow, peer: PID, noEvents: true });
    if (S.s.players[PID]) { S.s.players[PID].cls = selCls; S.setTalents(S.s.players[PID], PROG.personal()); }
    S.drainEvents();
    beginPlay(S, false);
    return;
  }
  const info = NP.applySnap(sim, full, { pid: PID, now: timeNow, peer: PID, noEvents: document.hidden });
  if (info.result) {
    const [ack, res] = info.result;
    for (const [seq, r] of res || []) { const it = MP.pending.find(x => x.seq === seq); if (it && it.cb && !it.done) { it.done = true; try { it.cb(r); } catch (e) { console.warn(e); } } }
    MP.pending = MP.pending.filter(x => x.seq > ack);
  }
  if (!info.inGame && mode !== 'menu') { MP.gid = null; toMenu(); mpNote('你已离开这局游戏', true); return; }
  if (info.respawned) { cam.yaw = 0; cam.pitch = 0; }
  if ((sim.s.phase === 'victory' || sim.s.phase === 'defeat') && info.phase0 !== sim.s.phase && mode === 'play' && endTimer <= 0) endTimer = 2.2;
}
// 队友本地射击：按自己画面判定，命中结果汇总后上报
function clientShoot(lp) {
  const W = sim.wpnOf(lp);
  if (W.proj) {
    // 火箭弹由主机生成弹体，本地只做开火反馈
    const cp = Math.cos(lp.pitch), d = [-Math.sin(lp.yaw) * cp, Math.sin(lp.pitch), -Math.cos(lp.yaw) * cp];
    netCmd({ t: 'rocket', o: [r2n(lp.x + d[0] * 0.6), r2n(lp.y + 1.5 + d[1] * 0.6), r2n(lp.z + d[2] * 0.6)], d: d.map(r3n) });
    sim.events.push({ type: 'shot', pid: PID, w: W.id, x: lp.x + d[0] * 30, y: lp.y + 1.5 + d[1] * 30, z: lp.z + d[2] * 30, hit: false, wall: false, hk: '', dir: -1, mtype: '' });
    return;
  }
  const r = sim.traceFire(lp, Math.random), agg = new Map();
  for (const h of r.hits) {
    const b = MP.dmgBuf.get(h.m.id) || [0, 0]; b[0] += h.dmg; b[1]++; MP.dmgBuf.set(h.m.id, b);
    h.m.hitT = 0.12;
    const a = agg.get(h.m) || { dmg: 0, head: false, x: h.x, y: h.y, z: h.z };
    a.dmg += h.dmg * (1 - (MON[h.m.type].armor || 0)); a.head = a.head || h.head; agg.set(h.m, a);
  }
  for (const [m, a] of agg) sim.events.push({ type: 'hit', pid: PID, id: m.id, mtype: m.type, x: a.x, y: a.y, z: a.z, dmg: Math.round(a.dmg), head: a.head, kill: false, w: W.id });
  for (const e of r.ends) sim.events.push({ type: 'shot', pid: PID, w: W.id, x: e.ex, y: e.ey, z: e.ez, hit: !!e.best, wall: !!e.wall, hk: e.wall ? e.wall.kind : '', dir: e.wall && e.wall.kind === 'wall' ? e.wall.dir : -1, mtype: e.best ? e.best.type : '' });
}
function clientPresence(force) {
  if (MP.role !== 'client' || !MP.game) return;
  const now = performance.now();
  if (!force && now - MP.lastPres < 50) return;
  MP.lastPres = now;
  if (MP.dmgBuf.size && MP.gid) {
    const h = [...MP.dmgBuf].slice(0, 30).map(([id, b]) => [id, Math.round(b[0] * 10) / 10, b[1]]);
    MP.dmgBuf.clear();
    MP.pending.push({ seq: ++MP.cmdSeq, cmd: { t: 'dmg', h }, t: now });
  }
  // 超时的命令（主机迟迟不确认）提示一下
  for (const it of MP.pending) if (!it.done && it.cb && now - it.t > 6000) { it.done = true; it.cb({ ok: false, reason: '网络延迟过高，操作未生效' }); }
  const lp = sim && MP.gid && sim.s.players[PID];
  const pr = { v: NP.VERSION, n: MP.name, gid: MP.gid, tal: PROG.personal(), cls: selCls, c: MP.pending.slice(-16).map(x => [x.seq, x.cmd]) };
  if (MP.pk) pr.pk = MP.pk;
  if (MP.ping) pr.pg = MP.ping; if (MP.qc) pr.qc = MP.qc; if (MP.ch) pr.ch = MP.ch;
  if (lp) {
    const firing = lp.input.fire && !lp.dead && lp.ammo > 0 && lp.reloadT <= 0;
    pr.s = [r2n(lp.x), r2n(lp.y), r2n(lp.z), r3n(lp.yaw), r3n(lp.pitch), firing ? 1 : 0, lp.life || 0, Math.max(0, WEAPONS.findIndex(w => w.id === lp.wpn)), lp.mount || 0];
  }
  const key = JSON.stringify(pr);
  if (key === MP.sentPres) return;
  MP.sentPres = key;
  MP.game.presence(pr).catch(() => {});
}

/* ---------- 后台运行：标签页隐藏时 rAF 停止，用 Worker 定时器继续推进模拟（单人和房主都适用；只有按 Esc 才暂停） ---------- */
let bgTicker = null, bgLast = 0;
function ensureBgTicker() {
  if (bgTicker) return;
  const tick = () => {
    // 单人：只要没按 Esc 暂停就继续跑；房主：一直跑（联机不暂停）
    const run = sim && document.hidden && mode !== 'menu' && (MP.role === 'solo' ? mode === 'play' : MP.role === 'host' && MP.gid);
    if (!run) { bgLast = 0; return; }
    const now = performance.now();
    if (!bgLast) bgLast = now;
    const dt = Math.min(0.25, (now - bgLast) / 1000); bgLast = now;
    worldStep(dt, false);
  };
  try {
    const url = URL.createObjectURL(new Blob(['setInterval(function(){postMessage(0)},33)'], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = tick;
    w.onerror = () => { try { w.terminate(); } catch (e) { /* 忽略 */ } bgTicker = setInterval(tick, 33); };
    bgTicker = w;
  } catch (e) { bgTicker = setInterval(tick, 33); }
}

/* ---------------- 全局状态 ---------------- */
let sim = null, demo = null, diff = 'normal', selMap = 'station', selEndless = false, selMode = 'std', selMut = [];
let customSel = { map: 'station', diff: 'normal', mut: [] };
try {
  const pf = JSON.parse(localStorage.getItem('jhsw-sel') || '{}');
  if (pf.map && TD.MAPS[pf.map]) selMap = pf.map; if (pf.diff && TD.DIFFS[pf.diff]) diff = pf.diff;
  selMode = pf.mode === 'endless' || pf.mode === 'daily' ? pf.mode : (pf.endless ? 'endless' : 'std');
  if (Array.isArray(pf.mut)) selMut = pf.mut.filter(id => TD.MUT[id]);
} catch (e) { /* 无存储 */ }
customSel = { map: selMap, diff, mut: selMut.slice() };
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
// 当前菜单选择 → 开局配置
function gameCfg() {
  if (selMode === 'daily') { const d = dailySpec(todayStr()); return { map: d.map, diff: d.diff, endless: false, mut: d.mut, daily: d.date, seed: d.seed }; }
  return { map: selMap, diff, endless: selMode === 'endless', mut: selMut.slice(), daily: null, seed: (Math.random() * 1e9) | 0 };
}
/* ---------- 局外成长：星星与天赋 ---------- */
const PROG = {
  tal: {},
  load() { try { this.tal = JSON.parse(localStorage.getItem('jhsw-tal') || '{}') || {}; } catch (e) { this.tal = {}; } },
  save() { try { localStorage.setItem('jhsw-tal', JSON.stringify(this.tal)); } catch (e) { /* 无存储 */ } },
  dailyWins() { try { const a = JSON.parse(localStorage.getItem('jhsw-daily') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } },
  addDailyWin(d) { const a = this.dailyWins(); if (!a.includes(d)) { a.push(d); try { localStorage.setItem('jhsw-daily', JSON.stringify(a.slice(-400))); } catch (e) { /* 无存储 */ } } },
  stars() {
    const all = loadBest(); let n = 0;
    for (const m of MAP_LIST) {
      for (const d of ['normal', 'hard', 'hell']) { const r = all[bestKey(m.id, d, 'std')]; if (r && r.win) n++; }
      if (['normal', 'hard', 'hell'].some(d => { const r = all[bestKey(m.id, d, 'endless')]; return r && r.wave >= m.waves.length + 10; })) n++;
    }
    return n + this.dailyWins().length;
  },
  kills() { try { return +localStorage.getItem('jhsw-kills') || 0; } catch (e) { return 0; } },
  addKills(n) { try { localStorage.setItem('jhsw-kills', String(this.kills() + Math.max(0, n | 0))); } catch (e) { /* 无存储 */ } },
  spent() { return TALENTS.reduce((a, t) => a + Math.min(t.max, this.tal[t.id] | 0), 0); },
  team() { const o = {}; for (const t of TALENTS) if (t.team) o[t.id] = Math.min(t.max, this.tal[t.id] | 0); return o; },
  personal() { const o = {}; for (const t of TALENTS) if (!t.team) o[t.id] = Math.min(t.max, this.tal[t.id] | 0); return o; },
};
PROG.load();
/* ---------- 重型陷阱（2×2）阶段性解锁：通关指定关卡 / 完成成就（记录在本机） ---------- */
const mapWon = id => { const all = loadBest(); return ['normal', 'hard', 'hell'].some(d => { const r = all[bestKey(id, d, 'std')]; return r && r.win; }); };
const UNLOCKS = {
  rail: { how: '通关「空间站·中枢」（任意难度）', ok: () => mapWon('station') },
  grinder: { how: '通关「三岔要塞」（任意难度）', ok: () => mapWon('fortress') },
  mortar: { how: '成就「歼灭者」：累计击杀 800 只怪物', prog: () => `已击杀 ${Math.min(800, PROG.kills())} / 800`, ok: () => PROG.kills() >= 800 },
};
const isUnlocked = id => !UNLOCKS[id] || !!window.__unlockAll || UNLOCKS[id].ok();
const lockText = id => { const u = UNLOCKS[id]; return u ? `未解锁 · ${u.how}${u.prog ? `（${u.prog()}）` : ''}` : ''; };
let selCls = 'assault';
try { const c = localStorage.getItem('jhsw-cls'); if (CLS[c]) selCls = c; } catch (e) { /* 无存储 */ }
let mode = 'menu';           // menu | play | pause | end
let tool = 'gun';            // 'gun' 或陷阱 id
let locked = false, fallbackLook = false, hadLock = false;
let endTimer = 0, timeNow = 0, frameAlpha = 0, simNow = 0, timeScale = 1, slowmoT = 0;
const cam = { yaw: 0, pitch: 0, fov: 75, shake: 0, ads: 0, bob: 0, x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, rx: 1, rz: 0, ux: 0, uy: 1, uz: 0 };
const vm = { kick: 0, flash: 0, swayX: 0, swayY: 0, switchT: 0 };
const keys = {};
const mouse = { l: false, r: false, any: false };
let reloadReq = false;
let aim = null;
let bigMap = false;
const staticCache = new Map();

/* ---------------- 颜色 ---------------- */
// [r,g,b,a,emit,flash,panel,add,nofog]
const col = (r, g, b, a, emit, flash, panel, add, nofog) => [r, g, b, a === undefined ? 1 : a, emit || 0, flash || 0, panel || 0, !!add, !!nofog];
const SC = col(0, 0, 0);
function c(r, g, b, a, emit, flash, add, nofog) {
  SC[0] = r; SC[1] = g; SC[2] = b; SC[3] = a === undefined ? 1 : a; SC[4] = emit || 0; SC[5] = flash || 0; SC[6] = 0; SC[7] = !!add; SC[8] = !!nofog;
  return SC;
}
const CAT_COL = { floor: [0.31, 0.84, 0.77], pad: [1.0, 0.71, 0.28], wall: [1.0, 0.42, 0.55], ceil: [0.71, 0.55, 1.0], heavy: [1.0, 0.45, 0.22], hfloor: [0.55, 1.0, 0.4] };

/* ============================================================
 * 音效（WebAudio 合成，无外部资源）
 * ============================================================ */
const Snd = {
  ctx: null, out: null, noise: null, last: {},
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.out = this.ctx.createGain(); this.out.gain.value = settings.vol;
      const comp = this.ctx.createDynamicsCompressor();
      this.out.connect(comp); comp.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { this.ctx = null; }
  },
  setVol(v) { if (this.out) this.out.gain.value = v; },
  // 背景低频嗡鸣（太空站环境音），战斗中略微加强
  amb: null,
  setMusic(v) { if (Music.g) Music.g.gain.setTargetAtTime(v * 0.32, this.ctx.currentTime, 0.2); },
  ambient(on) {
    if (!this.ctx) return;
    if (on && !this.amb) {
      const t = this.ctx.currentTime, g = this.ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 2);
      const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 150; f.Q.value = 2;
      const lfo = this.ctx.createOscillator(), lg = this.ctx.createGain(); lfo.frequency.value = 0.07; lg.gain.value = 60; lfo.connect(lg); lg.connect(f.frequency);
      const o1 = this.ctx.createOscillator(), o2 = this.ctx.createOscillator(); o1.type = o2.type = 'sawtooth'; o1.frequency.value = 55; o2.frequency.value = 55.6;
      o1.connect(f); o2.connect(f); f.connect(g); g.connect(this.out);
      o1.start(); o2.start(); lfo.start();
      this.amb = { g, nodes: [o1, o2, lfo] };
    } else if (!on && this.amb) {
      const a = this.amb, t = this.ctx.currentTime; a.g.gain.cancelScheduledValues(t); a.g.gain.setValueAtTime(a.g.gain.value, t); a.g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      setTimeout(() => a.nodes.forEach(n => { try { n.stop(); } catch (e) { /* 已停止 */ } }), 800);
      this.amb = null;
    }
  },
  ambLevel(v) { if (this.amb) this.amb.g.gain.setTargetAtTime(v, this.ctx.currentTime, 1.5); },
  spatial(x, z, range) {
    if (x === undefined) return { v: 1, p: 0 };
    const dx = x - cam.x, dz = z - cam.z, d = Math.hypot(dx, dz);
    const v = Math.pow(clamp(1 - d / (range || 45), 0, 1), 1.4);
    const p = d > 0.5 ? clamp((dx * cam.rx + dz * cam.rz) / d, -1, 1) * 0.8 : 0;
    return { v, p };
  },
  chain(vol, pan) {
    const g = this.ctx.createGain(); g.gain.value = vol;
    if (this.ctx.createStereoPanner) { const p = this.ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(this.out); }
    else g.connect(this.out);
    return g;
  },
  tone(type, f0, f1, dur, vol, pan, delay) {
    const t = this.ctx.currentTime + (delay || 0);
    const o = this.ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = this.chain(0, pan);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); o.start(t); o.stop(t + dur + 0.05);
  },
  hiss(dur, ftype, f0, f1, q, vol, pan, delay) {
    const t = this.ctx.currentTime + (delay || 0);
    const s = this.ctx.createBufferSource(); s.buffer = this.noise; s.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = ftype; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = this.chain(0, pan);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  },
  play(name, x, z, opt) {
    if (!this.ctx || mode === 'menu') return;
    const now = performance.now();
    const gap = { mshot: 60, hack: 200, burrow: 150, shot2: 45, shotgun: 120, sniper: 150, rocketFire: 120, strike: 100, tick: 35, laser: 120, flame: 160, tesla: 90, spike: 70, tshot: 55, step: 120, kill: 40, gold: 60, heart: 300 }[name] || 25;
    if (this.last[name] && now - this.last[name] < gap) return;
    this.last[name] = now;
    const sp = this.spatial(x, z, opt && opt.range);
    if (sp.v < 0.02) return;
    const v = sp.v, p = sp.p;
    switch (name) {
      case 'shot': this.hiss(0.09, 'bandpass', 2400, 600, 0.8, 0.5 * v, p); this.tone('square', 180, 60, 0.07, 0.18 * v, p); break;
      case 'gatling': this.hiss(0.06, 'bandpass', 1700, 500, 0.9, 0.42 * v, p); this.tone('square', 120, 45, 0.05, 0.16 * v, p); break;
      case 'spinUp': this.tone('sawtooth', 70, 260, 0.4, 0.07 * v, p); break;
      case 'overheat': this.hiss(0.7, 'highpass', 3000, 6000, 1, 0.25 * v, p); this.tone('square', 520, 380, 0.25, 0.1 * v, p); break;
      case 'shot2': this.hiss(0.08, 'bandpass', 2000, 600, 0.8, 0.3 * v, p); this.tone('square', 160, 60, 0.06, 0.1 * v, p); break;
      case 'shotgun': this.hiss(0.22, 'lowpass', 2600, 300, 0.7, 0.65 * v, p); this.tone('sine', 110, 40, 0.18, 0.4 * v, p); this.hiss(0.05, 'highpass', 4000, 2000, 1, 0.15, p, 0.32); this.tone('square', 300, 200, 0.04, 0.06, p, 0.38); break;
      case 'sniper': this.hiss(0.05, 'highpass', 6000, 3000, 0.8, 0.5 * v, p); this.tone('sawtooth', 1400, 90, 0.35, 0.22 * v, p); this.hiss(0.6, 'bandpass', 1200, 300, 2, 0.18 * v, p, 0.05); break;
      case 'rocketFire': this.hiss(0.6, 'bandpass', 500, 2600, 1.5, 0.4 * v, p); this.tone('sine', 90, 50, 0.3, 0.3 * v, p); break;
      case 'throw': this.hiss(0.15, 'bandpass', 900, 1800, 2, 0.15 * v, p); this.tone('sine', 1400, 1700, 0.06, 0.05 * v, p, 0.05); break;
      case 'switch': this.tone('square', 600, 500, 0.03, 0.06, 0); this.hiss(0.05, 'highpass', 3000, 2500, 1, 0.12, 0, 0.06); break;
      case 'buy': [0, 0.07].forEach((d, i) => this.tone('triangle', 1100 + i * 500, 1300 + i * 500, 0.09, 0.14, 0, d)); break;
      case 'strikeCall': for (let i = 0; i < 4; i++) this.tone('sine', 900 + i * 220, 900 + i * 220, 0.08, 0.14, p, i * 0.28); break;
      case 'ping': this.tone('sine', 1500, 1500, 0.07, 0.12, 0); this.tone('sine', 2000, 2000, 0.09, 0.1, 0, 0.08); break;
      case 'research': [0, 0.09, 0.18, 0.3].forEach((d, i) => this.tone('sine', [660, 880, 1100, 1650][i], [700, 920, 1180, 1700][i], 0.16, 0.13, p, d)); this.hiss(0.5, 'bandpass', 2000, 5000, 3, 0.08, p, 0.1); break;
      case 'resupply': this.hiss(0.18, 'highpass', 2500, 1200, 1, 0.22, p); this.tone('triangle', 500, 1000, 0.25, 0.14, p, 0.05); this.tone('sine', 1300, 1500, 0.12, 0.08, p, 0.25); break;
      case 'device': this.tone('square', 440, 880, 0.12, 0.12, p); this.tone('square', 660, 1320, 0.12, 0.1, p, 0.12); this.hiss(0.5, 'bandpass', 800, 2400, 2, 0.15, p, 0.1); break;
      case 'shatter': this.hiss(0.25, 'highpass', 5000, 2500, 1, 0.35 * v, p); this.tone('triangle', 2400, 1800, 0.15, 0.1 * v, p); break;
      case 'freeze': this.hiss(0.3, 'highpass', 4000, 6000, 2, 0.15 * v, p); break;
      case 'burrow': this.hiss(0.4, 'lowpass', 600, 120, 1, 0.3 * v, p); this.tone('sine', 70, 40, 0.3, 0.25 * v, p); break;
      case 'hack': [0, 0.08, 0.16].forEach((d, i) => this.tone('square', 1200 - i * 300, 900 - i * 300, 0.07, 0.1 * v + 0.03, p, d)); break;
      case 'mshot': this.hiss(0.05, 'bandpass', 2600, 1400, 1, 0.22 * v, p); this.tone('square', 260, 120, 0.05, 0.08 * v, p); break;
      case 'rail': this.tone('sawtooth', 1800, 120, 0.35, 0.22 * v, p); this.tone('sine', 220, 60, 0.5, 0.5 * v, p); this.hiss(0.4, 'highpass', 6000, 1500, 1, 0.3 * v, p); break;
      case 'mortar': this.tone('sine', 70, 35, 0.5, 0.7 * v, p); this.hiss(0.5, 'lowpass', 900, 150, 1, 0.45 * v, p); this.tone('triangle', 500, 900, 0.25, 0.08 * v, p, 0.05); break;
      case 'grinder': this.hiss(0.3, 'bandpass', 2500, 1800, 3, 0.14 * v, p); this.tone('sawtooth', 160, 150, 0.3, 0.06 * v, p); break;
      case 'blink': this.tone('sine', 300, 1400, 0.18, 0.18 * v, p); this.hiss(0.2, 'highpass', 4000, 3000, 1, 0.12 * v, p); break;
      case 'aura': this.tone('sine', 420, 640, 0.35, 0.12 * v, p); this.tone('sine', 630, 960, 0.35, 0.06 * v, p); break;
      case 'shieldBreak': this.tone('square', 900, 200, 0.2, 0.1 * v, p); this.hiss(0.25, 'highpass', 3000, 1200, 1, 0.18 * v, p); break;
      case 'shellFire': this.tone('sine', 90, 50, 0.4, 0.5 * v, p); this.hiss(0.4, 'lowpass', 1500, 200, 1, 0.4 * v, p); break;
      case 'strike': this.tone('sine', 80, 25, 1.4, 0.8 * v + 0.2, p); this.hiss(1.6, 'lowpass', 3000, 80, 0.6, 0.7 * v + 0.2, p); this.tone('sawtooth', 300, 40, 0.8, 0.25 * v, p); break;
      case 'tick': this.tone('sine', 1800, 1500, 0.04, 0.12 * v, p); break;
      case 'head': this.tone('sine', 2600, 2200, 0.06, 0.16, p); this.tone('triangle', 3400, 3000, 0.05, 0.08, p, 0.03); break;
      case 'kill': this.tone('triangle', 900, 1400, 0.08, 0.14 * v, p); this.tone('triangle', 1400, 1900, 0.09, 0.1 * v, p, 0.06); break;
      case 'reload': this.hiss(0.05, 'highpass', 3000, 2000, 1, 0.2, 0); this.hiss(0.06, 'highpass', 2500, 1800, 1, 0.22, 0, 0.9); break;
      case 'empty': this.tone('square', 900, 700, 0.03, 0.08, 0); break;
      case 'build': this.tone('triangle', 400, 900, 0.12, 0.22, p); this.tone('triangle', 900, 1300, 0.1, 0.12, p, 0.08); break;
      case 'upgrade': [0, 0.06, 0.12].forEach((d, i) => this.tone('triangle', 600 + i * 300, 700 + i * 320, 0.1, 0.18, p, d)); break;
      case 'sell': this.tone('triangle', 900, 350, 0.18, 0.2, p); break;
      case 'deny': this.tone('square', 220, 180, 0.12, 0.12, 0); break;
      case 'spike': this.hiss(0.08, 'highpass', 4000, 2500, 1, 0.22 * v, p); this.tone('square', 300, 120, 0.06, 0.08 * v, p); break;
      case 'push': this.tone('sine', 140, 60, 0.18, 0.4 * v, p); this.hiss(0.1, 'lowpass', 900, 300, 1, 0.2 * v, p); break;
      case 'tesla': this.hiss(0.12, 'bandpass', 5000, 1500, 4, 0.22 * v, p); this.tone('sawtooth', 120, 90, 0.12, 0.08 * v, p); break;
      case 'tshot': this.hiss(0.05, 'bandpass', 3000, 1200, 1, 0.16 * v, p); break;
      case 'aa': this.hiss(0.5, 'bandpass', 600, 2400, 2, 0.22 * v, p); break;
      case 'laser': this.tone('sawtooth', 880, 860, 0.18, 0.06 * v, p); this.tone('sine', 1760, 1700, 0.18, 0.05 * v, p); break;
      case 'flame': this.hiss(0.35, 'lowpass', 900, 500, 0.7, 0.2 * v, p); break;
      case 'crusher': this.tone('sine', 90, 35, 0.4, 0.6 * v, p); this.hiss(0.3, 'lowpass', 1200, 200, 1, 0.35 * v, p); break;
      case 'boom': this.tone('sine', 120, 30, 0.6, 0.6 * v, p); this.hiss(0.7, 'lowpass', 2000, 100, 0.8, 0.5 * v, p); break;
      case 'boomS': this.hiss(0.3, 'lowpass', 2400, 300, 0.8, 0.25 * v, p); break;
      case 'core': this.tone('sawtooth', 520, 380, 0.3, 0.2, 0); this.tone('sawtooth', 520, 380, 0.3, 0.2, 0, 0.35); break;
      case 'hurt': this.tone('sawtooth', 200, 90, 0.18, 0.22, 0); this.hiss(0.12, 'lowpass', 900, 200, 1, 0.25, 0); break;
      case 'wave': this.tone('sawtooth', 110, 112, 0.9, 0.2, 0); this.tone('sawtooth', 165, 166, 0.9, 0.14, 0); this.tone('sawtooth', 220, 222, 1.1, 0.1, 0, 0.3); break;
      case 'clear': [0, 0.1, 0.2, 0.32].forEach((d, i) => this.tone('triangle', [523, 659, 784, 1046][i], [523, 659, 784, 1046][i], 0.25, 0.16, 0, d)); break;
      case 'boss': this.tone('sawtooth', 70, 55, 1.6, 0.35, 0); this.tone('sawtooth', 105, 82, 1.6, 0.2, 0); this.hiss(1.4, 'lowpass', 400, 120, 1, 0.3, 0); break;
      case 'emp': this.tone('sine', 1600, 60, 0.7, 0.3 * v + 0.1, p); this.hiss(0.6, 'bandpass', 3000, 300, 3, 0.2, p); break;
      case 'stomp': this.tone('sine', 70, 28, 0.5, 0.6 * v, p); break;
      case 'bstep': this.tone('sine', 58, 26, 0.32, 0.5 * v, p); this.hiss(0.18, 'lowpass', 300, 90, 1, 0.22 * v, p); break;
      case 'roar': this.tone('sawtooth', 160, 70, 0.8, 0.3 * v, p); this.hiss(0.7, 'bandpass', 700, 300, 2, 0.25 * v, p); break;
      case 'broken': this.hiss(0.4, 'lowpass', 3000, 300, 1, 0.3 * v, p); this.tone('square', 300, 80, 0.3, 0.12 * v, p); break;
      case 'win': [0, 0.15, 0.3, 0.45, 0.7].forEach((d, i) => this.tone('triangle', [392, 523, 659, 784, 1046][i], [392, 523, 659, 784, 1046][i] * 1.01, 0.4, 0.18, 0, d)); break;
      case 'lose': [0, 0.3, 0.6].forEach((d, i) => this.tone('sawtooth', [330, 262, 196][i], [320, 250, 150][i], 0.5, 0.18, 0, d)); break;
      case 'jump': this.hiss(0.06, 'lowpass', 800, 300, 1, 0.08, 0); break;
      case 'gold': this.tone('sine', 1320, 1500, 0.05, 0.05, 0); break;
      case 'count': this.tone('sine', 880, 880, 0.09, 0.12, 0); break;
      case 'step': this.hiss(0.06, 'lowpass', 500, 180, 1, 0.09, rnd(-0.15, 0.15)); this.tone('sine', 95, 55, 0.06, 0.05, 0); break;
      case 'land': this.tone('sine', 120, 45, 0.14, 0.18, 0); this.hiss(0.1, 'lowpass', 700, 150, 1, 0.15, 0); break;
      case 'heart': this.tone('sine', 62, 44, 0.12, 0.28, 0); this.tone('sine', 58, 40, 0.12, 0.2, 0, 0.17); break;
    }
  },
};

/* ============================================================
 * 背景音乐：程序生成的步进音序器（布防 / 战斗 / BOSS 三种情绪，切换时等到下一小节）
 * ============================================================ */
const Music = {
  g: null, mood: 'off', want: 'off', step: 0, next: 0, timer: 0, bar: 0,
  // 和弦（MIDI 根音 + 小三 / 大三）：每小节一个
  PROG: {
    calm: [[57, 'm'], [53, 'M'], [48, 'M'], [55, 'M']],
    battle: [[57, 'm'], [57, 'm'], [53, 'M'], [55, 'M'], [57, 'm'], [57, 'm'], [52, 'm'], [55, 'M']],
    // BOSS 战：D 和声小调，8 小节 Dm-Dm-B♭-B♭-Gm-Gm-A-A（A 大三和弦制造紧张感）
    boss: [[50, 'm'], [50, 'm'], [46, 'M'], [46, 'M'], [43, 'm'], [43, 'm'], [45, 'M'], [45, 'M']],
  },
  BPM: { calm: 84, battle: 122, boss: 152 },
  inten: 1,   // BOSS 阶段 1-3：越往后编制越满
  // BOSS 主旋律（每小节 8 个八分音符，0 = 休止）
  LEAD: [[74, 0, 77, 81, 82, 81, 77, 76], [74, 0, 74, 76, 77, 79, 81, 0], [82, 0, 81, 77, 74, 77, 81, 82], [86, 0, 85, 82, 81, 0, 77, 0],
    [79, 0, 82, 86, 85, 82, 81, 79], [77, 0, 79, 81, 82, 0, 79, 77], [81, 0, 85, 88, 86, 85, 82, 81], [85, 0, 81, 0, 76, 79, 81, 85]],
  hz: n => 440 * Math.pow(2, (n - 69) / 12),
  start() {
    const A = Snd.ctx; if (!A || this.g) return;
    this.g = A.createGain(); this.g.gain.value = (settings.music === undefined ? 0.5 : settings.music) * 0.32;
    this.g.connect(Snd.out);
    this.next = A.currentTime + 0.1;
    this.timer = setInterval(() => this.tick(), 60);
  },
  set(m) { this.want = m; if (m !== 'off') this.start(); },
  tick() {
    const A = Snd.ctx; if (!A || !this.g) return;
    if (A.currentTime > this.next + 1) this.next = A.currentTime + 0.05;   // 页面在后台时跳过
    while (this.next < A.currentTime + 0.25) { this.play(this.next); }
  },
  play(t) {
    // 每小节开头才切换情绪
    if (this.step % 16 === 0) { if (this.mood !== this.want) { this.mood = this.want; this.bar = 0; } }
    const m = this.mood, sixteenth = 60 / (this.BPM[m] || 100) / 4;
    if (m !== 'off') {
      const prog = this.PROG[m] || this.PROG.calm, ch = prog[this.bar % prog.length], root = ch[0], third = ch[1] === 'm' ? 3 : 4;
      const tones = [root, root + third, root + 7, root + 12], st = this.step % 16;
      if (m === 'calm') {
        if (st === 0) { this.pad(t, tones, sixteenth * 16, 0.05); this.bass(t, root - 12, sixteenth * 14, 0.11, 'triangle'); }
        if (st % 4 === 2) this.pluck(t, this.hz(tones[(st / 4 + this.bar) % 4 | 0] + 12), sixteenth * 3, 0.03);
      } else if (m === 'boss') {
        this.playBoss(t, st, sixteenth, root, tones, ch[1] === 'M');
      } else {
        const boss = m === 'boss';
        if (st === 0) this.pad(t, tones, sixteenth * 16, boss ? 0.045 : 0.035);
        if (st % 2 === 0) this.bass(t, root - 12 + (st % 8 === 6 ? 7 : 0), sixteenth * 1.7, boss ? 0.16 : 0.13, 'sawtooth');
        this.pluck(t, this.hz(tones[[0, 1, 2, 3, 2, 1, 2, 3][st % 8]] + 12), sixteenth * 0.9, boss ? 0.028 : 0.022);
        if (st % 4 === 0 || (boss && st % 4 === 2 && st > 8)) this.kick(t, boss ? 0.5 : 0.42);
        if (st === 4 || st === 12) this.snare(t, 0.2);
        if (st % 2 === 1 || boss) this.hat(t, st % 4 === 2 ? 0.05 : 0.03);
      }
    }
    this.step++; if (this.step % 16 === 0) this.bar++;
    this.next = t + sixteenth;
  },
  // BOSS 战编曲：疾走的 galloping 低音 + 双踩 + 铜管重音 + 合唱铺底 + 主旋律，阶段越高越满
  playBoss(t, st, s16, root, tones, major) {
    const I = this.inten || 1, bar = this.bar;
    if (st === 0) { this.choir(t, tones, s16 * 16, 0.045 + 0.01 * I); }
    // 低音：每拍「哒-哒哒」三连（第 0、2、3 个十六分）
    if (st % 4 !== 1) this.dbass(t, root - 12, s16 * (st % 4 === 0 ? 1.6 : 0.9), st % 4 === 0 ? 0.2 : 0.14);
    // 鼓：每拍底鼓，第二阶段起加双踩；2、4 拍军鼓，每 4 小节最后一拍滚奏
    if (st % 4 === 0) this.kick(t, 0.55);
    else if (I >= 2 && st % 4 === 2) this.kick(t, 0.32);
    else if (I >= 3 && st % 2 === 1) this.kick(t, 0.22);
    if (st === 4 || st === 12) this.snare(t, 0.26);
    if (bar % 4 === 3 && st >= 12) this.snare(t, 0.1 + (st - 11) * 0.04);
    if (st % 2 === 0) this.hat(t, st % 4 === 2 ? 0.06 : 0.035);
    // 铜管重音
    if ((bar % 2 === 0 && (st === 0 || st === 3 || st === 6 || st === 10)) || (I >= 3 && st === 14)) this.brass(t, tones, s16 * (st === 0 ? 3 : 1.6), 0.05 + 0.012 * I);
    // 主旋律（八分音符）；狂暴阶段高八度叠加
    if (st % 2 === 0) {
      let n = this.LEAD[bar % 8][st / 2]; if (!major && n === 85) n = 84;
      if (n) { this.lead(t, n - (I === 1 ? 12 : 0), s16 * 1.8, 0.03); if (I >= 3) this.lead(t, n + 12, s16 * 1.4, 0.014); }
    } else if (I >= 2 && st % 4 === 3) this.pluck(t, this.hz(tones[(st >> 2) % 4] + 24), s16 * 0.8, 0.012);
  },
  shaper() { if (!this._ws) { const c = new Float32Array(256); for (let i = 0; i < 256; i++) { const x = i / 128 - 1; c[i] = Math.tanh(x * 3.2); } this._ws = c; } return this._ws; },
  dbass(t, n, dur, vol) {
    const A = Snd.ctx, o = A.createOscillator(), o2 = A.createOscillator(), w = A.createWaveShaper(), f = A.createBiquadFilter();
    o.type = 'sawtooth'; o2.type = 'square'; o.frequency.value = this.hz(n); o2.frequency.value = this.hz(n - 12);
    w.curve = this.shaper(); f.type = 'lowpass'; f.frequency.setValueAtTime(1400, t); f.frequency.exponentialRampToValueAtTime(260, t + dur);
    o.connect(w); o2.connect(w); w.connect(f); f.connect(this.env(t, vol, 0.004, dur));
    o.start(t); o2.start(t); o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  },
  brass(t, tones, dur, vol) {
    const A = Snd.ctx, f = A.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(2600, t + 0.05); f.frequency.exponentialRampToValueAtTime(700, t + dur);
    f.connect(this.env(t, vol, 0.02, dur));
    for (const n of [tones[0], tones[1], tones[2], tones[0] + 12]) for (const det of [-9, 9]) { const o = A.createOscillator(); o.type = 'sawtooth'; o.frequency.value = this.hz(n); o.detune.value = det; o.connect(f); o.start(t); o.stop(t + dur + 0.1); }
  },
  choir(t, tones, dur, vol) {
    const A = Snd.ctx, f = A.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.6;
    const g = this.env(t, vol, dur * 0.35, dur * 0.7); f.connect(g);
    const lfo = A.createOscillator(), lg = A.createGain(); lfo.frequency.value = 5.2; lg.gain.value = 6; lfo.connect(lg); lfo.start(t); lfo.stop(t + dur * 1.1);
    for (const n of [tones[0], tones[1], tones[2], tones[0] + 12]) { const o = A.createOscillator(); o.type = 'triangle'; o.frequency.value = this.hz(n + 12); lg.connect(o.detune); o.connect(f); o.start(t); o.stop(t + dur * 1.1); }
  },
  lead(t, n, dur, vol) {
    const A = Snd.ctx, o = A.createOscillator(), o2 = A.createOscillator(), f = A.createBiquadFilter();
    o.type = 'sawtooth'; o2.type = 'square'; o.frequency.value = this.hz(n); o2.frequency.value = this.hz(n); o2.detune.value = 7;
    f.type = 'lowpass'; f.frequency.value = 2400;
    o.connect(f); o2.connect(f); f.connect(this.env(t, vol, 0.01, dur));
    o.start(t); o2.start(t); o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  },
  env(t, peak, a, d) { const g = Snd.ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); g.connect(this.g); return g; },
  pad(t, tones, dur, vol) {
    const A = Snd.ctx, f = A.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1100; f.Q.value = 0.7;
    const g = this.env(t, vol, dur * 0.3, dur * 0.75); f.connect(g);
    for (const n of tones.slice(0, 3)) for (const det of [-6, 6]) { const o = A.createOscillator(); o.type = 'sawtooth'; o.frequency.value = this.hz(n); o.detune.value = det; o.connect(f); o.start(t); o.stop(t + dur * 1.1); }
  },
  bass(t, n, dur, vol, type) {
    const A = Snd.ctx, o = A.createOscillator(), f = A.createBiquadFilter(); o.type = type; o.frequency.value = this.hz(n);
    f.type = 'lowpass'; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(220, t + dur);
    o.connect(f); f.connect(this.env(t, vol, 0.01, dur)); o.start(t); o.stop(t + dur + 0.05);
  },
  pluck(t, hz, dur, vol) { const o = Snd.ctx.createOscillator(); o.type = 'square'; o.frequency.value = hz; o.connect(this.env(t, vol, 0.005, dur)); o.start(t); o.stop(t + dur + 0.05); },
  kick(t, vol) { const o = Snd.ctx.createOscillator(); o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.14); o.connect(this.env(t, vol, 0.003, 0.18)); o.start(t); o.stop(t + 0.25); },
  noise(t, vol, type, fq, dur) {
    const A = Snd.ctx, s = A.createBufferSource(); s.buffer = Snd.noise;
    const f = A.createBiquadFilter(); f.type = type; f.frequency.value = fq; s.connect(f); f.connect(this.env(t, vol, 0.002, dur));
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  },
  snare(t, vol) { this.noise(t, vol, 'bandpass', 1800, 0.16); },
  hat(t, vol) { this.noise(t, vol, 'highpass', 7000, 0.04); },
};

/* ============================================================
 * 静态世界（地板、墙体、天花板、灯带、路线箭头）
 * ============================================================ */
// 每张地图一套配色
const THEMES = {
  station: { lane: [0.22, 0.255, 0.3], floor: [0.27, 0.28, 0.3], pad: [0.3, 0.27, 0.21], base: [0.17, 0.25, 0.29], spawn: [0.28, 0.14, 0.15], wall: [0.27, 0.295, 0.34], cornice: [0.13, 0.145, 0.17], ceil: [0.085, 0.095, 0.115], trim: [1, 0.6, 0.18], upper: [0.35, 0.8, 1], lamp: [0.78, 0.86, 0.95], fog: [0.035, 0.045, 0.06], sky: [0.6, 0.65, 0.76], ground: [0.26, 0.25, 0.27], sun: [0.42, 0.42, 0.48] },
  fortress: { lane: [0.3, 0.265, 0.22], floor: [0.34, 0.31, 0.26], pad: [0.36, 0.29, 0.18], base: [0.2, 0.27, 0.27], spawn: [0.32, 0.15, 0.12], wall: [0.39, 0.34, 0.28], cornice: [0.2, 0.17, 0.14], ceil: [0.12, 0.1, 0.08], trim: [1, 0.55, 0.15], upper: [0.3, 0.95, 0.8], lamp: [1, 0.9, 0.7], fog: [0.06, 0.05, 0.04], sky: [0.7, 0.64, 0.55], ground: [0.3, 0.26, 0.22], sun: [0.5, 0.44, 0.36] },
  furnace: { lane: [0.23, 0.185, 0.175], floor: [0.27, 0.22, 0.21], pad: [0.33, 0.24, 0.16], base: [0.2, 0.2, 0.24], spawn: [0.34, 0.12, 0.1], wall: [0.28, 0.22, 0.21], cornice: [0.15, 0.1, 0.09], ceil: [0.09, 0.06, 0.05], trim: [1, 0.32, 0.1], upper: [1, 0.55, 0.2], lamp: [1, 0.66, 0.38], fog: [0.075, 0.035, 0.025], sky: [0.68, 0.5, 0.44], ground: [0.33, 0.21, 0.17], sun: [0.5, 0.32, 0.24] },
  abyss: { lane: [0.19, 0.19, 0.26], floor: [0.23, 0.23, 0.3], pad: [0.29, 0.25, 0.31], base: [0.16, 0.22, 0.3], spawn: [0.25, 0.12, 0.25], wall: [0.25, 0.25, 0.34], cornice: [0.12, 0.12, 0.18], ceil: [0.07, 0.07, 0.11], trim: [0.75, 0.45, 1], upper: [0.5, 0.82, 1], lamp: [0.76, 0.8, 1], fog: [0.03, 0.03, 0.065], sky: [0.54, 0.56, 0.76], ground: [0.22, 0.2, 0.28], sun: [0.38, 0.38, 0.5] },
};
// 室外：沙岩山体 + 傍晚天光
THEMES.outdoor = { lane: [0.33, 0.29, 0.24], floor: [0.4, 0.37, 0.33], pad: [0.42, 0.34, 0.22], base: [0.25, 0.31, 0.34], spawn: [0.38, 0.18, 0.14], wall: [0.5, 0.4, 0.31], cornice: [0.36, 0.28, 0.21], ceil: [0.2, 0.2, 0.22], trim: [1, 0.6, 0.2], upper: [0.4, 0.85, 1], lamp: [1, 0.9, 0.7], fog: [0.62, 0.66, 0.74], fogD: 0.0058, sky: [0.92, 0.9, 0.95], ground: [0.45, 0.37, 0.29], sun: [1.05, 0.88, 0.68] };
// 赤岩峡谷：红褐色岩壁、暖色的黄昏雾气
THEMES.canyon = { lane: [0.42, 0.28, 0.21], floor: [0.5, 0.37, 0.29], pad: [0.48, 0.33, 0.2], base: [0.25, 0.3, 0.34], spawn: [0.45, 0.17, 0.12], wall: [0.68, 0.36, 0.23], cornice: [0.45, 0.25, 0.17], ceil: [0.2, 0.18, 0.18], trim: [1, 0.6, 0.2], upper: [0.4, 0.85, 1], lamp: [1, 0.9, 0.7], fog: [0.8, 0.62, 0.52], fogD: 0.0062, sky: [1.0, 0.86, 0.78], ground: [0.56, 0.35, 0.24], sun: [1.12, 0.8, 0.58] };
const themeOf = S => THEMES[S.def.theme] || THEMES.station;
function tileOf(S, x, z) { if (x < 0 || z < 0 || x >= S.W || z >= S.H) return TILE.WALL; return S.grid[z * S.W + x]; }
function laneFrame(S, lane) {
  const p0 = S.paths[lane].pts[0], d = S.spawnDir[lane];
  return { x: p0.x, z: p0.z, dx: d.dx, dz: d.dz, yaw: Math.atan2(d.dx, d.dz) };
}
function buildPlatforms(S) {
  // 2×2 炮台位：和地面齐平，只在地上画一圈细细的琥珀色框和四角折线，提示重型炮台放这里
  const LINE = col(1, 0.62, 0.15, 1, 0.45), CORNER = col(1, 0.66, 0.2, 1, 0.8);
  for (const [px0, pz0] of S.def.platforms || []) {
    const x0 = px0 * T, z0 = pz0 * T, cx = x0 + T, cz = z0 + T, L = 2 * T, G = S.tileH(px0, pz0) + 0.012;
    const m = 0.18, a = L - 2 * m;
    for (const [ex, ez, sx, sz] of [[cx, z0 + m, a, 0.05], [cx, z0 + L - m, a, 0.05], [x0 + m, cz, 0.05, a], [x0 + L - m, cz, 0.05, a]]) E.push('box', ex, G, ez, 0, sx, 0.01, sz, LINE);
    for (const [qx, qz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const kx = cx + qx * (T - m), kz = cz + qz * (T - m);
      E.push('box', kx - qx * 0.3, G + 0.002, kz, 0, 0.6, 0.012, 0.12, CORNER);
      E.push('box', kx, G + 0.002, kz - qz * 0.3, 0, 0.12, 0.012, 0.6, CORNER);
    }
  }
}
function buildCommonStatic(S, TH) {
  // 路线箭头（让玩家看清怪物行进方向）
  const tmp = { x: 0, z: 0, dx: 0, dz: 0 };
  const drawn = new Set();
  for (const lane of S.lanes) {
    const p = S.paths[lane];
    for (let d = 3; d < p.len - 4; d += 2.4) {
      pathAt(p, d, tmp);
      const key = Math.round(tmp.x * 2) + ',' + Math.round(tmp.z * 2);
      if (drawn.has(key)) continue; drawn.add(key);
      const rx = -tmp.dz, rz = tmp.dx;
      const tx = tmp.x + tmp.dx * 0.3, tz = tmp.z + tmp.dz * 0.3;
      const ch = col(0.95, 0.3, 0.25, 1, 0.55);
      const gy = S.floorH(tx, tz) + 0.012, gy2 = S.floorH(tx - tmp.dx * 0.45, tz - tmp.dz * 0.45) + 0.012;
      E.pushBeam('box', tx, gy, tz, tx - tmp.dx * 0.45 + rx * 0.4, gy2, tz - tmp.dz * 0.45 + rz * 0.4, 0.13, 0.01, ch);
      E.pushBeam('box', tx, gy, tz, tx - tmp.dx * 0.45 - rx * 0.4, gy2, tz - tmp.dz * 0.45 - rz * 0.4, 0.13, 0.01, ch);
    }
  }
  // 水晶基座
  const cp = S.crystalPos, CG = cp.y || 0;
  E.push('cyl', cp.x, CG + 0.25, cp.z, 0, 4.6, 0.5, 4.6, col(0.16, 0.2, 0.24, 1, 0, 0, 4));
  E.push('cyl', cp.x, CG + 0.55, cp.z, 0, 3.2, 0.12, 3.2, col(0.22, 0.3, 0.36));
  E.push('ring', cp.x, CG + 0.62, cp.z, 0, 1.75, 1, 1.75, col(0.37, 0.89, 1.0, 1, 1));
  E.push('ring', cp.x, CG + 0.02, cp.z, 0, 4.2, 1, 4.2, col(0.37, 0.89, 1.0, 1, 0.8));
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2, px = cp.x + Math.cos(a) * 3.4, pz = cp.z + Math.sin(a) * 3.4;
    if (tileOf(S, Math.floor(px / T), Math.floor(pz / T)) !== TILE.BASE) continue;
    E.push('box', px, CG + 1.1, pz, -a, 0.25, 2.2, 0.5, col(0.2, 0.24, 0.28, 1, 0, 0, 2));
    E.push('box', px, CG + 2.1, pz, -a, 0.27, 0.12, 0.52, col(0.37, 0.89, 1.0, 1, 1));
  }
  // 科研舱：服务器机柜、科研终端、补给柜、全息沙盘台
  buildLabStatic(S, TH);
  // 出怪口门框（朝向沿第一段路线）
  for (const lane of S.lanes) {
    const f = laneFrame(S, lane), bx = f.x - f.dx * 1.6, bz = f.z - f.dz * 1.6, rx = f.dz, rz = -f.dx, G = S.floorH(f.x, f.z);
    const fr = col(0.22, 0.12, 0.13, 1, 0, 0, 2);
    E.push('box', bx + rx * 2.6, G + 2.6, bz + rz * 2.6, f.yaw, 0.6, 5.2, 0.6, fr);
    E.push('box', bx - rx * 2.6, G + 2.6, bz - rz * 2.6, f.yaw, 0.6, 5.2, 0.6, fr);
    E.push('box', bx, G + 5.3, bz, f.yaw, 5.8, 0.5, 0.6, fr);
    E.push('box', bx + f.dx * 0.3, G + 5.0, bz + f.dz * 0.3, f.yaw, 5.0, 0.08, 0.05, col(1, 0.25, 0.2, 1, 1));
  }
}
// 有高低差的地图：逐格画出不同高度的地面、斜坡、崖壁、二层桥面；室外没有天花板
function buildTerrainStatic(S) {
  const TH = themeOf(S), W = S.W, H = S.H;
  const C3 = (a, emit, panel) => col(a[0], a[1], a[2], 1, emit || 0, 0, panel || 0);
  const hash = (x, z) => { let h = (x * 374761393 + z * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  E.beginStatic();
  const CX = W * T / 2, CZ = H * T / 2, RR = Math.max(W, H) * T;
  // 远景：大地、远山、太阳
  E.push('box', CX, -0.45, CZ, 0, RR * 6, 0.5, RR * 6, C3(TH.ground));
  for (let i = 0; i < 34; i++) {
    const a = i / 34 * Math.PI * 2 + hash(i, 7) * 0.2, r = RR * (0.95 + hash(i, 3) * 0.7), h = 16 + hash(i, 5) * 30, w = 70 + hash(i, 9) * 60;
    const k = 0.75 + hash(i, 11) * 0.25;
    E.push('cone', CX + Math.cos(a) * r, h / 2 - 1, CZ + Math.sin(a) * r, a, w, h, w, col(TH.wall[0] * k * 0.8, TH.wall[1] * k * 0.8, TH.wall[2] * k * 0.85, 1, 0, 0, 13));
    // 旁边再叠一两座矮峰，打破锥形轮廓
    for (let j = 0; j < 2; j++) {
      const a2 = a + (j ? 1 : -1) * (0.03 + hash(i, 13 + j) * 0.05), r2 = r * (0.97 + hash(i, 17 + j) * 0.1), h2 = h * (0.45 + hash(i, 19 + j) * 0.35), w2 = w * (0.7 + hash(i, 23 + j) * 0.4);
      E.push('cone', CX + Math.cos(a2) * r2, h2 / 2 - 1, CZ + Math.sin(a2) * r2, a2 * 3, w2, h2, w2, col(TH.wall[0] * k * 0.7, TH.wall[1] * k * 0.7, TH.wall[2] * k * 0.75, 1, 0, 0, 13));
    }
  }
  E.push('sphere', CX - 0.45 * RR * 3, RR * 1.3, CZ - 0.5 * RR * 3, 0, 40, 40, 40, c(1, 0.85, 0.6, 1, 1, 0, false, true));
  const FL = { [TILE.LANE]: C3(TH.lane, 0, 14), [TILE.FLOOR]: C3(TH.floor, 0, 11), [TILE.PAD]: C3(TH.pad, 0, 11), [TILE.BASE]: C3(TH.base, 0, 10), [TILE.SPAWN]: C3(TH.spawn, 0, 14) };
  const TRIM = C3(TH.trim, 1), UPPER = C3(TH.upper, 0.75), LAMP = C3(TH.lamp, 1);
  const CLIFF = k => col(TH.wall[0] * k, TH.wall[1] * k, TH.wall[2] * k, 1, 0, 0, 13);
  const tH = (x, z) => S.tileH(x, z);
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const t = tileOf(S, x, z), cx = (x + 0.5) * T, cz = (z + 0.5) * T, i = z * W + x;
    if (t === TILE.WALL) {
      let edge = false, top = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (tileOf(S, x + dx, z + dz) !== TILE.WALL) { edge = true; top = Math.max(top, tH(x + dx, z + dz)); }
      if (!edge) continue;
      const hh = top + 3.4 + hash(x, z) * 3.2, k = 0.82 + hash(z, x) * 0.22;
      E.push('box', cx, hh / 2 - 0.3, cz, 0, T, hh + 0.6, T, CLIFF(k));
      // 岩层：中间一道深色横纹，顶上一块错位的岩石
      E.push('box', cx, top + 1.2 + hash(x + 3, z) * 1.5, cz, 0, T * 1.02, 0.35, T * 1.02, CLIFF(k * 0.72));
      E.push('box', cx + (hash(x, z + 5) - 0.5) * 0.6, hh + 0.25, cz + (hash(x + 5, z) - 0.5) * 0.6, hash(x, z) * 1.5, T * 0.78, 0.7, T * 0.7, CLIFF(k * 0.9));
      if (hash(x + 9, z + 9) > 0.7) E.push('oct', cx, hh + 0.9, cz, hash(x, z) * 3, 1.3, 1.1, 1.3, CLIFF(k * 0.8));
      continue;
    }
    const ri = S.rampOf.get(i);
    if (ri !== undefined) {
      // 斜坡：底下垫阶梯，上面一块倾斜的坡面
      const r = S.ramps[ri], d = DIRS[r.dir], N = 4;
      const hAt = f => S.tileFloor(i, cx + d[0] * T * (f - 0.5), cz + d[1] * T * (f - 0.5));
      for (let k = 0; k < N; k++) {
        const h0 = hAt(k / N), f = (k + 0.5) / N;
        if (h0 > 0.02) E.push('box', cx + d[0] * T * (f - 0.5), (h0 - 0.25) / 2, cz + d[1] * T * (f - 0.5), 0, d[0] ? T / N : T * 0.985, h0 + 0.25, d[1] ? T / N : T * 0.985, CLIFF(0.75));
      }
      const hl = hAt(0), hh = hAt(1), L = Math.hypot(T, hh - hl), pitch = Math.atan2(hh - hl, T);
      E.pushR('box', cx, (hl + hh) / 2 - 0.1 * Math.cos(pitch), cz, Math.atan2(-d[0], -d[1]), pitch, 0, T * 0.985, 0.2, L, FL[t]);
      if (t !== TILE.LANE) for (let k = 1; k < 4; k++) { const f = k / 4, y = hl + (hh - hl) * f; E.push('box', cx + d[0] * T * (f - 0.5), y + 0.012, cz + d[1] * T * (f - 0.5), 0, d[0] ? 0.06 : T * 0.9, 0.02, d[1] ? 0.06 : T * 0.9, col(1, 0.62, 0.2, 1, 0.5)); }
    } else {
      const h = tH(x, z);
      // 高台：下面是岩石 / 挡土墙，上面一层地面材质
      if (h > 0.5) { E.push('box', cx, (h - 0.25 - 0.2) / 2, cz, 0, T, h + 0.05, T, t === TILE.LANE ? CLIFF(0.9) : col(0.36, 0.35, 0.34, 1, 0, 0, 11)); E.push('box', cx, h - 0.1, cz, 0, T * 0.995, 0.2, T * 0.995, FL[t]); }
      else E.push('box', cx, (h - 0.25) / 2, cz, 0, T * 0.995, h + 0.25, T * 0.995, FL[t]);
      // 崖边：比旁边高出 1 米以上时，顶上加一圈石沿和灯带
      for (let dd = 0; dd < 4; dd++) {
        const nx = x + DIRS[dd][0], nz = z + DIRS[dd][1];
        if (tileOf(S, nx, nz) === TILE.WALL || S.isRamp(nx, nz) || tH(nx, nz) > h - 1) continue;
        const alongX = DIRS[dd][1] !== 0, fx = cx + DIRS[dd][0] * (T * 0.5 - 0.12), fz = cz + DIRS[dd][1] * (T * 0.5 - 0.12);
        E.push('box', fx, h + 0.12, fz, 0, alongX ? T : 0.24, 0.24, alongX ? 0.24 : T, CLIFF(0.7));
        E.push('box', fx + DIRS[dd][0] * 0.13, h - 0.25, fz + DIRS[dd][1] * 0.13, 0, alongX ? T : 0.02, 0.06, alongX ? 0.02 : T, UPPER);
      }
    }
    // 通道贴着墙 / 崖壁的地方：琥珀色踢脚灯
    if (t === TILE.LANE || t === TILE.SPAWN) for (let dd = 0; dd < 4; dd++) {
      if (!S.wallSide(x, z, dd) || ri !== undefined) continue;
      const alongX = DIRS[dd][1] !== 0, fx = cx + DIRS[dd][0] * (T * 0.5 - 0.02), fz = cz + DIRS[dd][1] * (T * 0.5 - 0.02);
      E.push('box', fx, tH(x, z) + 0.2, fz, 0, alongX ? T : 0.05, 0.07, alongX ? 0.05 : T, t === TILE.SPAWN ? col(1, 0.25, 0.25, 1, 1) : TRIM);
    }
    // 二层桥面：桥板 + 底部钢梁和灯 + 两侧栏杆
    if (S.deck.has(i)) {
      const DH = S.DECK_H, DB = S.DECK_B;
      E.push('box', cx, (DH + DB) / 2, cz, 0, T, DH - DB, T, col(0.3, 0.31, 0.34, 1, 0, 0, 2));
      E.push('box', cx, DH + 0.005, cz, 0, T * 0.99, 0.01, T * 0.99, col(0.3, 0.31, 0.34, 1, 0, 0, 15));
      E.push('box', cx, DB - 0.12, cz, 0, T, 0.24, 0.3, col(0.22, 0.23, 0.26));
      E.push('box', cx, DB - 0.12, cz, 0, 0.3, 0.24, T, col(0.22, 0.23, 0.26));
      if ((x + z) % 2 === 0) E.push('box', cx + T * 0.25, DB - 0.02, cz + T * 0.25, 0, T * 0.4, 0.04, 0.12, LAMP);
      for (let dd = 0; dd < 4; dd++) {
        const nx = x + DIRS[dd][0], nz = z + DIRS[dd][1], ni = nz * W + nx;
        if (S.deck.has(ni) || tileOf(S, nx, nz) === TILE.WALL || Math.abs(tH(nx, nz) - DH) < 0.3) continue;
        const alongX = DIRS[dd][1] !== 0, fx = cx + DIRS[dd][0] * (T * 0.5 - 0.06), fz = cz + DIRS[dd][1] * (T * 0.5 - 0.06);
        E.push('box', fx, DH + 1.0, fz, 0, alongX ? T : 0.08, 0.08, alongX ? 0.08 : T, col(1, 0.6, 0.2, 1, 0.6));
        E.push('box', fx, DH + 0.5, fz, 0, alongX ? T : 0.04, 0.04, alongX ? 0.04 : T, col(0.4, 0.42, 0.46));
        for (const o of [-0.45, 0.45]) E.push('box', fx + (alongX ? o * T : 0), DH + 0.5, fz + (alongX ? 0 : o * T), 0, 0.08, 1.0, 0.08, col(0.35, 0.36, 0.4));
        E.push('box', fx, DB - 0.05, fz, 0, alongX ? T : 0.04, 0.05, alongX ? 0.04 : T, UPPER);
      }
    }
    // 外场小道具：靠崖壁的空地摆物资箱 / 油桶 / 碎石，通道边缘撒些碎石（只是装饰，不挡路；远处不画）
    if (ri === undefined && !S.deck.has(i)) {
      E.setDetail(true);
      const h0 = tH(x, z);
      if (t === TILE.FLOOR) {
        let wd = -1;
        for (let dd = 0; dd < 4; dd++) if (S.wallSide(x, z, dd)) { wd = dd; break; }
        const r0 = hash(x * 3 + 1, z * 5 + 2);
        if (wd >= 0 && r0 > 0.45) {
          const d = DIRS[wd], px = cx + d[0] * (T * 0.5 - 0.5) + (d[1] ? (r0 - 0.7) * 1.2 : 0), pz = cz + d[1] * (T * 0.5 - 0.5) + (d[0] ? (r0 - 0.7) * 1.2 : 0);
          const kind = Math.floor(hash(x + 11, z + 13) * 3);
          if (kind === 0) {
            const cc = col(0.42, 0.36, 0.24, 1, 0, 0, 4), rot = r0 * 0.6;
            E.push('box', px, h0 + 0.4, pz, rot, 0.8, 0.8, 0.8, cc);
            E.push('box', px, h0 + 0.4, pz, rot, 0.84, 0.1, 0.84, col(0.25, 0.22, 0.16));
            if (r0 > 0.7) E.push('box', px + 0.1, h0 + 1.1, pz - 0.05, rot + 0.4, 0.6, 0.6, 0.6, cc);
          } else if (kind === 1) {
            for (let k = 0; k < 2; k++) {
              const bx = px + (d[1] ? (k - 0.5) * 0.65 : 0), bz = pz + (d[0] ? (k - 0.5) * 0.65 : 0);
              const bc = k ? col(0.62, 0.22, 0.14, 1, 0, 0, 0) : col(0.2, 0.38, 0.5);
              E.push('cyl', bx, h0 + 0.48, bz, 0, 0.56, 0.96, 0.56, bc);
              E.push('cyl', bx, h0 + 0.3, bz, 0, 0.58, 0.05, 0.58, col(0.2, 0.2, 0.22));
              E.push('cyl', bx, h0 + 0.68, bz, 0, 0.58, 0.05, 0.58, col(0.2, 0.2, 0.22));
            }
          } else {
            E.push('oct', px, h0 + 0.35, pz, r0 * 4, 1.1, 0.8, 0.9, CLIFF(0.85));
            E.push('oct', px + 0.55, h0 + 0.18, pz + 0.3, r0 * 7, 0.5, 0.4, 0.45, CLIFF(0.75));
          }
        }
      }
      if ((t === TILE.LANE || t === TILE.FLOOR) && hash(x + 21, z + 17) > 0.55) {
        for (let k = 0; k < 3; k++) {
          const u = hash(x * 7 + k, z * 3 + k * 5), v = hash(z * 7 + k * 3, x * 5 + k);
          const sz = 0.12 + u * 0.18;
          E.push('oct', cx + (u - 0.5) * T * 0.9, h0 + sz * 0.3, cz + (v - 0.5) * T * 0.9, u * 6, sz, sz * 0.6, sz * 0.8, CLIFF(0.7 + v * 0.2));
        }
      }
      E.setDetail(false);
    }
    if (t === TILE.PAD && !S.plat.has(i)) {
      const py = tH(x, z);
      E.push('ring', cx, py + 0.015, cz, 0, T * 0.42, 1, T * 0.42, col(1, 0.68, 0.22, 1, 0.9));
      E.push('box', cx, py + 0.012, cz, 0.785, T * 0.12, 0.01, T * 0.12, col(1, 0.68, 0.22, 1, 0.9));
    }
  }
  // 梯子：两根侧杆 + 横档，顶部伸出扶手，底部亮一条绿色引导灯
  for (const [x, z, dir] of S.def.ladders || []) {
    const d = DIRS[dir], h0 = S.tileH(x, z), h1 = S.tileH(x + d[0], z + d[1]), H = h1 - h0;
    const fx = (x + 0.5 + d[0] * 0.5) * T - d[0] * 0.12, fz = (z + 0.5 + d[1] * 0.5) * T - d[1] * 0.12;
    const ox = d[1] ? 1 : 0, oz = d[0] ? 1 : 0, yaw = Math.atan2(d[0], d[1]);
    const RAIL = col(0.62, 0.6, 0.55, 1, 0, 0, 0), RUNG = col(0.75, 0.72, 0.66);
    for (const sd of [-0.42, 0.42]) {
      E.push('box', fx + ox * sd, h0 + (H + 1.0) / 2, fz + oz * sd, yaw, 0.09, H + 1.0, 0.09, RAIL);
      E.push('box', fx + ox * sd + d[0] * 0.22, h1 + 0.95, fz + oz * sd + d[1] * 0.22, yaw, 0.08, 0.08, 0.5, RAIL);
      E.push('box', fx + ox * sd, h1 + 1.02, fz + oz * sd, yaw, 0.12, 0.06, 0.12, col(1, 0.65, 0.2, 1, 1));
    }
    for (let y = h0 + 0.3; y < h1 + 0.05; y += 0.36) E.push('box', fx, y, fz, yaw, 0.84, 0.05, 0.06, RUNG);
    E.push('box', fx - d[0] * 0.25, h0 + 0.02, fz - d[1] * 0.25, yaw, 0.9, 0.02, 0.4, col(0.42, 0.94, 0.64, 1, 0.9));
  }
  buildPlatforms(S);
  buildCommonStatic(S, TH);
  return E.endStatic();
}
function buildStatic(S) {
  if (S.terrain) return buildTerrainStatic(S);
  const TH = themeOf(S), W = S.W, H = S.H;
  const C3 = (a, emit, panel) => col(a[0], a[1], a[2], 1, emit || 0, 0, panel || 0);
  E.beginStatic();
  E.push('box', W * T / 2, -0.35, H * T / 2, 0, W * T, 0.5, H * T, col(0.02, 0.025, 0.035));
  E.push('box', W * T / 2, WALL_H + 0.25, H * T / 2, 0, W * T, 0.5, H * T, C3(TH.ceil, 0, 17));
  // 材质编号（见 engine.js 片元着色器）：10 金属地板 11 地砖 12 墙板 15 格栅 16 警示条
  const FL = { [TILE.LANE]: C3(TH.lane, 0, 10), [TILE.FLOOR]: C3(TH.floor, 0, 11), [TILE.PAD]: C3(TH.pad, 0, 11), [TILE.BASE]: C3(TH.base, 0, 10), [TILE.SPAWN]: C3(TH.spawn, 0, 10) };
  const WALLC = C3(TH.wall, 0, 12), CORN = C3(TH.cornice, 0, 12);
  const PIPE = col(TH.cornice[0] * 1.6, TH.cornice[1] * 1.6, TH.cornice[2] * 1.6), PIPE2 = col(0.42, 0.36, 0.22), GRATE = col(0.3, 0.32, 0.36, 1, 0, 0, 15), HAZ = col(0.95, 0.72, 0.12, 1, 0, 0, 16);
  const hsh = (x, z, k) => { let h = (x * 374761393 + z * 668265263 + k * 1274126177) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  const TRIM = C3(TH.trim, 1), UPPER = C3(TH.upper, 0.75), LAMP = C3(TH.lamp, 1), REDSTRIP = col(1, 0.25, 0.25, 1, 1);
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const t = tileOf(S, x, z), cx = (x + 0.5) * T, cz = (z + 0.5) * T;
    if (t !== TILE.WALL) {
      E.push('box', cx, -0.1, cz, 0, T * 0.995, 0.2, T * 0.995, FL[t]);
      if ((x * 7 + z * 3) % 4 === 0) E.push('box', cx, WALL_H - 0.03, cz, 0, T * 0.62, 0.06, T * 0.14, LAMP);
      for (let d = 0; d < 4; d++) {
        if (tileOf(S, x + DIRS[d][0], z + DIRS[d][1]) !== TILE.WALL) continue;
        const fx = cx + DIRS[d][0] * (T * 0.5 - 0.02), fz = cz + DIRS[d][1] * (T * 0.5 - 0.02);
        const alongX = DIRS[d][1] !== 0;
        const sx = alongX ? T : 0.05, sz = alongX ? 0.05 : T;
        if (t === TILE.LANE) E.push('box', fx, 0.2, fz, 0, sx, 0.07, sz, TRIM);
        if (t === TILE.SPAWN) E.push('box', fx, 0.2, fz, 0, sx, 0.07, sz, REDSTRIP);
        E.push('box', fx, 4.7, fz, 0, sx, 0.05, sz, UPPER);
        E.push('box', fx, WALL_H - 0.35, fz, 0, alongX ? T : 0.3, 0.7, alongX ? 0.3 : T, CORN);
        // 墙面细节：踢脚板、贴墙管线、通风格栅、壁灯（贴墙薄片，不挡路）
        const nx = -DIRS[d][0], nz = -DIRS[d][1], r = hsh(x, z, d);
        E.setDetail(true);
        E.push('box', fx + nx * 0.05, 0.12, fz + nz * 0.05, 0, alongX ? T : 0.1, 0.24, alongX ? 0.1 : T, CORN);
        for (const [py, pr, pc] of [[3.75, 0.18, PIPE], [4.05, 0.12, PIPE2]]) {
          const ox = fx + nx * (0.12 + pr * 0.5), oz = fz + nz * (0.12 + pr * 0.5);
          E.pushR('pipe', ox, py, oz, 0, alongX ? 0 : Math.PI / 2, alongX ? Math.PI / 2 : 0, pr, T + 0.02, pr, pc);
        }
        if (r < 0.3) E.push('box', fx + nx * 0.04, 1.25, fz + nz * 0.04, 0, alongX ? 1.1 : 0.06, 0.6, alongX ? 0.06 : 1.1, GRATE);
        else if (r < 0.5) {
          E.push('box', fx + nx * 0.08, 2.9, fz + nz * 0.08, 0, alongX ? 0.7 : 0.14, 0.18, alongX ? 0.14 : 0.7, col(0.2, 0.22, 0.25));
          E.push('box', fx + nx * 0.16, 2.86, fz + nz * 0.16, 0, alongX ? 0.6 : 0.02, 0.08, alongX ? 0.02 : 0.6, LAMP);
        } else if (r < 0.62 && t !== TILE.LANE) {
          // 墙边的设备柜
          E.push('box', fx + nx * 0.3, 0.9, fz + nz * 0.3, 0, alongX ? 1.0 : 0.5, 1.8, alongX ? 0.5 : 1.0, col(0.24, 0.26, 0.3, 1, 0, 0, 2));
          E.push('box', fx + nx * 0.56, 1.45, fz + nz * 0.56, 0, alongX ? 0.5 : 0.02, 0.06, alongX ? 0.02 : 0.5, UPPER);
        }
        E.setDetail(false);
      }
      // 通道与玩家区域交界处：警示条纹
      if (t === TILE.LANE) for (let d = 0; d < 4; d++) {
        const nt = tileOf(S, x + DIRS[d][0], z + DIRS[d][1]);
        if (nt !== TILE.FLOOR && nt !== TILE.PAD && nt !== TILE.BASE) continue;
        const alongX = DIRS[d][1] !== 0, fx = cx + DIRS[d][0] * (T * 0.5 - 0.1), fz = cz + DIRS[d][1] * (T * 0.5 - 0.1);
        E.push('box', fx, 0.004, fz, 0, alongX ? T * 0.96 : 0.18, 0.01, alongX ? 0.18 : T * 0.96, HAZ);
      }
    } else {
      let edge = false;
      for (let dz = -1; dz <= 1 && !edge; dz++) for (let dx = -1; dx <= 1; dx++) if (tileOf(S, x + dx, z + dz) !== TILE.WALL) { edge = true; break; }
      if (edge) E.push('box', cx, WALL_H / 2, cz, 0, T, WALL_H, T, WALLC);
    }
    if (t === TILE.PAD && !S.plat.has(z * S.W + x)) {
      const py = 0;
      E.push('ring', cx, py + 0.015, cz, 0, T * 0.42, 1, T * 0.42, col(1, 0.68, 0.22, 1, 0.9));
      E.push('box', cx, py + 0.012, cz, 0.785, T * 0.12, 0.01, T * 0.12, col(1, 0.68, 0.22, 1, 0.9));
    }
  }
  buildPlatforms(S);
  buildCommonStatic(S, TH);
  return E.endStatic();
}

/* ============================================================
 * 粒子 / 光源 / 浮动文字
 * ============================================================ */
const parts = [];
const MAXP = (window.__TOUCH || matchMedia('(pointer: coarse)').matches) ? 650 : 1100;
function particle(o) {
  if (parts.length >= MAXP) parts.shift();
  o.t = 0; o.vx = o.vx || 0; o.vy = o.vy || 0; o.vz = o.vz || 0; o.grav = o.grav || 0; o.drag = o.drag || 0;
  o.s0 = o.s0 || 0.15; o.s1 = o.s1 === undefined ? o.s0 : o.s1; o.a0 = o.a0 === undefined ? 1 : o.a0;
  o.g = o.g === 'sphere' || !o.g ? 'ball' : o.g; o.c = o.c || [1, 1, 1]; o.add = o.add !== false;
  parts.push(o);
}
function burst(x, y, z, n, o) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, e = rnd(-0.3, 1), sp = rnd(o.sp0 || 2, o.sp1 || 6);
    particle({
      x, y, z, vx: cosA(a, e) * sp, vy: e * sp, vz: Math.sin(a) * Math.cos(e) * sp,
      life: rnd(o.l0 || 0.3, o.l1 || 0.7), s0: o.s0 || 0.12, s1: o.s1 === undefined ? 0.02 : o.s1, c: o.c, add: o.add !== false,
      grav: o.grav === undefined ? 9 : o.grav, g: o.g || 'sphere', drag: o.drag || 1.5, bounce: o.bounce, a0: o.a0,
    });
  }
}
function cosA(a, e) { return Math.cos(a) * Math.cos(e); }
const lights = [];
function flashLight(x, y, z, r, c3, i, life) { lights.push({ x, y, z, r, c: c3, i, life, t: 0 }); }

const nums = [];
const numLayer = $('nums');
function floatNum(x, y, z, text, cls) {
  let el = null;
  for (const n of nums) if (!n.on) { el = n; break; }
  if (!el) {
    if (nums.length >= 48) { el = nums[0]; for (const n of nums) if (n.t > el.t) el = n; }
    else { el = { div: document.createElement('div') }; el.div.className = 'num'; numLayer.appendChild(el.div); nums.push(el); }
  }
  el.on = true; el.x = x; el.y = y; el.z = z; el.t = 0; el.vy = 1.2; el.ox = rnd(-0.3, 0.3);
  el.div.textContent = text; el.div.className = 'num ' + (cls || '');
}

/* ============================================================
 * 摄像机 / 投影
 * ============================================================ */
const VIEW = new Float32Array(16), PROJ = new Float32Array(16), VP = new Float32Array(16);
function setupCamera(ex, ey, ez, yaw, pitch, fov) {
  const W = canvas.width, H = canvas.height;
  Engine.perspective(PROJ, fov * Math.PI / 180, W / H, 0.05, 260);
  Engine.viewFPS(VIEW, ex, ey, ez, yaw, pitch);
  Engine.mul(VP, PROJ, VIEW);
  if (E) E.setFrustum(VP);
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  cam.x = ex; cam.y = ey; cam.z = ez;
  cam.fx = -sy * cp; cam.fy = sp; cam.fz = -cy * cp; cam.rx = cy; cam.rz = -sy;
  cam.ux = -cam.rz * cam.fy; cam.uy = cam.rz * cam.fx - cam.rx * cam.fz; cam.uz = cam.rx * cam.fy;
  cam.rYaw = yaw; cam.rPitch = pitch;
}
function project(x, y, z) {
  const m = VP;
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (cw <= 0.05) return null;
  return { x: (cx / cw * 0.5 + 0.5) * innerWidth, y: (1 - (cy / cw * 0.5 + 0.5)) * innerHeight };
}
// 自适应分辨率：帧时间过长时自动降低渲染分辨率
const TOUCH = !!(window.__TOUCH || /[?&]touch=1/.test(location.search) || (matchMedia('(pointer: coarse)').matches && (navigator.maxTouchPoints || 0) > 0));
const quality = { base: Math.min(window.devicePixelRatio || 1, TOUCH ? 1.5 : 1.25), scale: 0, acc: 0, n: 0, cool: 0 };
quality.scale = TOUCH ? Math.min(quality.base, 1.0) : quality.base;   // 手机先从 1 倍起步，跑得动再慢慢升
function resize() {
  let sc = window.__RES || quality.scale;
  const maxPix = 2.4e6, pix = innerWidth * innerHeight * sc * sc;
  if (pix > maxPix) sc *= Math.sqrt(maxPix / pix);
  canvas.width = Math.max(1, Math.floor(innerWidth * sc));
  canvas.height = Math.max(1, Math.floor(innerHeight * sc));
}
const fpsM = { t: 0, n: 0, worst: 0 };
function fpsMeter(dt) {
  if (!settings.showFps) return;
  fpsM.t += dt; fpsM.n++; fpsM.worst = Math.max(fpsM.worst, dt);
  if (fpsM.t < 0.5) return;
  const st = E.stats();
  $('fpsTag').textContent = `${Math.round(fpsM.n / fpsM.t)} FPS  最慢 ${Math.round(fpsM.worst * 1000)}ms\n分辨率 ${canvas.width}×${canvas.height}（×${(quality.scale || 1).toFixed(2)}）${quality.autoLow ? ' 低精细' : ''}\n绘制 ${st.draws} 批 · ${st.inst} 个物体`;
  fpsM.t = 0; fpsM.n = 0; fpsM.worst = 0;
}
function adaptQuality(dt) {
  if (document.hidden) return;
  quality.acc += dt; quality.n++; quality.cool -= dt;
  if (quality.acc < 1.5) return;
  const avg = quality.acc / quality.n; quality.acc = 0; quality.n = 0;
  if (quality.cool > 0) return;
  if (avg > 0.028 && quality.scale > 0.5) { quality.scale = Math.max(0.5, quality.scale * 0.85); resize(); quality.cool = 2; quality.slow = 0; }
  else if (avg > 0.03 && !quality.autoLow && settings.detail !== 'low' && ++quality.slow >= 2) {
    // 分辨率已经降到底还是卡：本局自动改用低材质精细度（不改玩家的设置）
    quality.autoLow = true; quality.cool = 4;
    if (mode === 'play') toast('画面较卡，已自动降低材质精细度（可在设置中调整）');
  }
  else if (avg < 0.0135 && quality.scale < quality.base) { quality.scale = Math.min(quality.base, quality.scale * 1.08); resize(); quality.cool = 3; }
}
addEventListener('resize', resize); resize();

/* ============================================================
 * 怪物绘制
 * ============================================================ */
const MX = { x: 0, y: 0, z: 0, yaw: 0, cy: 1, sy: 0, s: 1 };
const TN = { slow: 0, poison: 0, burn: 0, flash: 0, enr: 0, champ: false };
function mc(r, g, b, emit, a) {
  let R = r, G = g, B = b, em = emit || 0;
  if (TN.slow > 0) { const k = Math.min(0.85, 0.45 * TN.slow); R = lerp(R, 0.55, k); G = lerp(G, 0.78, k); B = lerp(B, 1.0, k); }
  if (TN.poison) { R = lerp(R, 0.35, 0.3); G = lerp(G, 0.85, 0.3); B = lerp(B, 0.3, 0.3); }
  if (TN.burn) { R = lerp(R, 1.0, 0.35); G = lerp(G, 0.45, 0.35); B = lerp(B, 0.15, 0.35); em = Math.max(em, 0.25 + Math.random() * 0.2); }
  if (TN.champ && !emit) { R = lerp(R, 1, 0.35); G = lerp(G, 0.78, 0.35); B = lerp(B, 0.25, 0.35); em = Math.max(em, 0.12); }
  if (TN.enr && !emit) { R = lerp(R, 0.9, 0.35); G = lerp(G, 0.15, 0.35); B = lerp(B, 0.1, 0.35); em = Math.max(em, 0.2); }
  return c(R, G, B, a === undefined ? 1 : a, em, TN.flash);
}
function P(g, lx, ly, lz, sx, sy, sz, cc, yawOff) {
  const s = MX.s;
  lx *= s; ly *= s; lz *= s;
  E.push(g, MX.x + MX.cy * lx + MX.sy * lz, MX.y + ly, MX.z - MX.sy * lx + MX.cy * lz, MX.yaw + (yawOff || 0), sx * s, sy * s, sz * s, cc);
}
function PR(g, lx, ly, lz, pitch, roll, sx, sy, sz, cc, yawOff) {
  const s = MX.s;
  lx *= s; ly *= s; lz *= s;
  E.pushR(g, MX.x + MX.cy * lx + MX.sy * lz, MX.y + ly, MX.z - MX.sy * lx + MX.cy * lz, MX.yaw + (yawOff || 0), pitch, roll, sx * s, sy * s, sz * s, cc);
}
// 绕 X 轴摆动的肢体：(lx,ly,lz) 为关节点
function LIMB(g, lx, ly, lz, len, w, d, ang, cc, roll) {
  const oy = -len / 2 * Math.cos(ang), oz = -len / 2 * Math.sin(ang);
  PR(g, lx, ly + oy, lz + oz, ang, roll || 0, w, len, d, cc);
}
function LOCAL(lx, ly, lz) { const s = MX.s; lx *= s; ly *= s; lz *= s; return [MX.x + MX.cy * lx + MX.sy * lz, MX.y + ly, MX.z - MX.sy * lx + MX.cy * lz]; }

let S_cur = null;
// 熔炉巨像：玄武岩躯体 + 发光熔岩裂纹
function drawColossus(m, x, y, z, sw, moving, t) {
  const R = () => mc(0.2, 0.15, 0.14), R2 = () => mc(0.28, 0.21, 0.17);
  const glow = 0.75 + 0.25 * Math.sin(t * 3), L = () => c(1, 0.42, 0.08, 1, glow, TN.flash), L2 = () => c(1, 0.5, 0.12, 1, glow * 0.7);
  LIMB('box', -1.0, 3.0, 0, 3.0, 0.95, 1.1, sw * 0.4, R());
  LIMB('box', 1.0, 3.0, 0, 3.0, 0.95, 1.1, -sw * 0.4, R());
  LIMB('box', -1.0, 2.2, -0.01, 1.2, 1.0, 1.15, sw * 0.4, L2());
  LIMB('box', 1.0, 2.2, -0.01, 1.2, 1.0, 1.15, -sw * 0.4, L2());
  P('box', 0, 3.2, 0, 2.4, 0.9, 1.4, R2());
  P('box', 0, 4.4, 0, 3.2, 2.2, 2.0, R());
  P('box', 0, 4.4, -1.02, 1.4, 1.6, 0.06, L());
  P('box', 0, 4.4, -1.04, 0.3, 1.9, 0.05, L());
  P('box', -2.1, 5.2, 0, 1.2, 1.0, 1.6, R2());
  P('box', 2.1, 5.2, 0, 1.2, 1.0, 1.6, R2());
  P('box', 0, 5.85, -0.15, 1.1, 0.9, 1.0, R());
  P('box', 0, 5.9, -0.66, 0.9, 0.18, 0.04, L());
  for (const sd of [-1, 1]) {
    const sh = LOCAL(sd * 2.2, 4.8, 0), hand = LOCAL(sd * 2.5, 2.2 + Math.abs(sw) * 0.4, -0.6 - sw * sd * 0.6);
    E.pushBeam('box', sh[0], sh[1], sh[2], hand[0], hand[1], hand[2], 0.9, 0.9, R());
    E.push('sphere', hand[0], hand[1], hand[2], 0, 1.0, 1.0, 1.0, L());
    if (Math.random() < 0.3) particle({ x: hand[0], y: hand[1], z: hand[2], vy: -2, life: 0.8, s0: 0.15, s1: 0.05, c: [1, 0.5, 0.1], grav: 8, bounce: true });
  }
  if (Math.random() < 0.4) particle({ x: x + rnd(-1, 1), y: rnd(1, 5), z: z + rnd(-1, 1), vy: rnd(0.5, 2), life: 1, s0: 0.1, s1: 0, c: [1, 0.55, 0.15], grav: -0.5 });
  void moving; void y;
}
function drawMonster(m, a) {
  const def = MON[m.type];
  const x = lerp(m.ox, m.x, a), y = lerp(m.oy, m.y, a), z = lerp(m.oz, m.z, a);
  const yaw = Math.atan2(-m.fx, -m.fz);
  MX.x = x; MX.y = y; MX.z = z; MX.yaw = yaw; MX.cy = Math.cos(yaw); MX.sy = Math.sin(yaw); MX.s = 1;
  TN.slow = m.frozenT > 0 ? 2 : m.slowAmt > 0 ? 1 : 0; TN.poison = m.poisonT > 0; TN.burn = m.burnT > 0; TN.flash = m.hitT > 0 ? 0.55 : 0; TN.enr = m.enraged; TN.champ = !!m.champ;
  const moving = m.state === 'move' && m.stunT <= 0;
  const ph = timeNow * def.spd * 2.1 * (1 - m.slowAmt * 0.55) + m.seed;
  const sw = moving ? Math.sin(ph) : 0;
  const atk = m.state === 'block' && m.stunT <= 0 ? Math.sin(timeNow * 8 + m.seed) : 0;
  const t = timeNow + m.seed;
  const born = clamp((simNow - (m.born || 0)) / 0.35, 0.05, 1);
  let top = 2.1, ghost = false;
  if (born < 1) E.push('sphere', x, y + 1, z, 0, 2.6 * (1 - born) + 0.3, 3 * (1 - born) + 0.3, 2.6 * (1 - born) + 0.3, c(1, 0.3, 0.25, 0.5 * (1 - born), 1, 0, true));
  switch (m.type) {
    case 'grunt': case 'brute': {
      const big = m.type === 'brute', sc = big ? 1.45 : 1;
      if (hasModel('robot')) {
        let clip = 'walk', rate = def.spd / (2.6 * sc);
        if (m.state === 'block' && m.stunT <= 0) { clip = 'punch'; rate = 1.15; }
        else if (m.stunT > 0 || m.state === 'queue') { clip = 'idle'; rate = 1; }
        else if (m.launchT > 0) { clip = 'run'; rate = 1.6; }
        rate *= 1 - m.slowAmt * 0.55;
        animClip('robot', clip, timeNow * rate + m.seed);
        const tn = big ? (m.enraged ? [0.9, 0.4, 0.4] : [0.55, 0.62, 0.8]) : [1, 1, 1];
        E.push('robot', x, y, z, yaw, sc * born, sc * born, sc * born, mc(tn[0], tn[1], tn[2], 0));
        E.anim();
        if (big) P('sphere', 0, 1.18 * sc, -0.33 * sc, 0.32, 0.32, 0.16, mc(1, 0.55, 0.15, 1));
      }
      top = 1.95 * sc + 0.1; break;
    }
    case 'runner': {
      if (hasModel('fox')) {
        let clip = 'run', rate = def.spd / 5.2;
        if (m.state !== 'move' || m.stunT > 0) { clip = 'walk'; rate = m.state === 'block' && m.stunT <= 0 ? 1.8 : 0.2; }
        rate *= 1 - m.slowAmt * 0.55;
        animClip('fox', clip, timeNow * rate + m.seed);
        E.push('fox', x, y, z, yaw, born, born, born, mc(0.72, 0.55, 0.55, 0));
        E.anim();
        P('box', 0, 0.62, -0.84, 0.16, 0.035, 0.03, mc(1, 0.25, 0.12, 1));
      }
      top = 1.1; break;
    }
    case 'stalker': case 'sapper': case 'gunner': {
      // 机器人底模 + 各自的配件
      const sc = m.type === 'gunner' ? 1.05 : 0.92;
      if (m.aiming) { MX.yaw = Math.atan2(-m.ax, -m.az); MX.cy = Math.cos(MX.yaw); MX.sy = Math.sin(MX.yaw); }
      if (hasModel('robot')) {
        let clip = m.type === 'stalker' ? 'run' : 'walk', rate = def.spd / (m.type === 'stalker' ? 4.4 : 2.6);
        if (m.state === 'block' && m.stunT <= 0) { clip = 'punch'; rate = 1.15; }
        else if (m.stunT > 0 || m.state === 'queue' || m.state === 'hack' || m.aiming) { clip = 'idle'; rate = 1; }
        rate *= 1 - m.slowAmt * 0.55;
        animClip('robot', clip, timeNow * rate + m.seed);
        if (m.type === 'stalker' && m.cloak) {
          // 隐身：只剩一层流动的折光轮廓
          E.push('robot', x, y, z, MX.yaw, sc * born, sc * born, sc * born, c(0.35, 0.7, 1, 0.13 + 0.07 * Math.sin(t * 7), 0.7, 0, true));
          E.anim(); ghost = true; top = 2.0; break;
        }
        const tn = m.type === 'stalker' ? [0.34, 0.27, 0.5] : m.type === 'sapper' ? [1, 0.8, 0.32] : [0.95, 0.42, 0.38];
        E.push('robot', x, y, z, MX.yaw, sc * born, sc * born, sc * born, mc(tn[0], tn[1], tn[2], 0));
        E.anim();
      }
      if (m.type === 'stalker') {
        for (const sd of [-1, 1]) PR('box', sd * 0.42, 0.95, -0.35, -0.4, 0, 0.04, 0.05, 0.85, c(0.8, 0.45, 1, 1, 1, TN.flash));
        P('box', 0, 1.68, -0.24, 0.26, 0.05, 0.03, c(0.85, 0.5, 1, 1, 1));
      } else if (m.type === 'sapper') {
        P('box', 0, 1.25, 0.3, 0.46, 0.5, 0.26, mc(0.24, 0.24, 0.27));
        P('box', 0.14, 1.85, 0.36, 0.025, 0.55, 0.025, mc(0.3, 0.3, 0.32));
        const bl = Math.sin(timeNow * 8 + m.seed) > 0;
        P('sphere', 0.14, 2.15, 0.36, 0.08, 0.08, 0.08, c(0.3, 1, 0.5, 1, bl ? 1 : 0.2));
        if (m.state === 'hack') {
          let tr = null, bd = 3.8;
          for (const q of S_cur.s.traps) { const d = Math.hypot(q.wx - x, q.wz - z); if (d < bd) { bd = d; tr = q; } }
          if (tr) {
            let x0 = x, y0 = y + 1.3, z0 = z; const ty = tr.kind === 'ceil' ? tr.wy - 0.6 : tr.kind === 'wall' ? tr.wy : tr.wy + 0.5;
            for (let k = 1; k <= 4; k++) {
              const f = k / 4, j = k < 4 ? 0.25 : 0;
              const xn = lerp(x, tr.wx, f) + rnd(-j, j), yn = lerp(y + 1.3, ty, f) + rnd(-j, j), zn = lerp(z, tr.wz, f) + rnd(-j, j);
              E.pushBeam('box', x0, y0, z0, xn, yn, zn, 0.05, 0.05, c(0.3, 1, 0.55, 1, 1, 0, true));
              x0 = xn; y0 = yn; z0 = zn;
            }
            if (Math.random() < 0.4) burst(tr.wx, ty, tr.wz, 1, { c: [0.3, 1, 0.5], sp0: 1, sp1: 3, s0: 0.05, l0: 0.1, l1: 0.25 });
          }
        }
      } else {
        P('box', 0.22, 1.2, -0.42, 0.12, 0.15, 0.8, mc(0.17, 0.17, 0.2));
        P('box', 0.22, 1.32, -0.2, 0.06, 0.1, 0.25, c(1, 0.3, 0.25, 1, 0.8));
        if (m.aiming) {
          const g0 = LOCAL(0.22, 1.22, -0.85), L = 12;
          E.pushBeam('box', g0[0], g0[1], g0[2], g0[0] + m.ax * L, g0[1] + 0.1, g0[2] + m.az * L, 0.015, 0.015, c(1, 0.2, 0.2, 0.55, 1, 0, true));
        }
      }
      top = 2.1; break;
    }
    case 'burrower': {
      if (m.burrow) {
        E.push('sphere', x, -0.1, z, t, 1.4, 0.4, 1.4, c(0.22, 0.18, 0.15));
        if (Math.random() < 0.7) particle({ x: x + rnd(-0.6, 0.6), y: 0.15, z: z + rnd(-0.6, 0.6), vx: rnd(-1, 1), vy: rnd(1, 3), vz: rnd(-1, 1), life: 0.6, s0: 0.12, s1: 0.04, c: [0.32, 0.25, 0.2], g: 'box', grav: 12, add: false });
        ghost = true; top = 0.6; break;
      }
      for (let i = 4; i >= 0; i--) {
        const r = 0.6 - i * 0.07, wob = Math.sin(ph * 1.6 - i * 0.9) * 0.12;
        P('sphere', wob, 0.45 + Math.abs(Math.sin(ph * 1.6 - i)) * 0.08, -0.35 + i * 0.5, r * 1.1, r * 0.95, r * 1.1, i % 2 ? mc(0.42, 0.3, 0.22) : mc(0.52, 0.38, 0.26));
      }
      P('cone', -0.2, 0.42, -0.9, 0.12, 0.4, 0.12, mc(0.85, 0.8, 0.7), 0.5);
      P('cone', 0.2, 0.42, -0.9, 0.12, 0.4, 0.12, mc(0.85, 0.8, 0.7), -0.5);
      P('sphere', -0.18, 0.66, -0.78, 0.09, 0.09, 0.09, c(1, 0.65, 0.2, 1, 1));
      P('sphere', 0.18, 0.66, -0.78, 0.09, 0.09, 0.09, c(1, 0.65, 0.2, 1, 1));
      top = 1.2; break;
    }
    case 'mite': {
      MX.s = 0.5;
      const pulse = 0.5 + 0.5 * Math.sin(t * 9);
      P('sphere', 0, 0.6, 0.1, 0.95, 0.6, 1.05, mc(0.2, 0.14, 0.24));
      P('sphere', 0, 0.62, 0.35, 0.6, 0.45, 0.65, c(0.8, 0.35 + pulse * 0.2, 1, 0.9, 1, TN.flash, true));
      for (let i = 0; i < 6; i++) {
        const side = i < 3 ? -1 : 1, k = i % 3, lz = (k - 1) * 0.35, step = moving ? Math.sin(ph * 2.5 + i * 2.1) : 0;
        const hip = LOCAL(side * 0.35, 0.62, lz), knee = LOCAL(side * 0.75, 0.95 + Math.max(0, step) * 0.15, lz + step * 0.1), foot = LOCAL(side * 1.05, 0.02, lz * 1.4 + step * 0.18);
        E.pushBeam('box', hip[0], hip[1], hip[2], knee[0], knee[1], knee[2], 0.05, 0.05, mc(0.16, 0.12, 0.18));
        E.pushBeam('box', knee[0], knee[1], knee[2], foot[0], foot[1], foot[2], 0.04, 0.04, mc(0.16, 0.12, 0.18));
      }
      top = 0.7; break;
    }
    case 'siege': {
      MX.s = 1;
      const tk = moving ? (timeNow * 2) % 1 : 0;
      for (const sd of [-1, 1]) {
        P('box', sd * 1.25, 0.55, 0, 0.85, 1.1, 3.4, mc(0.14, 0.14, 0.15));
        for (let i = 0; i < 4; i++) P('box', sd * 1.68, 0.55, -1.2 + ((i + tk) % 4) * 0.8, 0.02, 0.9, 0.1, mc(0.3, 0.3, 0.3));
      }
      P('box', 0, 1.55, 0, 2.3, 1.1, 2.9, mc(0.44, 0.42, 0.33));
      P('box', 0, 1.6, -1.47, 2.0, 0.7, 0.06, mc(0.32, 0.3, 0.24));
      P('box', 0, 2.55, 0.15, 1.7, 0.95, 1.8, mc(0.38, 0.37, 0.3));
      P('box', 0, 2.62, -0.78, 0.9, 0.14, 0.04, c(1, 0.3, 0.2, 1, 1, TN.flash));
      const c0 = LOCAL(0, 2.75, -0.5), c1 = LOCAL(0, 3.5, -3.3);
      E.pushBeam('cyl', c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], 0.42, 0.42, mc(0.2, 0.2, 0.22), true);
      E.push('sphere', c1[0], c1[1], c1[2], 0, 0.5, 0.5, 0.5, mc(0.12, 0.12, 0.13));
      for (const sd of [-1, 1]) P('box', sd * 0.95, 3.15, 0.6, 0.35, 0.5, 0.8, mc(0.3, 0.3, 0.26));
      top = 4.4; break;
    }
    case 'brood': case 'broodling': {
      MX.s = m.type === 'brood' ? 1 : 0.6;
      const pulse = 1 + 0.06 * Math.sin(t * 3);
      P('sphere', 0, 2.1, 0.5, 3.0 * pulse, 2.4 * pulse, 3.4 * pulse, mc(0.26, 0.15, 0.3));
      for (let i = 0; i < 6; i++) { const a = i * 1.05 + 0.4; P('sphere', Math.cos(a) * 1.2, 2.4 + Math.sin(a * 2) * 0.6, 0.6 + Math.sin(a) * 1.3, 0.45, 0.45, 0.45, c(0.95, 0.4, 1, 1, 0.6 + 0.4 * Math.sin(t * 4 + i), TN.flash)); }
      P('sphere', 0, 1.6, -1.4, 1.3, 1.05, 1.2, mc(0.2, 0.12, 0.22));
      P('cone', -0.4, 1.25, -2.0, 0.22, 0.7, 0.22, mc(0.85, 0.75, 0.8), 0.6);
      P('cone', 0.4, 1.25, -2.0, 0.22, 0.7, 0.22, mc(0.85, 0.75, 0.8), -0.6);
      P('box', 0, 1.85, -1.98, 0.7, 0.12, 0.05, c(1, 0.3, 0.6, 1, 1, TN.flash));
      for (let i = 0; i < 8; i++) {
        const side = i < 4 ? -1 : 1, k = i % 4, lz = (k - 1.5) * 0.9, step = moving ? Math.sin(ph * 1.2 + i * 1.7) : 0;
        const hip = LOCAL(side * 1.1, 1.5, lz), knee = LOCAL(side * 2.4, 2.6 + Math.max(0, step) * 0.3, lz + step * 0.3), foot = LOCAL(side * 3.0, 0.05, lz * 1.3 + step * 0.4);
        E.pushBeam('box', hip[0], hip[1], hip[2], knee[0], knee[1], knee[2], 0.2 * MX.s, 0.2 * MX.s, mc(0.16, 0.1, 0.18));
        E.pushBeam('box', knee[0], knee[1], knee[2], foot[0], foot[1], foot[2], 0.15 * MX.s, 0.15 * MX.s, mc(0.16, 0.1, 0.18));
      }
      top = m.type === 'brood' ? 4.2 : 2.6; break;
    }
    case 'flyer': case 'healer': {
      const hl = m.type === 'healer';
      if (hasModel('drone')) {
        animStatic('drone');
        const tn = hl ? [0.55, 1, 0.65] : [0.9, 0.86, 1.0];
        E.pushR('drone', x, y - 0.55 * born, z, yaw, Math.sin(t * 1.3) * 0.12, Math.sin(t) * 0.16, born * (hl ? 1.1 : 1), born * (hl ? 1.1 : 1), born * (hl ? 1.1 : 1), mc(tn[0], tn[1], tn[2], 0));
        E.anim();
        E.push('disc', x, y - 0.6, z, t * 4, 1.2, 1, 1.2, hl ? c(0.4, 1, 0.5, 0.25, 1, 0, true) : c(0.75, 0.45, 1, 0.22, 1, 0, true));
      }
      if (hl) {
        const pu = 0.6 + 0.4 * Math.sin(timeNow * 5 + m.seed);
        E.push('box', x, y + 0.85, z, timeNow, 0.5, 0.14, 0.14, c(0.4, 1, 0.5, 1, pu));
        E.push('box', x, y + 0.85, z, timeNow, 0.14, 0.14, 0.5, c(0.4, 1, 0.5, 1, pu));
        E.push('ring', x, y - 0.4, z, 0, 5.5, 1, 5.5, c(0.35, 1, 0.5, 0.12 * pu, 1, 0, true));
      }
      top = hl ? 1.1 : 0.75; break;
    }
    case 'bomber': {
      const pulse = 0.5 + 0.5 * Math.sin(t * 9);
      MX.y += moving ? Math.abs(Math.sin(ph * 2)) * 0.05 : 0;
      P('sphere', 0, 0.6, 0.1, 0.95, 0.6, 1.05, mc(0.2, 0.2, 0.22));
      P('sphere', 0, 0.62, 0.15, 0.6, 0.45, 0.65, c(1.0, 0.45 + pulse * 0.2, 0.1, 0.85, 1, TN.flash, true));
      P('box', 0, 0.68, -0.48, 0.34, 0.2, 0.2, mc(0.25, 0.24, 0.26));
      P('box', 0, 0.7, -0.59, 0.24, 0.05, 0.02, mc(1, 0.6, 0.1, 1));
      for (let i = 0; i < 6; i++) {
        const side = i < 3 ? -1 : 1, k = i % 3;
        const lz = (k - 1) * 0.35, step = moving ? Math.sin(ph * 1.5 + i * 2.1) : 0;
        const hip = LOCAL(side * 0.35, 0.62, lz);
        const knee = LOCAL(side * 0.75, 0.95 + Math.max(0, step) * 0.15, lz + step * 0.1);
        const foot = LOCAL(side * 1.05, 0.02, lz * 1.4 + step * 0.18);
        const lc = mc(0.16, 0.16, 0.18);
        E.pushBeam('box', hip[0], hip[1], hip[2], knee[0], knee[1], knee[2], 0.08, 0.08, lc);
        E.pushBeam('box', knee[0], knee[1], knee[2], foot[0], foot[1], foot[2], 0.07, 0.07, lc);
      }
      top = 1.3; break;
    }
    case 'elite': {
      const bob = moving ? Math.abs(Math.cos(ph)) * 0.1 : 0;
      MX.y += bob;
      LIMB('box', -0.45, 1.1, 0.35, 1.1, 0.42, 0.45, sw * 0.5, mc(0.15, 0.14, 0.16));
      LIMB('box', 0.45, 1.1, 0.35, 1.1, 0.42, 0.45, -sw * 0.5, mc(0.15, 0.14, 0.16));
      PR('box', 0, 1.95, 0, 0.35, 0, 1.5, 1.35, 1.1, mc(0.25, 0.22, 0.25));
      PR('box', 0, 2.25, -0.25, 0.35, 0, 1.0, 0.6, 0.5, mc(0.32, 0.28, 0.3));
      P('box', 0, 2.55, -0.72, 0.6, 0.55, 0.55, mc(0.22, 0.2, 0.22));
      P('box', -0.14, 2.62, -1.0, 0.12, 0.06, 0.02, mc(1, 0.2, 0.15, 1));
      P('box', 0.14, 2.62, -1.0, 0.12, 0.06, 0.02, mc(1, 0.2, 0.15, 1));
      P('box', 0, 2.42, -0.98, 0.3, 0.08, 0.04, mc(0.9, 0.85, 0.8));
      const arm = atk ? -0.9 + atk * 0.9 : -sw * 0.7;
      LIMB('box', -0.92, 2.45, -0.3, 2.2, 0.42, 0.45, arm - 0.25, mc(0.24, 0.21, 0.23));
      LIMB('box', 0.92, 2.45, -0.3, 2.2, 0.42, 0.45, (atk ? -0.9 - atk * 0.9 : sw * 0.7) - 0.25, mc(0.24, 0.21, 0.23));
      top = 3.4; break;
    }
    case 'shield': case 'blinker': {
      const sh = m.type === 'shield', sc = sh ? 1.2 : 0.95;
      if (hasModel('robot')) {
        let clip = sh ? 'walk' : 'run', rate = def.spd / (sh ? 2.6 * sc : 4.4);
        if (m.state === 'block' && m.stunT <= 0) { clip = 'punch'; rate = 1.15; }
        else if (m.stunT > 0 || m.state === 'queue') { clip = 'idle'; rate = 1; }
        rate *= 1 - m.slowAmt * 0.55;
        animClip('robot', clip, timeNow * rate + m.seed);
        const tn = sh ? [0.38, 0.62, 0.75] : [0.5, 0.36, 0.85];
        E.push('robot', x, y, z, yaw, sc * born, sc * born, sc * born, mc(tn[0], tn[1], tn[2], 0));
        if (!sh) {   // 相位残影
          const g = Math.sin(t * 11) > 0.3 ? 0.18 : 0.08;
          E.push('robot', x + m.fx * 0.35, y, z + m.fz * 0.35, yaw, sc, sc, sc, c(0.6, 0.4, 1, g, 1, 0, true));
          E.push('robot', x + m.fx * 0.7, y, z + m.fz * 0.7, yaw, sc, sc, sc, c(0.4, 0.8, 1, g * 0.6, 1, 0, true));
        }
        E.anim();
      }
      if (sh) {
        const pu = 0.5 + 0.5 * Math.sin(t * 4);
        P('box', 0, 1.3, 0.42, 0.62, 0.72, 0.32, mc(0.22, 0.24, 0.28));
        P('cyl', 0, 1.82, 0.45, 0.16, 0.36, 0.16, mc(0.3, 0.32, 0.36));
        P('sphere', 0, 2.08, 0.45, 0.3, 0.3, 0.3, c(0.4, 0.85, 1, 1, 0.6 + 0.4 * pu, TN.flash));
        // 前方的六边形能量盾牌
        P('box', 0.22, 0.98, -0.72, 0.95, 1.1, 0.05, c(0.3, 0.7, 1, 0.07 + 0.04 * pu, 0.5, 0, true));
        for (const [ox, oy, w, h] of [[0.22, 1.53, 0.95, 0.05], [0.22, 0.43, 0.95, 0.05], [-0.25, 0.98, 0.05, 1.1], [0.69, 0.98, 0.05, 1.1]]) P('box', ox, oy, -0.72, w, h, 0.06, c(0.45, 0.85, 1, 1, 0.7, TN.flash));
        top = 2.45;
      } else {
        P('box', 0, 1.52, -0.36, 0.34, 0.06, 0.04, c(0.75, 0.5, 1, 1, 1, TN.flash));
        for (const sd of [-1, 1]) P('box', sd * 0.3, 1.0, 0.32, 0.08, 0.7, 0.08, c(0.4, 0.85, 1, 1, 0.7 + 0.3 * Math.sin(t * 9 + sd)));
        top = 2.0;
      }
      break;
    }
    case 'tank': {
      MX.s = 1;
      const tk = moving ? (timeNow * 1.8) % 1 : 0;
      for (const sd of [-1, 1]) {
        P('box', sd * 0.98, 0.42, 0, 0.55, 0.84, 2.9, mc(0.12, 0.12, 0.13));
        for (let i = 0; i < 5; i++) P('box', sd * 1.27, 0.42, -1.2 + ((i + tk) % 5) * 0.6, 0.02, 0.72, 0.1, mc(0.28, 0.28, 0.28));
        for (let i = 0; i < 4; i++) PR('cyl', sd * 1.0, 0.36, -1.05 + i * 0.7, 0, Math.PI / 2, 0.56, 0.6, 0.56, mc(0.2, 0.2, 0.21));
      }
      P('box', 0, 0.98, 0.1, 1.75, 0.62, 2.6, mc(0.36, 0.38, 0.31));
      PR('box', 0, 0.92, -1.25, -0.6, 0, 1.75, 0.5, 0.5, mc(0.32, 0.34, 0.28));
      for (const sd of [-1, 1]) P('box', sd * 0.95, 1.05, 0.1, 0.12, 0.5, 2.2, mc(0.45, 0.43, 0.3));
      P('box', 0, 1.55, 0.15, 1.25, 0.55, 1.35, mc(0.42, 0.44, 0.36));
      P('box', 0, 1.88, 0.35, 0.7, 0.14, 0.6, mc(0.3, 0.31, 0.26));
      P('sphere', 0, 1.75, -0.6, 0.55, 0.36, 0.3, c(1, 0.35, 0.2, 1, 0.8 + 0.2 * Math.sin(t * 5), TN.flash));
      const rec = m.canT !== undefined && def.cannon && m.canT > def.cannon.every - 0.3 ? 0.25 : 0;
      const b0 = LOCAL(0, 1.45, -0.5 + rec), b1 = LOCAL(0, 1.5, -2.5 + rec);
      E.pushBeam('cyl', b0[0], b0[1], b0[2], b1[0], b1[1], b1[2], 0.24, 0.24, mc(0.18, 0.18, 0.2), true);
      E.push('cyl', b1[0], b1[1], b1[2], 0, 0.34, 0.3, 0.34, mc(0.15, 0.15, 0.16));
      P('box', 0.5, 2.05, 0.55, 0.06, 0.5, 0.06, mc(0.2, 0.2, 0.2));
      top = 2.3; break;
    }
    case 'gunship': {
      MX.s = 1;
      const tilt = Math.sin(t * 1.1) * 0.08;
      if (m.aiming) { MX.yaw = Math.atan2(-m.ax, -m.az); MX.cy = Math.cos(MX.yaw); MX.sy = Math.sin(MX.yaw); }
      P('box', 0, 0, 0.25, 1.1, 0.62, 2.7, mc(0.3, 0.32, 0.37));
      PR('box', 0, 0.05, -0.85, 0.35, tilt, 0.95, 0.55, 0.8, mc(0.26, 0.28, 0.33));
      P('sphere', 0, 0.3, -1.15, 0.85, 0.62, 0.85, c(1, 0.5, 0.2, 1, 0.8 + 0.2 * Math.sin(t * 6), TN.flash));
      PR('box', 0, 0.02, 0.35, 0, tilt, 3.6, 0.12, 0.85, mc(0.24, 0.26, 0.3));
      P('box', 0, 0.45, 1.45, 0.1, 0.7, 0.7, mc(0.24, 0.26, 0.3));
      for (const sd of [-1, 1]) {
        P('cyl', sd * 1.8, 0.05 + sd * tilt, 0.35, 0.7, 0.5, 0.7, mc(0.2, 0.21, 0.24));
        P('disc', sd * 1.8, 0.34 + sd * tilt, 0.35, 1.9, 1, 1.9, c(0.6, 0.65, 0.75, 0.35, 0.3, 0, true), t * 25 * sd);
        P('sphere', sd * 1.8, -0.22, 0.35, 0.35, 0.2, 0.35, c(1, 0.45, 0.2, 1, 1));
      }
      const g0 = LOCAL(0, -0.45, -0.7), g1 = LOCAL(0, -0.5, -1.6);
      E.pushBeam('cyl', g0[0], g0[1], g0[2], g1[0], g1[1], g1[2], 0.14, 0.14, mc(0.15, 0.15, 0.17), true);
      if (m.aiming) E.pushBeam('box', g1[0], g1[1], g1[2], g1[0] + m.ax * 14, g1[1] - 2.2, g1[2] + m.az * 14, 0.02, 0.02, c(1, 0.3, 0.2, 0.5, 1, 0, true));
      if (Math.random() < 0.4) particle({ x: x + rnd(-0.3, 0.3), y: y - 0.4, z: z + rnd(-0.3, 0.3), vy: -2, life: 0.3, s0: 0.15, s1: 0, c: [1, 0.5, 0.2] });
      top = 1.0; break;
    }
    case 'colossus': case 'boss': {
      MX.s = 1;
      const bob = moving ? Math.abs(Math.cos(ph)) * 0.18 : 0;
      MX.y += bob;
      const charge = m.type === 'boss' && m.empT !== undefined && m.empT < 1.6 ? (1.6 - m.empT) / 1.6 : 0;
      if (m.type === 'colossus') { drawColossus(m, x, y, z, sw, moving, t); top = 6.3; break; }
      LIMB('box', -0.95, 3.0, 0, 3.0, 0.8, 1.0, sw * 0.4, mc(0.16, 0.17, 0.2));
      LIMB('box', 0.95, 3.0, 0, 3.0, 0.8, 1.0, -sw * 0.4, mc(0.16, 0.17, 0.2));
      P('box', -0.95, 0.25, -0.35 + sw * 0.5, 1.1, 0.5, 1.8, mc(0.22, 0.23, 0.26));
      P('box', 0.95, 0.25, -0.35 - sw * 0.5, 1.1, 0.5, 1.8, mc(0.22, 0.23, 0.26));
      P('box', 0, 3.1, 0, 2.2, 0.8, 1.3, mc(0.2, 0.21, 0.24));
      P('box', 0, 4.25, 0, 3.0, 2.1, 1.9, mc(0.3, 0.31, 0.36));
      P('box', 0, 4.4, -0.96, 2.2, 1.2, 0.08, mc(0.18, 0.19, 0.22));
      P('sphere', 0, 4.3, -1.02, 0.95, 0.95, 0.35, c(1.0, 0.35 + charge * 0.5, 0.2 + charge * 0.8, 1, 1, TN.flash));
      P('box', -1.95, 5.1, 0, 1.1, 0.8, 1.6, mc(0.26, 0.27, 0.31));
      P('box', 1.95, 5.1, 0, 1.1, 0.8, 1.6, mc(0.26, 0.27, 0.31));
      P('box', 0, 5.6, -0.1, 1.1, 0.75, 1.0, mc(0.25, 0.26, 0.3));
      P('box', 0, 5.65, -0.62, 0.9, 0.16, 0.04, c(0.4 + charge * 0.6, 0.9, 1.0, 1, 1, TN.flash));
      for (const sd of [-1, 1]) {
        P('box', sd * 2.0, 4.1, -0.3, 0.75, 0.75, 2.4, mc(0.22, 0.23, 0.27));
        const tip = LOCAL(sd * 2.0, 4.1, -1.6);
        const bk = LOCAL(sd * 2.0, 4.1, -0.9);
        E.pushBeam('cyl', bk[0], bk[1], bk[2], tip[0], tip[1], tip[2], 0.45, 0.45, mc(0.14, 0.15, 0.18), true);
        E.push('sphere', tip[0], tip[1], tip[2], 0, 0.35, 0.35, 0.35, c(0.4, 0.9, 1.0, 0.5 + charge * 0.5, 1, 0, true));
      }
      if (charge > 0) E.push('sphere', x, y + 4.3, z, 0, 3 + charge * 4, 3 + charge * 4, 3 + charge * 4, c(0.4, 0.8, 1, 0.08 + charge * 0.12, 1, 0, true));
      top = 6.3; break;
    }
  }
  if (ghost) return;
  const gy = S_cur && S_cur.terrain ? S_cur.floorH(x, z) : 0;
  if (m.champ) {
    E.push('ring', x, gy + 0.07, z, timeNow * 2, def.r * 2.4, 1, def.r * 2.4, c(1, 0.78, 0.25, 0.9, 1, 0, true));
    E.push('sphere', x, y + top * 0.5, z, 0, def.r * 3, top * 1.1, def.r * 3, c(1, 0.75, 0.2, 0.07, 1, 0, true));
  }
  // 影子
  E.push('disc', x, gy + 0.025, z, 0, def.r * 2.6, 1, def.r * 2.6, c(0, 0, 0, def.fly ? 0.28 : 0.42));
  if (m.stunT > 0) {
    for (let i = 0; i < 3; i++) {
      const aa = timeNow * 5 + i * 2.1, rr = def.r * 0.9 + 0.2;
      E.push('oct', x + Math.cos(aa) * rr, y + top + 0.15, z + Math.sin(aa) * rr, aa, 0.16, 0.16, 0.16, c(1, 0.9, 0.3, 1, 1));
    }
  }
  if (m.slowAmt > 0 && !def.fly) E.push('ring', x, gy + 0.05, z, timeNow, def.r * 1.6, 1, def.r * 1.6, c(0.5, 0.8, 1, 0.6, 1, 0, true));
  // 能量护盾
  if (m.shield > 0) {
    const cy = def.fly ? y : y + top * 0.5, rr = def.r * 2.4 + 0.5, pu = 0.5 + 0.5 * Math.sin(timeNow * 6 + m.seed);
    E.push('sphere', x, cy, z, timeNow, rr, def.fly ? rr * 0.8 : top * 1.15, rr, c(0.4, 0.85, 1, 0.1 + 0.05 * pu, 1, 0, true));
    E.push('ring', x, cy, z, timeNow * 2, rr * 0.52, 1, rr * 0.52, c(0.5, 0.9, 1, 0.35 + 0.2 * pu, 1, 0, true));
  }
  // 血条
  if (!def.boss && (m.hp < m.maxHp || m.shield > 0)) {
    const dd = Math.hypot(x - cam.x, z - cam.z);
    if (dd < 45) {
      const w = clamp(def.r * 1.6, 0.8, 1.8), f = m.hp / m.maxHp, by = y + top + 0.35;
      E.push('box', x, by, z, cam.rYaw, w + 0.06, 0.13, 0.02, c(0.02, 0.03, 0.05, 0.75, 0, 0, false, true));
      const off = -(w - w * f) / 2;
      E.push('box', x + cam.rx * off - cam.fx * 0.02, by, z + cam.rz * off - cam.fz * 0.02, cam.rYaw, w * f, 0.08, 0.03,
        c(f > 0.5 ? lerp(1, 0.35, (f - 0.5) * 2) : 1, f > 0.5 ? 0.92 : lerp(0.25, 0.92, f * 2), 0.3, 1, 1, 0, false, true));
      if (m.shield > 0) E.push('box', x - cam.fx * 0.03, by + 0.1, z - cam.fz * 0.03, cam.rYaw, w, 0.05, 0.03, c(0.45, 0.88, 1, 1, 1, 0, false, true));
    }
  }
}

/* ============================================================
 * 陷阱绘制（ghost = 预览颜色）
 * ============================================================ */
const TX = { x: 0, y: 0, z: 0, yaw: 0, cy: 1, sy: 0 };
let GHOST = null, TDIS = 0;
function tc(r, g, b, emit, a, add) {
  if (GHOST) return c(GHOST[0], GHOST[1], GHOST[2], 0.42, 0.6, 0, false);
  const k = TDIS ? 0.15 : 1;
  return c(r, g, b, a === undefined ? 1 : a, (emit || 0) * k, 0, add);
}
function Q(g, lx, ly, lz, sx, sy, sz, cc, yawOff) {
  E.push(g, TX.x + TX.cy * lx + TX.sy * lz, TX.y + ly, TX.z - TX.sy * lx + TX.cy * lz, TX.yaw + (yawOff || 0), sx, sy, sz, cc);
}
function QR(g, lx, ly, lz, yawOff, pitch, roll, sx, sy, sz, cc) {
  E.pushR(g, TX.x + TX.cy * lx + TX.sy * lz, TX.y + ly, TX.z - TX.sy * lx + TX.cy * lz, TX.yaw + (yawOff || 0), pitch, roll, sx, sy, sz, cc);
}
const pathDirCache = new Map();
function pathDirAt(S, wx, wz) {
  const key = Math.round(wx * 10) + ',' + Math.round(wz * 10);
  if (pathDirCache.has(key)) return pathDirCache.get(key);
  let best = 1e9, dir = [0, 1];
  for (const lane of S.lanes) for (const s of S.paths[lane].segs) {
    const u = clamp((wx - s.ax) * s.dx + (wz - s.az) * s.dz, 0, s.len);
    const px = s.ax + s.dx * u, pz = s.az + s.dz * u, d = Math.hypot(px - wx, pz - wz);
    if (d < best) { best = d; dir = [s.dx, s.dz]; }
  }
  pathDirCache.set(key, dir);
  return dir;
}
let TBR = '';
function lvPips(lv, lx, ly, lz, horizontal) {
  if (GHOST) return;
  if (TBR) {
    // 进阶陷阱：金色(甲) / 紫色(乙) 菱形徽记
    const cc = TBR === 'a' ? [1, 0.75, 0.25] : [0.8, 0.5, 1];
    Q('oct', lx, ly + (horizontal ? 0.25 : 0.32), lz, 0.16, 0.24, 0.16, c(cc[0], cc[1], cc[2], 1, 1), timeNow * 2);
    return;
  }
  for (let i = 0; i < lv; i++) {
    const o = (i - (lv - 1) / 2) * 0.2;
    if (horizontal) Q('box', lx + o, ly, lz, 0.12, 0.05, 0.12, c(0.37, 0.89, 1.0, 1, 1));
    else Q('box', lx + o, ly, lz, 0.12, 0.12, 0.04, c(0.37, 0.89, 1.0, 1, 1));
  }
}
// 加特林炮塔：转台底座 + 防弹护盾 + 六管旋转枪管；自己坐在上面时只画底座（上半部分由第一人称模型画）
function drawGatling(S, tr, lv, since) {
  const lp = S.s.players[PID], mine = !GHOST && lp && lp.mount === tr.id;
  Q('cyl', 0, 0.22, 0, 1.25, 0.44, 1.25, tc(0.24, 0.25, 0.28));
  Q('cyl', 0, 0.47, 0, 1.0, 0.08, 1.0, tc(0.13, 0.14, 0.16));
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; Q('box', Math.cos(a) * 0.6, 0.3, Math.sin(a) * 0.6, 0.08, 0.3, 0.08, tc(0.95, 0.6, 0.18, 0.5)); }
  const yaw = GHOST ? 0 : (tr.cAim === undefined ? tr.aimYaw || 0 : tr.cAim);
  TX.yaw = yaw; TX.cy = Math.cos(yaw); TX.sy = Math.sin(yaw);
  Q('cyl', 0, 0.62, 0, 0.75, 0.16, 0.75, tc(0.3, 0.31, 0.33));
  Q('box', 0, 0.62, 0.62, 0.7, 0.12, 0.55, tc(0.2, 0.21, 0.23));   // 射手踏板
  Q('cyl', 0, 0.86, 0, 0.62, 0.36, 0.62, tc(0.22, 0.23, 0.26));
  Q('box', 0, 1.06, 0, 0.95, 0.08, 0.5, tc(0.28, 0.29, 0.31));
  if (mine) { TX.yaw = 0; TX.cy = 1; TX.sy = 0; lvPips(lv, 0, 0.45, 0.66, true); return; }
  // 俯仰：有人操控时跟随射手视角
  let P = 0;
  if (!GHOST) for (const id in S.s.players) { const q = S.s.players[id]; if (q.mount === tr.id && !q.dead) { P = clamp(q.pitch || 0, -0.6, 0.8); break; } }
  const cP = Math.cos(P), sP = Math.sin(P), PY = 1.38, K = 1.22;
  const R = (ly, lz) => [PY + (ly * cP - lz * sP) * K, (ly * sP + lz * cP) * K];
  const QP = (g, lx, ly, lz, sx, sy, sz, cc, extra) => { const o = R(ly, lz); QR(g, lx * K, o[0], o[1], 0, P + (extra || 0), 0, sx * K, sy * K, sz * K, cc); };
  const firing = !GHOST && since < 0.2;
  tr.spinV = lerp(tr.spinV || 0, firing ? 1 : 0, 0.08); tr.spinA = (tr.spinA || 0) + tr.spinV * 0.55;
  // 支架（U 形托架）
  for (const sd of [-1, 1]) { Q('box', sd * 0.43, 1.25, 0, 0.1, 0.42, 0.4, tc(0.26, 0.27, 0.29)); QR('cyl', sd * 0.38, PY, 0, 0, 0, Math.PI / 2, 0.2, 0.1, 0.2, tc(0.95, 0.6, 0.18, 0.5)); }
  // 机匣与供弹箱
  QP('box', 0, 0, 0.05, 0.46, 0.38, 0.62, tc(0.32, 0.33, 0.3));
  for (let i = 0; i < 4; i++) QP('box', 0, 0.2, -0.18 + i * 0.12, 0.48, 0.03, 0.05, tc(0.2, 0.21, 0.22));
  QP('box', 0, 0.3, 0.08, 0.06, 0.12, 0.34, tc(0.22, 0.22, 0.24));
  QP('box', 0, 0.21, 0.05, 0.3, 0.04, 0.5, tc(0.95, 0.6, 0.18, 0.4));
  QP('box', -0.38, -0.08, 0.1, 0.3, 0.34, 0.44, tc(0.33, 0.36, 0.24));
  for (let i = 0; i < 4; i++) QP('box', -0.2, 0.0 - i * 0.02, -0.08 + i * 0.07, 0.08, 0.04, 0.05, tc(0.9, 0.7, 0.3));
  // 防弹护盾（中间留射击口）
  for (const sd of [-1, 1]) QP('box', sd * 0.42, 0.05, -0.32, 0.42, 0.8, 0.06, tc(0.38, 0.4, 0.36));
  QP('box', 0, 0.36, -0.32, 1.26, 0.18, 0.06, tc(0.38, 0.4, 0.36));
  for (const sd of [-1, 1]) QP('box', sd * 0.42, 0.3, -0.36, 0.3, 0.035, 0.02, tc(1, 0.6, 0.18, 0.7));
  // 六根枪管（旋转）
  const heat = !GHOST && since < 0.2 ? 0.25 : 0;
  for (let i = 0; i < 6; i++) {
    const a = tr.spinA + i / 6 * Math.PI * 2, bx = Math.cos(a) * 0.1, by = Math.sin(a) * 0.1;
    QP('cyl', bx, by, -0.85, 0.07, 1.0, 0.07, tc(0.16 + heat, 0.16, 0.18), Math.PI / 2);
  }
  for (const z of [-0.45, -1.05, -1.33]) QP('cyl', 0, 0, z, 0.3, 0.05, 0.3, tc(0.26, 0.27, 0.3), Math.PI / 2);
  QP('cyl', 0, 0, -0.85, 0.06, 1.0, 0.06, tc(0.1, 0.1, 0.11), Math.PI / 2);
  // 握把
  for (const sd of [-1, 1]) QP('box', sd * 0.2, -0.05, 0.48, 0.05, 0.2, 0.05, tc(0.15, 0.15, 0.16));
  QP('box', 0, -0.05, 0.42, 0.45, 0.04, 0.04, tc(0.25, 0.25, 0.27));
  if (!GHOST && since < 0.05) {
    const o = R(0, -1.5);
    Q('sphere', 0, o[0], o[1], 0.42, 0.42, 0.42, c(1, 0.78, 0.4, 0.9, 1, 0, true));
  }
  TX.yaw = 0; TX.cy = 1; TX.sy = 0;
  lvPips(lv, 0, 0.45, 0.66, true);
}
// 第一人称：坐在加特林上看到的枪身
function drawGatlingVM(p, tr, dt) {
  const spin = p.spin || 0, heat = p.heat || 0;
  vm.gspin = (vm.gspin || 0) + dt * spin * 38;
  const firing = p.input.fire && spin > 0.3 && !p.overheat;
  const jx = firing ? rnd(-0.004, 0.004) : 0, jy = firing ? rnd(-0.004, 0.004) : 0;
  const AX = 0 + jx, AY = -0.34 + jy, k = vm.kick * 0.03;
  const hc = [0.16 + heat * 0.84, 0.16 + heat * 0.3, 0.18 - heat * 0.1];
  const P2 = Math.PI / 2;
  // 枪管
  for (let i = 0; i < 6; i++) {
    const a = vm.gspin + i / 6 * Math.PI * 2;
    V('cyl', AX + Math.cos(a) * 0.085, AY + Math.sin(a) * 0.085, -1.0 + k, 0.065, 1.0, 0.065, c(hc[0], hc[1], hc[2], 1, heat > 0.5 ? (heat - 0.5) * 1.6 : 0), P2);
  }
  V('cyl', AX, AY, -1.0 + k, 0.05, 1.0, 0.05, c(0.08, 0.08, 0.09), P2);
  for (const z of [-0.62, -1.15, -1.46]) V('cyl', AX, AY, z + k, 0.27, 0.045, 0.27, c(0.26, 0.27, 0.3), P2);
  // 机匣、护盾边缘、握把
  V('box', AX, AY - 0.06, -0.42 + k, 0.3, 0.2, 0.34, c(0.3, 0.31, 0.29));
  V('box', AX, AY + 0.045, -0.46 + k, 0.12, 0.012, 0.2, c(0.95, 0.6, 0.18, 1, 0.35));
  V('box', AX - 0.3, AY - 0.14, -0.4 + k, 0.22, 0.22, 0.32, c(0.33, 0.36, 0.24));
  for (let i = 0; i < 5; i++) V('box', AX - 0.17, AY - 0.06 + Math.sin(vm.gspin * 0.5 + i) * 0.004, -0.52 + i * 0.05 + k, 0.06, 0.03, 0.035, c(0.9, 0.7, 0.3));
  // 防弹护盾：只露出顶边，压在画面下方，不挡视线
  V('box', AX, AY - 0.24, -0.8, 1.1, 0.26, 0.05, c(0.36, 0.38, 0.34));
  V('box', AX, AY - 0.11, -0.82, 1.0, 0.02, 0.02, c(1, 0.6, 0.18, 1, 0.5));
  for (const sd of [-1, 1]) {
    V('box', AX + sd * 0.72, AY - 0.12, -0.7, 0.06, 0.4, 0.3, c(0.3, 0.31, 0.29));
    V('box', AX + sd * 0.17, AY - 0.12, -0.02, 0.05, 0.16, 0.05, c(0.13, 0.13, 0.14));
  }
  V('box', AX, AY - 0.06, -0.02, 0.38, 0.035, 0.035, c(0.24, 0.24, 0.26));
  // 热量条（机匣顶上）
  V('box', AX + 0.1 + heat * 0.06, AY + 0.045, -0.3 + k, 0.12 * Math.max(0.02, heat), 0.01, 0.015, c(1, 0.4 + 0.5 * (1 - heat), 0.15, 1, 1));
  vm.mz = [AX, AY, -1.52];
  if (vm.flash > 0) {
    const o = vm.mz;
    V('sphere', o[0], o[1], o[2], 0.16, 0.16, 0.16, c(1, 0.85, 0.5, 0.95, 1, 0, true));
    V('box', o[0], o[1], o[2], 0.4, 0.03, 0.03, c(1, 0.7, 0.3, 0.8, 1, 0, true), 0, timeNow * 40);
    V('box', o[0], o[1], o[2], 0.03, 0.4, 0.03, c(1, 0.7, 0.3, 0.8, 1, 0, true), 0, timeNow * 40);
  }
  if (heat > 0.6 && Math.random() < 0.15 * heat) { const q = camLocal([AX + rnd(-0.06, 0.06), AY + 0.08, -1.0]); particle({ x: q[0], y: q[1], z: q[2], vx: rnd(-0.2, 0.2), vy: rnd(0.5, 1.1), vz: rnd(-0.2, 0.2), life: rnd(0.6, 1.1), s0: 0.06, s1: 0.3, c: [0.6, 0.6, 0.62], add: false, a0: 0.35 }); }
}
// 防空导弹·对地模式：履带底座 + 低平的 2×3 对地火箭巢 + 火控雷达
function drawAAGround(tr, lv, since) {
  // 注意：c()/tc() 返回共享数组，必须现用现取
  const ARM = () => tc(0.4, 0.42, 0.36), DK = () => tc(0.12, 0.12, 0.13), MID = () => tc(0.22, 0.23, 0.22), OR = () => tc(1, 0.5, 0.15, 1), RED = () => tc(1, 0.2, 0.15, 1);
  // 履带底座
  Q('box', 0, 0.22, 0, 1.15, 0.36, 1.25, MID());
  for (const sd of [-1, 1]) {
    Q('box', sd * 0.68, 0.24, 0, 0.28, 0.44, 1.5, DK());
    for (let i = 0; i < 5; i++) Q('box', sd * 0.68, 0.47, -0.6 + i * 0.3, 0.3, 0.025, 0.12, tc(0.32, 0.32, 0.34));
    for (const zz of [-0.6, 0, 0.6]) QR('cyl', sd * 0.83, 0.24, zz, 0, 0, Math.PI / 2, 0.3, 0.05, 0.3, tc(0.4, 0.4, 0.42));
  }
  Q('box', 0, 0.42, 0.63, 0.9, 0.03, 0.02, tc(1, 0.5, 0.15, 0.6));
  // 转台
  const yaw = GHOST ? 0 : (tr.cAim || 0);
  TX.yaw = yaw; TX.cy = Math.cos(yaw); TX.sy = Math.sin(yaw);
  Q('cyl', 0, 0.5, 0, 1.0, 0.16, 1.0, ARM());
  Q('cyl', 0, 0.6, 0, 0.7, 0.08, 0.7, DK());
  // 火箭巢：略微上扬，正面 2×3 发射管
  const P = 0.14, cP = Math.cos(P), sP = Math.sin(P), Y0 = 1.0;
  const rot = (ly, lz) => [Y0 + ly * cP - lz * sP, ly * sP + lz * cP];
  const rec = !GHOST && since < 0.12 ? 0.07 : 0;
  { const o = rot(0, 0.05 + rec); QR('box', 0, o[0], o[1], 0, P, 0, 1.1, 0.62, 1.2, ARM()); }
  { const o = rot(0.33, 0.05 + rec); QR('box', 0, o[0], o[1], 0, P, 0, 1.0, 0.06, 1.0, MID()); }
  for (const sd of [-1, 1]) { const o = rot(0, 0.05 + rec); QR('box', sd * 0.58, o[0], o[1], 0, P, 0, 0.06, 0.7, 1.26, DK()); }
  { const o = rot(0, -0.57 + rec); QR('box', 0, o[0], o[1], 0, P, 0, 1.14, 0.66, 0.06, DK()); }
  for (let r = 0; r < 2; r++) for (let k = 0; k < 3; k++) {
    const lx = (k - 1) * 0.34, ly = r ? -0.15 : 0.15, o = rot(ly, -0.6 + rec), o2 = rot(ly, -0.68 + rec);
    QR('cyl', lx, o[0], o[1], 0, P + Math.PI / 2, 0, 0.24, 0.05, 0.24, tc(0.06, 0.06, 0.07));
    if (GHOST || since > 0.35 || (r * 3 + k) % 2) { QR('cyl', lx, o[0], o[1], 0, P + Math.PI / 2, 0, 0.16, 0.08, 0.16, tc(0.8, 0.8, 0.78)); QR('cone', lx, o2[0], o2[1], 0, P - Math.PI / 2, 0, 0.16, 0.2, 0.16, OR()); }
  }
  // 侧面装甲条纹与警示灯
  for (const sd of [-1, 1]) {
    const o = rot(0.12, 0.1 + rec);
    QR('box', sd * 0.615, o[0], o[1], 0, P, 0, 0.012, 0.08, 0.9, OR());
  }
  // 火控雷达：转台侧上方，红色镜头 + 天线
  Q('box', 0.38, 1.5, 0.3, 0.3, 0.24, 0.34, MID());
  Q('box', 0.38, 1.5, 0.12, 0.22, 0.08, 0.02, RED());
  Q('cyl', -0.35, 1.55, 0.42, 0.04, 0.5, 0.04, tc(0.5, 0.5, 0.52));
  Q('sphere', -0.35, 1.82, 0.42, 0.07, 0.07, 0.07, tc(1, 0.3, 0.2, GHOST ? 0 : 0.6 + 0.4 * Math.sin(simNow * 6 + tr.x)));
  // 尾部散热口
  { const o = rot(0.05, 0.66 + rec); QR('box', 0, o[0], o[1], 0, P, 0, 0.8, 0.3, 0.04, tc(0.9, 0.35, 0.1, 0.5)); }
  if (!GHOST && since < 0.1) {
    const o = rot(0, -0.85);
    Q('sphere', 0, o[0], o[1], 0.55, 0.4, 0.55, c(1, 0.6, 0.25, 0.8, 1, 0, true));
  }
  TX.yaw = 0; TX.cy = 1; TX.sy = 0;
  lvPips(lv, 0, 0.45, 0.66, true);
}
function drawTrap(S, tr, ghost) {
  GHOST = ghost || null; TDIS = !ghost && tr.disT > 0; TBR = (!ghost && tr.br) || '';
  const def = TRAP[tr.type], lv = tr.lv || 1;
  const since = ghost ? (tr.type === 'spike' ? 0.2 : 9) : simNow - (tr.fireT === undefined ? -99 : tr.fireT);
  TX.x = tr.wx; TX.y = tr.wy; TX.z = tr.wz; TX.yaw = 0;
  if (tr.kind === 'wall') TX.yaw = Math.atan2(DIRS[tr.dir][0], DIRS[tr.dir][1]);
  TX.cy = Math.cos(TX.yaw); TX.sy = Math.sin(TX.yaw);
  const plate = () => { Q('box', 0, 0.06, 0, T * 0.86, 0.12, T * 0.86, tc(0.24, 0.26, 0.29)); Q('box', 0, 0.125, 0, T * 0.7, 0.01, T * 0.7, tc(0.15, 0.16, 0.18)); };
  switch (tr.type) {
    case 'slow': {
      plate();
      const pul = 0.5 + 0.5 * Math.sin(timeNow * 3 + tr.x);
      Q('ring', 0, 0.14, 0, T * (0.22 + pul * 0.12), 1, T * (0.22 + pul * 0.12), tc(0.45, 0.8, 1, 1));
      Q('ring', 0, 0.14, 0, T * 0.38, 1, T * 0.38, tc(0.45, 0.8, 1, 0.8));
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) Q('cyl', ox * T * 0.33, 0.22, oz * T * 0.33, 0.2, 0.2, 0.2, tc(0.4, 0.75, 1, 1));
      if (tr.activeT > 0 && !GHOST) Q('cyl', 0, 0.9, 0, T * 0.85, 1.6, T * 0.85, c(0.45, 0.75, 1, 0.08, 1, 0, true));
      lvPips(lv, 0, 0.15, T * 0.38, true);
      break;
    }
    case 'spike': {
      plate();
      let h = 0;
      if (since < 0.08) h = since / 0.08; else if (since < 0.35) h = 1; else if (since < 0.75) h = 1 - (since - 0.35) / 0.4;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        Q('cone', i * T * 0.24, 0.12 + h * 0.42 - 0.08, j * T * 0.24, 0.2, 0.25 + h * 0.55, 0.2, tc(0.62, 0.66, 0.6));
        Q('cyl', i * T * 0.24, 0.13, j * T * 0.24, 0.24, 0.02, 0.24, tc(0.3, 0.95, 0.4, 0.9));
      }
      lvPips(lv, 0, 0.15, T * 0.4, true);
      break;
    }
    case 'push': {
      plate();
      const pd = pathDirAt(S, tr.wx, tr.wz);
      TX.yaw = Math.atan2(pd[0], pd[1]); TX.cy = Math.cos(TX.yaw); TX.sy = Math.sin(TX.yaw);
      let ang = 0;
      if (since < 0.1) ang = since / 0.1; else if (since < 0.4) ang = 1; else if (since < 1.0) ang = 1 - (since - 0.4) / 0.6;
      const L = T * 0.72, a = ang * 1.1;
      // 铰链在下游一侧，自由端朝上游掀起
      const hz = L / 2;
      QR('box', 0, 0.16 + Math.sin(a) * L / 2, hz - Math.cos(a) * L / 2, 0, a, 0, L, 0.08, L, tc(0.36, 0.33, 0.28));
      QR('box', 0, 0.21 + Math.sin(a) * L / 2, hz - Math.cos(a) * L / 2, 0, a, 0, L * 0.5, 0.01, 0.12, tc(1, 0.65, 0.2, 1));
      Q('box', 0, 0.14, hz, L, 0.1, 0.12, tc(0.2, 0.2, 0.22));
      lvPips(lv, 0, 0.15, -T * 0.4, true);
      break;
    }
    case 'tesla': {
      const hpF = tr.maxHp ? tr.hp / tr.maxHp : 1;
      Q('cyl', 0, 0.25, 0, T * 0.82, 0.5, T * 0.82, tc(0.22, 0.23, 0.27));
      Q('cyl', 0, 0.55, 0, T * 0.6, 0.12, T * 0.6, tc(0.3, 0.3, 0.35));
      Q('cyl', 0, 1.5, 0, 0.42, 2.0, 0.42, tc(0.28, 0.28, 0.32));
      for (let i = 0; i < 3; i++) Q('ring', 0, 1.0 + i * 0.5, 0, 0.62 - i * 0.08, 1, 0.62 - i * 0.08, tc(0.7, 0.45, 1.0, 1), timeNow * (i + 1));
      const pul = 0.75 + 0.25 * Math.sin(timeNow * 6 + tr.x);
      Q('sphere', 0, 2.75, 0, 0.7, 0.7, 0.7, tc(0.78 * pul, 0.55 * pul, 1.0, 1));
      if (!GHOST && !TDIS) Q('sphere', 0, 2.75, 0, 1.3, 1.3, 1.3, c(0.7, 0.45, 1, 0.12, 1, 0, true));
      lvPips(lv, 0, 0.52, T * 0.42, true);
      if (!GHOST && hpF < 0.999) {
        const w = 1.4, by = 3.55;
        E.push('box', tr.wx, by, tr.wz, cam.rYaw, w + 0.06, 0.14, 0.02, c(0.02, 0.03, 0.05, 0.75, 0, 0, false, true));
        const off = -(w - w * hpF) / 2;
        E.push('box', tr.wx + cam.rx * off - cam.fx * 0.02, by, tr.wz + cam.rz * off - cam.fz * 0.02, cam.rYaw, w * hpF, 0.09, 0.03, c(0.7, 0.5, 1, 1, 1, 0, false, true));
      }
      break;
    }
    case 'sentry': {
      Q('cyl', 0, 0.3, 0, 1.1, 0.6, 1.1, tc(0.24, 0.25, 0.28));
      Q('cyl', 0, 0.85, 0, 0.32, 0.6, 0.32, tc(0.2, 0.21, 0.24));
      const yaw = GHOST ? 0 : (tr.cAim === undefined ? 0 : tr.cAim);
      TX.yaw = yaw; TX.cy = Math.cos(yaw); TX.sy = Math.sin(yaw);
      const rec = since < 0.06 ? 0.08 : 0;
      if (hasModel('repeater')) {
        animStatic('repeater');
        Q('repeater', 0, 1.02, rec, 1.35, 1.35, 1.35, tc(0.95, 0.92, 0.88));
        E.anim();
        Q('box', 0, 1.05, 0.1, 0.5, 0.06, 0.5, tc(1, 0.65, 0.2, 1));
        if (!GHOST && since < 0.05) {
          const fx = TX.x - TX.sy * 0.95, fz = TX.z - TX.cy * 0.95;
          E.push('sphere', fx, 1.42, fz, 0, 0.45, 0.45, 0.45, c(1, 0.8, 0.4, 0.9, 1, 0, true));
        }
      }
      for (const sd of hasModel('repeater') ? [] : [-0.16, 0.16]) {
        const b0x = sd, b0z = -0.35 + rec, b1z = -1.0 + rec;
        const p0 = [TX.x + TX.cy * b0x + TX.sy * b0z, 1.35, TX.z - TX.sy * b0x + TX.cy * b0z];
        const p1 = [TX.x + TX.cy * b0x + TX.sy * b1z, 1.35, TX.z - TX.sy * b0x + TX.cy * b1z];
        E.pushBeam('cyl', p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], 0.1, 0.1, tc(0.16, 0.16, 0.18), true);
        if (!GHOST && since < 0.05) E.push('sphere', p1[0], p1[1], p1[2], 0, 0.35, 0.35, 0.35, c(1, 0.8, 0.4, 0.9, 1, 0, true));
      }
      TX.yaw = 0; TX.cy = 1; TX.sy = 0;
      lvPips(lv, 0, 0.61, 0.5, true);
      break;
    }
    case 'gatling': { drawGatling(S, tr, lv, since); break; }
    case 'aa': {
      if (TBR === 'b') { drawAAGround(tr, lv, since); break; }
      Q('box', 0, 0.3, 0, 1.3, 0.6, 1.3, tc(0.24, 0.25, 0.28));
      const yaw = GHOST ? 0 : (tr.cAim || 0);
      TX.yaw = yaw; TX.cy = Math.cos(yaw); TX.sy = Math.sin(yaw);
      QR('box', 0, 1.15, 0, 0, 0.55, 0, 1.0, 0.75, 1.1, tc(0.32, 0.33, 0.3));
      for (let i = 0; i < 4; i++) {
        const lx = (i % 2 ? 0.22 : -0.22), ly = (i < 2 ? 0.16 : -0.16);
        const fy = 1.15 + ly * Math.cos(0.55) + 0.55 * Math.sin(0.55);
        const fz = -ly * Math.sin(0.55) + -0.55 * Math.cos(0.55);
        Q('cyl', lx, fy, fz, 0.2, 0.04, 0.2, tc(0.05, 0.05, 0.06));
        Q('sphere', lx, fy, fz - 0.02, 0.1, 0.1, 0.1, tc(1, 0.3, 0.2, 1));
      }
      TX.yaw = 0; TX.cy = 1; TX.sy = 0;
      lvPips(lv, 0, 0.61, 0.55, true);
      break;
    }
    case 'laser': {
      Q('box', 0, 0, 0.12, 1.0, 0.7, 0.3, tc(0.24, 0.25, 0.28));
      Q('box', 0, 0.3, 0.04, 0.9, 0.06, 0.06, tc(1, 0.25, 0.3, 1));
      const on = tr.activeT > 0 && !GHOST;
      Q('cyl', 0, 0, -0.04, 0.3, 0.3, 0.3, tc(1, 0.2, 0.25, on ? 1 : 0.6), 0);
      if (on && tr.line) {
        const len = tr.line.length * T - 0.1, d = DIRS[tr.dir];
        const ex = tr.wx - d[0] * len, ez = tr.wz - d[1] * len;
        const fl = 0.75 + Math.random() * 0.25;
        if (TBR === 'a') {   // 过载：白热内芯 + 更粗的红色外焰
          E.pushBeam('box', tr.wx - d[0] * 0.2, 1.5, tr.wz - d[1] * 0.2, ex, 1.5, ez, 0.1, 0.1, c(1, 0.9 * fl, 0.85, 1, 1, 0, true));
          E.pushBeam('box', tr.wx - d[0] * 0.2, 1.5, tr.wz - d[1] * 0.2, ex, 1.5, ez, 0.5, 0.5, c(1, 0.15, 0.2, 0.28 * fl, 1, 0, true));
        } else if (TBR === 'b') {   // 棱镜：青紫双色光束
          E.pushBeam('box', tr.wx - d[0] * 0.2, 1.5, tr.wz - d[1] * 0.2, ex, 1.5, ez, 0.07, 0.07, c(0.75, 0.5 * fl, 1, 1, 1, 0, true));
          E.pushBeam('box', tr.wx - d[0] * 0.2, 1.62, tr.wz - d[1] * 0.2, ex, 1.62, ez, 0.04, 0.04, c(0.3, 1, 1, 0.9, 1, 0, true));
          E.pushBeam('box', tr.wx - d[0] * 0.2, 1.5, tr.wz - d[1] * 0.2, ex, 1.5, ez, 0.36, 0.36, c(0.6, 0.35, 1, 0.2 * fl, 1, 0, true));
        } else {
        E.pushBeam('box', tr.wx - d[0] * 0.2, 1.5, tr.wz - d[1] * 0.2, ex, 1.5, ez, 0.06, 0.06, c(1, 0.35 * fl, 0.35, 1, 1, 0, true));
        E.pushBeam('box', tr.wx - d[0] * 0.2, 1.5, tr.wz - d[1] * 0.2, ex, 1.5, ez, 0.3, 0.3, c(1, 0.2, 0.25, 0.22 * fl, 1, 0, true));
        }
        E.pushBeam('box', tr.wx - d[0] * 0.2, 3.1, tr.wz - d[1] * 0.2, ex, 3.1, ez, 0.04, 0.04, c(1, 0.35, 0.35, 0.6, 1, 0, true));
      }
      lvPips(lv, 0, -0.45, 0.02);
      break;
    }
    case 'flame': {
      Q('box', 0, -0.4, 0.12, 0.9, 0.9, 0.3, tc(0.26, 0.24, 0.22));
      const tip = TX.cy * 0, on = tr.activeT > 0 && !GHOST;
      QR('cone', 0, -0.4, -0.18, 0, -Math.PI / 2, 0, 0.4, 0.45, 0.4, tc(0.35, 0.3, 0.26));
      Q('sphere', 0, -0.4, -0.42, 0.18, 0.18, 0.18, tc(1, 0.5, 0.1, on ? 1 : 0.5));
      Q('box', 0, 0.1, 0.0, 0.7, 0.06, 0.05, tc(1, 0.5, 0.1, 1));
      lvPips(lv, 0, -0.95, 0.02);
      void tip;
      break;
    }
    case 'rail': {
      // 轨道电磁炮：八角底座 + 旋转炮塔 + 双导轨，充能线圈随冷却逐渐点亮
      Q('cyl', 0, 0.3, 0, 3.7, 0.6, 3.7, tc(0.19, 0.2, 0.23));
      Q('cyl', 0, 0.66, 0, 3.0, 0.12, 3.0, tc(0.26, 0.27, 0.31));
      Q('ring', 0, 0.62, 0, 1.86, 1, 1.86, tc(1, 0.5, 0.2, 1));
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; Q('box', Math.cos(a) * 1.75, 0.45, Math.sin(a) * 1.75, 0.5, 0.9, 0.5, tc(0.24, 0.25, 0.28), -a); }
      const cdv = TRAP.rail.cd[lv - 1] * (TBR === 'b' ? 0.55 : 1), chg = GHOST ? 0.6 : clamp(since / cdv, 0, 1);
      const yaw = GHOST ? 0 : (tr.cAim || 0);
      TX.yaw = yaw; TX.cy = Math.cos(yaw); TX.sy = Math.sin(yaw);
      const rec = since < 0.15 ? (0.15 - since) * 3 : 0;
      Q('cyl', 0, 1.0, 0, 1.6, 0.6, 1.6, tc(0.22, 0.23, 0.26));
      Q('box', 0, 1.65, 0.35 + rec, 1.5, 0.9, 2.0, tc(0.52, 0.54, 0.6)); Q('box', 0, 1.65, -0.66 + rec, 1.52, 0.12, 0.04, tc(1, 0.5, 0.2, 1));
      Q('box', 0, 2.15, 0.6 + rec, 1.1, 0.25, 1.2, tc(0.4, 0.42, 0.47));
      Q('cyl', 0, 1.7, 1.42 + rec, 0.9, 0.5, 0.9, tc(0.24, 0.25, 0.29));
      Q('ring', 0, 1.97, 1.42 + rec, 0.42, 1, 0.42, tc(0.4, 0.8, 1, 0.3 + chg * 0.6), timeNow * 3);
      for (const sd of [-1, 1]) {
        Q('box', sd * 0.4, 2.05, -1.0 + rec, 0.24, 0.5, 4.4, tc(0.6, 0.62, 0.68));
        Q('box', sd * 0.4, 2.32, -1.0 + rec, 0.12, 0.05, 4.3, tc(0.4, 0.8, 1, 0.4 + chg * 0.6));
        Q('box', sd * 0.4, 2.05, -1.0 + rec, 0.06, 0.54, 4.3, tc(0.4, 0.75, 1, chg * 0.9));
        for (let k = 0; k < 4; k++) { const on = chg >= (k + 1) / 4; Q('box', sd * 0.36, 2.0, -0.2 - k * 0.75 + rec, 0.34, 0.56, 0.16, on ? tc(0.5, 0.85, 1, 1) : tc(0.2, 0.22, 0.26)); }
      }
      Q('box', 0, 1.62, -0.7 + rec, 0.6, 0.18, 1.2, tc(0.18, 0.19, 0.22));
      if (!GHOST && chg >= 1) Q('sphere', 0, 2.0, -3.0, 0.25 + 0.05 * Math.sin(timeNow * 20), 0.25, 0.25, c(0.6, 0.9, 1, 0.9, 1, 0, true));
      TX.yaw = 0; TX.cy = 1; TX.sy = 0;
      lvPips(lv, 0, 0.75, 1.55, true);
      break;
    }
    case 'mortar': {
      // 等离子迫击炮：方形炮座 + 高仰角粗炮管，发射后后坐
      Q('box', 0, 0.3, 0, 3.8, 0.6, 3.8, tc(0.21, 0.22, 0.24));
      Q('box', 0, 0.62, 0, 3.4, 0.06, 3.4, tc(0.28, 0.27, 0.25));
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { Q('box', ox * 1.7, 0.66, oz * 1.7, 0.4, 0.1, 0.4, tc(1, 0.5, 0.2, 1)); Q('cyl', ox * 1.45, 0.95, oz * 1.45, 0.42, 0.6, 0.42, tc(0.3, 0.3, 0.32)); }
      if (!GHOST && S.s.players[PID] && S.s.players[PID].mount === tr.id) {
        // 自己在操控：只画观测台（炮管在脚下，挡视线）
        Q('cyl', 0, 0.95, 0, 1.3, 0.6, 1.3, tc(0.26, 0.27, 0.3));
        Q('ring', 0, 1.27, 0, 0.75, 1, 0.75, tc(1, 0.55, 0.2, 1));
        lvPips(lv, 0, 0.65, 1.95, true);
        break;
      }
      const yaw = GHOST ? 0 : (tr.cAim || 0);
      TX.yaw = yaw; TX.cy = Math.cos(yaw); TX.sy = Math.sin(yaw);
      Q('cyl', 0, 0.85, 0, 2.2, 0.45, 2.2, tc(0.25, 0.26, 0.29));
      Q('box', 0, 1.35, 0.25, 1.7, 0.75, 1.5, tc(0.55, 0.52, 0.48)); Q('box', 0, 1.35, -0.51, 1.72, 0.1, 0.04, tc(0.6, 0.45, 1, 1));
      for (const sd of [-1, 1]) Q('box', sd * 0.95, 1.55, 0, 0.22, 1.1, 1.0, tc(0.26, 0.26, 0.28));
      const rec = since < 0.35 ? (0.35 - since) * 1.4 : 0, pit = 0.95, L = 2.6;
      const bx0 = 0, by0 = 1.55, bz0 = 0.1 + rec * Math.cos(pit), by1 = by0 + Math.sin(pit) * L - rec * Math.sin(pit), bz1 = bz0 - Math.cos(pit) * L;
      const W0 = [TX.x + TX.sy * bz0, TX.y + by0, TX.z + TX.cy * bz0], W1 = [TX.x + TX.sy * bz1, TX.y + by1, TX.z + TX.cy * bz1];
      E.pushBeam('cyl', W0[0], W0[1], W0[2], W1[0], W1[1], W1[2], 0.82, 0.82, tc(0.42, 0.42, 0.46), true);
      const Wm = [lerp(W0[0], W1[0], 0.45), lerp(W0[1], W1[1], 0.45), lerp(W0[2], W1[2], 0.45)];
      E.pushBeam('cyl', Wm[0], Wm[1], Wm[2], lerp(Wm[0], W1[0], 0.2), lerp(Wm[1], W1[1], 0.2), lerp(Wm[2], W1[2], 0.2), 0.98, 0.98, tc(0.55, 0.4, 1, since < 0.5 ? 1 : 0.5), true);
      E.push('sphere', W1[0], W1[1], W1[2], 0, 0.62, 0.62, 0.62, GHOST ? tc(0, 0, 0) : c(0.55, 0.4, 1, since < 0.25 ? 1 : 0.6, 1, 0, true));
      for (let i = 0; i < 3; i++) Q('sphere', 0.62, 1.05, 0.95 - i * 0.32, 0.26, 0.26, 0.26, tc(0.6, 0.45, 1, 0.8));
      TX.yaw = 0; TX.cy = 1; TX.sy = 0;
      lvPips(lv, 0, 0.7, 1.75, true);
      break;
    }
    case 'grinder': {
      // 碎骨绞盘：四片锯盘嵌在通道地面里，转动时缝隙透出绿光
      const on = GHOST ? false : tr.activeT > 0, spin = (GHOST ? 0 : timeNow) * (on ? 9 : 1.2) + tr.x;
      Q('box', 0, 0.06, 0, T * 1.94, 0.12, T * 1.94, tc(0.17, 0.18, 0.2));
      for (const [ex, ez, sx, sz] of [[0, -T * 0.95, T * 1.94, 0.14], [0, T * 0.95, T * 1.94, 0.14], [-T * 0.95, 0, 0.14, T * 1.94], [T * 0.95, 0, 0.14, T * 1.94]]) Q('box', ex, 0.14, ez, sx, 0.06, sz, tc(0.55, 1, 0.35, 1));
      for (const [qx, qz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const dir = qx * qz, x0 = qx * T * 0.48, z0 = qz * T * 0.48;
        Q('cyl', x0, 0.13, z0, 2.0, 0.04, 2.0, tc(0.55, 1, 0.35, on ? 0.9 : 0.35));
        Q('cyl', x0, 0.17, z0, 1.75, 0.08, 1.75, tc(0.52, 0.54, 0.58), spin * dir);
        for (let i = 0; i < 8; i++) { const a = spin * dir + i * Math.PI / 4; Q('box', x0 + Math.cos(a) * 0.86, 0.24, z0 + Math.sin(a) * 0.86, 0.28, 0.16, 0.1, tc(0.75, 0.75, 0.72), -a); }
        Q('cyl', x0, 0.24, z0, 0.42, 0.12, 0.42, tc(0.25, 0.26, 0.29));
      }
      Q('cyl', 0, 0.2, 0, 0.6, 0.16, 0.6, tc(0.55, 1, 0.35, on ? 1 : 0.4));
      if (on && Math.random() < 0.6) particle({ x: TX.x + rnd(-2, 2), y: TX.y + 0.3, z: TX.z + rnd(-2, 2), vx: rnd(-3, 3), vy: rnd(2, 5), vz: rnd(-3, 3), life: 0.35, s0: 0.06, s1: 0, c: [1, 0.85, 0.5], grav: 14 });
      lvPips(lv, 0, 0.22, T * 0.9, true);
      break;
    }
    case 'crusher': {
      Q('box', 0, -0.2, 0, T * 0.9, 0.4, T * 0.9, tc(0.22, 0.23, 0.26));
      const CH = tr.wy, G0 = S.floorH(tr.wx, tr.wz) + 0.42, REST = CH - (CH < 5 ? 1.15 : 1.45);
      let yy = REST;
      if (!GHOST) {
        if (since < 0.1) yy = lerp(REST, G0, since / 0.1);
        else if (since < 0.45) yy = G0;
        else if (since < 1.4) yy = lerp(G0, REST, (since - 0.45) / 0.95);
      }
      const ly = yy - CH;
      Q('cyl', 0, ly / 2, 0, 0.35, Math.max(0.1, -ly - 0.8), 0.35, tc(0.6, 0.62, 0.66));
      Q('box', 0, ly, 0, T * 0.95, 0.8, T * 0.95, tc(0.3, 0.29, 0.27));
      Q('box', 0, ly - 0.25, 0, T * 0.97, 0.12, T * 0.97, tc(1, 0.6, 0.15, 1));
      Q('box', 0, ly + 0.42, 0, T * 0.6, 0.06, T * 0.6, tc(0.2, 0.2, 0.22));
      lvPips(lv, 0, ly + 0.46, 0, true);
      break;
    }
  }
  if (TBR && !ghost) evoFx(S, tr, since);
  // 放在通道上的炮台：底部加一圈路障，并显示耐久
  if (tr.lane || (ghost && tr.laneGhost)) {
    TX.x = tr.wx; TX.y = tr.wy; TX.z = tr.wz; TX.yaw = 0; TX.cy = 1; TX.sy = 0;
    for (const [ox, oz, sx, sz] of [[0, -T * 0.42, T * 0.9, 0.18], [0, T * 0.42, T * 0.9, 0.18], [-T * 0.42, 0, 0.18, T * 0.9], [T * 0.42, 0, 0.18, T * 0.9]]) Q('box', ox, 0.3, oz, sx, 0.6, sz, tc(0.45, 0.42, 0.36));
    for (const [ox, oz] of [[-T * 0.42, -T * 0.42], [T * 0.42, -T * 0.42], [-T * 0.42, T * 0.42], [T * 0.42, T * 0.42]]) Q('box', ox, 0.62, oz, 0.22, 0.06, 0.22, tc(1, 0.5, 0.15, 1));
  }
  if (!ghost && tr.lane && tr.maxHp && tr.hp < tr.maxHp - 0.5) {
    const hpF = tr.hp / tr.maxHp, w = 1.4, by = 2.6;
    E.push('box', tr.wx, by, tr.wz, cam.rYaw, w + 0.06, 0.14, 0.02, c(0.02, 0.03, 0.05, 0.75, 0, 0, false, true));
    const off = -(w - w * hpF) / 2;
    E.push('box', tr.wx + cam.rx * off - cam.fx * 0.02, by, tr.wz + cam.rz * off - cam.fz * 0.02, cam.rYaw, w * hpF, 0.09, 0.03, c(1, 0.7, 0.25, 1, 1, 0, false, true));
  }
  GHOST = null; TDIS = 0;
}

/* ---------- 陷阱进阶外观：每个分支一套专属造型 + 底座光环 ---------- */
const EVO_COL = {
  rail: { a: [0.55, 0.85, 1], b: [1, 0.6, 0.25] }, mortar: { a: [1, 0.5, 0.15], b: [0.75, 0.5, 1] }, grinder: { a: [1, 0.3, 0.2], b: [0.7, 0.4, 1] }, gatling: { a: [1, 0.7, 0.25], b: [0.35, 0.8, 1] },
  slow: { a: [0.75, 0.95, 1], b: [0.3, 0.85, 1] }, spike: { a: [0.35, 1, 0.35], b: [1, 0.7, 0.25] },
  push: { a: [1, 0.45, 0.2], b: [0.3, 0.9, 1] }, tesla: { a: [0.7, 0.55, 1], b: [1, 0.85, 0.25] },
  sentry: { a: [1, 0.6, 0.2], b: [1, 0.25, 0.3] }, aa: { a: [1, 0.8, 0.3], b: [1, 0.45, 0.15] },
  laser: { a: [1, 0.9, 0.8], b: [0.7, 0.5, 1] }, flame: { a: [1, 0.55, 0.12], b: [0.35, 0.6, 1] },
  crusher: { a: [1, 0.75, 0.25], b: [0.3, 0.95, 1] },
};
function evoFx(S, tr, since) {
  const br = TBR, col = (EVO_COL[tr.type] || {})[br] || [1, 0.8, 0.3], t = timeNow + tr.x * 0.37 + tr.z * 0.61;
  const C = (k, a) => c(col[0] * k, col[1] * k, col[2] * k, a === undefined ? 1 : a, TDIS ? 0.15 : 1);
  const G = a => c(col[0], col[1], col[2], a, TDIS ? 0.1 : 1, 0, true);
  TX.x = tr.wx; TX.y = tr.wy; TX.z = tr.wz; TX.yaw = 0;
  if (tr.kind === 'wall') TX.yaw = Math.atan2(DIRS[tr.dir][0], DIRS[tr.dir][1]);
  TX.cy = Math.cos(TX.yaw); TX.sy = Math.sin(TX.yaw);
  const cat = TRAP[tr.type].cat, spark = (x, y, z, n, o) => { if (!TDIS && Math.random() < n) particle(Object.assign({ x, y, z, vx: rnd(-0.6, 0.6), vy: rnd(0.8, 2), vz: rnd(-0.6, 0.6), life: rnd(0.5, 1), s0: 0.07, s1: 0, c: col, grav: -0.5, drag: 0.5 }, o || {})); };
  // 底座光环（地面 / 炮台类）
  if (cat === 'floor' || cat === 'pad' || cat === 'heavy' || cat === 'hfloor') {
    const r = T * (cat === 'heavy' || cat === 'hfloor' ? 1.0 : tr.type === 'tesla' || cat === 'pad' ? 0.5 : 0.47);
    Q('ring', 0, 0.035, 0, r, 1, r, G(0.75), t * 0.6);
    for (let i = 0; i < 4; i++) { const a = t * 0.6 + i * Math.PI / 2; Q('box', Math.cos(a) * r, 0.05, Math.sin(a) * r, 0.16, 0.04, 0.16, C(1), -a); }
  }
  switch (tr.type + br) {
    case 'raila': {   // 超载线圈：两侧电容组 + 环绕电弧
      const yaw = tr.cAim || 0; TX.yaw = yaw; TX.cy = Math.cos(yaw); TX.sy = Math.sin(yaw);
      for (const sd of [-1, 1]) { Q('cyl', sd * 0.95, 1.75, 0.6, 0.45, 1.0, 0.45, tc(0.25, 0.26, 0.3)); Q('ring', sd * 0.95, 1.75 + Math.sin(t * 4) * 0.35, 0.6, 0.32, 1, 0.32, C(1), t * 5); }
      if (!TDIS && Math.random() < 0.3) { const a = [TX.x - TX.cy * 0.95 + TX.sy * 0.6, TX.y + 2.2, TX.z + TX.sy * 0.95 + TX.cy * 0.6], b = [TX.x + TX.cy * 0.95 + TX.sy * 0.6, TX.y + 2.2, TX.z - TX.sy * 0.95 + TX.cy * 0.6]; E.pushBeam('box', a[0], a[1] + rnd(-0.2, 0.2), a[2], b[0], b[1] + rnd(-0.2, 0.2), b[2], 0.03, 0.03, c(0.8, 0.9, 1, 1, 1, 0, true)); }
      break;
    }
    case 'railb': {   // 速射轨道：炮管外加旋转散热环
      const yaw = tr.cAim || 0; TX.yaw = yaw; TX.cy = Math.cos(yaw); TX.sy = Math.sin(yaw);
      for (let k = 0; k < 3; k++) Q('ring', 0, 2.0, -1.0 - k * 0.8, 0.62, 1, 0.62, C(0.7 + 0.3 * Math.sin(t * 8 + k)), t * 6);
      for (const sd of [-1, 1]) for (let k = 0; k < 4; k++) Q('box', sd * 0.82, 1.6, 0.9 - k * 0.22, 0.05, 0.6, 0.14, tc(0.32, 0.33, 0.37));
      break;
    }
    case 'mortara': { // 燃烧弹：两侧燃料罐 + 炮口火苗
      const yaw = tr.cAim || 0; TX.yaw = yaw; TX.cy = Math.cos(yaw); TX.sy = Math.sin(yaw);
      for (const sd of [-1, 1]) { Q('cyl', sd * 1.25, 1.35, 0.6, 0.55, 1.0, 0.55, tc(0.55, 0.22, 0.1)); Q('box', sd * 1.25, 1.35, 0.32, 0.4, 0.08, 0.02, C(1)); }
      spark(TX.x - TX.sy * 1.6, TX.y + 3.6, TX.z - TX.cy * 1.6, 0.4, { c: [1, 0.55, 0.15], s0: 0.14, vy: rnd(1, 2) });
      break;
    }
    case 'mortarb': { // 集束弹：炮管两侧挂载子弹药舱
      const yaw = tr.cAim || 0; TX.yaw = yaw; TX.cy = Math.cos(yaw); TX.sy = Math.sin(yaw);
      for (const sd of [-1, 1]) { Q('box', sd * 0.75, 2.3, -0.35, 0.35, 0.55, 0.9, tc(0.3, 0.29, 0.27)); for (let k = 0; k < 2; k++) Q('sphere', sd * 0.75, 2.45 - k * 0.3, -0.82, 0.16, 0.16, 0.16, C(1)); }
      break;
    }
    case 'grindera': { // 锯刃风暴：锯盘外圈加装红热刀刃
      const spin = timeNow * (tr.activeT > 0 ? 9 : 1.2) + tr.x;
      for (const [qx, qz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const dir = qx * qz; for (let i = 0; i < 6; i++) { const a = -spin * dir + i * Math.PI / 3; Q('cone', qx * T * 0.48 + Math.cos(a) * 0.55, 0.32, qz * T * 0.48 + Math.sin(a) * 0.55, 0.14, 0.32, 0.14, C(0.9)); } }
      break;
    }
    case 'grinderb': { // 引力漩涡：上升的紫色引力环
      for (let k = 0; k < 3; k++) { const ph = (t * 0.6 + k / 3) % 1; Q('ring', 0, 0.2 + ph * 4, 0, T * (1.3 - ph * 0.9), 1, T * (1.3 - ph * 0.9), G(0.5 * (1 - ph)), t * 2); }
      Q('sphere', 0, 0.35, 0, 0.5, 0.5, 0.5, C(1));
      break;
    }
    case 'slowa': {   // 冰封力场：四角升起冰晶，寒雾
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        Q('oct', ox * T * 0.33, 0.55 + Math.sin(t * 2 + ox + oz) * 0.05, oz * T * 0.33, 0.22, 0.75, 0.22, c(0.75, 0.95, 1, 0.85, TDIS ? 0.1 : 0.8), t * 0.5);
        Q('oct', ox * T * 0.2, 0.32, oz * T * 0.2, 0.12, 0.38, 0.12, c(0.85, 1, 1, 0.9, TDIS ? 0.1 : 0.9), -t);
      }
      Q('disc', 0, 0.13, 0, T * 0.8, 1, T * 0.8, G(0.12));
      spark(TX.x + rnd(-1, 1), 0.3, TX.z + rnd(-1, 1), 0.3, { vy: rnd(0.2, 0.6), s0: 0.18, s1: 0.4, c: [0.8, 0.95, 1], life: 1.2, a0: 0.25 });
      break;
    }
    case 'slowb': {   // 迟滞矩阵：投射到周围 3×3 格的网格与立柱
      const R = T * 1.5;
      for (let i = -1; i <= 2; i++) { const o = (i - 0.5) * T; Q('box', o, 0.03, 0, 0.04, 0.01, R * 2, G(0.5)); Q('box', 0, 0.03, o, R * 2, 0.01, 0.04, G(0.5)); }
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        Q('cyl', ox * R, 0.45, oz * R, 0.14, 0.9, 0.14, tc(0.25, 0.27, 0.3));
        Q('sphere', ox * R, 0.95, oz * R, 0.2, 0.2, 0.2, C(1));
      }
      Q('ring', 0, 0.6 + Math.sin(t * 2) * 0.25, 0, R, 1, R, G(0.35), t);
      break;
    }
    case 'spikea': {  // 剧毒刺：毒液池 + 冒泡
      Q('disc', 0, 0.135, 0, T * 0.8, 1, T * 0.8, c(0.2, 0.9, 0.25, 0.35, TDIS ? 0.1 : 0.7, 0, true));
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) Q('sphere', i * T * 0.24, 0.62 + Math.sin(t * 3 + i * 2 + j) * 0.03, j * T * 0.24, 0.1, 0.1, 0.1, c(0.4, 1, 0.3, 1, TDIS ? 0.1 : 1));
      spark(TX.x + rnd(-0.9, 0.9), 0.2, TX.z + rnd(-0.9, 0.9), 0.45, { vy: rnd(0.4, 1), s0: 0.1, s1: 0.02, c: [0.35, 1, 0.3], grav: -0.2 });
      break;
    }
    case 'spikeb': {  // 穿甲刺：金属钻头 + 旋转钻环
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { Q('ring', i * T * 0.24, 0.16, j * T * 0.24, 0.36, 1, 0.36, C(1), t * 4); Q('ring', i * T * 0.24, 0.3, j * T * 0.24, 0.26, 1, 0.26, C(0.8), -t * 4); }
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) Q('box', ox * T * 0.4, 0.2, oz * T * 0.4, 0.22, 0.16, 0.22, tc(0.75, 0.55, 0.25));
      Q('box', 0, 0.14, 0, T * 0.9, 0.03, 0.08, C(0.9)); Q('box', 0, 0.14, 0, 0.08, 0.03, T * 0.9, C(0.9));
      break;
    }
    case 'pusha': {   // 弹射器：液压活塞 + 发光箭头
      const pd = pathDirAt(S, tr.wx, tr.wz); TX.yaw = Math.atan2(pd[0], pd[1]); TX.cy = Math.cos(TX.yaw); TX.sy = Math.sin(TX.yaw);
      for (const sd of [-1, 1]) { Q('cyl', sd * T * 0.4, 0.35, 0, 0.22, 0.6, 0.22, tc(0.3, 0.3, 0.33)); Q('cyl', sd * T * 0.4, 0.72, 0, 0.12, 0.25 + (since < 0.4 ? 0.3 : 0), 0.12, C(1)); }
      for (let k = 0; k < 3; k++) { const z = T * 0.3 - k * T * 0.25, a = 0.4 + 0.6 * ((t * 2 + k * 0.33) % 1); Q('box', 0.13, 0.2, z + 0.1, 0.36, 0.02, 0.07, G(a), 0.8); Q('box', -0.13, 0.2, z + 0.1, 0.36, 0.02, 0.07, G(a), -0.8); }
      break;
    }
    case 'pushb': {   // 连弹板：两侧蓄能线圈快速闪烁
      for (const sd of [-1, 1]) { Q('cyl', sd * T * 0.42, 0.3, 0, 0.2, 0.6, 0.2, tc(0.25, 0.27, 0.3)); for (let k = 0; k < 4; k++) Q('ring', sd * T * 0.42, 0.12 + k * 0.14, 0, 0.42, 1, 0.42, C(0.6 + 0.5 * Math.sin(t * 9 + k)), t * 3); }
      Q('box', 0, 0.2, 0, T * 0.75, 0.02, 0.05, G(0.6 + 0.4 * Math.sin(t * 12)));
      break;
    }
    case 'teslaa': {  // 链式闪电：三颗卫星电球 + 环绕电弧
      for (let i = 0; i < 3; i++) {
        const a = t * 2.2 + i * 2.094, x = Math.cos(a) * 0.95, z = Math.sin(a) * 0.95, y = 2.75 + Math.sin(t * 3 + i) * 0.2;
        Q('sphere', x, y, z, 0.26, 0.26, 0.26, C(1));
        if (!TDIS && Math.random() < 0.35) { const p0 = [TX.x + x, TX.y + y, TX.z + z]; E.pushBeam('box', p0[0], p0[1], p0[2], TX.x, TX.y + 2.75, TX.z, 0.03, 0.03, c(0.85, 0.75, 1, 1, 1, 0, true)); }
      }
      Q('ring', 0, 2.75, 0, 1.0, 1, 1.0, G(0.4), t);
      break;
    }
    case 'teslab': {  // 麻痹线圈：金色粗线圈高速旋转
      for (let i = 0; i < 4; i++) Q('ring', 0, 0.95 + i * 0.42, 0, 0.78 - i * 0.06, 1, 0.78 - i * 0.06, C(1), -t * (3 + i));
      Q('sphere', 0, 2.75, 0, 0.82, 0.82, 0.82, c(1, 0.85, 0.3, 0.35, TDIS ? 0.1 : 1, 0, true));
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + t; Q('box', Math.cos(a) * 0.55, 3.3, Math.sin(a) * 0.55, 0.06, 0.5, 0.06, C(1), -a); }
      break;
    }
    case 'sentrya': { // 双联机枪：并排第二挺枪 + 双弹链
      const yaw = tr.cAim || 0; TX.yaw = yaw; TX.cy = Math.cos(yaw); TX.sy = Math.sin(yaw);
      for (const sd of [-0.42, 0.42]) {
        Q('box', sd, 1.3, -0.2, 0.18, 0.24, 0.9, tc(0.2, 0.2, 0.23));
        Q('cyl', sd, 1.3, -0.75, 0.12, 0.12, 0.12, C(since < 0.06 ? 1.4 : 0.8));
        const bx = sd, rec = since < 0.06 ? 0.08 : 0, z0 = -0.6 + rec, z1 = -1.25 + rec;
        E.pushBeam('cyl', TX.x + TX.cy * bx + TX.sy * z0, TX.y + 1.3, TX.z - TX.sy * bx + TX.cy * z0, TX.x + TX.cy * bx + TX.sy * z1, TX.y + 1.3, TX.z - TX.sy * bx + TX.cy * z1, 0.1, 0.1, tc(0.14, 0.14, 0.16), true);
        if (since < 0.05) E.push('sphere', TX.x + TX.cy * bx + TX.sy * z1, TX.y + 1.3, TX.z - TX.sy * bx + TX.cy * z1, 0, 0.35, 0.35, 0.35, c(1, 0.75, 0.35, 0.9, 1, 0, true));
        Q('box', sd * 1.25, 1.1, 0.1, 0.1, 0.3, 0.35, C(0.8));
      }
      break;
    }
    case 'sentryb': { // 侦测穿甲弹：顶部旋转雷达 + 红色扫描光
      const yaw = tr.cAim || 0; TX.yaw = yaw; TX.cy = Math.cos(yaw); TX.sy = Math.sin(yaw);
      Q('cyl', 0, 1.75, 0.2, 0.06, 0.4, 0.06, tc(0.3, 0.3, 0.33));
      TX.yaw = t * 2.5; TX.cy = Math.cos(TX.yaw); TX.sy = Math.sin(TX.yaw);
      Q('box', 0, 2.0, 0.2, 0.7, 0.3, 0.05, tc(0.28, 0.28, 0.32)); Q('box', 0, 2.0, 0.17, 0.5, 0.06, 0.02, C(1));
      TX.yaw = yaw; TX.cy = Math.cos(yaw); TX.sy = Math.sin(yaw);
      if (!TDIS) { const L = 6, p0 = [TX.x - TX.sy * 0.9, TX.y + 1.42, TX.z - TX.cy * 0.9]; E.pushBeam('box', p0[0], p0[1], p0[2], p0[0] - TX.sy * L, p0[1], p0[2] - TX.cy * L, 0.02, 0.02, c(1, 0.2, 0.25, 0.5, 1, 0, true)); }
      break;
    }
    case 'aaa': {     // 集束导弹：两侧加挂导弹巢
      const yaw = tr.cAim || 0; TX.yaw = yaw; TX.cy = Math.cos(yaw); TX.sy = Math.sin(yaw);
      for (const sd of [-0.78, 0.78]) {
        QR('box', sd, 1.2, 0, 0, 0.55, 0, 0.45, 0.6, 0.9, tc(0.3, 0.3, 0.28));
        for (let i = 0; i < 3; i++) Q('sphere', sd, 1.2 + (i - 1) * 0.16 + 0.25, -0.45 + (i - 1) * 0.05, 0.11, 0.11, 0.11, C(1));
      }
      break;
    }
    case 'aab': break;   // 对地模式整体换成 drawAAGround 的模型
    case 'lasera': {  // 过载激光：散热鳍片 + 白热发射口
      for (let i = -2; i <= 2; i++) Q('box', i * 0.18, 0.45, 0.1, 0.06, 0.22, 0.28, i % 2 ? tc(0.3, 0.3, 0.34) : C(0.8));
      Q('cyl', 0, 0, -0.12, 0.42, 0.12, 0.42, C(1));
      spark(TX.x - TX.sy * 0.3, TX.y + 0.4, TX.z - TX.cy * 0.3, 0.15, { c: [1, 0.6, 0.4], s0: 0.05 });
      break;
    }
    case 'laserb': {  // 棱镜光束：发射口前旋转棱镜
      Q('oct', 0, 0, -0.45, 0.35, 0.55, 0.35, c(0.75, 0.6, 1, 0.85, TDIS ? 0.1 : 0.9), t * 1.5);
      Q('ring', 0, 0, -0.45, 0.6, 1, 0.6, G(0.5), t * 2);
      break;
    }
    case 'flamea': {  // 凝固汽油：两侧燃料罐 + 滴落火星
      for (const sd of [-0.55, 0.55]) { Q('cyl', sd, -0.35, 0.1, 0.3, 0.8, 0.3, tc(0.5, 0.25, 0.12)); Q('box', sd, -0.35, -0.06, 0.32, 0.06, 0.02, C(1)); }
      spark(TX.x - TX.sy * 0.45, TX.y - 0.5, TX.z - TX.cy * 0.45, 0.25, { vy: -1, grav: 6, c: [1, 0.5, 0.1], s0: 0.06 });
      break;
    }
    case 'flameb': {  // 蓝焰：蓝色引燃火苗 + 喷口光环
      Q('sphere', 0, -0.4, -0.5, 0.26, 0.26, 0.26, c(0.4, 0.65, 1, 1, TDIS ? 0.1 : 1));
      Q('ring', 0, -0.4, -0.3, 0.55, 1, 0.55, G(0.6), t * 3);
      spark(TX.x - TX.sy * 0.6, TX.y - 0.4, TX.z - TX.cy * 0.6, 0.5, { vx: -TX.sy * 1.5, vz: -TX.cy * 1.5, vy: 0.4, c: [0.4, 0.65, 1], s0: 0.12, s1: 0, life: 0.35 });
      break;
    }
    case 'crushera': { // 重锤：锤面加装尖刺与金色护甲
      const CH = tr.wy, G0 = S.floorH(tr.wx, tr.wz) + 0.42, REST = CH - (CH < 5 ? 1.15 : 1.45);
      let yy = REST;
      if (since < 0.1) yy = lerp(REST, G0, since / 0.1); else if (since < 0.45) yy = G0; else if (since < 1.4) yy = lerp(G0, REST, (since - 0.45) / 0.95);
      const ly = yy - CH;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) QR('cone', i * T * 0.3, ly - 0.42, j * T * 0.3, 0, Math.PI, 0, 0.22, 0.3, 0.22, tc(0.75, 0.7, 0.6));
      for (const [ox, oz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) Q('box', ox * T * 0.49, ly, oz * T * 0.49, ox ? 0.08 : T * 0.97, 0.7, oz ? 0.08 : T * 0.97, C(0.9));
      break;
    }
    case 'crusherb': { // 连击锤：两侧辅助活塞 + 青色能量条
      for (const sd of [-1, 1]) { Q('cyl', sd * T * 0.36, -0.9, 0, 0.18, 1.4, 0.18, tc(0.55, 0.57, 0.62)); Q('box', sd * T * 0.36, -1.65, 0, 0.3, 0.08, 0.3, C(0.7 + 0.3 * Math.sin(t * 10))); }
      Q('box', 0, -0.42, 0, T * 0.92, 0.04, 0.1, C(1)); Q('box', 0, -0.42, 0, 0.1, 0.04, T * 0.92, C(1));
      break;
    }
  }
}

/* ============================================================
 * 水晶 / 传送门 / 弹体 / 其他玩家
 * ============================================================ */
let crystalHitT = 0;
function drawCrystal(S) {
  const cp = S.crystalPos, f = S.s.crystal.hp / S.s.crystal.max;
  if (Math.random() < 0.5) { const a = Math.random() * Math.PI * 2, r = rnd(0.6, 1.8); particle({ x: cp.x + Math.cos(a) * r, y: 0.7, z: cp.z + Math.sin(a) * r, vy: rnd(1.2, 2.6), life: rnd(1.0, 1.8), s0: 0.06, s1: 0.0, c: f > 0.35 ? [0.4, 0.9, 1] : [1, 0.35, 0.35], grav: 0, drag: 0 }); }
  if (f < 0.35 && Math.random() < 0.25) burst(cp.x + rnd(-0.6, 0.6), rnd(1.6, 3.6), cp.z + rnd(-0.6, 0.6), 3, { c: [1, 0.3, 0.3], sp0: 2, sp1: 5, s0: 0.06, l0: 0.15, l1: 0.3, grav: 6 });
  const r = lerp(1.0, 0.37, f), g = lerp(0.25, 0.89, f), b = lerp(0.3, 1.0, f);
  const yb = 2.6 + Math.sin(timeNow * 1.4) * 0.15;
  E.push('oct', cp.x, yb, cp.z, timeNow * 0.6, 1.7, 3.0, 1.7, c(r, g, b, 0.92, 0.65, crystalHitT > 0 ? crystalHitT : 0));
  E.push('oct', cp.x, yb, cp.z, -timeNow * 0.9, 0.9, 1.7, 0.9, c(r * 0.6 + 0.4, g * 0.6 + 0.4, b * 0.6 + 0.4, 1, 1));
  for (let i = 0; i < 3; i++) {
    const a = timeNow * 0.8 + i * 2.09;
    E.push('oct', cp.x + Math.cos(a) * 2.3, yb + Math.sin(timeNow * 2 + i) * 0.4, cp.z + Math.sin(a) * 2.3, a * 2, 0.35, 0.6, 0.35, c(r, g, b, 1, 0.9));
  }
  if (crystalHitT > 0) E.push('sphere', cp.x, yb, cp.z, 0, 4.4, 5.4, 4.4, c(r, g, b, crystalHitT * 0.3, 1, 0, true));
  E.pushBeam('cyl', cp.x, 0.6, cp.z, cp.x, yb - 1.4, cp.z, 0.25, 0.25, c(r, g, b, 0.35, 1, 0, true), true);
}
// 出怪口状态：open 已开启 / soon 下一波开启 / closed 封锁
function laneState(S, lane) {
  const w = S.s.wave, from = S.laneFrom(lane);
  if (from <= Math.max(1, w)) return 'open';
  if (S.s.phase === 'build' && from === w + 1) return 'soon';
  return 'closed';
}
function drawPortals(S, dt) {
  for (const lane of S.lanes) {
    const f = laneFrame(S, lane), st = laneState(S, lane);
    const px = f.x - f.dx * 1.3, pz = f.z - f.dz * 1.3, rx = f.dz, rz = -f.dx;
    if (portalFlare[lane] === undefined) portalFlare[lane] = 0;
    const fl = portalFlare[lane]; portalFlare[lane] = Math.max(0, fl - dt * 2.5);
    if (st === 'closed') {
      // 封锁：灰色闸门 + 暗红指示灯
      E.pushR('ring', px, 2.5, pz, f.yaw, Math.PI / 2, 0, 2.2, 1, 2.2, c(0.3, 0.3, 0.33, 1, 0.1));
      for (let k = -2; k <= 2; k++) E.push('box', px + rx * k * 0.8, 2.5, pz + rz * k * 0.8, f.yaw, 0.25, 4.6, 0.15, c(0.2, 0.21, 0.24));
      E.push('box', px, 4.9, pz, f.yaw, 0.5, 0.18, 0.2, c(0.6, 0.1, 0.1, 1, 0.6));
      continue;
    }
    const soon = st === 'soon', k = soon ? 0.5 + 0.5 * Math.sin(timeNow * 6) : 1;
    const R = soon ? [1, 0.7, 0.2] : [1, 0.25, 0.22];
    if (fl > 0) E.pushR('disc', px + f.dx * 0.05, 2.5, pz + f.dz * 0.05, f.yaw, Math.PI / 2, 0, 4.4 + fl * 0.8, 1, 4.4 + fl * 0.8, c(1, 0.5, 0.35, Math.min(1, fl) * 0.7, 1, 0, true));
    if (!soon && Math.random() < 0.35) { const a = Math.random() * Math.PI * 2, ca = Math.cos(a) * 2.6, sa = Math.sin(a) * 2.6; particle({ x: px + rx * ca + f.dx * 0.2, y: 2.5 + sa, z: pz + rz * ca + f.dz * 0.2, vx: -rx * ca * 1.35, vy: -sa * 1.35, vz: -rz * ca * 1.35, life: 0.7, s0: 0.08, s1: 0.02, c: [1, 0.35, 0.25], grav: 0 }); }
    E.pushR('ring', px, 2.5, pz, f.yaw, Math.PI / 2, timeNow, 2.2, 1, 2.2, c(R[0], R[1], R[2], 1, k));
    if (soon) { for (let j = -2; j <= 2; j++) E.push('box', px + rx * j * 0.8, 2.5, pz + rz * j * 0.8, f.yaw, 0.25, 4.6, 0.15, c(0.22, 0.2, 0.18)); E.push('box', px, 4.9, pz, f.yaw, 0.5, 0.18, 0.2, c(1, 0.7, 0.2, 1, k)); continue; }
    E.pushR('ring', px, 2.5, pz, f.yaw, Math.PI / 2, -timeNow * 1.7, 1.6, 1, 1.6, c(1, 0.45, 0.2, 0.8, 1, 0, true));
    E.pushR('disc', px, 2.5, pz, f.yaw, Math.PI / 2, timeNow * 2, 4.2, 1, 4.2, c(0.8, 0.12, 0.15, 0.55, 1, 0, true));
  }
}
function drawProj(S, a) {
  for (const p of S.s.proj) {
    const L = Math.hypot(p.vx, p.vy, p.vz) || 1;
    if (p.kind === 'nade') {
      const bl = Math.sin(timeNow * 22) > 0;
      E.push('sphere', p.x, p.y, p.z, timeNow * 6, 0.22, 0.22, 0.22, c(0.25, 0.27, 0.3));
      E.push('sphere', p.x, p.y + 0.06, p.z, 0, 0.12, 0.12, 0.12, c(0.4, 0.9, 1, 1, bl ? 1 : 0.3));
      if (Math.random() < 0.6) particle({ x: p.x, y: p.y, z: p.z, life: 0.3, s0: 0.08, s1: 0, c: [0.4, 0.9, 1], grav: 0, drag: 0 });
      continue;
    }
    if (p.kind === 'mb') {   // 怪物光弹：红色发光弹头 + 拖尾
      const fx = p.vx / L, fy = p.vy / L, fz = p.vz / L;
      E.pushBeam('box', p.x - fx * 1.1, p.y - fy * 1.1, p.z - fz * 1.1, p.x, p.y, p.z, 0.1, 0.1, c(1, 0.3, 0.22, 0.75, 1, 0, true));
      E.push('sphere', p.x, p.y, p.z, 0, 0.26, 0.26, 0.26, c(1, 0.55, 0.4, 1, 1, 0, true));
      flashLight(p.x, p.y, p.z, 3.5, [1, 0.35, 0.25], 0.9, 0.02);
      continue;
    }
    if (p.kind === 'rocket') {
      const fx = p.vx / L, fy = p.vy / L, fz = p.vz / L;
      E.pushBeam('cyl', p.x - fx * 0.55, p.y - fy * 0.55, p.z - fz * 0.55, p.x, p.y, p.z, 0.16, 0.16, c(0.3, 0.32, 0.36), true);
      E.push('sphere', p.x - fx * 0.65, p.y - fy * 0.65, p.z - fz * 0.65, 0, 0.32, 0.32, 0.32, c(1, 0.7, 0.3, 1, 1, 0, true));
      for (let i = 0; i < 2; i++) particle({ x: p.x - fx * 0.7, y: p.y - fy * 0.7, z: p.z - fz * 0.7, vx: rnd(-0.4, 0.4), vy: rnd(-0.2, 0.5), vz: rnd(-0.4, 0.4), life: rnd(0.4, 0.9), s0: 0.2, s1: 0.7, c: [0.55, 0.55, 0.58], a0: 0.35, add: false });
      flashLight(p.x, p.y, p.z, 6, [1, 0.6, 0.3], 1.2, 0.02);
      continue;
    }
    const bx = p.x - p.vx / L * 0.6, by = p.y - p.vy / L * 0.6, bz = p.z - p.vz / L * 0.6;
    E.pushBeam('cyl', bx, by, bz, p.x, p.y, p.z, 0.16, 0.16, c(0.85, 0.85, 0.8), true);
    E.push('sphere', bx, by, bz, 0, 0.3, 0.3, 0.3, c(1, 0.6, 0.2, 0.9, 1, 0, true));
    if (Math.random() < 0.7) particle({ x: bx, y: by, z: bz, vx: rnd(-0.3, 0.3), vy: rnd(0, 0.5), vz: rnd(-0.3, 0.3), life: 0.5, s0: 0.25, s1: 0.7, c: [0.55, 0.55, 0.58], a0: 0.35, add: false });
  }
  void a;
}
// 队友：渲染位置平滑 + 程序化士兵模型 + 开火曳光
const teamVis = {};
const MATE = { D: col(0.2, 0.21, 0.25), G: col(0.62, 0.65, 0.7), G2: col(0.45, 0.48, 0.53), GUN: col(0.3, 0.31, 0.34) };
function drawOtherPlayers(S, a, dt) {
  const k = 1 - Math.exp(-dt * 14);
  for (const id in teamVis) if (!S.s.players[id]) { if (teamVis[id].tag) teamVis[id].tag.remove(); delete teamVis[id]; }
  for (const id in S.s.players) {
    if (id === PID) continue;
    const p = S.s.players[id];
    let v = teamVis[id];
    if (!v) v = teamVis[id] = { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, walk: 0, fireAcc: 0, spd: 0 };
    const dx = p.x - v.x, dz = p.z - v.z, d = Math.hypot(dx, dz);
    if (d > 6) { v.x = p.x; v.z = p.z; } else { v.x += dx * k; v.z += dz * k; }
    v.y += (p.y - v.y) * k; v.pitch += (p.pitch - v.pitch) * k;
    if (p.invT > 0 && !p.dead) E.push('sphere', v.x, v.y + 1.0, v.z, timeNow, 1.5, 2.3, 1.5, c(0.5, 0.9, 1, 0.1 + 0.05 * Math.sin(timeNow * 8), 1, 0, true));
    let dy = p.yaw - v.yaw; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2; v.yaw += dy * k;
    v.spd = lerp(v.spd, dt > 0 ? Math.min(10, d * k / dt) : 0, Math.min(1, dt * 8));
    v.walk += dt * v.spd * 1.25;
    v.dead = p.dead;
    if (p.dead) continue;
    const tc3 = TEAM_COL[p.slot % 4];
    MX.x = v.x; MX.y = v.y; MX.z = v.z; MX.yaw = v.yaw; MX.cy = Math.cos(v.yaw); MX.sy = Math.sin(v.yaw); MX.s = 1;
    TN.slow = 0; TN.poison = false; TN.burn = false; TN.flash = 0; TN.enr = false; TN.champ = false;
    const air = v.y > 0.05, sw = air ? 0.5 : Math.sin(v.walk) * Math.min(1, v.spd / 6) * 0.7;
    // 浅色装甲 + 深色关节 + 队伍色发光条，暗处也能一眼认出
    const D = MATE.D, G = MATE.G, G2 = MATE.G2, TCc = col(tc3[0], tc3[1], tc3[2], 1, 1), TCd = col(tc3[0] * 0.55, tc3[1] * 0.55, tc3[2] * 0.55, 1, 0.25);
    LIMB('box', -0.14, 0.92, 0, 0.9, 0.19, 0.22, sw, D);
    LIMB('box', 0.14, 0.92, 0, 0.9, 0.19, 0.22, air ? -0.3 : -sw, D);
    LIMB('box', -0.14, 0.8, -0.02, 0.36, 0.21, 0.24, sw, G2);
    LIMB('box', 0.14, 0.8, -0.02, 0.36, 0.21, 0.24, air ? -0.3 : -sw, G2);
    P('box', 0, 1.0, 0, 0.44, 0.2, 0.28, D);
    P('box', 0, 1.32, 0, 0.54, 0.52, 0.32, G);
    P('box', 0, 1.42, -0.17, 0.46, 0.08, 0.02, TCc);
    P('box', -0.33, 1.52, 0, 0.16, 0.14, 0.3, TCd);
    P('box', 0.33, 1.52, 0, 0.16, 0.14, 0.3, TCd);
    P('box', 0, 1.3, 0.22, 0.38, 0.44, 0.14, D);
    P('box', 0, 1.42, 0.3, 0.24, 0.06, 0.03, TCc);
    P('box', 0, 1.74, 0, 0.3, 0.32, 0.32, G);
    P('box', 0, 1.75, -0.165, 0.25, 0.09, 0.02, TCc);
    P('box', 0, 1.91, 0.02, 0.32, 0.05, 0.34, G2);
    // 双臂 + 步枪，随俯仰角抬起
    const pt = clamp(v.pitch, -1.2, 1.2);
    PR('box', -0.24, 1.42, -0.18, pt, 0, 0.12, 0.12, 0.44, G2);
    PR('box', 0.24, 1.42, -0.18, pt, 0, 0.12, 0.12, 0.44, G2);
    // 步枪：枪身 + 队伍色瞄具灯条；gp 为枪口
    const gc = LOCAL(0.04, 1.44 + Math.sin(pt) * 0.42, -0.18 - Math.cos(pt) * 0.42);
    E.pushR('box', gc[0], gc[1], gc[2], v.yaw, pt, 0, 0.1, 0.15, 0.78, MATE.GUN);
    E.pushR('box', gc[0], gc[1] + 0.09 * Math.cos(pt), gc[2], v.yaw, pt, 0, 0.03, 0.03, 0.5, TCc);
    const gp = LOCAL(0.04, 1.44 + Math.sin(pt) * 0.82, -0.18 - Math.cos(pt) * 0.82);
    E.push('disc', v.x, 0.03, v.z, 0, 0.75, 1, 0.75, c(0, 0, 0, 0.35));
    E.push('ring', v.x, 0.05, v.z, timeNow, 0.6, 1, 0.6, c(tc3[0], tc3[1], tc3[2], 0.5, 1, 0, true));
    // 开火：按射速生成曳光与枪口火光（纯视觉）
    const firing = MP.role === 'client' ? p.fire : p.input.fire;
    const PW = WPN[p.wpn] || WPN.rifle;
    if (firing && mode !== 'menu') {
      v.fireAcc += dt * PW.rps;
      while (v.fireAcc >= 1) {
        v.fireAcc -= 1;
        const mz = gp;
        flashLight(mz[0], mz[1], mz[2], PW.id === 'rifle' ? 5 : 9, [1, 0.75, 0.4], PW.id === 'rifle' ? 1.1 : 2, 0.06);
        Snd.play(PW.id === 'rifle' ? 'shot2' : PW.id === 'shotgun' ? 'shotgun' : PW.id === 'sniper' ? 'sniper' : 'rocketFire', v.x, v.z);
        if (PW.proj) continue;   // 火箭弹由快照里的弹体显示
        const n = PW.pellets ? 5 : 1, spr = PW.pellets ? 0.07 : 0.01;
        for (let j = 0; j < n; j++) {
          const yaw = v.yaw + rnd(-spr, spr), pitch = v.pitch + rnd(-spr, spr), cp = Math.cos(pitch);
          const fx = -Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(yaw) * cp;
          const h = S.raycast(v.x, v.y + 1.62, v.z, fx, fy, fz, 120);
          const L = h ? h.t : 120, ex = v.x + fx * L, ey = v.y + 1.62 + fy * L, ez = v.z + fz * L;
          if (PW.id === 'sniper') tracers.push({ x1: mz[0], y1: mz[1], z1: mz[2], x2: ex, y2: ey, z2: ez, t: 0, life: 0.35, c: [0.45, 0.9, 1], w: 3 });
          else tracers.push({ x1: mz[0], y1: mz[1], z1: mz[2], x2: ex, y2: ey, z2: ez, t: 0, life: 0.07, c: [1, 0.82, 0.55] });
          if (h) burst(ex, ey, ez, 3, { c: [1, 0.8, 0.45], sp0: 1.5, sp1: 4, l0: 0.1, l1: 0.25, s0: 0.04, grav: 12 });
        }
      }
    } else v.fireAcc = 0.9;
  }
}
// 队友头顶名牌（DOM），被墙挡住时变淡
function updateTags() {
  const layer = $('tags');
  if (!sim || MP.role === 'solo') { if (layer.firstChild) clearTags(); return; }
  for (const id in teamVis) {
    const v = teamVis[id], p = sim.s.players[id];
    if (!p) continue;
    if (!v.tag) {
      v.tag = document.createElement('div'); v.tag.className = 'tag';
      v.tag.innerHTML = '<b></b><i><s></s></i>';
      layer.appendChild(v.tag);
    }
    const sp = p.dead ? null : project(v.x, v.y + 2.25, v.z);
    if (!sp) { v.tag.style.opacity = 0; continue; }
    const dist = Math.hypot(v.x - cam.x, v.z - cam.z);
    if (!v.occT || timeNow - v.occT > 0.2) {
      v.occT = timeNow;
      const dx = v.x - cam.x, dy = v.y + 1.9 - cam.y, dz = v.z - cam.z, L = Math.hypot(dx, dy, dz) || 1;
      const h = sim.raycast(cam.x, cam.y, cam.z, dx / L, dy / L, dz / L, L);
      v.occ = !!(h && h.t < L - 0.5);
    }
    v.tag.style.opacity = v.occ ? 0.45 : 1;
    v.tag.style.setProperty('--tc', TEAM_CSS[p.slot % 4]);
    v.tag.style.transform = `translate(${sp.x.toFixed(1)}px,${sp.y.toFixed(1)}px) translate(-50%,-100%) scale(${clamp(14 / Math.max(dist, 1), 0.7, 1).toFixed(2)})`;
    const tn = `[${(CLS[p.cls] || CLS.assault).short}] ${p.name}`;
    const b = v.tag.firstChild; if (b.textContent !== tn) b.textContent = tn;
    v.tag.querySelector('s').style.width = (p.hp / p.maxHp * 100).toFixed(0) + '%';
  }
}
function clearTags() { const layer = $('tags'); while (layer.firstChild) layer.firstChild.remove(); for (const id in teamVis) teamVis[id].tag = null; }
// 左下角队伍面板
function updateTeam() {
  const box = $('team');
  if (!sim || MP.role === 'solo') { box.hidden = true; return; }
  box.hidden = false;
  const ps = Object.values(sim.s.players).sort((a, b) => a.slot - b.slot);
  const key = ps.map(q => [q.id, q.name, q.cls, Math.ceil(q.hp), q.dead ? Math.ceil(q.respawnT) : -1, q.ready ? 1 : 0, q.kills].join(',')).join('|') + sim.s.phase;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = '';
  for (const q of ps) {
    const row = document.createElement('div'); row.className = 'tm' + (q.dead ? ' dead' : '') + (q.id === PID ? ' me' : '');
    row.style.setProperty('--tc', TEAM_CSS[q.slot % 4]);
    const nm = document.createElement('b'); nm.textContent = `[${(CLS[q.cls] || CLS.assault).short}] ${q.name}`;
    const st = document.createElement('span');
    st.textContent = q.dead ? `阵亡 ${Math.ceil(q.respawnT)}s` : (sim.s.phase === 'build' && q.ready ? '已准备' : `击杀 ${q.kills}`);
    const bar = document.createElement('i'); const fill = document.createElement('s'); fill.style.width = (q.hp / q.maxHp * 100).toFixed(0) + '%'; bar.appendChild(fill);
    row.append(nm, st, bar); box.appendChild(row);
  }
}

/* ============================================================
 * 第一人称武器模型（图层 1，不会穿墙）
 * ============================================================ */
function V(g, lx, ly, lz, sx, sy, sz, cc, pitchOff, rollOff) {
  const x = cam.x + cam.rx * lx + cam.ux * ly - cam.fx * lz;
  const y = cam.y + cam.uy * ly - cam.fy * lz;
  const z = cam.z + cam.rz * lx + cam.uz * ly - cam.fz * lz;
  E.pushR(g, x, y, z, cam.rYaw, cam.rPitch + (pitchOff || 0), rollOff || 0, sx, sy, sz, cc);
}
const VMC2 = { B: col(0.56, 0.59, 0.64), D: col(0.2, 0.21, 0.24), A: col(0.95, 0.56, 0.2), O: col(0.42, 0.46, 0.36), CY: col(0.37, 0.89, 1.0, 1, 0.9) };
const VMC = { W: col(1, 1, 1), G: col(0.24, 0.25, 0.29), A: col(0.85, 0.52, 0.18), D: col(0.12, 0.13, 0.15), CY: col(0.37, 0.89, 1.0, 1, 0.9) };
function drawViewmodel(dt) {
  const p = sim && sim.s.players[PID];
  if (!p || p.dead) return;
  E.setLayer(1);
  const ads = cam.ads, k = vm.kick, K = 0.8;
  const sw = vm.switchT > 0 ? vm.switchT / 0.25 : 0;
  const W = WPN[p.wpn] || WPN.rifle;
  const reload = p.reloadT > 0 ? Math.sin(Math.min(1, (W.reload - p.reloadT) / W.reload) * Math.PI) : 0;
  { const mt = myMount(); if (mt) { if (mt.type === 'gatling') drawGatlingVM(p, mt, dt); E.setLayer(0); return; } }
  if (tool === 'gun' && W.id === 'sniper' && cam.ads > 0.85) { E.setLayer(0); vm.mz = [0, -0.05, -0.3]; return; }
  const bob = Math.sin(cam.bob * 2) * 0.006 * (1 - ads);
  const bx = lerp(0.2, 0.0, ads) + vm.swayX, by = lerp(-0.24, -0.135, ads) - sw * 0.3 - reload * 0.08 + vm.swayY + bob;
  const bz = lerp(-0.66, -0.52, ads) + k * 0.05;
  const pk = k * 0.08 + reload * 0.45, rl = reload * 0.5;
  const cP = Math.cos(pk), sP = Math.sin(pk), cR = Math.cos(rl), sR = Math.sin(rl);
  const off = (ox, oy, oz) => {
    ox *= K; oy *= K; oz *= K;
    const x1 = ox * cR - oy * sR, y1 = ox * sR + oy * cR;
    return [bx + x1, by + y1 * cP - oz * sP, bz + y1 * sP + oz * cP];
  };
  const G3 = (g, ox, oy, oz, sx, sy, sz, cc) => { const o = off(ox, oy, oz); V(g, o[0], o[1], o[2], sx * K, sy * K, sz * K, cc, pk, rl); };
  const flashFx = () => {
    if (vm.flash <= 0) return;
    const o2 = vm.mz, big = W.id === 'rifle' ? 1 : 1.8;
    V('sphere', o2[0], o2[1], o2[2], 0.1 * big, 0.1 * big, 0.1 * big, c(1, 0.85, 0.5, 0.95, 1, 0, true));
    V('box', o2[0], o2[1], o2[2], 0.26 * big, 0.02, 0.02, c(1, 0.7, 0.3, 0.8, 1, 0, true), 0, timeNow * 40);
    V('box', o2[0], o2[1], o2[2], 0.02, 0.26 * big, 0.02, c(1, 0.7, 0.3, 0.8, 1, 0, true), 0, timeNow * 40);
  };
  if (tool === 'gun' && W.id === 'shotgun') {
    const G = VMC2.B, A = VMC2.A, D = VMC2.D, CY = VMC2.CY, pump = clamp((timeNow - (vm.lastFire || -9)) / 0.5, 0, 1);
    const pp = pump < 1 ? Math.sin(pump * Math.PI) : 0;
    G3('box', 0, 0, 0.02, 0.11, 0.12, 0.36, G);
    G3('box', -0.024, 0.025, -0.36, 0.045, 0.045, 0.52, D);
    G3('box', 0.024, 0.025, -0.36, 0.045, 0.045, 0.52, D);
    G3('box', 0, -0.035, -0.26 + pp * 0.08, 0.1, 0.055, 0.2, A);
    G3('box', 0, -0.035, 0.28, 0.08, 0.11, 0.2, G);
    G3('box', 0, -0.11 - reload * 0.08, 0.06, 0.05, 0.12, 0.07, D);
    G3('box', 0.057, 0.01, -0.04, 0.004, 0.03, 0.26, CY);
    G3('box', -0.057, 0.01, -0.04, 0.004, 0.03, 0.26, CY);
    vm.mz = off(0, 0.025, -0.66); vm.ej = off(0.08, 0.03, -0.05);
    flashFx();
  } else if (tool === 'gun' && W.id === 'sniper') {
    const G = VMC2.B, D = VMC2.D, CY = VMC2.CY;
    G3('box', 0, 0, 0.02, 0.08, 0.11, 0.5, G);
    G3('box', 0, 0.012, -0.5, 0.04, 0.04, 0.62, D);
    G3('box', 0, 0.012, -0.83, 0.06, 0.06, 0.06, CY);
    G3('box', 0, 0.1, -0.02, 0.055, 0.055, 0.3, D);
    G3('box', 0, 0.1, -0.18, 0.07, 0.07, 0.03, CY);
    G3('box', 0, 0.1, 0.14, 0.065, 0.065, 0.03, D);
    G3('box', 0, -0.03, 0.32, 0.065, 0.12, 0.2, G);
    G3('box', 0, -0.1 - reload * 0.1, -0.02, 0.05, 0.11, 0.07, D);
    for (let i = 0; i < 3; i++) G3('box', 0, 0.012, -0.3 - i * 0.12, 0.05, 0.05, 0.015, CY);
    vm.mz = off(0, 0.012, -0.88); vm.ej = off(0.07, 0.03, -0.02);
    flashFx();
  } else if (tool === 'gun' && W.id === 'rocket') {
    const G = VMC2.O, A = VMC2.A, D = VMC2.D, CY = VMC2.CY;
    G3('box', 0.03, 0.05, -0.18, 0.13, 0.13, 0.66, G);
    G3('box', 0.03, 0.05, -0.52, 0.155, 0.155, 0.05, A);
    G3('box', 0.03, 0.05, -0.3, 0.14, 0.14, 0.03, A);
    G3('box', 0.03, 0.05, 0.16, 0.155, 0.155, 0.05, D);
    G3('box', 0.03, -0.05, -0.08, 0.045, 0.11, 0.06, D);
    G3('box', 0.03, -0.05, -0.3, 0.045, 0.1, 0.05, D);
    G3('box', -0.05, 0.13, -0.22, 0.025, 0.06, 0.12, CY);
    if (p.ammo > 0 && reload < 0.5) G3('box', 0.03, 0.05, -0.53, 0.08, 0.08, 0.04, c(1, 0.45, 0.2, 1, 0.6));
    vm.mz = off(0.03, 0.05, -0.58); vm.ej = off(0.03, 0.05, 0.3);
    flashFx();
  } else if (tool === 'gun' && hasModel('blaster')) {
    const o = off(0.02, -0.07, 0.04);
    animStatic('blaster');
    V('blaster', o[0], o[1], o[2], 0.34, 0.34, 0.34, VMC.W, pk, rl);
    E.anim();
    vm.mz = off(0.02, 0.02, -0.2);
    vm.ej = off(0.06, 0.04, -0.02);
    if (vm.flash > 0) {
      const o2 = vm.mz;
      V('sphere', o2[0], o2[1], o2[2], 0.1, 0.1, 0.1, c(1, 0.85, 0.5, 0.95, 1, 0, true));
      V('box', o2[0], o2[1], o2[2], 0.26, 0.02, 0.02, c(1, 0.7, 0.3, 0.8, 1, 0, true), 0, timeNow * 40);
      V('box', o2[0], o2[1], o2[2], 0.02, 0.26, 0.02, c(1, 0.7, 0.3, 0.8, 1, 0, true), 0, timeNow * 40);
    }
  } else if (tool === 'gun') {
    const G = VMC.G, A = VMC.A, D = VMC.D, CY = VMC.CY;
    G3('box', 0, 0, 0, 0.085, 0.11, 0.42, G);
    G3('box', 0, 0.065, -0.02, 0.06, 0.03, 0.3, D);
    G3('box', 0, 0.092, 0.03, 0.03, 0.035, 0.05, D);
    G3('box', 0, 0.098, 0.03, 0.012, 0.012, 0.052, CY);
    G3('box', 0, -0.01, -0.33, 0.04, 0.04, 0.28, D);
    G3('box', 0, -0.02, -0.14, 0.092, 0.055, 0.15, A);
    G3('box', 0, -0.12 - reload * 0.1, -0.02, 0.05, 0.16, 0.08, D);
    G3('box', 0, -0.035, 0.25, 0.06, 0.09, 0.16, G);
    G3('box', 0.044, 0.012, -0.05, 0.004, 0.018, 0.22, CY);
    G3('box', -0.044, 0.012, -0.05, 0.004, 0.018, 0.22, CY);
    vm.mz = off(0, -0.01, -0.5);
    if (vm.flash > 0) {
      const o = vm.mz;
      V('sphere', o[0], o[1], o[2], 0.1, 0.1, 0.1, c(1, 0.85, 0.5, 0.95, 1, 0, true));
      V('box', o[0], o[1], o[2], 0.24, 0.02, 0.02, c(1, 0.7, 0.3, 0.8, 1, 0, true), 0, timeNow * 40);
      V('box', o[0], o[1], o[2], 0.02, 0.24, 0.02, c(1, 0.7, 0.3, 0.8, 1, 0, true), 0, timeNow * 40);
    }
  } else {
    const def = TRAP[tool], cc = CAT_COL[def.cat];
    const o1 = off(-0.03, 0.0, 0.02), o2 = off(-0.03, 0.004, 0.012), o3 = off(-0.03, 0.12 + Math.sin(timeNow * 3) * 0.01, -0.02);
    V('box', o1[0], o1[1], o1[2], 0.2, 0.13, 0.02, c(0.16, 0.17, 0.2), -0.55, 0.12);
    V('box', o2[0], o2[1], o2[2], 0.17, 0.1, 0.004, c(cc[0] * 0.55, cc[1] * 0.55, cc[2] * 0.55, 1, 0.6), -0.55, 0.12);
    V('oct', o3[0], o3[1], o3[2], 0.05, 0.07, 0.05, c(cc[0], cc[1], cc[2], 0.85, 1, 0, true), 0, timeNow * 2);
  }
  E.setLayer(0);
  void dt;
}

/* ============================================================
 * 瞄准：放置位 / 已有陷阱
 * ============================================================ */
let slotCache = null;
function computeAim() {
  const p = sim.s.players[PID];
  if (!p || p.dead) return null;
  const ex = cam.x, ey = cam.y, ez = cam.z, dx = cam.fx, dy = cam.fy, dz = cam.fz;
  const hit = sim.raycast(ex, ey, ez, dx, dy, dz, 20);
  const res = { hit, slot: null, can: null, trap: null };
  // 先找视线上的陷阱实体（高的炮台/塔）
  let best = null, bt = hit ? hit.t : 20;
  for (const tr of sim.s.traps) {
    if (tr.id === p.mount) continue;   // 自己坐着的炮塔不参与瞄准
    const def = TRAP[tr.type];
    const h = def.block ? 1.6 : def.cat === 'heavy' ? 1.5 : def.cat === 'hfloor' ? 0.3 : (def.cat === 'pad' ? 1.0 : (tr.kind === 'ceil' ? -1 : (tr.kind === 'wall' ? 0 : 0.3)));
    const r = def.block ? 1.0 : def.big ? 1.7 : (def.cat === 'pad' ? 0.9 : 0.75);
    const lx = tr.wx - ex, ly = h + tr.wy - ey, lz = tr.wz - ez;
    const tca = lx * dx + ly * dy + lz * dz;
    if (tca < 0 || tca > bt + 0.5) continue;
    const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
    if (d2 < r * r && tca < bt + 0.5) { bt = tca; best = tr; }
  }
  if (!best && hit) {
    const kinds = hit.kind === 'wall' ? [{ kind: 'wall', x: hit.x, z: hit.z, dir: hit.dir }] : [{ kind: hit.kind, x: hit.x, z: hit.z }];
    for (const k of kinds) { const t = sim.trapAtSlot(k); if (t && t.id !== p.mount) best = t; }
  }
  res.trap = best;
  if (tool !== 'gun') {
    const def = TRAP[tool];
    res.slot = sim.slotFromHit(def.cat, hit);
    res.can = sim.canBuild(PID, tool, res.slot);
  }
  return res;
}
function drawBuildOverlay() {
  if (!sim || tool === 'gun' || mode !== 'play') return;
  const def = TRAP[tool], cc = CAT_COL[def.cat];
  if (!slotCache) { slotCache = {}; for (const k of ['floor', 'pad', 'wall', 'ceil', 'heavy']) slotCache[k] = sim.listSlots(k); slotCache.hfloor = slotCache.floor; }
  const p = sim.s.players[PID];
  for (const sl of slotCache[def.cat]) {
    const big = def.cat === 'heavy', w = sim.trapWorld(big ? { type: tool, x: sl.x, z: sl.z, kind: 'floor' } : sl);
    if (Math.abs(w.x - p.x) > 22 || Math.abs(w.z - p.z) > 22) continue;
    if (big ? sim.trapAtSlot(sl, tool) : sim.trapAtSlot(sl)) continue;
    if (big) { E.push('box', w.x, w.y + 0.04, w.z, 0, T * 1.86, 0.01, T * 1.86, c(cc[0], cc[1], cc[2], 0.1, 1, 0, true)); continue; }
    if (sl.kind === 'wall') {
      const alongX = DIRS[sl.dir][1] !== 0;
      E.push('box', w.x - DIRS[sl.dir][0] * 0.03, w.y, w.z - DIRS[sl.dir][1] * 0.03, 0, alongX ? T * 0.8 : 0.02, 2.2, alongX ? 0.02 : T * 0.8, c(cc[0], cc[1], cc[2], 0.07, 1, 0, true));
    } else {
      const yy = sl.kind === 'ceil' ? w.y - 0.03 : w.y + 0.03;
      E.push('box', w.x, yy, w.z, 0, T * 0.86, 0.01, T * 0.86, c(cc[0], cc[1], cc[2], 0.07, 1, 0, true));
    }
  }
  if (aim && aim.slot) {
    const ok = aim.can && aim.can.ok;
    const gc = ok ? [0.35, 1.0, 0.55] : [1.0, 0.32, 0.32];
    const w = sim.trapWorld({ type: tool, kind: aim.slot.kind, x: aim.slot.x, z: aim.slot.z, dir: aim.slot.dir });
    if (def.big) E.push('box', w.x, w.y + 0.05, w.z, 0, T * 1.94, 0.02, T * 1.94, c(gc[0], gc[1], gc[2], 0.22, 1, 0, true));
    const ghost = { type: tool, kind: aim.slot.kind, x: aim.slot.x, z: aim.slot.z, dir: aim.slot.dir || 0, lv: 1, wx: w.x, wy: w.y, wz: w.z, activeT: 0, fireT: -9, disT: 0, laneGhost: sim.laneTurret(tool, aim.slot) };
    drawTrap(sim, ghost, gc);
    if (aim.slot.kind === 'wall') {
      for (const i of sim.wallLine(aim.slot.x, aim.slot.z, aim.slot.dir)) {
        const tx = i % sim.W, tz = Math.floor(i / sim.W);
        E.push('box', (tx + 0.5) * T, sim.tileH(tx, tz) + 0.04, (tz + 0.5) * T, 0, T * 0.9, 0.01, T * 0.9, c(gc[0], gc[1], gc[2], 0.16, 1, 0, true));
      }
    } else if (tool === 'crusher') {
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!sim.solid(aim.slot.x + dx, aim.slot.z + dz))
        E.push('box', (aim.slot.x + dx + 0.5) * T, sim.tileH(aim.slot.x + dx, aim.slot.z + dz) + 0.04, (aim.slot.z + dz + 0.5) * T, 0, T * 0.9, 0.01, T * 0.9, c(gc[0], gc[1], gc[2], 0.14, 1, 0, true));
    }
    const R = def.range ? (Array.isArray(def.range) ? def.range[0] : def.range) : 0;
    if (R) E.push('ring', w.x, w.y + 0.06, w.z, 0, R, 1, R, c(gc[0], gc[1], gc[2], 0.5, 1, 0, true));
  }
}

/* ============================================================
 * 事件 → 特效 / 音效 / HUD
 * ============================================================ */
function camLocal(o) {
  return [cam.x + cam.rx * o[0] + cam.ux * o[1] - cam.fx * o[2], cam.y + cam.uy * o[1] - cam.fy * o[2], cam.z + cam.rz * o[0] + cam.uz * o[1] - cam.fz * o[2]];
}
function muzzleWorld() {
  const o = vm.mz || [0.2, -0.25, -1.0];
  return [cam.x + cam.rx * o[0] + cam.ux * o[1] - cam.fx * o[2], cam.y + cam.uy * o[1] - cam.fy * o[2], cam.z + cam.rz * o[0] + cam.uz * o[1] - cam.fz * o[2]];
}
const tracers = [];
const strikeFx = [];
const shellFx = [];
function drawLava(S) {
  const lv = S.s.lava; if (!lv) return;
  let n = 0;
  for (const k in lv) {
    if (++n > 160) break;
    const left = lv[k], i = +k, tx = i % S.W, tz = Math.floor(i / S.W), cx = (tx + 0.5) * T, cz = (tz + 0.5) * T;
    const a = clamp(left / 3, 0, 1), fl = 0.75 + 0.25 * Math.sin(timeNow * 4 + i);
    E.push('box', cx, 0.035, cz, 0, T * 0.98, 0.04, T * 0.98, c(0.9, 0.22 * fl + 0.08, 0.03, 0.6 * a, 0.55, 0, false));
    if (Math.random() < 0.05 * a) particle({ x: cx + rnd(-1, 1), y: 0.1, z: cz + rnd(-1, 1), vy: rnd(0.8, 2), life: 0.7, s0: 0.12, s1: 0, c: [1, 0.55, 0.15], grav: 2 });
    if (n % 9 === 0 && a > 0.3) flashLight(cx, 0.6, cz, 6, [1, 0.45, 0.1], 0.8 * a, 0.02);
  }
}
function drawShells(dt) {
  for (let i = shellFx.length - 1; i >= 0; i--) {
    const f = shellFx[i]; f.t += dt;
    if (f.t >= f.T) { shellFx.splice(i, 1); continue; }
    if (f.gy === undefined) f.gy = S_cur ? S_cur.floorH(f.tx, f.tz) : 0;
    const top = S_cur && S_cur.outdoor ? 60 : WALL_H - 0.3;
    const k = f.t / f.T, x = lerp(f.x, f.tx, k), z = lerp(f.z, f.tz, k), y = Math.min(top, lerp(f.y || 4.2, f.gy + 0.4, k) + Math.sin(k * Math.PI) * (f.k === 't' ? 2.2 : 5));
    const pc = f.k === 'm' ? [0.6, 0.45, 1] : f.k === 't' ? [1, 0.8, 0.35] : [1, 0.6, 0.25], R = f.k === 'm' ? 3.8 : f.k === 't' ? 2.2 : 2.6;
    E.push('sphere', x, y, z, 0, f.k === 'm' ? 0.55 : 0.35, f.k === 'm' ? 0.55 : 0.35, f.k === 'm' ? 0.55 : 0.35, c(pc[0], pc[1], pc[2], 1, 1, 0, true));
    particle({ x, y, z, vy: 0.3, life: 0.6, s0: 0.25, s1: 0.7, c: f.k === 'm' ? [0.55, 0.45, 0.9] : [0.5, 0.48, 0.45], add: f.k === 'm', a0: 0.4 });
    E.push('ring', f.tx, f.gy + 0.06, f.tz, timeNow * 3, R * (1.2 - k * 0.3), 1, R * (1.2 - k * 0.3), f.k === 'm' ? c(0.6, 0.45, 1, 0.8, 1, 0, true) : c(1, 0.35, 0.2, 0.8, 1, 0, true));
  }
  // 轨道电磁炮的贯穿光束
  for (let i = railFx.length - 1; i >= 0; i--) {
    const f = railFx[i]; f.t += dt;
    if (f.t >= 0.5) { railFx.splice(i, 1); continue; }
    const k = 1 - f.t / 0.5;
    E.pushBeam('box', f.x1, f.y1, f.z1, f.x2, f.y2, f.z2, 0.12 * k + 0.02, 0.12 * k + 0.02, c(0.9, 0.97, 1, k, 1, 0, true));
    E.pushBeam('box', f.x1, f.y1, f.z1, f.x2, f.y2, f.z2, 0.7 * k, 0.7 * k, c(0.35, 0.7, 1, 0.3 * k, 1, 0, true));
    for (let j = 0; j < 4; j++) { const u = (f.t * 3 + j / 4) % 1; E.push('ring', lerp(f.x1, f.x2, u), lerp(f.y1, f.y2, u), lerp(f.z1, f.z2, u), 0, 0.45 * k, 1, 0.45 * k, c(0.6, 0.85, 1, 0.6 * k, 1, 0, true)); }
  }
  // 相位行者瞬移残影
  for (let i = blinkFx.length - 1; i >= 0; i--) {
    const f = blinkFx[i]; f.t += dt;
    if (f.t >= 0.6) { blinkFx.splice(i, 1); continue; }
    const k = 1 - f.t / 0.6;
    E.pushBeam('box', f.x, 1.0, f.z, f.x2, 1.0, f.z2, 0.5 * k, 1.6 * k, c(0.6, 0.4, 1, 0.25 * k, 1, 0, true));
    E.push('sphere', f.x, 1.0, f.z, 0, 1.2 * k, 2 * k, 1.2 * k, c(0.6, 0.4, 1, 0.3 * k, 1, 0, true));
  }
  // 棱盾守卫的护盾脉冲
  for (let i = auraFx.length - 1; i >= 0; i--) {
    const f = auraFx[i]; f.t += dt;
    if (f.t >= 0.7) { auraFx.splice(i, 1); continue; }
    const k = f.t / 0.7;
    E.push('ring', f.x, 0.15 + k * 0.6, f.z, 0, f.r * k, 1, f.r * k, c(0.4, 0.85, 1, 0.8 * (1 - k), 1, 0, true));
  }
  // 燃烧弹的火海
  for (let i = fireFx.length - 1; i >= 0; i--) {
    const f = fireFx[i]; f.t += dt;
    if (f.t >= 4) { fireFx.splice(i, 1); continue; }
    const k = f.t < 3.4 ? 1 : (4 - f.t) / 0.6;
    E.push('disc', f.x, 0.05, f.z, 0, 3.6, 1, 3.6, c(1, 0.4, 0.1, 0.22 * k, 1, 0, true));
    if (Math.random() < 0.8 * k) particle({ x: f.x + rnd(-3, 3), y: 0.2, z: f.z + rnd(-3, 3), vy: rnd(1, 2.5), life: rnd(0.4, 0.8), s0: rnd(0.2, 0.4), s1: 0.6, c: [1, rnd(0.35, 0.6), 0.1], drag: 1, a0: 0.7 });
  }
}
const railFx = [], blinkFx = [], auraFx = [], fireFx = [];
function drawStrikes(dt) {
  for (let i = strikeFx.length - 1; i >= 0; i--) {
    const f = strikeFx[i];
    if (f.hit !== undefined) {
      f.hit += dt;
      if (f.hit > 0.7) { strikeFx.splice(i, 1); continue; }
      const k = 1 - f.hit / 0.7, R = SKILL.ult.r * 0.55 * k + 0.3;
      E.pushBeam('cyl', f.x, 0, f.z, f.x, 60, f.z, R, R, c(0.6, 0.92, 1, k, 1, 0, true));
      E.pushBeam('cyl', f.x, 0, f.z, f.x, 60, f.z, R * 2.2, R * 2.2, c(0.4, 0.75, 1, k * 0.3, 1, 0, true));
      continue;
    }
    f.t += dt;
    if (f.t > f.delay + 2) { strikeFx.splice(i, 1); continue; }
    const k = clamp(f.t / f.delay, 0, 1), R = SKILL.ult.r;
    E.push('ring', f.x, 0.06, f.z, timeNow * 2, R * (1.2 - 0.25 * k), 1, R * (1.2 - 0.25 * k), c(1, 0.35, 0.3, 0.9, 1, 0, true));
    E.push('ring', f.x, 0.07, f.z, -timeNow * 3, R * 0.25 + R * (1 - k) * 0.6, 1, R * 0.25 + R * (1 - k) * 0.6, c(1, 0.6, 0.4, 0.8, 1, 0, true));
    E.pushBeam('box', f.x, 0, f.z, f.x, 60, f.z, 0.05 + k * 0.12, 0.05 + k * 0.12, c(1, 0.4, 0.35, 0.5 + 0.5 * k, 1, 0, true));
    if (Math.random() < 0.5) particle({ x: f.x + rnd(-R, R), y: 0.1, z: f.z + rnd(-R, R), vy: rnd(1, 3), life: 0.6, s0: 0.08, s1: 0, c: [1, 0.5, 0.4], grav: 0 });
  }
}
const rings = [];
const corpses = [];
const decals = [];
const buildFx = new Map();
let bossFx = null;
const portalFlare = { A: 0, B: 0 };
function addCorpse(e) {
  const yaw = Math.atan2(-(e.fx || 0), -(e.fz === undefined ? 1 : e.fz));
  const RT = { grunt: [1, [0.85, 0.85, 0.85]], brute: [1.45, [0.5, 0.56, 0.72]], stalker: [0.92, [0.34, 0.27, 0.5]], sapper: [0.92, [1, 0.8, 0.32]], gunner: [1.05, [0.95, 0.42, 0.38]] }[e.mtype];
  if (RT && hasModel('robot')) {
    corpses.push({ kind: 'robot', x: e.x, z: e.z, yaw, s: RT[0], tint: RT[1], t: 0 });
    return true;
  }
  if (e.mtype === 'runner' && hasModel('fox')) {
    corpses.push({ kind: 'fox', x: e.x, z: e.z, yaw, s: 1, tint: [0.62, 0.48, 0.48], t: 0, ph: Math.random(), side: Math.random() < 0.5 ? -1 : 1 });
    return true;
  }
  return false;
}
function drawCorpses(dt) {
  while (corpses.length > 45) corpses.shift();
  for (let i = corpses.length - 1; i >= 0; i--) {
    const k = corpses[i]; k.t += dt;
    if (k.t > 3.9) { corpses.splice(i, 1); continue; }
    const sink = Math.max(0, k.t - 2.4) * 1.1;
    const glow = k.t > 2.4 ? Math.min(1, (k.t - 2.4) * 2) * 0.35 : 0;
    if (k.kind === 'robot') {
      animClip('robot', 'death', k.t);
      E.push('robot', k.x, -sink * k.s, k.z, k.yaw, k.s, k.s, k.s, c(k.tint[0], k.tint[1], k.tint[2], 1, 0, glow * 0.4));
    } else {
      animClip('fox', 'run', k.ph);
      const r = Math.min(1, k.t / 0.3) * Math.PI / 2 * k.side;
      E.pushR('fox', k.x, Math.abs(Math.sin(r)) * 0.16 - sink, k.z, k.yaw, 0, r, 1, 1, 1, c(k.tint[0], k.tint[1], k.tint[2], 1, 0, glow * 0.4));
    }
    E.anim();
    if (k.t > 2.3 && Math.random() < 0.5) particle({ x: k.x + rnd(-0.6, 0.6) * k.s, y: rnd(0.05, 0.5), z: k.z + rnd(-0.6, 0.6) * k.s, vy: rnd(0.8, 1.8), life: 0.7, s0: 0.07, s1: 0, c: [0.4, 0.9, 1], grav: 0 });
  }
}
function addDecal(e) {
  if (decals.length > 80) decals.shift();
  decals.push({ x: e.x, y: e.y, z: e.z, hk: e.hk, dir: e.dir, t: 0, s: rnd(0.16, 0.24), r: Math.random() * 6 });
}
function drawDecals(dt) {
  for (let i = decals.length - 1; i >= 0; i--) {
    const d = decals[i]; d.t += dt;
    if (d.t > 12) { decals.splice(i, 1); continue; }
    const a = d.t > 10 ? (12 - d.t) / 2 : 1, hot = Math.max(0, 1 - d.t / 0.6);
    let yaw = d.r, pitch = 0, x = d.x, y = d.y, z = d.z;
    if (d.hk === 'floor' || d.hk === 'deck') y = d.y + 0.012;
    else if (d.hk === 'ceil') y = d.y - 0.012;
    else if ((d.hk === 'wall' || d.hk === 'cliff') && d.dir >= 0) { const nx = -DIRS[d.dir][0], nz = -DIRS[d.dir][1]; yaw = Math.atan2(nx, nz); pitch = Math.PI / 2; x += nx * 0.015; z += nz * 0.015; }
    E.pushR('disc', x, y, z, yaw, pitch, d.r, d.s, 1, d.s, c(0.03, 0.03, 0.035, 0.7 * a));
    if (hot > 0) E.pushR('disc', x, y, z, yaw, pitch, d.r, d.s * 0.55, 1, d.s * 0.55, c(1, 0.55, 0.15, hot, 1, 0, true));
  }
}
function explode(x, y, z, r, small) {
  const big = !small;
  for (let i = 0; i < (big ? 26 : 10); i++) particle({ x, y, z, vx: rnd(-1, 1) * (big ? 6 : 3), vy: rnd(-0.5, 1) * (big ? 6 : 3), vz: rnd(-1, 1) * (big ? 6 : 3), life: rnd(0.3, 0.6), s0: big ? 0.8 : 0.4, s1: 0.1, c: [1, rnd(0.4, 0.7), 0.15], drag: 3, grav: -1 });
  for (let i = 0; i < (big ? 10 : 4); i++) particle({ x: x + rnd(-1, 1), y: y + rnd(0, 1), z: z + rnd(-1, 1), vy: rnd(0.5, 1.5), life: rnd(0.8, 1.4), s0: 0.6, s1: big ? 2.2 : 1.2, c: [0.25, 0.24, 0.24], add: false, a0: 0.5 });
  if (big) for (let i = 0; i < 8; i++) particle({ x, y, z, vx: rnd(-1, 1) * 9, vy: rnd(2, 8), vz: rnd(-1, 1) * 9, life: rnd(0.6, 1.0), s0: 0.08, s1: 0.02, c: [1, 0.8, 0.4], grav: 14, bounce: true });
  particle({ x, y, z, life: 0.18, s0: big ? 1.2 : 0.6, s1: big ? r * 2.2 : r * 1.4, c: [1, 0.75, 0.4], a0: 0.9, drag: 0 });
  flashLight(x, y + 1, z, big ? 14 : 7, [1, 0.6, 0.25], big ? 2.5 : 1.3, 0.25);
  if (big) { rings.push({ x, z, y: 0.15, r0: 0.5, r1: r * 1.5, t: 0, life: 0.4, c: [1, 0.6, 0.25] }); const d = Math.hypot(x - cam.x, z - cam.z); if (d < 14) shake(0.4 * (1 - d / 14)); }
  Snd.play(big ? 'boom' : 'boomS', x, z);
}
function updateBossFx(dt) {
  if (!bossFx) return;
  const b = bossFx; b.t += dt;
  if (b.t < 1.7) {
    while (b.next < b.t) { explode(b.x + rnd(-2.2, 2.2), rnd(1, 6), b.z + rnd(-2.2, 2.2), 2.5, Math.random() < 0.5); b.next += 0.13; }
    if (b.m) { b.m.ox = b.m.x; b.m.oz = b.m.z; b.m.oy = b.m.y = -Math.max(0, b.t - 0.6) * 2.2; b.m.hitT = Math.random() < 0.4 ? 0.1 : 0; b.m.state = 'queue'; drawMonster(b.m, 1); }
  } else {
    explode(b.x, 3, b.z, 7, false);
    for (let i = 0; i < 70; i++) particle({ x: b.x + rnd(-2, 2), y: rnd(0.5, 6), z: b.z + rnd(-2, 2), vx: rnd(-7, 7), vy: rnd(3, 11), vz: rnd(-7, 7), life: rnd(1, 2), s0: rnd(0.2, 0.5), s1: 0.1, c: [0.32, 0.33, 0.38], g: 'box', grav: 16, bounce: true, add: false, drag: 0.4 });
    rings.push({ x: b.x, z: b.z, y: 0.2, r0: 1, r1: 18, t: 0, life: 0.7, c: [1, 0.7, 0.4] });
    flashLight(b.x, 4, b.z, 34, [1, 0.7, 0.4], 3.5, 1.2);
    shake(1.2);
    bossFx = null;
  }
}
function handleEvents(S) {
  for (const e of S.drainEvents()) {
    switch (e.type) {
      case 'shot': {
        const W = WPN[e.w] || WPN.rifle;
        if (e.pid === PID) {
          const mz = muzzleWorld();
          if (timeNow - (vm.lastFire || 0) > 0.04) {
            vm.lastFire = timeNow;
            const kick = { rifle: 0.004, shotgun: 0.045, sniper: 0.06, rocket: 0.05, gatling: 0.0022 }[W.id] || 0.004;
            vm.kick = Math.min(1, vm.kick + 0.4 * W.kick + (W.id !== 'rifle' && W.id !== 'gatling' ? 0.5 : 0)); vm.flash = W.id === 'rifle' || W.id === 'gatling' ? 0.045 : 0.08;
            cam.pitch = clamp(cam.pitch + kick * (1 - cam.ads * 0.5), -1.5, 1.5); cam.yaw += rnd(-0.0015, 0.0015) * (W.id === 'rifle' ? 1 : W.id === 'gatling' ? 2 : 6);
            flashLight(mz[0], mz[1], mz[2], W.id === 'rifle' || W.id === 'gatling' ? 7 : 11, [1, 0.75, 0.4], W.id === 'gatling' ? 0.7 : W.id === 'rifle' ? 1.4 : 2.4, 0.06);
            Snd.play(W.id === 'gatling' ? 'gatling' : W.id === 'rifle' ? 'shot' : W.id === 'shotgun' ? 'shotgun' : W.id === 'sniper' ? 'sniper' : 'rocketFire');
            if (W.id === 'gatling') shake(0.035); else if (W.id !== 'rifle') shake(W.id === 'shotgun' ? 0.12 : 0.18);
            if (W.id === 'rocket') for (let i = 0; i < 10; i++) particle({ x: mz[0], y: mz[1], z: mz[2], vx: -cam.fx * rnd(1, 4) + rnd(-1, 1), vy: rnd(0, 1.5), vz: -cam.fz * rnd(1, 4) + rnd(-1, 1), life: rnd(0.5, 1), s0: 0.2, s1: 0.9, c: [0.6, 0.6, 0.62], add: false, a0: 0.4 });
          }
          if (W.id === 'sniper') tracers.push({ x1: mz[0], y1: mz[1], z1: mz[2], x2: e.x, y2: e.y, z2: e.z, t: 0, life: 0.35, c: [0.45, 0.9, 1], w: 3 });
          else if (W.id !== 'rocket') tracers.push({ x1: mz[0], y1: mz[1], z1: mz[2], x2: e.x, y2: e.y, z2: e.z, t: 0, life: W.id === 'shotgun' ? 0.09 : 0.07 });
        }
        if (e.pid === PID && W.id !== 'rocket' && (W.id !== 'gatling' || (vm.ejN = (vm.ejN || 0) + 1) % 4 === 0)) {
          const ej = camLocal(W.id === 'gatling' ? [0.3, -0.42, -0.7] : vm.ej || [0.26, -0.18, -0.5]);
          particle({ x: ej[0], y: ej[1], z: ej[2], vx: cam.rx * rnd(1.6, 2.6) + rnd(-0.3, 0.3), vy: rnd(1.4, 2.4), vz: cam.rz * rnd(1.6, 2.6) + rnd(-0.3, 0.3), life: 1.0, s0: 0.035, s1: 0.035, c: [0.95, 0.7, 0.28], g: 'box', add: false, grav: 13, bounce: true, drag: 0.2 });
        }
        if (e.wall) { burst(e.x, e.y, e.z, 6, { c: [1, 0.8, 0.45], sp0: 1.5, sp1: 5, l0: 0.1, l1: 0.35, s0: 0.05, grav: 12 }); addDecal(e); particle({ x: e.x, y: e.y, z: e.z, vy: 0.4, life: 0.5, s0: 0.12, s1: 0.5, c: [0.5, 0.5, 0.52], add: false, a0: 0.35 }); }
        break;
      }
      case 'hit': {
        if (e.pid !== PID) break;
        const hc = { grunt: [1, 0.7, 0.25], brute: [1, 0.6, 0.2], runner: [1, 0.3, 0.25], flyer: [0.8, 0.5, 1], healer: [0.4, 1, 0.5], bomber: [1, 0.55, 0.1], elite: [1, 0.35, 0.3], boss: [0.5, 0.9, 1], stalker: [0.8, 0.5, 1], burrower: [0.85, 0.6, 0.3], sapper: [1, 0.8, 0.3], gunner: [1, 0.4, 0.3], mite: [0.9, 0.4, 1], siege: [1, 0.7, 0.3], colossus: [1, 0.5, 0.1], brood: [0.95, 0.4, 1], broodling: [0.95, 0.4, 1] }[e.mtype] || [0.3, 1, 0.85];
        burst(e.x, e.y, e.z, e.head ? 9 : 5, { c: e.head ? [1, 0.9, 0.4] : hc, sp0: 1.5, sp1: 6, l0: 0.15, l1: 0.35, s0: 0.07, grav: 10 });
        floatNum(e.x, e.y + 0.2, e.z, String(e.dmg), e.head ? 'head' : '');
        hitMarker(e.kill ? 'kill' : (e.head ? 'head' : ''));
        Snd.play(e.head ? 'head' : 'tick');
        break;
      }
      case 'kill': {
        const def = MON[e.mtype];
        const pal = { grunt: [0.36, 0.38, 0.32], runner: [0.42, 0.24, 0.2], brute: [0.36, 0.38, 0.43], flyer: [0.6, 0.35, 0.9], bomber: [1, 0.5, 0.1], elite: [0.3, 0.25, 0.3], boss: [0.4, 0.42, 0.48], burrower: [0.5, 0.36, 0.25], mite: [0.4, 0.2, 0.5], siege: [0.44, 0.42, 0.33], colossus: [0.3, 0.2, 0.15], brood: [0.4, 0.2, 0.45], broodling: [0.4, 0.2, 0.45] }[e.mtype] || [0.4, 0.4, 0.4];
        const hasCorpse = addCorpse(e);
        if (def.boss) { const bm = S._mById.get(e.id) || (S._gone && S._gone.get(e.id)); bossFx = { x: e.x, z: e.z, t: 0, next: 0, m: bm ? Object.assign({}, bm) : null }; slowmoT = 1.9; }
        if (e.mtype === 'flyer' || e.mtype === 'healer') explode(e.x, e.y, e.z, 1.6, true);
        if (def.elite) explode(e.x, 1.5, e.z, 4, false);
        const n = def.boss ? 0 : (def.elite ? 30 : (hasCorpse ? 0 : 10));
        for (let i = 0; i < n; i++) particle({ x: e.x + rnd(-0.4, 0.4) * def.r * 2, y: e.y + rnd(0.3, 1.6) * (def.boss ? 3 : 1), z: e.z + rnd(-0.4, 0.4) * def.r * 2, vx: rnd(-4, 4), vy: rnd(2, 7), vz: rnd(-4, 4), life: rnd(0.8, 1.6), s0: rnd(0.1, 0.25) * (def.boss ? 2.5 : 1), s1: 0.05, c: pal, g: 'box', grav: 16, bounce: true, add: false, drag: 0.6 });
        burst(e.x, e.y + 1, e.z, hasCorpse ? 10 : 6, { c: hasCorpse ? [1, 0.75, 0.3] : [1, 0.35, 0.2], sp0: 1, sp1: 4, l0: 0.2, l1: 0.4, s0: hasCorpse ? 0.08 : 0.3, s1: 0.02 });
        if (e.bounty) floatNum(e.x, e.y + (def.fly ? 0.6 : 2.0), e.z, '+' + e.bounty, 'gold');
        if (e.pid === PID) { Snd.play('kill', e.x, e.z); if (MP.role === 'client') hitMarker('kill'); }
        if (def.elite) feed(`精英「${def.name}」已被击杀`, 'good');
        if (def.boss) { feed(`BOSS「${def.name}」被击败！`, 'good'); shake(0.6); Snd.play('boom'); }
        break;
      }
      case 'core': {
        crystalHitT = 0.6; alarm();
        const cp = S.crystalPos;
        burst(cp.x, 2.6, cp.z, 18, { c: [1, 0.3, 0.3], sp0: 2, sp1: 8, s0: 0.2 });
        feed(`${MON[e.mtype].name} 冲击水晶 -${e.dmg}`, 'bad');
        Snd.play('core');
        if (e.mtype === 'boss') shake(1);
        break;
      }
      case 'build': case 'upgrade': {
        if (e.type === 'upgrade' && e.br && TRAP[e.trap] && EVO[e.trap]) feed(`${TRAP[e.trap].name} 进阶为「${EVO[e.trap][e.br].name}」`, 'good');
        if (e.type === 'build') buildFx.set(e.id, timeNow);
        else for (let k = 0; k < 3; k++) rings.push({ x: e.x, z: e.z, y: e.y + 0.1 - k * 0.5, vy: 3.2, r0: 1.0, r1: 1.0, t: -k * 0.08, life: 0.55, c: [0.37, 0.89, 1] });
        burst(e.x, e.y + 0.5, e.z, 14, { c: e.type === 'build' ? [0.4, 1, 0.75] : [0.37, 0.89, 1], sp0: 1, sp1: 4, l0: 0.3, l1: 0.6, s0: 0.12, grav: -2 });
        Snd.play(e.type, e.x, e.z);
        break;
      }
      case 'devUse': {
        const dv = S.def.devices && S.def.devices[e.i]; if (!dv) break;
        const q = S.s.players[e.pid];
        feed(`${e.pid === PID ? '你' : (q ? q.name : '队友')} 启动了「${devName(dv)}」`, 'good');
        const w = S.deviceWorld(dv);
        Snd.play('device', w.x, w.z, { range: 120 });
        if (dv.type === 'gate') setTimeout(() => Snd.play('stomp', (dv.area[0] + 1.5) * T, dv.area[1] * T, { range: 90 }), 300);
        break;
      }
      case 'research': {
        const t = TD.TECH_BY[e.tech]; if (!t) break;
        const q = S.s.players[e.pid], who = e.pid === PID ? '你' : (q ? q.name : '队友');
        feed(`${who} 研究了「${t.name}」Lv${e.lv}：${t.desc(e.lv)}`, 'good');
        if (e.pid !== PID) toast(`${who} 研究了 ${t.name} Lv${e.lv}`);
        const ti = TD.TECH.indexOf(t);
        for (const lb of S.def.labs || []) {
          const r = S.labObj(lb.racks[ti]), tc = TECH_COL[ti];
          burst(r.x, 1.6, r.z, 18, { c: tc, sp0: 1, sp1: 4, l0: 0.4, l1: 0.8, s0: 0.1, grav: -3 });
          for (let k = 0; k < 3; k++) rings.push({ x: r.x, z: r.z, y: 0.2 + k * 0.6, vy: 2.5, r0: 0.5, r1: 1.2, t: -k * 0.1, life: 0.6, c: tc });
          const h = labHolo(S, lb); flashLight(h.x, 2, h.z, 10, tc, 2, 0.4);
          Snd.play('research', r.x, r.z, { range: 60 });
        }
        if (e.pid !== PID) Snd.play('research');
        cache.lab = '';
        break;
      }
      case 'resupply': {
        if (e.pid === PID) { feed('补给完成：生命、手雷、弹药已补满，轨道打击充能 +25%', 'good'); Snd.play('resupply'); }
        const q = S.s.players[e.pid];
        if (q) burst(q.x, 1.2, q.z, 16, { c: [0.4, 1, 0.6], sp0: 0.5, sp1: 2.5, l0: 0.4, l1: 0.8, s0: 0.1, grav: -3 });
        break;
      }
      case 'combo': {
        if (e.k === 'napalm') { fireFx.push({ x: e.x, z: e.z, t: 0 }); break; }
        const C = { shatter: ['碎冰 ×2', [0.6, 0.9, 1]], ignite: ['爆燃！', [1, 0.5, 0.15]], air: ['空中连击', [1, 0.8, 0.3]], spread: ['毒素扩散', [0.4, 1, 0.4]] }[e.k];
        if (!C) break;
        floatNum(e.x, e.y + 0.8, e.z, C[0], 'combo');
        if (e.k === 'ignite') { explode(e.x, e.y, e.z, 2.4, true); rings.push({ x: e.x, z: e.z, y: 0.2, r0: 0.4, r1: 2.6, t: 0, life: 0.35, c: [1, 0.55, 0.2] }); }
        if (e.k === 'shatter') { for (let i = 0; i < 14; i++) particle({ x: e.x + rnd(-1.5, 1.5), y: rnd(0.2, 1.4), z: e.z + rnd(-1.5, 1.5), vx: rnd(-4, 4), vy: rnd(1, 5), vz: rnd(-4, 4), life: rnd(0.4, 0.8), s0: rnd(0.08, 0.18), s1: 0.03, c: [0.75, 0.92, 1], g: 'box', grav: 12, bounce: true }); Snd.play('shatter', e.x, e.z); }
        if (e.k === 'spread') burst(e.x, 0.5, e.z, 10, { c: [0.4, 1, 0.4], sp0: 1, sp1: 3, s0: 0.2, s1: 0.5, l0: 0.4, l1: 0.8, grav: -0.5, a0: 0.4 });
        break;
      }
      case 'sell': burst(e.x, e.y + 0.5, e.z, 10, { c: [1, 0.75, 0.3], sp0: 1, sp1: 3, s0: 0.1, grav: -1 }); Snd.play('sell', e.x, e.z); break;
      case 'trap': {
        switch (e.kind) {
          case 'freeze': for (let i = 0; i < 12; i++) particle({ x: e.x + rnd(-1, 1), y: rnd(0.1, 1), z: e.z + rnd(-1, 1), vy: rnd(0.5, 2), life: 0.8, s0: 0.12, s1: 0, c: [0.7, 0.92, 1], grav: 0 }); break;
          case 'spike': burst(e.x, 0.4, e.z, 5, { c: [0.35, 1, 0.4], sp0: 0.5, sp1: 2, s0: 0.25, s1: 0.5, l0: 0.4, l1: 0.8, grav: -0.5, a0: 0.3 }); break;
          case 'push': burst(e.x, 0.3, e.z, 8, { c: [1, 0.7, 0.3], sp0: 2, sp1: 5, s0: 0.1 }); break;
          case 'tesla': flashLight(e.x, 2.8, e.z, 8, [0.7, 0.45, 1], 1.6, 0.12); break;
          case 'aa': burst(e.x, 2.2, e.z, 6, { c: [0.7, 0.7, 0.7], sp0: 0.5, sp1: 2, s0: 0.3, s1: 0.8, add: false, a0: 0.4, grav: -1 }); break;
          case 'crusher': {
            burst(e.x, 0.3, e.z, 16, { c: [0.6, 0.58, 0.55], sp0: 3, sp1: 7, s0: 0.25, s1: 0.6, add: false, a0: 0.45, grav: 2, l0: 0.4, l1: 0.9 });
            rings.push({ x: e.x, z: e.z, y: 0.1, r0: 0.5, r1: 4, t: 0, life: 0.35, c: [1, 0.75, 0.4] });
            const d = Math.hypot(e.x - cam.x, e.z - cam.z); if (d < 12) shake(0.25 * (1 - d / 12));
            break;
          }
        }
        Snd.play(e.kind, e.x, e.z);
        break;
      }
      case 'tshot': {
        const tr = findTrap(e.id);
        if (tr) {
          const yaw = tr.cAim || 0, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
          tracers.push({ x1: tr.wx + fx, y1: tr.wy + 1.35, z1: tr.wz + fz, x2: e.x, y2: e.y, z2: e.z, t: 0, life: 0.05, c: [1, 0.75, 0.35] });
          burst(e.x, e.y, e.z, 2, { c: [1, 0.8, 0.4], sp0: 1, sp1: 3, s0: 0.05, l0: 0.1, l1: 0.2 });
        }
        Snd.play('tshot', e.x, e.z);
        break;
      }
      case 'boom': explode(e.x, e.y, e.z, e.r, e.small); break;
      case 'trapBroken': {
        burst(e.x, 1.5, e.z, 20, { c: [0.7, 0.5, 1], sp0: 2, sp1: 7, s0: 0.15, g: 'box' });
        feed(`${TRAP[e.trap].name} 被摧毁`, 'bad');
        Snd.play('broken', e.x, e.z);
        break;
      }
      case 'waveStart': {
        portalFlare.A = portalFlare.B = 2;
        const total = e.total;
        banner(e.boss ? `第 ${e.wave} / ${total} 波 · 终局` : `第 ${e.wave} / ${total} 波`, e.name + (e.tip ? ' — ' + e.tip : ''), e.boss);
        feed(`第 ${e.wave} 波「${e.name}」来袭，共 ${e.count} 只` + (e.bonus ? `，提前开战 +${e.bonus} 金币` : ''), '');
        Snd.play('wave');
        break;
      }
      case 'waveClear': banner(`第 ${e.wave} 波 清除`, `波次奖励 +${e.bonus} 金币 · 布防阶段 30 秒`, false, 'clear'); Snd.play('clear'); break;
      case 'boss': { const bd = MON[e.mtype] || MON.boss; feed(`BOSS「${bd.name}」出现在${e.laneName || ''}出怪口！`, 'bad'); if (TD.BOSS_TIP && TD.BOSS_TIP[e.mtype]) feed(TD.BOSS_TIP[e.mtype], 'bad'); Snd.play('boss'); shake(0.4); break; }
      case 'burrow': case 'surface': {
        const m = S._mById.get(e.id), x = m ? m.x : e.x, z = m ? m.z : e.z;
        for (let i = 0; i < 14; i++) particle({ x: x + rnd(-0.7, 0.7), y: 0.2, z: z + rnd(-0.7, 0.7), vx: rnd(-3, 3), vy: rnd(2, 6), vz: rnd(-3, 3), life: rnd(0.5, 0.9), s0: rnd(0.08, 0.2), s1: 0.05, c: [0.35, 0.27, 0.2], g: 'box', grav: 14, bounce: true, add: false });
        rings.push({ x, z, y: 0.08, r0: 0.4, r1: 2.2, t: 0, life: 0.35, c: [0.7, 0.5, 0.3] });
        Snd.play('burrow', x, z);
        break;
      }
      case 'hacked': {
        burst(e.x, e.y + 0.6, e.z, 16, { c: [0.3, 1, 0.5], sp0: 1, sp1: 4, s0: 0.08, l0: 0.3, l1: 0.6 });
        feed(`${TRAP[e.trap] ? TRAP[e.trap].name : '陷阱'} 被骇客工兵骇入，瘫痪 10 秒`, 'bad');
        Snd.play('hack', e.x, e.z, { range: 60 });
        break;
      }
      case 'mshot': {
        burst(e.x, e.y, e.z, 4, { c: [1, 0.4, 0.3], sp0: 1, sp1: 3, s0: 0.1, l0: 0.08, l1: 0.18, grav: 0 });
        flashLight(e.x, e.y, e.z, 5, [1, 0.35, 0.25], 1.1, 0.05);
        Snd.play('mshot', e.x, e.z);
        break;
      }
      case 'boltHit': burst(e.x, e.y, e.z, 6, { c: [1, 0.45, 0.3], sp0: 1, sp1: 4, s0: 0.1, l0: 0.1, l1: 0.3 }); break;
      case 'shellFire': shellFx.push({ x: e.x, z: e.z, tx: e.tx, tz: e.tz, t: 0, T: e.t || 1.3, k: e.k || '', y: e.y || 4.2 }); Snd.play(e.k === 'm' ? 'mortar' : 'shellFire', e.x, e.z, { range: 90 }); break;
      case 'rail': {
        railFx.push({ x1: e.x, y1: e.y, z1: e.z, x2: e.x2, y2: e.y2, z2: e.z2, t: 0 });
        burst(e.x2, e.y2, e.z2, 10, { c: [0.6, 0.85, 1], sp0: 2, sp1: 6, s0: 0.12, l0: 0.2, l1: 0.5 });
        burst(e.x, e.y, e.z, 8, { c: [0.7, 0.9, 1], sp0: 1, sp1: 4, s0: 0.18, l0: 0.15, l1: 0.35 });
        Snd.play('rail', e.x, e.z, { range: 110 });
        const d = Math.hypot(e.x - cam.x, e.z - cam.z); if (d < 10) shake(0.15 * (1 - d / 10));
        break;
      }
      case 'blink': blinkFx.push({ x: e.x, z: e.z, x2: e.x2, z2: e.z2, t: 0 }); burst(e.x2, 1, e.z2, 10, { c: [0.65, 0.45, 1], sp0: 1, sp1: 4, s0: 0.15, l0: 0.2, l1: 0.5 }); Snd.play('blink', e.x2, e.z2); break;
      case 'aura': auraFx.push({ x: e.x, z: e.z, r: e.r || 6, t: 0 }); Snd.play('aura', e.x, e.z); break;
      case 'shieldBreak': burst(e.x, e.y, e.z, 12, { c: [0.45, 0.85, 1], sp0: 2, sp1: 5, s0: 0.1, l0: 0.2, l1: 0.45, g: 'box' }); Snd.play('shieldBreak', e.x, e.z); break;
      case 'fwave': {
        const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
        for (let i = 0; i < 60; i++) { const a = e.yaw + rnd(-0.55, 0.55), sp = rnd(8, 16); particle({ x: e.x + fx * 1.5, y: rnd(0.5, 3), z: e.z + fz * 1.5, vx: Math.sin(a) * sp, vy: rnd(-0.5, 1.5), vz: Math.cos(a) * sp, life: rnd(0.6, 1.0), s0: 0.4, s1: 1.6, c: [1, rnd(0.3, 0.6), 0.08], drag: 1.2, a0: 0.8 }); }
        flashLight(e.x + fx * 5, 2, e.z + fz * 5, 16, [1, 0.5, 0.15], 2.5, 0.6);
        const d = Math.hypot(e.x - cam.x, e.z - cam.z); if (d < 18) shake(0.4 * (1 - d / 18));
        Snd.play('flame', e.x, e.z, { range: 80 }); Snd.play('roar', e.x, e.z, { range: 80 });
        break;
      }
      case 'split': explode(e.x, 2, e.z, 4, false); feed('深渊母巢分裂成两只母巢裂体！', 'bad'); Snd.play('roar', e.x, e.z, { range: 100 }); break;
      case 'laneOpen': {
        for (const l of e.lanes) portalFlare[l] = 3;
        feed(`新出怪口开启：${e.names.join('、')}`, 'bad'); Snd.play('emp'); shake(0.3);
        setTimeout(() => banner('新出怪口开启', e.names.join('、') + ' · 注意分兵布防', true), 3300);
        break;
      }
      case 'heal': {
        const hm = S._mById.get(e.id);
        rings.push({ x: e.x, z: e.z, y: e.y, r0: 0.5, r1: 5.5, t: 0, life: 0.5, c: [0.35, 1, 0.5] });
        for (const id of e.ids) { const o = S._mById.get(id); if (o) { tracers.push({ x1: e.x, y1: e.y, z1: e.z, x2: o.x, y2: o.y + MON[o.type].body[0], z2: o.z, t: 0, life: 0.35, c: [0.35, 1, 0.5] }); burst(o.x, o.y + MON[o.type].body[0] + 0.4, o.z, 3, { c: [0.4, 1, 0.55], sp0: 0.5, sp1: 1.5, s0: 0.1, grav: -2, l0: 0.4, l1: 0.7 }); } }
        void hm;
        break;
      }
      case 'emp': {
        rings.push({ x: e.x, z: e.z, y: 1.5, r0: 1, r1: e.r, t: 0, life: 0.6, c: [0.45, 0.85, 1] });
        rings.push({ x: e.x, z: e.z, y: 0.1, r0: 1, r1: e.r, t: 0, life: 0.7, c: [0.45, 0.85, 1] });
        flashLight(e.x, 4, e.z, 18, [0.4, 0.8, 1], 2, 0.3);
        if (e.n) feed(`BOSS 释放 EMP，${e.n} 个陷阱短暂瘫痪`, 'bad');
        Snd.play('emp', e.x, e.z, { range: 80 });
        break;
      }
      case 'summon': if (!e.brood && !e.drop) feed('BOSS 召唤了援军', 'bad'); burst(e.x, 1, e.z, 20, { c: [1, 0.3, 0.25], sp0: 2, sp1: 5, s0: 0.2 }); break;
      case 'stomp': {
        rings.push({ x: e.x, z: e.z, y: 0.1, r0: 1, r1: e.r, t: 0, life: 0.45, c: [1, 0.6, 0.3] });
        shakeAt(e.x, e.z, 0.85, 34);
        Snd.play('stomp', e.x, e.z, { range: 70 });
        break;
      }
      case 'bossPhase': {
        const m = S._mById.get(e.id), nm = m ? MON[m.type].name : 'BOSS';
        if (e.phase === 2) { banner(`${nm} · 第二阶段`, '套上能量护盾并召唤护卫——电系陷阱、电磁炮破盾最快', true); feed(`${nm} 进入第二阶段：能量护盾 + 护卫`, 'bad'); }
        else { banner(`${nm} · 狂暴`, '移动加快、技能冷却大幅缩短，再召唤一批护卫——全力输出！', true); feed(`${nm} 进入狂暴阶段！`, 'bad'); }
        Snd.play('roar', e.x, e.z, { range: 120 }); Snd.play('boss'); shakeAt(e.x, e.z, 0.7, 60);
        rings.push({ x: e.x, z: e.z, y: 0.1, r0: 1, r1: 12, t: 0, life: 0.7, c: e.phase === 2 ? [0.45, 0.88, 1] : [1, 0.3, 0.2] });
        break;
      }
      case 'enrage': feed('狂猩赛博格 进入狂暴！', 'bad'); Snd.play('roar', e.x, e.z, { range: 80 }); break;
      case 'phurt': if (e.pid === PID) { hurtFx = Math.min(1, hurtFx + e.dmg / 40); Snd.play('hurt'); dmgDir(e.sx, e.sz); shake(0.12); } break;
      case 'spawn': {
        const p0 = S.paths[e.lane] && S.paths[e.lane].pts[0];
        if (p0 && e.d === 0) { portalFlare[e.lane] = 1; flashLight(p0.x, 2.5, p0.z - 1, 9, [1, 0.3, 0.25], 1.6, 0.25); burst(p0.x, 2.2, p0.z - 0.8, 8, { c: [1, 0.35, 0.25], sp0: 1, sp1: 4, s0: 0.12, grav: 0 }); }
        break;
      }
      case 'buy': { const q = S.s.players[e.pid]; if (q && WPN[e.w]) feed(`${e.pid === PID ? '你' : q.name} 购买了 ${WPN[e.w].name}（${WPN[e.w].cost} 金币）`, 'good'); Snd.play('buy'); break; }
      case 'wswitch': if (e.pid === PID) Snd.play('switch'); break;
      case 'throw': { const q = S.s.players[e.pid]; Snd.play('throw', q && e.pid !== PID ? q.x : undefined, q ? q.z : undefined); break; }
      case 'rocket': { const q = S.s.players[e.pid]; if (q && e.pid !== PID) Snd.play('rocketFire', q.x, q.z); break; }
      case 'strikeCall': {
        strikeFx.push({ x: e.x, z: e.z, t: 0, delay: e.delay || 1.3 });
        const q = S.s.players[e.pid];
        feed(`${e.pid === PID ? '你' : (q ? q.name : '队友')} 呼叫了轨道打击`, 'good');
        Snd.play('strikeCall', e.x, e.z, { range: 120 });
        break;
      }
      case 'strike': {
        const sf = strikeFx.find(f => Math.abs(f.x - e.x) < 0.1 && Math.abs(f.z - e.z) < 0.1); if (sf) sf.hit = 0;
        else strikeFx.push({ x: e.x, z: e.z, t: 9, delay: 0, hit: 0 });
        explode(e.x, 1.2, e.z, e.r, false);
        for (let i = 0; i < 6; i++) explode(e.x + rnd(-e.r, e.r) * 0.6, rnd(0.5, 3), e.z + rnd(-e.r, e.r) * 0.6, 2.5, true);
        for (let i = 0; i < 40; i++) particle({ x: e.x + rnd(-1, 1), y: rnd(0.2, 2), z: e.z + rnd(-1, 1), vx: rnd(-9, 9), vy: rnd(4, 14), vz: rnd(-9, 9), life: rnd(0.8, 1.6), s0: rnd(0.12, 0.3), s1: 0.05, c: [0.6, 0.9, 1], grav: 14, bounce: true });
        rings.push({ x: e.x, z: e.z, y: 0.15, r0: 1, r1: e.r * 2.2, t: 0, life: 0.6, c: [0.5, 0.9, 1] });
        rings.push({ x: e.x, z: e.z, y: 0.15, r0: 0.5, r1: e.r * 1.4, t: -0.1, life: 0.5, c: [1, 1, 1] });
        flashLight(e.x, 4, e.z, 30, [0.55, 0.85, 1], 4, 0.6);
        const d = Math.hypot(e.x - cam.x, e.z - cam.z); shake(Math.max(0.25, 1.1 * (1 - d / 40)));
        Snd.play('strike', e.x, e.z, { range: 150 });
        break;
      }
      case 'pdead': if (e.pid === PID) { feed('你倒下了，5 秒后在基地复活', 'bad'); } else if (S.s.players[e.pid]) feed(`${S.s.players[e.pid].name} 倒下了`, 'bad'); break;
      case 'pjoin': if (MP.role !== 'solo' && e.pid !== PID) feed(`${e.name} 加入了战斗`, 'good'); break;
      case 'pleave': if (MP.role !== 'solo') feed(`${e.name} 离开了战斗`, 'bad'); break;
      case 'pready': if (e.pid !== PID && e.on && S.s.players[e.pid]) feed(`${S.s.players[e.pid].name} 已准备开战`, ''); break;
      case 'respawn': if (e.pid === PID) { const p = S.s.players[PID]; cam.yaw = 0; cam.pitch = 0; void p; } break;
      case 'reload': if (e.pid === PID) Snd.play('reload'); break;
      case 'jump': if (e.pid === PID) Snd.play('jump'); break;
      case 'victory': endTimer = 2.2; Snd.play('win'); banner('胜利', '核心水晶守住了', false, 'clear'); break;
      case 'defeat': endTimer = 2.2; Snd.play('lose'); banner('核心水晶被摧毁', '防线失守', true); break;
    }
  }
}
let trapIndex = new Map();
function findTrap(id) { return trapIndex.get(id); }

/* ============================================================
 * HUD
 * ============================================================ */
const cache = {};
// 准星旁的竖向陷阱信息卡
const CAT_CSS = { floor: '#4fd6c4', pad: '#ffb547', wall: '#ff6b8c', ceil: '#b58cff', heavy: '#ff7a3d', hfloor: '#8cff66' };
function trapCardHTML(tr, d, up, gold) {
  const kb = act => TOUCH ? (act === 'KeyE' ? '▲' : '✕') : keyName(keyOf(act));
  const lvTxt = tr.lv >= MAX_LV ? 'MAX' : 'Lv' + tr.lv;
  let h = `<div class="tcHead"><b>${d.name}</b><small>${CAT_NAME[d.cat]}${tr.lane ? ' · 通道' : ''}</small></div>`;
  h += `<div class="tcLv">${Array.from({ length: MAX_LV }, (_, i) => `<i class="${i < tr.lv ? 'on' : ''}"></i>`).join('')}<span style="margin-left:4px">${lvTxt}</span></div>`;
  if (tr.br) { const ev = EVO[tr.type][tr.br]; h += `<div class="tcBr" style="--brc:${tr.br === 'a' ? '#ffc04d' : '#c08cff'}">${tr.br === 'a' ? '甲' : '乙'} · ${ev.name}</div>`; }
  h += '<hr>';
  if (tr.lv < MAX_LV) {
    const okc = gold >= up ? 'ok' : 'no';
    h += `<div class="tcRow ${okc}"><kbd>${kb('KeyE')}</kbd><span>${tr.lv === MAX_LV - 1 ? '进阶（二选一）' : '升级'}</span><em>${up}</em></div>`;
  } else h += `<div class="tcRow max"><kbd>${kb('KeyE')}</kbd><span>★ 已满级</span><em></em></div>`;
  h += `<div class="tcRow sell"><kbd>${kb('KeyX')}</kbd><span>拆除返还</span><em>+${sim.refundOf(tr, PID)}</em></div>`;
  if (d.block || tr.lane) {
    const k = Math.max(0, Math.min(1, tr.hp / tr.maxHp));
    h += `<div class="tcHp ${k < 0.3 ? 'low' : k < 0.6 ? 'mid' : ''}"><i style="width:${(k * 100).toFixed(1)}%"></i><span>耐久 ${Math.ceil(tr.hp)} / ${tr.maxHp}</span></div>`;
  }
  if (tr.disT > 0) h += `<div class="tcWarn">⚡ EMP 瘫痪中 ${Math.ceil(tr.disT)} 秒</div>`;
  return `<div style="--tcc:${CAT_CSS[d.cat] || '#5fe3ff'}">${h}</div>`;
}
function setText(id, v) { if (cache[id] !== v) { cache[id] = v; $(id).textContent = v; } }
function setStyle(el, k, v) { const key = el.id + k; if (cache[key] !== v) { cache[key] = v; if (k.startsWith('--')) el.style.setProperty(k, v); else el.style[k] = v; } }
function setClass(el, v) { const key = el.id + '.cls'; if (cache[key] !== v) { cache[key] = v; el.className = v; } }
let hurtFx = 0, alarmT = 0, hitT = 0;
function hitMarker(kind) { const h = $('hitmark'); h.className = 'on ' + (kind || ''); hitT = kind === 'kill' ? 0.22 : 0.12; }
function alarm() { alarmT = 0.8; }
function dmgDir(sx, sz) {
  if (sx === undefined || !sim) return;
  const p = sim.s.players[PID]; if (!p) return;
  const dx = sx - p.x, dz = sz - p.z; if (Math.hypot(dx, dz) < 0.2) return;
  const fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw), rx = Math.cos(cam.yaw), rz = -Math.sin(cam.yaw);
  const ang = Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz);
  const box = $('dmgDir'); while (box.children.length > 5) box.firstChild.remove();
  const el = document.createElement('i'); el.style.transform = `rotate(${ang.toFixed(3)}rad)`; box.appendChild(el);
  setTimeout(() => el.remove(), 1300);
}
function nextWaveHTML(w) {
  if (!sim) return '';
  const pv = sim.previewWave(w), W = pv.def, names = sim.def.laneNames;
  const all = sim.activeLanes(w);
  const laneTxt = ls => ls.length === all.length && all.length > 1 ? '全部出怪口' : ls.map(l => names[l] || l).join('·');
  const isEndless = w > sim.waves.length;
  return `<span class="nw-t">下一波 · 第 ${w} 波「${W.name}」</span>` + Object.keys(pv.agg).map(t => {
    const m = MON[t], cls = m.boss ? ' boss' : m.elite ? ' elite' : m.fly ? ' fly' : '';
    return `<span class="chip${cls}">${m.name} ×${pv.agg[t].n}<i>${laneTxt(pv.agg[t].lanes)}</i></span>`;
  }).join('') + (pv.opened.length ? `<span class="nw-tip warn">新出怪口开启：${pv.opened.map(l => names[l] || l).join('、')}</span>` : '') + (W.tip ? `<span class="nw-tip">${W.tip}</span>` : '') + (isEndless && w === sim.waves.length + 1 ? '<span class="nw-tip">剧本波次已全部清除，进入无尽模式</span>' : '');
}
function shake(v) { if (settings.shake === false) return; cam.shake = Math.min(1.2, cam.shake + v); }
// 按距离衰减的震动：离得越近越强
function shakeAt(x, z, amt, range) { const d = Math.hypot(x - cam.x, z - cam.z); if (d < range) shake(amt * Math.pow(1 - d / range, 1.5)); }
// BOSS 脚步：体型庞大，每一步都带来震感（离得越近越明显）
function bossTremor(S, dt) {
  for (const m of S.s.monsters) {
    if (m.dead || !MON[m.type].boss || MON[m.type].fly) continue;
    const mv = m._px === undefined ? 0 : Math.hypot(m.x - m._px, m.z - m._pz);
    m._px = m.x; m._pz = m.z;
    if (mv < 0.002 || m.stunT > 0) continue;
    m._stepT = (m._stepT || 0) - dt;
    if (m._stepT > 0) continue;
    m._stepT = 0.68 / (m.bossSpd || 1);
    const d = Math.hypot(m.x - cam.x, m.z - cam.z);
    if (d < 38) { shakeAt(m.x, m.z, 0.22, 38); Snd.play('bstep', m.x, m.z, { range: 60 }); }
  }
}
function feed(text, cls, ms, who) {
  const el = document.createElement('div');
  el.className = 'f ' + (cls || '');
  if (who) { const b = document.createElement('b'); b.textContent = who.name + '：'; b.style.color = who.col; el.appendChild(b); el.appendChild(document.createTextNode(text)); }
  else el.textContent = text;
  const box = $('feed'); box.appendChild(el);
  while (box.children.length > 6) box.removeChild(box.firstChild);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 600); }, ms || 4500);
}
let bannerT = 0;
function banner(t, s, danger, cls) {
  setText('bannerT', t); setText('bannerS', s || '');
  const b = $('banner'); b.className = 'on ' + (danger ? 'danger ' : '') + (cls || '');
  bannerT = 3.2;
}
let toastT = 0;
function toast(t, bad) { const el = $('toast'); el.textContent = t; el.className = 'on' + (bad ? ' bad' : ''); toastT = 1.6; }

const ICONS = {
  gun: '<path d="M2 10h14l2-2h4v4h-3l-1 2h-5l-1 4H8l1-4H2z"/>',
  slow: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7" stroke-dasharray="2 2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  spike: '<path d="M3 20h18M5 20l2.5-9L10 20M10.5 20L13 7l2.5 13M16 20l2.5-9L21 20"/>',
  push: '<path d="M3 20h18M6 17l12-7M18 10l-1 4M18 10l-4-.5"/>',
  tesla: '<path d="M9 21h6M10 21V9h4v12M8 6a4 4 0 0 1 8 0M13 2l-3 4h4l-3 4"/>',
  sentry: '<path d="M5 21h14M8 21v-4h8v4M7 13h10v4H7zM12 13V9M3 15h4"/>',
  aa: '<path d="M4 21h16M7 21v-5l10-8 2 2-8 11M14 6l3-3 4 4-3 3"/>',
  laser: '<path d="M2 6v12M2 9h4v6H2M6 12h16" /><path d="M10 10v4M14 10v4M18 10v4" stroke-dasharray="1 1"/>',
  flame: '<path d="M2 8v8M2 10h4v4H2M6 12c4-3 6 1 8-2 0 3 3 2 4 0 1 3 2 4 4 4-3 2-8 3-16-2"/>',
  crusher: '<path d="M3 3h18M12 3v6M5 9h14v5H5zM5 20h14M8 17l-2 3M16 17l2 3"/>',
  rail: '<path d="M3 21h18M6 21v-4h12v4M8 17l2-5h4l2 5M10 12l9-7M12 10l9-7M17 4l3 3"/>',
  mortar: '<path d="M3 21h18M6 21l2-5h8l2 5M9 16l3-8 3 8M12 8a6 6 0 0 1 8-3M18 3l3 2-2 2"/>',
  gatling: '<path d="M4 20h10M7 20v-4h4v4"/><rect x="6" y="9" width="7" height="5" rx="1"/><path d="M13 10h8M13 11.5h8M13 13h8M3 11h3"/>',
  grinder: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="3"/><circle cx="15.5" cy="15.5" r="3"/><path d="M8.5 4v2M8.5 11v2M4 8.5h2M11 8.5h2M15.5 11v2M15.5 18v2M11 15.5h2M18 15.5h2"/>',
  rifle: '<path d="M2 10h14l2-2h4v4h-3l-1 2h-5l-1 4H8l1-4H2z"/>',
  shotgun: '<path d="M2 9h16v3H2zM2 13h12M18 10.5h4M14 12l1 6h3l-1-6"/>',
  sniper: '<path d="M1 12h22M8 12v3h5l1 4h3l-1-4M10 8h6v3h-6zM5 12l-1 3"/>',
  rocket: '<path d="M3 9h15l3 3-3 3H3zM6 15v4h3v-4M3 7v10"/>',
  nade: '<circle cx="12" cy="14" r="6"/><path d="M10 8V5h4v3M14 5l4-2"/>',
  ult: '<path d="M12 2v8M8 6l4 4 4-4M5 21h14M7 21l5-9 5 9M3 14h3M18 14h3"/>',
};
function svgIcon(id) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg>`; }
/* ---------- 快捷栏：枪 + 5 个陷阱分组（可收起）----------
 * 每组只显示一个格子（上次选过的陷阱）；点一下选中它并展开同组的其他陷阱，再点一次收起。
 * 数字键 1-5 打开分组，再按数字选组内第几个；Tab 打开陷阱一览。 */
const TRAP_GROUPS = [
  { id: 'floor', name: '地面', cat: 'floor', traps: ['slow', 'spike', 'push', 'tesla'] },
  { id: 'wall', name: '墙壁', cat: 'wall', traps: ['laser', 'flame'] },
  { id: 'ceil', name: '天花板', cat: 'ceil', traps: ['crusher'] },
  { id: 'pad', name: '炮台', cat: 'pad', traps: ['sentry', 'aa', 'gatling'] },
  { id: 'heavy', name: '重型', cat: 'heavy', traps: ['rail', 'mortar', 'grinder'] },
];
for (const t of TRAPS) if (!TRAP_GROUPS.some(g => g.traps.includes(t.id))) TRAP_GROUPS[3].traps.push(t.id);
const grpOf = id => TRAP_GROUPS.find(g => g.traps.includes(id));
const grpPick = {};
let popGrp = null;
// 数字键：1-5 打开对应分组，分组展开时再按数字选组内第几个（按 1 再按 2 = 地面组第 2 个）
function trapKey(n) {
  if (popGrp) {
    const g = TRAP_GROUPS.find(x => x.id === popGrp);
    if (g && n >= 1 && n <= g.traps.length) { selectTool(g.traps[n - 1]); closePop(); return; }
  }
  const g = TRAP_GROUPS[n - 1];
  if (g) openPop(g.id, true);
}
const keyCombo = id => { const gi = TRAP_GROUPS.findIndex(g => g.traps.includes(id)); return gi < 0 ? '' : `${gi + 1} ${TRAP_GROUPS[gi].traps.indexOf(id) + 1}`; };
function slotHTML(id, key, name, cost) {
  return `<span class="k">${key}</span>${svgIcon(id)}<span class="n">${name}</span>${cost ? `<span class="c">${cost}</span>` : '<span class="c inf">∞</span>'}`;
}
function setChip(g) {
  const el = document.querySelector(`#hotbar .grp[data-grp="${g.id}"]`); if (!el) return;
  const t = TRAP[grpPick[g.id] || g.traps.find(isUnlocked) || g.traps[0]];
  el.dataset.id = t.id; el.className = 'slot grp cat-' + t.cat + (tool === t.id ? ' sel' : '') + (popGrp === g.id ? ' open' : '') + (isUnlocked(t.id) ? '' : ' locked');
  el.innerHTML = slotHTML(t.id, String(TRAP_GROUPS.indexOf(g) + 1), t.name, sim ? sim.trapCost(t.id, PID) : t.cost) + (g.traps.length > 1 ? `<span class="more">${g.traps.length}</span>` : '');
}
function openPop(gid, byKey) {
  popGrp = gid;
  const pop = $('trapPop'), g = TRAP_GROUPS.find(x => x.id === gid);
  for (const gg of TRAP_GROUPS) setChip(gg);
  if (!g || (g.traps.length < 2 && !byKey)) { pop.hidden = true; popGrp = null; return; }
  pop.innerHTML = `<b class="pt">${g.name}</b>`;
  for (const id of g.traps) {
    const t = TRAP[id], d = document.createElement('div');
    d.className = 'slot cat-' + t.cat + (tool === id ? ' sel' : '') + (isUnlocked(id) ? '' : ' locked'); d.dataset.id = id; if (!isUnlocked(id)) d.title = lockText(id);
    d.innerHTML = slotHTML(id, String(g.traps.indexOf(id) + 1), t.name, sim ? sim.trapCost(id, PID) : t.cost);
    d.addEventListener('pointerdown', ev => { ev.stopPropagation(); ev.preventDefault(); if (!isUnlocked(id)) { selectTool(id); return; } selectTool(id); closePop(); });
    pop.appendChild(d);
  }
  pop.hidden = false;
  // 对齐到分组格子正上方，不超出屏幕
  const chip = document.querySelector(`#hotbar .grp[data-grp="${gid}"]`), hb = $('hotbar');
  pop.style.left = '0px';
  const cr = chip.getBoundingClientRect(), hr = hb.getBoundingClientRect(), pw = pop.offsetWidth;
  let left = cr.left + cr.width / 2 - pw / 2 - hr.left;
  left = Math.max(-hr.left + 6, Math.min(left, innerWidth - hr.left - pw - 6));
  pop.style.left = left + 'px';
}
/* ---------- 陷阱一览（Tab）：按分组列出全部陷阱的详细说明，点一下就选中 ---------- */
let bookOpen = false;
function toggleBook(on) {
  bookOpen = on === undefined ? !bookOpen : on;
  $('trapBook').hidden = !bookOpen;
  if (bookOpen) { closePop(); if (shopOpen) toggleShop(false); if (labOpen) toggleLab(false); panelOpened(true); renderBook(); } else panelClosed();
}
function trapStats(t) {
  const L = [];
  const arr = (v, f) => Array.isArray(v) ? v.map(f || (x => x)).join(' / ') : (f ? f(v) : v);
  if (t.dmg) L.push(['伤害', arr(t.dmg)]);
  if (t.gun) L.push(['操控伤害', arr(t.gun) + '（每发）']);
  if (t.dps) L.push(['每秒伤害', arr(t.dps)]);
  if (t.poison) L.push(['中毒', arr(t.poison) + '（每秒）']);
  if (t.burn) L.push(['灼烧', arr(t.burn) + '（每秒）']);
  if (t.slow) L.push(['减速', arr(t.slow, v => Math.round(v * 100) + '%')]);
  if (t.hp) L.push(['耐久', arr(t.hp)]);
  if (t.cd) L.push(['间隔', arr(t.cd, v => v + ' 秒')]);
  if (t.range) L.push(['射程', arr(t.range, v => v + ' 米')]);
  if (t.splash) L.push(['溅射半径', t.splash + ' 米']);
  if (t.push) L.push(['击退', arr(t.push, v => v + ' 米')]);
  if (t.stun) L.push(['眩晕', t.stun + ' 秒']);
  if (TD.LANE_HP[t.id]) L.push(['通道上耐久', TD.LANE_HP[t.id].join(' / ')]);
  return L;
}
function renderBook() {
  // 左边按分组排的陷阱格子，右边详情（和图鉴同一套）；点格子看详情，点「选用」或双击直接拿在手上
  buildHelp();
  const box = $('bookList'); box.className = 'cdx bookCdx';
  box.innerHTML = '<div class="cdxList" id="bkL"></div><article class="cdxDetail" id="bkD"></article>';
  const L = $('bkL'), gold = sim ? sim.s.gold : 0;
  L.innerHTML = TRAP_GROUPS.map((g, gi) => `<div class="cdxGrp"><h4>${gi + 1} · ${g.name}</h4><div class="cdxTiles">${g.traps.map(id => { const t = TRAP[id], cost = sim ? sim.trapCost(id, PID) : t.cost; return `<button type="button" class="cdxTile${isUnlocked(id) ? '' : ' locked'}${tool === id ? ' cur' : ''}" style="--cc: var(--c-${t.cat})" data-bk="${id}"><span class="ic">${svgIcon(id)}</span><span>${t.name}</span><em class="${gold < cost ? 'poor' : ''}">${isUnlocked(id) ? cost : '未解锁'}</em></button>`; }).join('')}</div></div>`).join('');
  const show = id => {
    const it = (CODEX.trap || []).find(x => x.id === id); if (!it) return;
    for (const b of L.querySelectorAll('[data-bk]')) b.setAttribute('aria-current', b.dataset.bk === id ? 'true' : 'false');
    const D = $('bkD'); D.style.setProperty('--cc', `var(--c-${TRAP[id].cat})`);
    D.innerHTML = it.detail();
    if (isUnlocked(id)) {
      const u = document.createElement('button'); u.type = 'button'; u.className = 'cta bkUse'; u.dataset.use = id; u.textContent = '选用';
      u.addEventListener('click', () => { selectTool(id); toggleBook(false); });
      (D.querySelector('header') || D).appendChild(u);
    }
    bookSel = id;
  };
  for (const b of L.querySelectorAll('[data-bk]')) {
    b.addEventListener('click', () => show(b.dataset.bk));
    b.addEventListener('dblclick', () => { if (isUnlocked(b.dataset.bk)) { selectTool(b.dataset.bk); toggleBook(false); } });
    if (!TOUCH) b.addEventListener('mouseenter', () => show(b.dataset.bk));
  }
  show(tool !== 'gun' ? tool : bookSel || TRAP_GROUPS[0].traps[0]);
}
let bookSel = null;
function closePop() { if (popGrp === null) return; popGrp = null; $('trapPop').hidden = true; for (const g of TRAP_GROUPS) setChip(g); }
function buildHotbar() {
  const hb = $('hotbar'); hb.innerHTML = '';
  const gun = document.createElement('div');
  gun.className = 'slot cat-gun'; gun.dataset.id = 'gun';
  gun.innerHTML = slotHTML('rifle', 'Q', '脉冲步枪', 0);
  gun.addEventListener('pointerdown', ev => { ev.stopPropagation(); ev.preventDefault(); closePop(); selectTool('gun'); });
  hb.appendChild(gun);
  for (const g of TRAP_GROUPS) {
    const d = document.createElement('div');
    d.className = 'slot grp'; d.dataset.grp = g.id;
    d.addEventListener('pointerdown', ev => {
      ev.stopPropagation(); ev.preventDefault();
      const id = grpPick[g.id] || g.traps.find(isUnlocked) || g.traps[0];
      if (popGrp === g.id) { closePop(); return; }
      if (isUnlocked(id)) selectTool(id);
      openPop(g.id);
    });
    hb.appendChild(d);
    setChip(g);
  }
  const pop = document.createElement('div'); pop.id = 'trapPop'; pop.hidden = true;
  pop.addEventListener('pointerdown', ev => ev.stopPropagation());
  hb.appendChild(pop);
  popGrp = null;
}
function selectTool(id) {
  if (tool === id) return;
  if (id !== 'gun' && !isUnlocked(id)) { toast(`${TRAP[id].name} ${lockText(id)}`, true); Snd.play('deny'); return; }
  if (id !== 'gun' && myMount()) dismount();
  tool = id; vm.switchT = 0.25;
  { const g = id !== 'gun' && grpOf(id); if (g) grpPick[g.id] = id; if (popGrp && (!g || g.id !== popGrp)) closePop(); for (const gg of TRAP_GROUPS) setChip(gg); }
  for (const el of document.querySelectorAll('#hotbar [data-id]')) el.classList.toggle('sel', el.dataset.id === id);
  if (id !== 'gun') { const d = TRAP[id]; toast(`${d.name} · ${CAT_NAME[d.cat]} · ${sim ? sim.trapCost(id, PID) : d.cost} 金币`); }
  if (evoTrap !== null) closeEvo();
}
/* ============================================================
 * 图鉴：左边图标格子，右边详情，一屏显示完，不需要翻页
 * ============================================================ */
function monTags(k) {
  const m = MON[k], tags = [];
  if (m.fly) tags.push('飞行，地面陷阱无效');
  if (m.bomb) tags.push('遇到阻挡会自爆');
  if (m.elite) tags.push('半血狂暴，免疫击退');
  if (m.boss) tags.push('BOSS：血量 60% / 25% 时进入第二阶段和狂暴');
  if (m.heal) tags.push('治疗周围怪物，优先击落');
  if (m.stealth) tags.push('隐身：炮台锁不住，减速 / 攻击 / 靠近会现形');
  if (m.burrow) tags.push('钻入地下越过陷阱，期间无敌');
  if (m.hack) tags.push('骇入附近陷阱，使其瘫痪 10 秒');
  if (m.ranged) tags.push(`远程射击玩家（射程 ${m.ranged.range} 米，光弹可以躲）`);
  if (m.burnImmune) tags.push('免疫燃烧');
  if (m.split) tags.push('击破后分裂');
  if (m.aura) tags.push('给周围敌人套能量护盾，同一只怪 8 秒内只能套一次');
  if (m.cannon) tags.push(`炮击 ${m.cannon.range} 米内的炮台与阻挡物，使其瘫痪`);
  if (m.stunRes) tags.push('眩晕时间 -' + Math.round(m.stunRes * 100) + '%');
  if (m.blink) tags.push(`每 ${m.blink.every} 秒向前瞬移 ${m.blink.dist} 米，越过阻挡`);
  if (m.drop) tags.push('空投噬晶蛛');
  if (m.heavy) tags.push('重装单位，电磁炮优先锁定');
  if (k === 'mite') tags.push('体型小、速度快');
  return tags;
}
const MON_COUNTER = {
  shield: '优先在它身边放磁暴塔：磁暴塔、轨道电磁炮对护盾 ×3，激光 ×2.5，枪械 ×1.5；破盾瞬间敌人僵直 0.6 秒。',
  tank: '护甲厚、几乎不怕眩晕。轨道电磁炮无视护甲并优先打它；炮台放远一点，避开它的炮击范围。',
  blinker: '会越过一排阻挡，用覆盖整段通道的墙壁陷阱和炮台，而不是只靠一排磁暴塔。',
  gunship: '防空导弹、岗哨机枪、加特林、电磁炮都能打；碎骨绞盘「引力漩涡」能把它拽到地上。',
  stalker: '炮台锁不住隐身单位：侦察兵、减速器、亲手开枪都能让它现形。',
  burrower: '钻地时无敌，冒头后集火；把陷阱铺长一点。',
  bomber: '遇到阻挡会自爆，别让它贴近磁暴塔；用远程炮台在半路解决。',
  healer: '会给周围怪回血，优先用防空导弹或枪械击落。',
  sapper: '会骇入陷阱，用炮台在远处先打掉它。',
  gunner: '会停下来射击玩家，站在它视线外或者横向跑动躲光弹。',
  elite: '半血后狂暴提速，狙击枪和电磁炮最有效。',
};
const CODEX = {};
function cdxItem(kind, it) { (CODEX[kind] || (CODEX[kind] = [])).push(it); }
function dl(rows) { return `<dl class="cdxStats">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`; }
const CAT_RULE = {
  floor: '地面陷阱只能放在怪物通道上，对飞行怪无效；斜坡上不能放。',
  wall: '墙壁陷阱挂在通道两侧的墙上（室外高出 2.5 米的崖壁也算），光束横贯整条通道。',
  ceil: '天花板陷阱只能挂在室内天花板或二层桥底下。',
  pad: '炮台可以放在炮台位、空地或地上琥珀色框出的 2×2 炮台位；也能直接放在通道上——会挡住怪物并被攻击（有耐久，会慢慢自我修复）。',
  heavy: '重型炮台占地 2×2，最适合放在地上琥珀色框出的 2×2 炮台位，也能放在 2×2 的空地上。',
  hfloor: '2×2 地面陷阱，铺在通道上 2×2 的位置。',
};
const TRAP_NOTE = {
  gatling: '按 F 坐上去亲手扫射：先转管预热，之后每秒 20 发，对地对空都能打；连续开火约 5 秒会过热。F / 空格离开。',
  mortar: '按 F 站上观测台，用准星在地上选落点开炮：冷却 ×0.55、伤害 ×1.15。',
};
function buildHelp() {
  for (const k in CODEX) delete CODEX[k];
  // —— 陷阱 ——
  TRAP_GROUPS.forEach((g, gi) => g.traps.forEach((id, ti) => {
    const t = TRAP[id];
    cdxItem('trap', { id, grp: `${gi + 1} · ${g.name}`, name: t.name, icon: svgIcon(id), cat: t.cat, locked: () => !isUnlocked(id), detail: () => {
      const ev = EVO[id], desc = t.desc.split(' · ').slice(1).join(' · ') || t.desc;
      return `<header><span class="ic">${svgIcon(id)}</span><h3>${t.name}</h3><span class="cdxMeta">${CAT_NAME[t.cat]} · ${t.cost} 金币 · 按 <span class="kb">${keyCombo(id)}</span></span></header>
        <div class="cdxCols"><div>
        ${isUnlocked(id) ? '' : `<p class="cdxLock">${lockText(id)}</p>`}
        <p>${desc}</p>
        ${dl(trapStats(t).map(([k, v]) => [k, v]))}<p class="cdxFoot">数值依次为 Lv1 / Lv2 / Lv3 / Lv4</p></div><div>
        ${TRAP_NOTE[id] ? `<p class="cdxNote">${TRAP_NOTE[id]}</p>` : ''}
        ${ev ? `<div class="cdxEvo"><h4>满级进阶（Lv3 → Lv4 二选一）</h4><p><b>${ev.a.name}</b>${ev.a.desc}</p><p><b>${ev.b.name}</b>${ev.b.desc}</p></div>` : ''}
        <p class="cdxFoot">${CAT_RULE[t.cat] || ''}</p></div></div>`;
    } });
  }));
  // —— 敌人 ——
  for (const k of Object.keys(MON)) {
    const m = MON[k], grp = m.boss ? 'BOSS' : m.elite || m.heavy ? '精英与重装' : m.fly ? '空中' : '地面';
    cdxItem('mon', { id: k, grp, name: m.name, icon: svgIcon(m.boss ? 'ult' : m.fly ? 'aa' : 'spike'), cat: m.boss ? 'heavy' : m.elite || m.heavy ? 'wall' : m.fly ? 'ceil' : 'floor', detail: () => {
      const tags = monTags(k);
      return `<header><h3>${m.name}</h3><span class="cdxMeta">${grp}</span></header>
        <div class="cdxCols"><div>
        ${dl([['基础血量', m.hp.toLocaleString() + (m.boss ? '（按难度放大）' : '（随波次成长）')], ['移动速度', m.spd + ' 米/秒'], ['护甲', m.armor ? Math.round(m.armor * 100) + '%' : '无'], ['击杀奖励', m.bounty + ' 金币'], ['漏到水晶', m.core >= 999 ? '直接摧毁' : '-' + m.core + ' 水晶生命']])}
        ${tags.length ? `<ul class="cdxTags">${tags.map(x => `<li>${x}</li>`).join('')}</ul>` : '<p>基础单位，没有特殊能力。</p>'}</div><div>
        ${TD.BOSS_TIP && TD.BOSS_TIP[k] ? `<p class="cdxNote">${TD.BOSS_TIP[k]}</p>` : ''}
        ${MON_COUNTER[k] ? `<div class="cdxEvo"><h4>怎么对付</h4><p>${MON_COUNTER[k]}</p></div>` : ''}</div></div>`;
    } });
  }
  // —— 武器与职业 ——
  WEAPONS.forEach((w, i) => cdxItem('wpn', { id: w.id, grp: '武器（B 军械库购买，Q 切换）', name: w.name, icon: svgIcon(w.id), cat: 'gun', detail: () => `<header><span class="ic">${svgIcon(w.id)}</span><h3>${w.name}</h3><span class="cdxMeta">${w.cost ? w.cost + ' 金币' : '初始武器'} · 军械库第 ${i + 1} 格</span></header><p>${w.desc}</p>
      ${dl([['伤害', `${w.dmg}${w.pellets ? ' × ' + w.pellets + ' 颗' : ''}${w.splash ? '（范围 ' + w.splash + ' 米）' : ''}`], ['射速', w.rps + ' 发/秒'], ['弹匣', w.mag], ['换弹', w.reload + ' 秒'], ['爆头倍率', w.head ? '×' + w.head : '—']].concat(w.pierce ? [['贯穿', w.pierce + ' 个目标']] : []))}` }));
  cdxItem('wpn', { id: 'nade', grp: '技能', name: SKILL.nade.name, icon: svgIcon('nade'), cat: 'gun', detail: () => `<header><span class="ic">${svgIcon('nade')}</span><h3>${SKILL.nade.name}</h3><span class="cdxMeta">按 C 投掷</span></header><p>抛物线投掷，${SKILL.nade.fuse} 秒后爆炸。</p>${dl([['伤害', SKILL.nade.dmg], ['范围', SKILL.nade.r + ' 米'], ['数量', `最多 ${SKILL.nade.max} 枚（突击兵 +1）`], ['充能', `每 ${SKILL.nade.recharge} 秒 1 枚`]])}` });
  cdxItem('wpn', { id: 'ult', grp: '技能', name: SKILL.ult.name, icon: svgIcon('ult'), cat: 'gun', detail: () => `<header><span class="ic">${svgIcon('ult')}</span><h3>${SKILL.ult.name}</h3><span class="cdxMeta">能量满 100% 后按 Z</span></header><p>用枪造成伤害和击杀会积攒能量；满了以后对准地面呼叫，${SKILL.ult.delay} 秒后落下，大范围重创并眩晕敌人。</p>${dl([['伤害', SKILL.ult.dmg], ['范围', SKILL.ult.r + ' 米'], ['眩晕', SKILL.ult.stun + ' 秒']])}` });
  for (const c of CLASSES) cdxItem('wpn', { id: 'cls-' + c.id, grp: '职业（开局选择）', name: c.name, icon: `<b class="clsMark">${c.short}</b>`, cat: 'pad', detail: () => `<header><h3>${c.name}</h3><span class="cdxMeta">职业</span></header><p>${c.desc}</p><p class="cdxFoot">联机时每人可以选不同职业，搭配起来更强。</p>` });
  // —— 关卡 ——
  for (const d of MAP_LIST) {
    cdxItem('map', { id: d.id, grp: '关卡', name: d.name, icon: `<canvas class="cdxThumb" data-map="${d.id}"></canvas>`, cat: d.outdoor ? 'hfloor' : 'floor', detail: () => {
      const n = Object.keys(d.lanes).length, late = d.laneFrom ? Object.keys(d.laneFrom) : [], boss = d.waves[d.waves.length - 1];
      const bossT = (boss.groups || []).filter(g => MON[g.t] && MON[g.t].boss).map(g => MON[g.t].name);
      return `<header><h3>${d.name}</h3><span class="cdxMeta">${d.sub}${d.outdoor ? ' · 室外' : ' · 室内'}</span></header><p>${d.desc}</p>
        ${dl([['出怪口', n + ' 个' + (late.length ? `（${late.map(l => `${d.laneNames[l] || l} 第 ${d.laneFrom[l]} 波开启`).join('，')}）` : '')], ['波次', d.waves.length + ' 波'], ['初始金币', d.gold], ['终局 BOSS', bossT.join(' + ') || '—'], ['地图机关', (d.devices || []).map(dv => devName(dv)).join('、') || '无'], ['科研舱', (d.labs || []).length ? '有' : '无']].concat(d.ladders ? [['梯子', d.ladders.length + ' 处（谷底爬回崖顶）']] : []))}
        <canvas class="cdxBig" data-map="${d.id}"></canvas>`;
    } });
  }
  // —— 机制 ——
  const R = (id, grp, name, body) => cdxItem('rule', { id, grp, name, icon: '', cat: 'gun', detail: () => `<header><h3>${name}</h3><span class="cdxMeta">${grp}</span></header>${body}` });
  R('phase', '基础规则', 'BOSS 分阶段', '<p>BOSS 血量降到 60% 时进入第二阶段：怒吼、套上能量护盾（电系陷阱和电磁炮破盾最快）并召唤一队护卫。降到 25% 时进入狂暴：移动更快、技能冷却大幅缩短，再召唤一批护卫。血条上的两道白线就是阶段分界。</p>');
  R('respawn', '基础规则', '复活保护', '<p>阵亡 5 秒后在基地复活，复活后 10 秒内无敌。</p>');
  R('dodge', '基础规则', '躲子弹', '<p>远程怪（火线射手、天穹炮艇）射出的是看得见的红色光弹，不会预判你的走位——跑动、横移、跳跃都能躲开。</p>');
  R('unlock', '基础规则', '重型陷阱解锁', `<ul class="cdxTags">${Object.keys(UNLOCKS).map(id => `<li><b>${TRAP[id].name}</b>：${UNLOCKS[id].how}${isUnlocked(id) ? '（已解锁）' : ''}</li>`).join('')}</ul><p class="cdxFoot">解锁进度记录在这台设备上。</p>`);
  R('lb', '基础规则', '无尽排行榜', '<p>无尽模式结束（水晶被摧毁，或在暂停菜单里「结算并退出」）时自动结算分数并上传在线榜；主菜单「无尽排行榜」查看每张地图的前 20 名。</p>');
  R('height', '地形', '高地与崖壁', '<p>室外关卡有不同高度的台地。站在高处可以俯射，近战怪打不到你；台阶低于 0.75 米能直接走上去，更高的崖壁要走楼梯、斜坡或梯子，往下可以直接跳。通道旁高出 2.5 米以上的崖壁可以挂墙壁陷阱。</p>');
  R('deck', '地形', '二层桥', '<p>桥面能站人、两侧有护栏；只有桥底下有天花板，露天的地方不能放粉碎锤。小地图上琥珀色方块是桥，亮色区域是高处，白色箭头指向上坡，绿色短横是梯子。</p>');
  R('lab', '科研舱', '科研舱', '<p>每张地图都有一间科研舱（小地图上的紫色「科」）。走到科研终端旁按 F，用全队共享的金币研究科技，全队生效、本局有效；旁边的补给柜可以补满生命、手雷和弹药。</p>');
  TD.TECH.forEach((t, i) => R('tech-' + t.id, '科研科技', t.name, `<p>${t.desc(1)}，每级叠加，最高 ${TD.TECH_MAX} 级。</p>${dl([['每级花费', t.cost.join(' / ') + ' 金币']])}`));
  COMBOS.forEach(c => R('combo-' + c.name, '陷阱联动', c.name, `<p>${c.desc}</p>`));
  for (const kind of ['trap', 'mon', 'wpn', 'map', 'rule']) renderCodexList(kind);
}
const cdxSel = {};
function renderCodexList(kind) {
  const box = $('cdxL-' + kind); if (!box) return;
  const items = CODEX[kind] || [], groups = [];
  for (const it of items) { let g = groups.find(x => x.name === it.grp); if (!g) groups.push(g = { name: it.grp, items: [] }); g.items.push(it); }
  box.innerHTML = groups.map(g => `<div class="cdxGrp"><h4>${g.name}</h4><div class="cdxTiles${kind === 'map' ? ' maps' : ''}">${g.items.map(it => `<button type="button" class="cdxTile${it.locked && it.locked() ? ' locked' : ''}" style="--cc: var(--c-${it.cat})" data-cdx="${it.id}">${it.icon ? `<span class="ic">${it.icon}</span>` : ''}<span>${it.name}</span></button>`).join('')}</div></div>`).join('');
  for (const b of box.querySelectorAll('[data-cdx]')) {
    const show = () => selectCodex(kind, b.dataset.cdx);
    b.addEventListener('click', show); b.addEventListener('focus', show);
    if (!TOUCH) b.addEventListener('mouseenter', show);
  }
  for (const cv of box.querySelectorAll('canvas[data-map]')) { try { drawThumb(cv, MAPS[cv.dataset.map]); } catch (e) { /* 忽略 */ } }
  const dd = $('cdxD-' + kind); if (dd) dd.dataset.cur = '';
  selectCodex(kind, cdxSel[kind] || (items[0] && items[0].id));
}
function selectCodex(kind, id) {
  const it = (CODEX[kind] || []).find(x => x.id === id); if (!it) return;
  const d0 = $('cdxD-' + kind); if (cdxSel[kind] === id && d0 && d0.dataset.cur === id) return;
  cdxSel[kind] = id; if (d0) d0.dataset.cur = id;
  for (const b of document.querySelectorAll(`#cdxL-${kind} [data-cdx]`)) b.setAttribute('aria-current', b.dataset.cdx === id ? 'true' : 'false');
  const d = $('cdxD-' + kind); d.style.setProperty('--cc', `var(--c-${it.cat})`);
  d.innerHTML = it.detail();
  for (const cv of d.querySelectorAll('canvas[data-map]')) { try { drawThumb(cv, MAPS[cv.dataset.map]); } catch (e) { /* 忽略 */ } }
}

let mapCtx = null, mapBase = null, mapTimer = 0, MMK = 5;
// 小地图 / 地图缩略图：按地面高度提亮，标出崖边、斜坡方向和二层桥
function paintTiles(g, S, k, C) {
  const shade = (hex, h) => {
    const n = parseInt(hex.slice(1), 16), f = Math.min(0.45, h * 0.09);
    const r = n >> 16, gg = (n >> 8) & 255, b = n & 255, m = v => Math.round(v + (255 - v) * f);
    return `rgb(${m(r)},${m(gg)},${m(b)})`;
  };
  for (let z = 0; z < S.H; z++) for (let x = 0; x < S.W; x++) {
    const t = S.tileAt(x, z);
    g.fillStyle = t === TILE.WALL || !S.terrain ? C[t] : shade(C[t], S.tileH(x, z));
    g.fillRect(x * k, z * k, k, k);
  }
  if (!S.terrain) return;
  // 崖边：高处一侧画亮线
  g.fillStyle = 'rgba(255,214,150,.75)';
  for (let z = 0; z < S.H; z++) for (let x = 0; x < S.W; x++) {
    if (S.solid(x, z) || S.isRamp(x, z)) continue;
    const h = S.tileH(x, z);
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d][0], nz = z + DIRS[d][1];
      if (S.solid(nx, nz) || S.isRamp(nx, nz) || S.tileH(nx, nz) > h - 1) continue;
      if (d === 0) g.fillRect((x + 1) * k - 1, z * k, 1, k); else if (d === 2) g.fillRect(x * k, z * k, 1, k);
      else if (d === 1) g.fillRect(x * k, (z + 1) * k - 1, k, 1); else g.fillRect(x * k, z * k, k, 1);
    }
  }
  // 斜坡：上坡方向的小箭头
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1;
  for (const r of S.ramps) {
    const d = DIRS[r.dir], cx = (r.x0 + r.x1 + 1) / 2 * k, cz = (r.z0 + r.z1 + 1) / 2 * k, L = Math.max(3, Math.min(r.x1 - r.x0 + 1, r.z1 - r.z0 + 1) * k * 0.3);
    g.beginPath(); g.moveTo(cx - d[0] * L - d[1] * L * 0.7, cz - d[1] * L - d[0] * L * 0.7); g.lineTo(cx + d[0] * L, cz + d[1] * L); g.lineTo(cx - d[0] * L + d[1] * L * 0.7, cz - d[1] * L + d[0] * L * 0.7); g.stroke();
  }
  // 二层桥：琥珀色半透明 + 描边
  for (const r of S.def.decks || []) {
    const X = r[0] * k, Y = r[1] * k, Wd = (r[2] - r[0] + 1) * k, Hd = (r[3] - r[1] + 1) * k;
    g.fillStyle = 'rgba(255,181,71,.38)'; g.fillRect(X, Y, Wd, Hd);
    g.strokeStyle = 'rgba(255,200,110,.95)'; g.strokeRect(X + 0.5, Y + 0.5, Wd - 1, Hd - 1);
  }
  // 梯子：贴在崖壁那一边的绿色短横
  g.fillStyle = '#6cf0a4';
  for (const [x, z, dir] of S.def.ladders || []) {
    const d = DIRS[dir], cx = (x + 0.5 + d[0] * 0.38) * k, cz = (z + 0.5 + d[1] * 0.38) * k, w = d[0] ? 2 : k * 0.8, h = d[0] ? k * 0.8 : 2;
    g.fillRect(cx - w / 2, cz - h / 2, w, h);
  }
}
function buildMinimap(S) {
  const cv = $('minimap'); mapCtx = cv.getContext('2d');
  const k = MMK = Math.max(3, Math.min(5, Math.floor(Math.min(210 / S.W, 190 / S.H))));
  cv.width = S.W * k; cv.height = S.H * k; cv.style.width = cv.width + 'px'; cv.style.height = cv.height + 'px';
  mapBase = document.createElement('canvas'); mapBase.width = S.W * k; mapBase.height = S.H * k;
  const g = mapBase.getContext('2d');
  const C = { [TILE.WALL]: '#0b1017', [TILE.LANE]: '#2b3947', [TILE.FLOOR]: '#3a424c', [TILE.PAD]: '#5b4a2a', [TILE.BASE]: '#1f4c5c', [TILE.SPAWN]: '#5a2024' };
  paintTiles(g, S, k, C);
  g.strokeStyle = 'rgba(255,90,80,.55)'; g.lineWidth = 1; g.setLineDash([2, 2]);
  for (const lane of S.lanes) { g.beginPath(); S.paths[lane].pts.forEach((p, i) => { const X = p.x / T * k, Y = p.z / T * k; i ? g.lineTo(X, Y) : g.moveTo(X, Y); }); g.stroke(); }
  g.setLineDash([]); g.font = 'bold 10px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const lane of S.lanes) { const p0 = S.paths[lane].pts[0]; g.fillStyle = '#ffb3a8'; g.fillText(lane, p0.x / T * k, p0.z / T * k); }
  for (const lb of S.def.labs || []) {
    const X = lb.holo[0] * k, Y = lb.holo[1] * k;
    g.fillStyle = 'rgba(180,140,255,.9)'; g.fillRect(X - 6, Y - 6, 12, 12);
    g.fillStyle = '#140d22'; g.font = 'bold 10px sans-serif'; g.fillText('科', X, Y + 0.5);
  }
}
function drawMinimap(S) {
  if (!mapCtx) return;
  const cv = mapCtx.canvas, k = MMK;
  mapCtx.clearRect(0, 0, cv.width, cv.height);
  mapCtx.drawImage(mapBase, 0, 0);
  for (const tr of S.s.traps) {
    const cc = CAT_COL[TRAP[tr.type].cat];
    mapCtx.fillStyle = `rgb(${cc[0] * 255 | 0},${cc[1] * 255 | 0},${cc[2] * 255 | 0})`;
    mapCtx.fillRect(tr.wx / T * k - 1.5, tr.wz / T * k - 1.5, 3, 3);
  }
  for (const [i, dv] of (S.def.devices || []).entries()) {
    const st = S.s.devices[i], w = S.deviceWorld(dv), X = w.x / T * k, Y = w.z / T * k;
    mapCtx.fillStyle = st.act > 0 ? '#5fe3ff' : st.cd > 0 ? '#ff6b6b' : '#6cf0a4';
    mapCtx.beginPath(); mapCtx.moveTo(X, Y - 4); mapCtx.lineTo(X + 4, Y); mapCtx.lineTo(X, Y + 4); mapCtx.lineTo(X - 4, Y); mapCtx.fill();
    if (st.act > 0) { mapCtx.strokeStyle = 'rgba(95,227,255,.6)'; mapCtx.strokeRect(dv.area[0] * k, dv.area[1] * k, (dv.area[2] - dv.area[0] + 1) * k, (dv.area[3] - dv.area[1] + 1) * k); }
  }
  const cp = S.crystalPos;
  mapCtx.fillStyle = '#5fe3ff'; mapCtx.beginPath(); const cx = cp.x / T * k, cz = cp.z / T * k; mapCtx.moveTo(cx, cz - 5); mapCtx.lineTo(cx + 4, cz); mapCtx.lineTo(cx, cz + 5); mapCtx.lineTo(cx - 4, cz); mapCtx.fill();
  const dark = S.s.mut && S.s.mut.includes('blackout');
  for (const m of S.s.monsters) {
    const def = MON[m.type];
    if (m.burrow || m.cloak || (dark && !def.boss)) continue;
    mapCtx.fillStyle = def.boss ? '#ff3df0' : def.elite ? '#ff8a3d' : def.heal ? '#6cf0a4' : def.fly ? '#c48cff' : def.hack ? '#ffd23d' : '#ff4f62';
    const r = def.boss ? 4 : def.elite ? 3 : 1.6;
    mapCtx.beginPath(); mapCtx.arc(m.x / T * k, m.z / T * k, r, 0, Math.PI * 2); mapCtx.fill();
  }
  for (const id in S.s.players) {
    const p = S.s.players[id]; if (p.dead) continue;
    const px = p.x / T * k, pz = p.z / T * k, yaw = id === PID ? cam.yaw : p.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    mapCtx.fillStyle = id === PID ? '#ffffff' : TEAM_CSS[p.slot % 4];
    mapCtx.beginPath(); mapCtx.moveTo(px + fx * 5, pz + fz * 5); mapCtx.lineTo(px - fz * 3 - fx * 3, pz + fx * 3 - fz * 3); mapCtx.lineTo(px + fz * 3 - fx * 3, pz - fx * 3 - fz * 3); mapCtx.fill();
  }
}

const autoReady = { wave: -1, since: 0 };
function updateHUD(dt) {
  if (sim && mode === 'play') bossTremor(sim, dt);
  if (!sim) return;
  const s = sim.s, p = s.players[PID];
  const cf = s.crystal.hp / s.crystal.max;
  setStyle($('crysFill'), 'width', (cf * 100).toFixed(1) + '%');
  setText('crysNum', `${Math.ceil(s.crystal.hp)} / ${s.crystal.max}`);
  $('topbar').classList.toggle('low', cf < 0.3);
  const W = sim.totalWaves(), Wtxt = W === Infinity ? '∞' : W;
  const mt = (s.daily ? '每日挑战' + (s.mut && s.mut.length ? ' · ' : '') : '') + (s.mut && s.mut.length ? '突变：' + s.mut.map(id => MUT[id].name).join(' · ') : '');
  if (cache.mutTag !== mt) { cache.mutTag = mt; $('mutTag').textContent = mt; $('mutTag').hidden = !mt; }
  if (s.phase === 'build' && mode === 'play') {
    const sec = Math.ceil(s.timer);
    if (sec <= 5 && sec >= 1 && cache.countSec !== sec) { cache.countSec = sec; Snd.play('count'); }
  }
  if (s.phase === 'build') {
    setText('waveTxt', s.wave === 0 ? `${sim.def.name} · 共 ${Wtxt} 波` : `第 ${s.wave} / ${Wtxt} 波 已清除`);
    setText('phaseTxt', '布防阶段');
    const rc = sim.readyCount();
    setText('timerTxt', rc.of > 1 ? `${Math.ceil(s.timer)} 秒 · 按 G ${p && p.ready ? '取消准备' : '准备开战'}（${rc.n}/${rc.of}，全员准备提前开战 +${Math.floor(s.timer) * 3} 金币）` : `${Math.ceil(s.timer)} 秒 · 按 G 立即开战（+${Math.floor(s.timer) * 3} 金币）`);
    setClass($('phase'), 'build');
  } else if (s.phase === 'wave') {
    setText('waveTxt', `第 ${s.wave} / ${Wtxt} 波`);
    setText('phaseTxt', s.wave ? sim.waveDef(s.wave).name : '');
    setText('timerTxt', `剩余敌人 ${s.monsters.length + s.spawnQ.length}`);
    setClass($('phase'), 'wave');
  } else {
    setText('phaseTxt', s.phase === 'victory' ? '胜利' : '失败'); setText('timerTxt', '');
  }
  const boss = s.bossId ? s.monsters.find(m => m.id === s.bossId) : null;
  $('bossBar').hidden = !boss;
  if (boss) {
    const r = boss.hp / boss.maxHp, ph = r <= 0.25 ? 3 : r <= 0.6 ? 2 : 1;
    Music.inten = ph;
    setStyle($('bossFill'), 'width', (r * 100).toFixed(1) + '%'); setText('bossNum', `${Math.ceil(boss.hp)}`);
    setText('bossName', MON[boss.type].name + (ph === 3 ? ' · 狂暴' : ph === 2 ? ' · 第二阶段' : '') + (boss.shield > 0 ? ' · 护盾' : ''));
    $('bossBar').classList.toggle('ph3', ph === 3);
  }
  setText('goldNum', String(s.gold));
  setText('killNum', String(p ? p.kills : 0) + ' / ' + s.stats.kills);
  const nw = s.phase === 'build' && s.wave < sim.totalWaves() ? nextWaveHTML(s.wave + 1) : '';
  if (cache.nextWave !== nw) { cache.nextWave = nw; $('nextWave').innerHTML = nw; $('nextWave').hidden = !nw; }
  Snd.ambLevel(s.phase === 'wave' ? 0.075 : 0.045);
  updateTut(dt);
  Music.set(s.phase === 'victory' || s.phase === 'defeat' ? 'calm' : s.phase === 'wave' ? (s.bossId ? 'boss' : 'battle') : 'calm');
  if (p) {
    setStyle($('hpFill'), 'width', (p.hp / p.maxHp * 100).toFixed(1) + '%');
    setText('hpNum', String(Math.ceil(p.hp)));
    setText('ammoNum', p.reloadT > 0 ? '装填' : String(p.ammo));
    const W = WPN[p.wpn] || WPN.rifle, mt = myMount();
    if (mt && mt.type === 'mortar') {
      const left = mortarReady - timeNow;
      setText('ammoNum', left > 0 ? left.toFixed(1) + 's' : '就绪');
      setText('wpn', `等离子迫击炮 Lv${mt.lv} · F 离开`);
      setText('magNum', '装填');
    } else if (mt) {
      setText('ammoNum', p.overheat ? '过热' : Math.round((p.heat || 0) * 100) + '%');
      setText('wpn', `加特林炮塔 Lv${mt.lv} · F 离开`);
      setText('magNum', '热量');
      if (p.overheat && !cache.oh) Snd.play('overheat');
      cache.oh = !!p.overheat;
      const spinning = p.input.fire && !p.overheat;
      if (spinning && !cache.spinning && (p.spin || 0) < 0.3) Snd.play('spinUp');
      cache.spinning = spinning;
      if (MP.role === 'client' && (p.hostMount | 0) !== p.mount) { mountMiss += dt; if (mountMiss > 2.5) { dismount(); toast('队友已经在操控这座炮塔', true); } } else mountMiss = 0;
    } else {
      setText('wpn', `${W.name} · R 换弹 · Q 切枪 · B 军械库`);
      setText('magNum', '/ ' + p.mag);
    }
    setText('nadeN', String(p.nades));
    setStyle($('nadeFill'), 'width', (p.nades >= (p.nadeMax || SKILL.nade.max) ? 100 : (1 - p.nadeT / SKILL.nade.recharge) * 100).toFixed(0) + '%');
    $('skNade').classList.toggle('empty', p.nades < 1);
    setText('ultN', p.energy >= 100 ? '就绪' : Math.floor(p.energy) + '%');
    setStyle($('ultFill'), 'width', Math.min(100, p.energy).toFixed(0) + '%');
    $('skUlt').classList.toggle('ready', p.energy >= 100);
    const gs = $('hotbar').firstChild;
    if (gs && cache.gunSlot !== p.wpn) { cache.gunSlot = p.wpn; gs.querySelector('svg').outerHTML = svgIcon(p.wpn); gs.querySelector('.n').textContent = W.name; }
    if (shopOpen) renderShop();
    $('ammo').classList.toggle('low', mt ? (p.heat || 0) > 0.75 : p.ammo <= 6 && p.reloadT <= 0);
    $('deadMsg').hidden = !p.dead;
    if (p.dead) setText('respawnT', String(Math.ceil(p.respawnT)));
  }
  for (const el of document.querySelectorAll('#hotbar [data-id]')) {
    const id = el.dataset.id;
    if (el.classList.contains('locked')) { const ce = el.querySelector('.c'); if (ce && ce.textContent !== '未解锁') ce.textContent = '未解锁'; continue; }
    if (id !== 'gun') {
      const cst = sim.trapCost(id, PID); el.classList.toggle('poor', s.gold < cst);
      const ce = el.querySelector('.c'); if (ce && ce.textContent !== String(cst)) ce.textContent = cst;
    }
  }
  // 提示
  let pr = '', prCls = '', card = '';
  if (aim) {
    if (tool !== 'gun') {
      const d = TRAP[tool];
      if (aim.can && aim.can.ok) {
        pr = `左键放置 ${d.name}（${aim.can.cost} 金币）· 右键收起`; prCls = 'ok';
        if (sim.laneTurret(tool, aim.slot)) pr = `左键放到通道上：会挡住经过的怪物并被攻击（耐久 ${TD.LANE_HP[tool][0]}）· ${aim.can.cost} 金币`;
      }
      else { pr = (aim.can && aim.can.reason) || `对准${CAT_NAME[d.cat]}`; prCls = 'bad'; }
    }
    if (aim.trap && (tool === 'gun' || !aim.slot || (aim.can && !aim.can.ok))) {
      const tr = aim.trap, d = TRAP[tr.type];
      const up = sim.upgradeCost(tr, PID);
      // 信息卡只在 2 格以内显示，远处只高亮不弹卡
      const near = p && Math.hypot(tr.wx - p.x, tr.wz - p.z) <= T * (d.big ? 2.6 : 2.1);
      card = near ? trapCardHTML(tr, d, up, s.gold) : ''; pr = ''; prCls = '';
    }
  }
  const di = mode === 'play' ? nearDevice() : -1;
  if (di >= 0 && (!aim || !aim.trap) && tool === 'gun') {
    const dv = sim.def.devices[di], st = s.devices[di];
    pr = st.act > 0 ? `「${devName(dv)}」运行中 ${Math.ceil(st.act)} 秒` : st.cd > 0 ? `「${devName(dv)}」冷却中 ${Math.ceil(st.cd)} 秒` : `F 启动「${devName(dv)}」：${DEVICE[dv.type].desc}`;
    prCls = st.act <= 0 && st.cd <= 0 ? 'ok' : '';
  }
  const lo = mode === 'play' && tool === 'gun' && (!aim || !aim.trap) ? nearLabObj() : null;
  if (lo && p) {
    if (lo.kind === 'term') { pr = labOpen ? '按 1-5 研究科技 · F 关闭' : 'F 打开科研终端：用金币研究全队科技'; prCls = 'ok'; }
    else { pr = p.supT > 0 ? `补给柜冷却中 ${Math.ceil(p.supT)} 秒` : 'F 使用补给柜：补满生命、手雷、弹药，轨道打击充能 +25%'; prCls = p.supT > 0 ? '' : 'ok'; }
  }
  if (labOpen) { if (!lo || lo.kind !== 'term') toggleLab(false); else renderLab(); }
  // 加特林炮塔提示
  if (mode === 'play' && p && !p.dead) {
    const mt = myMount();
    if (mt && mt.type === 'mortar') {
      const a = mortarAim;
      pr = !a ? '准星对准地面选择落点' : !a.ok ? `落点 ${Math.round(a.d)} 米：超出射程（${TRAP.mortar.minRange}~${TRAP.mortar.range} 米）` : `落点 ${Math.round(a.d)} 米 · 左键开炮 · F / 空格 离开`;
      prCls = a && a.ok ? 'ok' : 'bad';
    } else if (mt) { pr = p.overheat ? '枪管过热，正在冷却…' : '按住左键扫射（枪管转起来后射速更快）· F / 空格 离开炮塔'; prCls = p.overheat ? 'bad' : 'ok'; }
    else if (tool === 'gun') {
      const g = nearGatling();
      if (g) { const gp = sim.gunnerOf(g), nm = TRAP[g.type].name; pr = gp && gp.id !== PID ? `${gp.name} 正在操控这座${nm}` : g.type === 'mortar' ? 'F 操控等离子迫击炮：亲手指定落点，冷却更短、伤害更高' : 'F 操控加特林炮塔：亲手扫射，对地对空都能打'; prCls = gp ? '' : 'ok'; }
    }
  }
  const tk = TD.TECH.map(t => sim.techLv(t.id)).join();
  if (cache.techBar !== tk) {
    cache.techBar = tk;
    const bar = $('techBar');
    bar.innerHTML = TD.TECH.map((t, i) => sim.techLv(t.id) ? `<span style="--tc:${TECH_CSS[i]}">${t.short} ${'Ⅰ Ⅱ Ⅲ'.split(' ')[sim.techLv(t.id) - 1]}</span>` : '').join('');
    bar.hidden = !bar.innerHTML;
  }
  if (TOUCH) pr = pr.replace('左键放置', '按「放置」放下').replace('左键放到', '按「放置」放到').replace(/\s*· 右键收起/, '');
  setText('prompt', pr); setClass($('prompt'), prCls);
  { const it = p && !p.dead && p.invT > 0 ? `复活保护 · 无敌 ${Math.ceil(p.invT)} 秒` : ''; if (cache.invTag !== it) { cache.invTag = it; $('invTag').textContent = it; $('invTag').hidden = !it; } }
  if (cache.trapCard !== card) { cache.trapCard = card; const el = $('trapCard'), m = /^<div style="--tcc:([^"]+)">/.exec(card); if (m) el.style.setProperty('--tcc', m[1]); el.innerHTML = card; el.hidden = !card; }
  if (TOUCH) updateTouchHUD(p, lo, di);
  // 自动准备：每波清除后稍等片刻自动按 G（同一波只触发一次，按 G 取消后不再自动）
  if (s.phase === 'build') { if (!autoReady.since) autoReady.since = performance.now(); } else autoReady.since = 0;
  if (settings.autoReady && mode === 'play' && s.phase === 'build' && s.wave > 0 && autoReady.wave !== s.wave && p && !p.ready && performance.now() - autoReady.since > 1500) {
    autoReady.wave = s.wave;
    netCmd({ t: 'ready', on: true }, r => { if (r.ok && r.bonus) toast(`自动准备：提前开战 +${r.bonus} 金币`); else if (r.ok && r.waiting) toast(`自动准备（${r.n}/${r.of}），等队友准备好就开战 · 按 G 取消`); });
  }
  // 准星
  const spread = p ? 7 + p.bloom * 22 + (keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD ? 4 : 0) - cam.ads * 4 : 7;
  setStyle($('cross'), '--g', spread.toFixed(1) + 'px');
  setClass($('cross'), tool === 'gun' ? '' : ('build ' + (aim && aim.can && aim.can.ok ? 'ok' : 'bad')));
  $('lockHint').hidden = !(mode === 'play' && !locked && !fallbackLook);
  // 效果
  hurtFx = Math.max(0, hurtFx - dt * 1.2);
  const lowHp = p && !p.dead ? clamp(1 - p.hp / 45, 0, 1) * 0.5 : 0;
  setStyle($('vignette'), 'opacity', Math.max(hurtFx, lowHp).toFixed(2));
  alarmT = Math.max(0, alarmT - dt);
  setStyle($('alarm'), 'opacity', (alarmT > 0 ? Math.abs(Math.sin(alarmT * 12)) * 0.8 : 0).toFixed(2));
  hitT -= dt; if (hitT <= 0 && $('hitmark').className) $('hitmark').className = '';
  bannerT -= dt; if (bannerT <= 0 && $('banner').classList.contains('on')) $('banner').classList.remove('on');
  toastT -= dt; if (toastT <= 0 && $('toast').classList.contains('on')) $('toast').classList.remove('on');
  mapTimer -= dt; if (mapTimer <= 0) { mapTimer = 0.07; drawMinimap(sim); }
}
function updateNums(dt) {
  for (const n of nums) {
    if (!n.on) continue;
    n.t += dt; n.y += n.vy * dt; n.vy *= 0.94;
    if (n.t > 0.9) { n.on = false; n.div.style.opacity = 0; continue; }
    const s = project(n.x, n.y, n.z);
    if (!s) { n.div.style.opacity = 0; continue; }
    n.div.style.opacity = n.t < 0.6 ? 1 : 1 - (n.t - 0.6) / 0.3;
    n.div.style.transform = `translate(${(s.x + n.ox * 30).toFixed(1)}px,${s.y.toFixed(1)}px) translate(-50%,-50%)`;
  }
}

/* ============================================================
 * 输入
 * ============================================================ */
function requestLock() {
  if (fallbackLook) return;
  if (!canvas.requestPointerLock) { lockFailed(); return; }
  // unadjustedMovement：读取原始鼠标位移（不经系统加速），也避开 Chrome 在 Windows 上偶发的位移跳变
  const plain = () => { try { const r2 = canvas.requestPointerLock(); if (r2 && r2.catch) r2.catch(() => lockFailed()); } catch (e) { lockFailed(); } };
  try {
    const r = canvas.requestPointerLock({ unadjustedMovement: true });
    if (r && r.catch) r.catch(err => { if (err && err.name === 'NotSupportedError') plain(); else lockFailed(); });
  } catch (e) { plain(); }
}
// 鼠标位移去尖峰：浏览器偶尔会报一个与前后完全不连续的巨大位移（锁定瞬间、掉帧合并事件、系统 bug），
// 视角就会突然甩一大圈。和最近几次位移相比明显离群的单个事件直接丢弃。
const look = { hist: [0, 0, 0], last: 0, skip: 0 };
function lookFilter(dx, dy) {
  const now = performance.now();
  if (now - look.last > 120) look.hist.fill(0);
  look.last = now;
  if (look.skip > 0) { look.skip--; return false; }
  const m = Math.hypot(dx, dy), avg = (look.hist[0] + look.hist[1] + look.hist[2]) / 3;
  // 只丢孤立的尖峰：连续两次大位移说明是真实的快速甩枪，第二次起照常生效
  if (m > 400 && m > avg * 6 + 120) { look.hist.push(m); look.hist.shift(); return false; }
  look.hist.push(m); look.hist.shift();
  return true;
}
function enableFallback() {
  if (fallbackLook) return;
  fallbackLook = true;
  toast('无法锁定鼠标：按住鼠标拖动转向，方向键也可转向', true);
}
function lockFailed() { if (mode !== 'play') return; if (!hadLock) enableFallback(); }
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (locked) { hadLock = true; look.skip = 2; look.hist.fill(0); panelUnlock = false; }
  // 只有按 Esc 才暂停：切窗口 / 切标签页导致的鼠标释放不暂停，游戏继续在后台运行，点一下画面即可重新锁定鼠标
  if (!locked && mode === 'play' && !fallbackLook && !panelUnlock) {
    setTimeout(() => {
      if (locked || mode !== 'play') return;
      if (document.hidden || !document.hasFocus()) { awayUnlock = true; return; }
      pauseGame();
    }, 120);
  }
});
let awayUnlock = false;
addEventListener('focus', () => { if (awayUnlock && mode === 'play' && !locked) toast('点击画面继续操作'); awayUnlock = false; });
/* ---------- 游戏内面板（军械库 / 科研终端 / 进阶 / 快捷消息）：打开时释放鼠标，方便点选和关闭 ---------- */
let panelUnlock = false;
function anyPanel() { return shopOpen || labOpen || evoTrap !== null || quickOpen || chatOpen || bookOpen; }
function panelOpened(needMouse) {
  if (!needMouse || !locked) return;
  panelUnlock = true;
  try { document.exitPointerLock(); } catch (e) { /* 忽略 */ }
}
function panelClosed() {
  if (anyPanel() || !panelUnlock) return;
  panelUnlock = false;
  if (mode === 'play' && !locked && !fallbackLook) requestLock();
}
function closePanels() {
  if (bookOpen) toggleBook(false);
  if (shopOpen) toggleShop(false);
  if (labOpen) toggleLab(false);
  if (evoTrap !== null) closeEvo();
  if (quickOpen) toggleQuick(false);
  if (chatOpen) closeChat();
}
document.addEventListener('pointerlockerror', lockFailed);
addEventListener('mousemove', e => {
  if (mode !== 'play') return;
  if (locked || (fallbackLook && mouse.any)) {
    if (!lookFilter(e.movementX || 0, e.movementY || 0)) return;
    const k = 0.0022 * settings.sens * (1 - cam.ads * (cache.scope ? 0.75 : 0.4));
    cam.yaw -= e.movementX * k;
    cam.pitch = clamp(cam.pitch - e.movementY * k, -1.5, 1.5);
  }
});
canvas.addEventListener('mousedown', e => {
  if (mode !== 'play') return;
  Snd.init();
  closePop();
  // 打开面板时鼠标已释放：点画面空白处 = 关闭面板并回到游戏
  if (anyPanel()) { closePanels(); if (!locked && !fallbackLook) requestLock(); return; }
  if (!locked && !fallbackLook) { requestLock(); return; }
  if (e.button === 1 || e.button === 3 || e.button === 4) {
    const code = remapKey('Mouse' + (e.button === 1 ? 3 : e.button + 1));
    if (code && !code.startsWith('Mouse')) { e.preventDefault(); onKey(code, { code, repeat: false, preventDefault() {} }); setTimeout(() => { keys[code] = false; }, 120); }
    return;
  }
  if (e.button === 0) {
    mouse.l = true;
    if (tool !== 'gun') tryPlace();
  } else if (e.button === 2) {
    mouse.r = true;
    if (tool !== 'gun') selectTool('gun');
  }
  mouse.any = true;
});
addEventListener('mouseup', e => { if (e.button === 0) mouse.l = false; if (e.button === 2) mouse.r = false; mouse.any = mouse.l || mouse.r; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
addEventListener('wheel', e => {
  if (mode !== 'play') return;
  const ids = ['gun', ...TRAP_GROUPS.flatMap(g => g.traps).filter(isUnlocked)];
  let i = ids.indexOf(tool);
  i = (i + (e.deltaY > 0 ? 1 : -1) + ids.length) % ids.length;
  selectTool(ids[i]);
}, { passive: true });
addEventListener('keydown', e => {
  if (keyCapture) { e.preventDefault(); e.stopPropagation(); finishKeyCapture(e.code); return; }
  if (e.target && e.target.matches && e.target.matches('input:not([type=range]):not([type=checkbox]), textarea')) return;   // 正在输入文字
  const code = e.isTrusted ? remapKey(e.code) : e.code;
  if (code === null) return;
  onKey(code, e);
});
function onKey(code, e) {
  if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && mode === 'play') e.preventDefault();
  // 整页浮层（设置 / 图鉴 / 天赋）优先响应 Esc
  if (code === 'Escape' || (code === 'KeyH' && !$('help').hidden)) {
    if (!$('settings').hidden) { closeSettings(); return; }
    if (!$('help').hidden) { closeHelp(); return; }
    if (!$('talents').hidden) { show('talents', false); return; }
    if (!$('lb').hidden) { show('lb', false); return; }
  }
  if (e.repeat && !['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(code)) { keys[code] = true; return; }
  keys[code] = true;
  if (mode === 'pause' && (code === 'Escape' || code === 'KeyP') && fallbackLook) { resumeGame(); return; }
  if (mode !== 'play') return;
  const d = code.match(/^Digit([1-9])$/);
  if ((code === 'Enter' || code === 'NumpadEnter') && !e.repeat) { openChat(); e.preventDefault(); return; }
  if (d && quickOpen) { sendQuick(+d[1] - 1); return; }
  if (quickOpen && code === 'Escape') { toggleQuick(false); return; }
  if (d && evoTrap !== null) { if (d[1] === '1' || d[1] === '2') chooseEvo(d[1] === '1' ? 'a' : 'b'); return; }
  if (evoTrap !== null && (code === 'Escape' || code === 'KeyE')) { closeEvo(); return; }
  if (d && labOpen) { doResearch(+d[1] - 1); return; }
  if (labOpen && code === 'Escape') { toggleLab(false); return; }
  if (d && shopOpen) { buyWeapon(+d[1] - 1); return; }
  if (d && bookOpen) { trapKey(+d[1]); return; }
  if (d) { trapKey(+d[1]); return; }
  if (code === 'Tab') { e.preventDefault && e.preventDefault(); toggleBook(); return; }
  if (bookOpen && code === 'Escape') { toggleBook(false); return; }
  if (shopOpen && code === 'Escape') { toggleShop(false); return; }
  switch (code) {
    case 'KeyQ': if (myMount()) break; if (tool !== 'gun') selectTool('gun'); else cycleWeapon(); break;
    case 'Space': if (myMount()) dismount(); break;
    case 'KeyB': toggleShop(); break;
    case 'KeyF': useDevice(); break;
    case 'KeyT': doPing(); break;
    case 'KeyV': toggleQuick(); break;
    case 'KeyC': throwNade(); break;
    case 'KeyZ': callStrike(); break;
    case 'KeyR': if (!myMount()) reloadReq = true; break;
    case 'KeyE': doUpgrade(); break;
    case 'KeyX': doSell(); break;
    case 'KeyG': case 'Enter': {
      if (sim.s.phase === 'build') {
        const me = sim.s.players[PID];
        netCmd({ t: 'ready', on: !(me && me.ready) }, r => {
          if (r.ok && r.bonus) toast(`提前开战 +${r.bonus} 金币`);
          else if (r.ok && r.waiting) toast(sim.s.players[PID] && sim.s.players[PID].ready ? `已准备（${r.n}/${r.of}），等队友都准备好就开战` : '已取消准备');
        });
      }
      break;
    }
    case 'KeyM': bigMap = !bigMap; $('mapWrap').classList.toggle('big', bigMap); break;
    case 'KeyH': case 'F1': e.preventDefault(); openHelp(); break;
    case 'Escape': case 'KeyP': if (fallbackLook || code === 'KeyP') pauseGame(); break;
  }
}
addEventListener('keyup', e => { const code = e.isTrusted ? remapKey(e.code) : e.code; if (code) keys[code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouse.l = mouse.r = mouse.any = false; });

function tryPlace() {
  if (sim && mode === 'play') aim = computeAim();
  if (!aim || tool === 'gun') return;
  if (!aim.slot || !aim.can || !aim.can.ok) { toast(aim.can ? (aim.can.reason || '无法放置') : '无法放置', true); Snd.play('deny'); return; }
  const sl = aim.slot, t = tool;
  netCmd({ t: 'build', trap: t, slot: { kind: sl.kind, x: sl.x, z: sl.z, dir: sl.dir || 0 } }, r => { if (!r.ok) { toast(r.reason || '无法放置', true); Snd.play('deny'); } });
}
function doUpgrade() {
  if (sim && mode === 'play') aim = computeAim();
  if (!aim || !aim.trap) { toast('对准一个陷阱再按 E 升级', true); return; }
  const tr = aim.trap, lv = tr.lv;
  if (lv >= MAX_LV) { toast(`${TRAP[tr.type].name} 已满级`, true); return; }
  if (lv === MAX_LV - 1) { openEvo(tr); return; }
  netCmd({ t: 'upgrade', id: tr.id }, r => { if (r.ok) toast(`${TRAP[tr.type].name} 升至 Lv${lv + 1}`); else { toast(r.reason || '无法升级', true); Snd.play('deny'); } });
}
function doSell() {
  if (sim && mode === 'play') aim = computeAim();
  if (!aim || !aim.trap) { toast('对准一个陷阱再按 X 拆除', true); return; }
  const tr = aim.trap;
  netCmd({ t: 'sell', id: tr.id }, r => { if (r.ok) toast(`已拆除 ${TRAP[tr.type].name}，返还 ${r.refund} 金币`); else if (r.reason) toast(r.reason, true); });
}
/* ---------- 标记与快捷消息 ---------- */
const QUICK = ['需要支援！', '我来守这里', '注意飞行敌人', 'BOSS 来了，集火！', '我去买枪 / 补陷阱', '谢谢！'];
const pingMarks = [];
const seenSig = new Map();
let quickOpen = false, sigSeq = 0;
function myColor() { const p = me(); return TEAM_CSS[p ? p.slot % 4 : 0]; }
function addPingMark(kind, x, y, z, mid, slot, name) {
  const col3 = TEAM_COL[slot % 4];
  if (pingMarks.length > 12) { const o = pingMarks.shift(); if (o.el) o.el.remove(); }
  const el = document.createElement('div'); el.className = 'ping'; el.style.setProperty('--tc', TEAM_CSS[slot % 4]);
  el.innerHTML = `<i>${kind ? '⚠' : '◆'}</i><b></b><span></span>`;
  el.querySelector('b').textContent = name + (kind ? ' 标记了敌人' : ' 标记了这里');
  $('tags').appendChild(el);
  pingMarks.push({ kind, x, y, z, mid, c: col3, t: 0, el });
  Snd.play('ping');
}
function doPing() {
  const p = me(); if (!p || p.dead) return;
  // 先找视线附近的敌人，再找命中的地面 / 墙面
  let best = null, bd = 1e9;
  for (const m of sim.s.monsters) {
    if (m.dead || m.cloak || m.burrow) continue;
    const def = MON[m.type], cy = m.y + def.body[0];
    const lx = m.x - cam.x, ly = cy - cam.y, lz = m.z - cam.z, tca = lx * cam.fx + ly * cam.fy + lz * cam.fz;
    if (tca < 0 || tca > 80) continue;
    const d2 = lx * lx + ly * ly + lz * lz - tca * tca, rr = def.body[1] + 0.8 + tca * 0.02;
    if (d2 < rr * rr && tca < bd) { const h = sim.raycast(cam.x, cam.y, cam.z, cam.fx, cam.fy, cam.fz, tca); if (!h) { bd = tca; best = m; } }
  }
  let sig;
  if (best) sig = [++sigSeq, 1, r2n(best.x), r2n(best.y + MON[best.type].body[0]), r2n(best.z), best.id];
  else {
    const h = sim.raycast(cam.x, cam.y, cam.z, cam.fx, cam.fy, cam.fz, 90);
    if (!h) { toast('对准地面、墙面或敌人按 T 标记', true); return; }
    sig = [++sigSeq, 0, r2n(h.px), r2n(h.py), r2n(h.pz), 0];
  }
  addPingMark(sig[1], sig[2], sig[3], sig[4], sig[5], p.slot, '你');
  if (MP.role !== 'solo') { MP.ping = sig; if (MP.role === 'host') hostPresence(); else clientPresence(true); }
}
function toggleQuick(on) {
  quickOpen = on === undefined ? !quickOpen : on;
  $('qchat').hidden = !quickOpen;
  if (!quickOpen) panelClosed();
  if (quickOpen) { if (shopOpen) toggleShop(false); if (evoTrap !== null) closeEvo(); if (labOpen) toggleLab(false); }
}
function sendQuick(i) {
  if (!QUICK[i]) return;
  toggleQuick(false);
  feed(`你：${QUICK[i]}`, 'good'); Snd.play('ping');
  if (MP.role !== 'solo') { MP.qc = [++sigSeq, i]; if (MP.role === 'host') hostPresence(); else clientPresence(true); }
}
/* ---------- 文字聊天：Enter 打开输入框，Enter 发送，Esc 取消 ---------- */
let chatOpen = false, chatLast = 0;
function cleanChat(t) { return String(t || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60); }
// 左下角聊天记录：10 秒后淡出，打开输入框时重新显示最近几条
function chatLine(name, col, text) {
  const box = $('chatLog'), el = document.createElement('div'), b = document.createElement('b');
  el.className = 'cm'; b.textContent = name + '：'; b.style.color = col;
  el.append(b, document.createTextNode(text));
  box.appendChild(el);
  while (box.children.length > 6) box.removeChild(box.firstChild);
  setTimeout(() => el.classList.add('old'), 10000);
}
function openChat() {
  if (mode !== 'play') return;
  if (shopOpen) toggleShop(false); if (labOpen) toggleLab(false); if (evoTrap !== null) closeEvo(); if (quickOpen) toggleQuick(false);
  for (const k in keys) keys[k] = false;
  mouse.l = mouse.r = false; mouse.any = false;
  chatOpen = true; $('chatBox').hidden = false; $('leftDock').classList.add('chatting');
  panelOpened(true);
  const inp = $('chatIn'); inp.value = '';
  setTimeout(() => { if (chatOpen) inp.focus(); }, 0);
}
function closeChat() {
  if (!chatOpen) return;
  chatOpen = false; $('chatBox').hidden = true; $('leftDock').classList.remove('chatting');
  const inp = $('chatIn'); if (document.activeElement === inp) inp.blur();
  panelClosed();
}
function sendChat() {
  const t = cleanChat($('chatIn').value);
  closeChat();
  if (!t) return;
  const now = performance.now();
  if (now - chatLast < 700) { toast('发得太快了，稍等一下', true); return; }
  chatLast = now;
  const p = me();
  chatLine('你', TEAM_CSS[p ? p.slot % 4 : 0], t); Snd.play('ping');
  if (MP.role !== 'solo') { MP.ch = [++sigSeq, t]; if (MP.role === 'host') hostPresence(); else clientPresence(true); }
}
function initChat() {
  const inp = $('chatIn');
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendChat(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
  });
  inp.addEventListener('keyup', e => e.stopPropagation());
  inp.addEventListener('blur', () => setTimeout(() => { if (chatOpen && document.activeElement !== inp) closeChat(); }, 150));
  $('chatSend').addEventListener('pointerdown', e => { e.preventDefault(); sendChat(); });
  $('qcType').addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); openChat(); });
}
// 读取其他玩家 presence 里的标记 / 快捷消息 / 文字聊天
function peerSignals(peers) {
  for (const pe of peers) {
    if (pe.isMe || pe.kind !== 'viewer') continue;
    const pr = pe.presence || {};
    const pg = Array.isArray(pr.pg) && pr.pg.length >= 6 && pr.pg.slice(1, 5).every(Number.isFinite) ? pr.pg : null;
    const qc = Array.isArray(pr.qc) && pr.qc.length >= 2 ? pr.qc : null;
    const seen = seenSig.get(pe.peer);
    // 第一次看到这名玩家：只记录，不回放旧标记
    const ch = Array.isArray(pr.ch) && pr.ch.length >= 2 && typeof pr.ch[1] === 'string' ? pr.ch : null;
    if (!seen) { seenSig.set(pe.peer, { pg: pg ? pg[0] : null, qc: qc ? qc[0] : null, ch: ch ? ch[0] : null }); continue; }
    const q = sim && sim.s.players[pe.peer], slot = q ? q.slot : 1, name = (q && q.name) || cleanName(pr.n) || '队友';
    if (pg && pg[0] !== seen.pg) { seen.pg = pg[0]; if (sim && mode !== 'menu') addPingMark(pg[1] ? 1 : 0, pg[2], pg[3], pg[4], pg[5] | 0, slot, name); }
    if (qc && qc[0] !== seen.qc) { seen.qc = qc[0]; if (QUICK[qc[1] | 0] && mode !== 'menu') { feed(`${name}：${QUICK[qc[1] | 0]}`, 'good'); Snd.play('ping'); } }
    if (ch && ch[0] !== seen.ch) { seen.ch = ch[0]; const t = cleanChat(ch[1]); if (t && mode !== 'menu') { chatLine(name, TEAM_CSS[slot % 4], t); Snd.play('ping'); } }
  }
}
function drawPings(dt) {
  for (let i = pingMarks.length - 1; i >= 0; i--) {
    const k = pingMarks[i]; k.t += dt;
    if (k.t > 6 || !sim) { if (k.el) k.el.remove(); pingMarks.splice(i, 1); continue; }
    if (k.kind && k.mid) { const m = sim._mById.get(k.mid); if (m) { k.x = m.x; k.z = m.z; k.y = m.y + MON[m.type].body[0]; } }
    const a = k.t > 5 ? 6 - k.t : 1, c3 = k.c;
    E.pushBeam('box', k.x, k.kind ? k.y + 0.8 : k.y, k.z, k.x, k.y + 7, k.z, 0.06, 0.06, c(c3[0], c3[1], c3[2], 0.6 * a, 1, 0, true));
    E.push('ring', k.x, k.kind ? k.y : k.y + 0.05, k.z, timeNow * 3, 0.9 + 0.2 * Math.sin(timeNow * 6), 1, 0.9 + 0.2 * Math.sin(timeNow * 6), c(c3[0], c3[1], c3[2], a, 1, 0, true));
    const sp = project(k.x, k.y + 1.2, k.z);
    if (!sp) { k.el.style.opacity = 0; continue; }
    k.el.style.opacity = a;
    k.el.style.transform = `translate(${sp.x.toFixed(1)}px,${sp.y.toFixed(1)}px) translate(-50%,-100%)`;
    k.el.querySelector('span').textContent = Math.round(Math.hypot(k.x - cam.x, k.z - cam.z)) + ' 米';
  }
}

/* ---------- 地图机关 ---------- */
function devName(dv) { return DEVICE[dv.type].name + (dv.tag ? `（${dv.tag}）` : ''); }
function nearDevice() {
  const p = me(); if (!p || p.dead || !sim.def.devices) return -1;
  let best = -1, bd = 3.2;
  sim.def.devices.forEach((dv, i) => { const w = sim.deviceWorld(dv), d = Math.hypot(p.x - w.x, p.z - w.z); if (d < bd) { bd = d; best = i; } });
  return best;
}
/* ---------- 加特林炮塔：坐上去亲手扫射 ---------- */
function myMount() { const p = sim && sim.s.players[PID]; return p && p.mount ? sim.mountOf(p) : null; }
// 附近可以操控的炮塔（加特林 / 迫击炮）：优先准星对着的那座，其次最近的
function nearGatling() {
  const p = sim && sim.s.players[PID]; if (!p || p.dead) return null;
  const MT = TD.MOUNTABLE, reach = tr => MT[tr.type] ? MT[tr.type].reach : -1;
  if (aim && aim.trap && Math.hypot(aim.trap.wx - p.x, aim.trap.wz - p.z) <= reach(aim.trap)) return aim.trap;
  let best = null, bd = 1e9;
  for (const tr of sim.s.traps) { const d = Math.hypot(tr.wx - p.x, tr.wz - p.z); if (d <= reach(tr) && d - reach(tr) < bd) { bd = d - reach(tr); best = tr; } }
  return best;
}
// 迫击炮落点：准星射线打到的地面
let mortarAim = null, mortarReady = 0;
function updateMortarAim(mt) {
  const def = TRAP.mortar, hit = sim.raycast(cam.x, cam.y, cam.z, cam.fx, cam.fy, cam.fz, def.range + 20);
  if (!hit) { mortarAim = null; return; }
  const x = cam.x + cam.fx * hit.t, z = cam.z + cam.fz * hit.t, d = Math.hypot(x - mt.wx, z - mt.wz);
  mortarAim = { x, z, y: sim.floorH(x, z), d, ok: d >= def.minRange && d <= def.range };
}
function tryMortarFire(mt) {
  if (!mortarAim || timeNow < mortarReady) return;
  if (!mortarAim.ok) { if (timeNow > (mortarAim.warnT || 0)) { toast(`超出射程：落点要在 ${TRAP.mortar.minRange}~${TRAP.mortar.range} 米之间`, true); mortarAim.warnT = timeNow + 1.5; } return; }
  mortarReady = timeNow + TRAP.mortar.cd[mt.lv - 1] * TD.MORTAR_MAN.cd;
  netCmd({ t: 'mfire', x: Math.round(mortarAim.x * 100) / 100, z: Math.round(mortarAim.z * 100) / 100 }, r => {
    if (r.ok) { mortarReady = timeNow + (r.cd || 0); shake(0.2); }
    else { mortarReady = timeNow + (r.cd || 0.3); if (r.reason) toast(r.reason, true); }
  });
}
function drawMortarAim(mt) {
  if (!mortarAim) return;
  const a = mortarAim, gc = a.ok ? (timeNow >= mortarReady ? [0.4, 1, 0.55] : [1, 0.8, 0.3]) : [1, 0.3, 0.3], R = TRAP.mortar.splash;
  E.push('ring', a.x, a.y + 0.06, a.z, timeNow, R, 1, R, c(gc[0], gc[1], gc[2], 0.75, 1, 0, true));
  E.push('ring', a.x, a.y + 0.06, a.z, -timeNow * 2, 0.6, 1, 0.6, c(gc[0], gc[1], gc[2], 0.9, 1, 0, true));
  E.push('cyl', a.x, a.y + 1.5, a.z, 0, 0.05, 3, 0.05, c(gc[0], gc[1], gc[2], 0.5, 1, 0, true));
  // 弹道预览
  const x0 = mt.wx, y0 = mt.wy + 2.4, z0 = mt.wz, hgt = 4 + a.d * 0.35;
  for (let i = 1; i < 14; i++) {
    const f = i / 14, x = lerp(x0, a.x, f), z = lerp(z0, a.z, f), y = lerp(y0, a.y, f) + Math.sin(f * Math.PI) * hgt;
    E.push('sphere', x, y, z, 0, 0.12, 0.12, 0.12, c(gc[0], gc[1], gc[2], 0.6, 1, 0, true));
  }
  // 射程圈
  for (const r of [TRAP.mortar.minRange, TRAP.mortar.range]) E.push('ring', mt.wx, mt.wy + 0.08, mt.wz, 0, r, 1, r, c(1, 0.55, 0.2, 0.18, 1, 0, true));
}
function mountGatling(tr) {
  const p = sim.s.players[PID];
  const r = sim.setMount(p, tr.id);
  if (!r.ok) { toast(r.reason || '无法操控', true); Snd.play('deny'); return; }
  selectTool('gun'); mountMiss = 0;
  cam.yaw = tr.aimYaw || cam.yaw; cam.pitch = tr.type === 'mortar' ? -0.45 : 0;
  Snd.play('build');
  toast(tr.type === 'mortar' ? '已操控等离子迫击炮 · 准星对准地面，左键开炮 · F / 空格 离开' : '已操控加特林炮塔 · 按住左键扫射 · F / 空格 离开');
}
function dismount() { const p = sim && sim.s.players[PID]; if (p && p.mount) { sim.setMount(p, 0); Snd.play('jump'); } }
let mountMiss = 0;
function useDevice() {
  if (myMount()) { dismount(); return; }
  if (labOpen) { toggleLab(false); return; }
  { const g = nearGatling(); if (g) { mountGatling(g); return; } }
  const lo = nearLabObj();
  if (lo) { if (lo.kind === 'term') toggleLab(true); else doResupply(); return; }
  const i = nearDevice();
  if (i < 0) { if (sim) toast('走到机关控制台（小地图 ◆）、科研终端或补给柜（小地图「科」）旁再按 F', true); return; }
  netCmd({ t: 'use', dev: i }, r => { if (!r.ok && r.reason) { toast(r.reason, true); Snd.play('deny'); } });
}
function drawDevices(S, dt) {
  const defs = S.def.devices; if (!defs) return;
  defs.forEach((dv, i) => {
    const st = S.s.devices[i], act = st.act > 0, ready = !act && st.cd <= 0;
    const w = S.deviceWorld(dv), sc = act ? [0.4, 0.9, 1] : ready ? [0.35, 1, 0.55] : [1, 0.35, 0.3];
    // 控制台
    E.push('box', w.x, 0.55, w.z, 0, 0.7, 1.1, 0.5, c(0.24, 0.25, 0.28));
    E.pushR('box', w.x, 1.2, w.z, 0, -0.5, 0, 0.62, 0.36, 0.06, c(sc[0], sc[1], sc[2], 1, ready ? 0.6 + 0.4 * Math.sin(timeNow * 4) : 0.9));
    E.push('box', w.x + 0.42, 1.05, w.z, 0, 0.06, 0.5, 0.06, c(0.6, 0.6, 0.62));
    E.push('sphere', w.x + 0.42, act ? 0.85 : 1.32, w.z, 0, 0.13, 0.13, 0.13, c(1, 0.4, 0.25, 1, 0.5));
    E.push('cyl', w.x, 2.4, w.z, timeNow, 0.08, 1.6, 0.08, c(sc[0], sc[1], sc[2], 0.35, 1, 0, true));
    E.push('ring', w.x, 0.05, w.z, timeNow * 2, 1.2, 1, 1.2, c(sc[0], sc[1], sc[2], 0.6, 1, 0, true));
    const a = dv.area, x0 = a[0] * T, z0 = a[1] * T, x1 = (a[2] + 1) * T, z1 = (a[3] + 1) * T, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    if (dv.type === 'cryo') {
      for (let tz = a[1]; tz <= a[3]; tz += 2) for (let tx = a[0]; tx <= a[2]; tx += 2) {
        if (S.solid(tx, tz)) continue;
        const px = (tx + 0.5) * T, pz = (tz + 0.5) * T;
        E.push('cyl', px, WALL_H - 0.25, pz, 0, 0.3, 0.5, 0.3, c(0.5, 0.55, 0.6));
        E.push('cyl', px, WALL_H - 0.52, pz, 0, 0.18, 0.06, 0.18, c(0.5, 0.85, 1, 1, act ? 1 : 0.2));
        if (act && Math.random() < 0.9) particle({ x: px + rnd(-0.3, 0.3), y: WALL_H - 0.6, z: pz + rnd(-0.3, 0.3), vx: rnd(-1.5, 1.5), vy: rnd(-6, -3), vz: rnd(-1.5, 1.5), life: rnd(0.6, 1), s0: 0.12, s1: 0.5, c: [0.75, 0.92, 1], a0: 0.5, grav: 2, drag: 0.5 });
      }
      if (act) { E.push('box', cx, 0.04, cz, 0, x1 - x0, 0.02, z1 - z0, c(0.6, 0.85, 1, 0.25, 0.6, 0, true)); flashLight(cx, 3, cz, 14, [0.5, 0.8, 1], 1.4, 0.02); }
    } else if (dv.type === 'gate') {
      // 闸门横跨区域上游边：平时收在天花板里，启动时落下
      const k = act ? clamp((DEVICE.gate.dur - st.act) / 0.35, 0, 1) * clamp(st.act / 0.4, 0, 1) : 0;
      const gy = lerp(WALL_H + 2.5, WALL_H / 2, k);
      E.push('box', cx, gy, z0 + 0.15, 0, x1 - x0, WALL_H, 0.3, c(0.35, 0.33, 0.3));
      for (let j = 0; j < 6; j++) E.push('box', x0 + (j + 0.5) * (x1 - x0) / 6, gy - WALL_H / 2 + 0.4, z0 - 0.02, 0, 0.12, 0.6, 0.06, c(1, 0.6, 0.15, 1, act ? 1 : 0.3));
      E.push('box', x0 - 0.15, WALL_H / 2, z0 + 0.15, 0, 0.3, WALL_H, 0.5, c(0.25, 0.25, 0.27));
      E.push('box', x1 + 0.15, WALL_H / 2, z0 + 0.15, 0, 0.3, WALL_H, 0.5, c(0.25, 0.25, 0.27));
    } else if (dv.type === 'vent') {
      for (let tz = a[1]; tz <= a[3]; tz++) for (let tx = a[0]; tx <= a[2]; tx++) {
        if (S.solid(tx, tz) || (tx + tz) % 2) continue;
        const px = (tx + 0.5) * T, pz = (tz + 0.5) * T;
        E.push('box', px, 0.03, pz, 0, 1.2, 0.04, 1.2, c(0.12, 0.1, 0.09));
        for (let j = -1; j <= 1; j++) E.push('box', px + j * 0.35, 0.05, pz, 0, 0.12, 0.02, 1.0, c(1, 0.45, 0.1, 1, act ? 1 : 0.25));
        if (act && Math.random() < 0.6) particle({ x: px + rnd(-0.5, 0.5), y: 0.1, z: pz + rnd(-0.5, 0.5), vx: rnd(-0.5, 0.5), vy: rnd(5, 9), vz: rnd(-0.5, 0.5), life: rnd(0.4, 0.7), s0: 0.3, s1: 0.9, c: [1, rnd(0.35, 0.6), 0.1], drag: 1.5, a0: 0.55 });
      }
      if (act) flashLight(cx, 2, cz, 16, [1, 0.5, 0.15], 2.2, 0.02);
    } else if (dv.type === 'gravity') {
      E.push('ring', cx, WALL_H - 0.3, cz, timeNow * (act ? 3 : 0.5), 3, 1, 3, c(0.75, 0.5, 1, 1, act ? 1 : 0.3));
      E.push('cyl', cx, WALL_H - 0.15, cz, 0, 2.4, 0.3, 2.4, c(0.22, 0.2, 0.28));
      if (act) {
        for (let r = 0; r < 3; r++) { const ph = ((timeNow * 0.8 + r / 3) % 1); E.push('ring', cx, WALL_H - ph * (WALL_H - 0.3), cz, timeNow, (x1 - x0) * 0.5 * (1 - ph * 0.5), 1, (z1 - z0) * 0.5 * (1 - ph * 0.5), c(0.7, 0.45, 1, 0.6 * (1 - ph), 1, 0, true)); }
        flashLight(cx, 3, cz, 14, [0.7, 0.45, 1], 1.4, 0.02);
      }
    }
  });
}

/* ---------- 科研舱 ---------- */
// 五项科技各一种颜色：超频 橙 / 装甲 青 / 回收 金 / 弹药 粉 / 维修 绿
const TECH_COL = [[1, 0.5, 0.18], [0.37, 0.89, 1], [1, 0.84, 0.3], [1, 0.42, 0.6], [0.42, 1, 0.6]];
const TECH_CSS = TECH_COL.map(a => `rgb(${a.map(v => Math.round(v * 255)).join(',')})`);
function setMX(x, y, z, yaw) { MX.x = x; MX.y = y; MX.z = z; MX.yaw = yaw; MX.cy = Math.cos(yaw); MX.sy = Math.sin(yaw); MX.s = 1; }
function labHolo(S, lb) { return { x: lb.holo[0] * T, z: lb.holo[1] * T }; }
function buildLabStatic(S, TH) {
  const UP = TH.upper;
  for (const lb of S.def.labs || []) {
    // 服务器机柜：顶部色条标明对应的科技
    lb.racks.forEach((o, i) => {
      const w = S.labObj(o), tc = TECH_COL[i];
      setMX(w.x, S.floorH(w.x, w.z), w.z, w.yaw);
      P('box', 0, 1.35, -0.12, 1.8, 2.7, 0.95, col(0.12, 0.13, 0.16, 1, 0, 0, 2));
      P('box', 0, 1.3, 0.37, 1.6, 2.45, 0.03, c(0.045, 0.055, 0.07));
      for (let k = 0; k < 7; k++) P('box', -0.2, 0.36 + k * 0.29, 0.39, 1.05, 0.035, 0.02, c(UP[0] * 0.6, UP[1] * 0.6, UP[2] * 0.6, 1, 0.45));
      P('box', 0, 2.78, 0.3, 1.8, 0.14, 0.06, c(tc[0], tc[1], tc[2], 1, 0.7));
      P('box', 0.86, 1.3, 0.38, 0.05, 2.45, 0.03, c(0.3, 0.32, 0.36));
      if (!S.outdoor) {
        P('cyl', 0.45, (2.7 + WALL_H) / 2, -0.4, 0.22, WALL_H - 2.7, 0.22, c(0.08, 0.08, 0.1));
        P('cyl', -0.45, (2.7 + WALL_H) / 2, -0.4, 0.16, WALL_H - 2.7, 0.16, c(0.1, 0.1, 0.12));
      }
    });
    // 科研终端：控制台 + 大屏
    let w = S.labObj(lb.term);
    setMX(w.x, S.floorH(w.x, w.z), w.z, w.yaw);
    P('box', 0, 0.5, -0.05, 2.1, 1.0, 0.95, col(0.2, 0.22, 0.26, 1, 0, 0, 2));
    PR('box', 0, 1.05, 0.12, 0.35, 0, 1.95, 0.07, 0.62, c(0.1, 0.11, 0.14));
    P('box', 0, 1.09, 0.14, 1.6, 0.02, 0.4, c(UP[0], UP[1], UP[2], 1, 0.35));
    P('box', 0, 1.35, -0.38, 0.22, 0.7, 0.12, c(0.16, 0.17, 0.2));
    P('box', 0, 2.3, -0.36, 2.4, 1.5, 0.12, c(0.13, 0.14, 0.17));
    P('box', 0, 2.3, -0.295, 2.24, 1.34, 0.02, c(0.02, 0.06, 0.08, 1, 0.25));
    P('box', 0, 3.17, -0.36, 2.4, 0.16, 0.1, c(UP[0], UP[1], UP[2], 1, 0.9));
    // 补给柜 + 弹药箱
    w = S.labObj(lb.sup);
    setMX(w.x, S.floorH(w.x, w.z), w.z, w.yaw);
    P('box', 0, 1.2, -0.1, 1.6, 2.4, 0.95, col(0.16, 0.21, 0.18, 1, 0, 0, 2));
    for (const sx of [-0.39, 0.39]) { P('box', sx, 1.12, 0.385, 0.74, 2.1, 0.04, c(0.21, 0.27, 0.23)); P('box', sx * 0.2, 1.15, 0.42, 0.04, 0.36, 0.04, c(0.6, 0.62, 0.64)); }
    P('box', 0, 1.82, 0.42, 0.52, 0.15, 0.02, c(0.35, 1, 0.5, 1, 0.55));
    P('box', 0, 1.82, 0.42, 0.15, 0.52, 0.02, c(0.35, 1, 0.5, 1, 0.55));
    P('box', -1.28, 0.36, 0.1, 0.72, 0.72, 0.72, c(0.3, 0.29, 0.19));
    P('box', -1.22, 0.98, 0.06, 0.56, 0.52, 0.56, c(0.26, 0.26, 0.17));
    P('box', -1.28, 0.36, 0.47, 0.5, 0.08, 0.01, c(1, 0.75, 0.2, 1, 0.6));
    // 全息沙盘台
    const h = labHolo(S, lb), hg = S.floorH(h.x, h.z);
    E.push('cyl', h.x, hg + 0.45, h.z, 0, 1.7, 0.9, 1.7, col(0.13, 0.14, 0.17, 1, 0, 0, 2));
    E.push('cyl', h.x, hg + 0.93, h.z, 0, 1.9, 0.06, 1.9, c(0.22, 0.24, 0.28));
    E.push('ring', h.x, hg + 0.97, h.z, 0, 0.92, 1, 0.92, c(UP[0], UP[1], UP[2], 1, 0.55));
    E.push('ring', h.x, hg + 0.015, h.z, 0, 2.0, 1, 2.0, c(UP[0], UP[1], UP[2], 1, 0.3));
    E.push('ring', h.x, hg + 0.015, h.z, 0, 1.35, 1, 1.35, c(UP[0], UP[1], UP[2], 1, 0.16));
  }
}
function drawLabs(S, dt) {
  const labs = S.def.labs; if (!labs) return;
  const p = me(), lvs = TD.TECH.map(t => S.techLv(t.id)), t = timeNow;
  for (const lb of labs) {
    const h = labHolo(S, lb);
    if (Math.hypot(cam.x - h.x, cam.z - h.z) > 46) continue;
    // 机柜指示灯：每研究一级亮一盏；已研究的机柜前面板闪烁
    lb.racks.forEach((o, i) => {
      const w = S.labObj(o), tc = TECH_COL[i], lv = lvs[i];
      setMX(w.x, S.floorH(w.x, w.z), w.z, w.yaw);
      for (let k = 0; k < 3; k++) {
        const on = k < lv;
        P('box', -0.5 + k * 0.5, 2.5, 0.41, 0.38, 0.13, 0.03, on ? c(tc[0], tc[1], tc[2], 1, 1) : c(0.13, 0.13, 0.15, 1, 0.05));
      }
      if (lv) for (let k = 0; k < 7; k++) {
        const b = Math.sin(t * (3 + k * 0.7) + i * 1.7 + k * 2.1);
        P('box', 0.55, 0.36 + k * 0.29, 0.4, 0.14, 0.05, 0.02, c(tc[0], tc[1], tc[2], 1, b > 0.2 ? 1 : 0.15));
      }
      if (lv === TD.TECH_MAX) P('box', 0, 0.02, 0.9, 1.7, 0.02, 0.5, c(tc[0], tc[1], tc[2], 0.35, 1, 0, true));
    });
    // 终端大屏：五根科技等级条 + 扫描线
    let w = S.labObj(lb.term);
    setMX(w.x, S.floorH(w.x, w.z), w.z, w.yaw);
    for (let i = 0; i < 5; i++) {
      const tc = TECH_COL[i], hh = 0.1 + 0.3 * lvs[i];
      P('box', -0.84 + i * 0.42, 1.74 + hh / 2, -0.28, 0.28, hh, 0.02, c(tc[0] * 0.8, tc[1] * 0.8, tc[2] * 0.8, 1, lvs[i] ? 0.55 : 0.15));
    }
    P('box', 0, 1.7 + ((t * 0.45) % 1) * 1.22, -0.275, 2.15, 0.025, 0.01, c(0.5, 0.95, 1, 0.5, 1, 0, true));
    const nearT = p && !p.dead && Math.hypot(p.x - w.x, p.z - w.z) < 3.6;
    if (nearT) E.push('ring', w.x + w.dx * 0.9, S.floorH(w.x, w.z) + 0.03, w.z + w.dz * 0.9, t, 0.9 + 0.08 * Math.sin(t * 5), 1, 0.9 + 0.08 * Math.sin(t * 5), c(0.37, 0.89, 1, 0.8, 1, 0, true));
    // 补给柜状态灯：绿色可用，红色冷却（下方进度条）
    w = S.labObj(lb.sup);
    setMX(w.x, S.floorH(w.x, w.z), w.z, w.yaw);
    const cd = p ? p.supT || 0 : 0, ready = cd <= 0;
    P('box', 0, 2.5, 0.38, 1.4, 0.09, 0.03, ready ? c(0.35, 1, 0.5, 1, 0.6 + 0.4 * Math.sin(t * 4)) : c(1, 0.3, 0.25, 1, 0.8));
    if (!ready) { const f = 1 - cd / TD.SUPPLY_CD; P('box', -0.65 + 0.65 * f, 2.36, 0.4, 1.3 * f, 0.05, 0.02, c(1, 0.75, 0.3, 1, 0.9)); }
    else if (p && !p.dead && Math.hypot(p.x - w.x, p.z - w.z) < 3.6) E.push('ring', w.x + w.dx * 0.9, S.floorH(w.x, w.z) + 0.03, w.z + w.dz * 0.9, t, 0.9 + 0.08 * Math.sin(t * 5), 1, 0.9 + 0.08 * Math.sin(t * 5), c(0.35, 1, 0.5, 0.8, 1, 0, true));
    drawHolo(S, h, lvs);
  }
}
// 全息战术沙盘：整张地图缩小到台面上方，实时显示路线、水晶、敌人与队友
function drawHolo(S, h, lvs) {
  const t = timeNow, Y = 1.18 + S.floorH(h.x, h.z), R = 1.05, k = 2 * R / (Math.max(S.W, S.H) * T);
  const ox = h.x - S.W * T * k / 2, oz = h.z - S.H * T * k / 2;
  const X = x => ox + x * k, Z = z => oz + z * k;
  E.push('disc', h.x, Y - 0.25, h.z, 0, R * 1.08, 1, R * 1.08, c(0.3, 0.75, 1, 0.06, 0.6, 0, true));
  E.push('ring', h.x, Y - 0.22 + 0.04 * Math.sin(t * 2), h.z, t * 0.6, R * 1.12, 1, R * 1.12, c(0.37, 0.89, 1, 0.28, 0.7, 0, true));
  E.push('ring', h.x, Y + 0.6 + 0.08 * Math.sin(t * 1.3), h.z, -t * 0.4, R * 0.55, 1, R * 0.55, c(0.37, 0.89, 1, 0.16, 0.7, 0, true));
  for (const lane of S.lanes) {
    const on = S.laneActive(lane, Math.max(1, S.s.wave + (S.s.phase === 'build' ? 1 : 0)));
    const pts = S.paths[lane].pts;
    for (let i = 0; i < pts.length - 1; i++) E.pushBeam('box', X(pts[i].x), Y, Z(pts[i].z), X(pts[i + 1].x), Y, Z(pts[i + 1].z), 0.022, 0.008, on ? c(1, 0.42, 0.32, 0.55, 0.55, 0, true) : c(0.5, 0.5, 0.6, 0.18, 0.5, 0, true));
  }
  const cp = S.crystalPos;
  E.push('oct', X(cp.x), Y + 0.16 + 0.02 * Math.sin(t * 3), Z(cp.z), t, 0.07, 0.13, 0.07, c(0.37, 0.89, 1, 1, 1));
  let n = 0;
  for (const m of S.s.monsters) {
    if (m.burrow || m.cloak || ++n > 160) continue;
    const def = MON[m.type], hh = def.boss ? 0.32 : def.elite ? 0.2 : 0.11, ww = def.boss ? 0.06 : def.elite ? 0.04 : 0.024;
    E.push('box', X(m.x), Y + (def.fly ? 0.1 : 0.005) + hh / 2, Z(m.z), 0, ww, hh, ww, def.boss ? c(1, 0.25, 0.95, 1, 0.9) : def.fly ? c(0.77, 0.55, 1, 1, 0.7) : c(1, 0.3, 0.35, 1, 0.7));
  }
  for (const id in S.s.players) {
    const q = S.s.players[id]; if (q.dead) continue;
    const tc = TEAM_COL[q.slot % 4];
    E.push('cone', X(q.x), Y + 0.09, Z(q.z), 0, 0.045, 0.18, 0.045, c(tc[0], tc[1], tc[2], 1, 0.9));
  }
  const mix = [0.37, 0.89, 1];
  const tot = lvs.reduce((a, b) => a + b, 0);
  flashLight(h.x, 2.2 + S.floorH(h.x, h.z), h.z, 9 + tot * 0.3, mix, 0.7 + tot * 0.04, 0.02);
}
// 本机玩家附近的科研舱物件
function nearLabObj() {
  const p = me(); if (!p || p.dead || !sim || !sim.def.labs) return null;
  const ti = sim.nearLab(p, 'term'), si = sim.nearLab(p, 'sup');
  if (ti < 0 && si < 0) return null;
  if (ti >= 0 && si >= 0) {
    const a = sim.labObj(sim.def.labs[ti].term), b = sim.labObj(sim.def.labs[si].sup);
    return Math.hypot(p.x - a.x, p.z - a.z) <= Math.hypot(p.x - b.x, p.z - b.z) ? { kind: 'term', i: ti } : { kind: 'sup', i: si };
  }
  return ti >= 0 ? { kind: 'term', i: ti } : { kind: 'sup', i: si };
}
let labOpen = false;
function toggleLab(on) {
  labOpen = on === undefined ? !labOpen : on;
  $('lab').hidden = !labOpen;
  if (labOpen) panelOpened(true); else setTimeout(panelClosed, 0);
  if (labOpen) {
    if (shopOpen) toggleShop(false);
    if (evoTrap !== null) closeEvo();
    if (quickOpen) toggleQuick(false);
    cache.lab = ''; renderLab();
  }
}
function renderLab() {
  if (!sim) return;
  const lvs = TD.TECH.map(t => sim.techLv(t.id)), key = lvs.join() + '|' + sim.s.gold;
  if (cache.lab === key) return;
  cache.lab = key;
  const list = $('labList'); list.innerHTML = '';
  TD.TECH.forEach((t, i) => {
    const lv = lvs[i], max = lv >= TD.TECH_MAX, cost = max ? 0 : t.cost[lv], poor = !max && sim.s.gold < cost;
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'wcard' + (max ? ' max' : '') + (poor ? ' poor' : '');
    b.style.setProperty('--tc', TECH_CSS[i]);
    b.innerHTML = `<span class="kb">${i + 1}</span><b>${t.name}</b><span class="pips">${[0, 1, 2].map(k => `<i class="${k < lv ? 'on' : ''}"></i>`).join('')}</span>` +
      `<span class="wd">${lv ? '当前：' + t.desc(lv) : '未研究'}</span>` + (max ? '' : `<span class="wd">Lv${lv + 1}：${t.desc(lv + 1)}</span>`) +
      `<em>${max ? '已满级' : cost + ' 金币'}</em>`;
    b.addEventListener('click', () => doResearch(i));
    list.appendChild(b);
  });
}
function doResearch(i) {
  const t = TD.TECH[i]; if (!t || !sim) return;
  const lv = sim.techLv(t.id);
  if (lv >= TD.TECH_MAX) { toast(`${t.name} 已满级`, true); return; }
  if (sim.s.gold < t.cost[lv]) { toast(`金币不足，需要 ${t.cost[lv]}`, true); Snd.play('deny'); return; }
  netCmd({ t: 'research', tech: t.id }, r => { if (!r.ok) { toast(r.reason || '无法研究', true); Snd.play('deny'); } else cache.lab = ''; });
}
function doResupply() {
  const p = me(); if (!p) return;
  if (p.supT > 0) { toast(`补给柜冷却中 ${Math.ceil(p.supT)} 秒`, true); Snd.play('deny'); return; }
  netCmd({ t: 'resupply' }, r => {
    if (!r.ok) { if (r.reason) { toast(r.reason, true); Snd.play('deny'); } return; }
    const q = me();
    if (MP.role === 'client' && q) { for (const g of q.guns) q.ammoBy[g] = WPN[g].mag; q.ammo = q.mag; q.reloadT = 0; q.supT = TD.SUPPLY_CD; }
  });
}

/* ---------- 陷阱进阶（Lv3 → Lv4 二选一） ---------- */
let evoTrap = null;
function openEvo(tr) {
  if (shopOpen) toggleShop(false);
  if (labOpen) toggleLab(false);
  evoTrap = tr.id;
  const E2 = EVO[tr.type], cost = sim.upgradeCost(tr, PID);
  $('evoTitle').textContent = `${TRAP[tr.type].name} 进阶 · ${cost} 金币`;
  const box = $('evoList'); box.innerHTML = '';
  ['a', 'b'].forEach((k, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'wcard';
    b.innerHTML = `<span class="kb">${i + 1}</span><b>${E2[k].name}</b><span class="wd">${E2[k].desc}</span>`;
    b.addEventListener('click', () => chooseEvo(k));
    box.appendChild(b);
  });
  $('evo').hidden = false;
  panelOpened(true);
}
function closeEvo() { evoTrap = null; $('evo').hidden = true; panelClosed(); }
function chooseEvo(k) {
  const tr = sim && sim.s.traps.find(t => t.id === evoTrap);
  closeEvo();
  if (!tr) return;
  const name = EVO[tr.type][k].name;
  netCmd({ t: 'upgrade', id: tr.id, br: k }, r => { if (r.ok) toast(`${TRAP[tr.type].name} 进阶为「${name}」`); else { toast(r.reason || '无法进阶', true); Snd.play('deny'); } });
}

/* ---------- 武器 / 技能 ---------- */
let shopOpen = false;
function me() { return sim && sim.s.players[PID]; }
function cycleWeapon() {
  const p = me(); if (!p || p.dead) return;
  const owned = WEAPONS.filter(w => p.guns.includes(w.id)).map(w => w.id);
  if (owned.length < 2) { toast('只有脉冲步枪 · 按 B 打开军械库购买武器'); return; }
  equipWeapon(owned[(owned.indexOf(p.wpn) + 1) % owned.length]);
}
function equipWeapon(w) {
  const p = me(); if (!p || !p.guns.includes(w)) return;
  if (tool !== 'gun') selectTool('gun');
  if (p.wpn === w) return;
  if (MP.role === 'client') sim.switchWeapon(p, w); else netCmd({ t: 'wpn', w });
  vm.switchT = 0.3;
  toast(WPN[w].name);
}
function toggleShop(on) {
  shopOpen = on === undefined ? !shopOpen : on;
  $('shop').hidden = !shopOpen;
  if (shopOpen && labOpen) toggleLab(false);
  if (shopOpen) panelOpened(true); else panelClosed();
  if (shopOpen) { cache.shop = ''; renderShop(); }
}
function renderShop() {
  const p = me(); if (!p) return;
  const key = p.guns.join() + p.wpn + sim.s.gold;
  if (cache.shop === key) return;
  cache.shop = key;
  const list = $('shopList'); list.innerHTML = '';
  WEAPONS.forEach((w, i) => {
    const own = p.guns.includes(w.id), cur = p.wpn === w.id, poor = !own && sim.s.gold < w.cost;
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'wcard' + (cur ? ' cur' : '') + (own ? ' own' : '') + (poor ? ' poor' : '');
    const dps = Math.round(w.dmg * (w.pellets || 1) * w.rps);
    b.innerHTML = `<span class="kb">${i + 1}</span><span class="wi">${svgIcon(w.id)}</span><b>${w.name}</b><span class="ws">伤害 ${w.dmg}${w.pellets ? '×' + w.pellets : ''}${w.splash ? ' 范围' : ''} · 弹匣 ${w.mag} · 每秒 ${dps}</span><span class="wd">${w.desc}</span><em>${cur ? '装备中' : own ? '已拥有 · 装备' : w.cost + ' 金币'}</em>`;
    b.addEventListener('click', () => buyWeapon(i));
    list.appendChild(b);
  });
}
function buyWeapon(i) {
  const W = WEAPONS[i], p = me();
  if (!W || !p) return;
  if (p.guns.includes(W.id)) { equipWeapon(W.id); return; }
  if (sim.s.gold < W.cost) { toast(`金币不足，需要 ${W.cost}`, true); Snd.play('deny'); return; }
  netCmd({ t: 'buy', w: W.id }, r => {
    if (!r.ok) { toast(r.reason || '无法购买', true); Snd.play('deny'); return; }
    const q = me();
    if (MP.role === 'client' && q) { if (!q.guns.includes(W.id)) q.guns.push(W.id); sim.switchWeapon(q, W.id); }
    if (tool !== 'gun') selectTool('gun');
    vm.switchT = 0.3; toast(`已购买 ${W.name}`); cache.shop = '';
  });
}
function throwNade() {
  const p = me(); if (!p || p.dead) return;
  if (p.nades < 1) { toast(`手雷充能中 ${Math.ceil(p.nadeT)} 秒`, true); return; }
  netCmd({ t: 'nade', o: [r2n(cam.x + cam.fx * 0.4), r2n(cam.y - 0.1), r2n(cam.z + cam.fz * 0.4)], d: [r3n(cam.fx), r3n(cam.fy), r3n(cam.fz)] }, r => { if (!r.ok && r.reason) toast(r.reason, true); });
  if (MP.role === 'client') { Snd.play('throw'); p.nades = Math.max(0, p.nades - 1); }
}
function callStrike() {
  const p = me(); if (!p || p.dead) return;
  if (p.energy < 100) { toast(`轨道打击充能 ${Math.floor(p.energy)}% · 用枪造成伤害和击杀来充能`, true); return; }
  const h = sim.raycast(cam.x, cam.y, cam.z, cam.fx, cam.fy, cam.fz, 90);
  if (!h) { toast('对准地面或通道呼叫轨道打击', true); return; }
  const back = h.kind === 'wall' ? 0.8 : 0;
  netCmd({ t: 'ult', x: r2n(h.px - cam.fx * back), z: r2n(h.pz - cam.fz * back) }, r => { if (!r.ok && r.reason) toast(r.reason, true); });
}
function sendInput() {
  const k = keys;
  let turn = 0, look = 0;
  if (k.ArrowLeft) turn += 1; if (k.ArrowRight) turn -= 1; if (k.ArrowUp) look += 1; if (k.ArrowDown) look -= 1;
  cam.yaw += turn * 2.2 * STEP * settings.sens; cam.pitch = clamp(cam.pitch + look * 1.6 * STEP * settings.sens, -1.5, 1.5);
  { const mt = myMount(); if (mt) cam.pitch = mt.type === 'mortar' ? clamp(cam.pitch, -1.25, 0.35) : clamp(cam.pitch, -0.75, 0.9); }
  let mx = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0), mz = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0);
  if (joy.on && (joy.x || joy.z)) { mx = joy.x; mz = joy.z; }
  const inp = {
    mx, mz,
    jump: !!k.Space, sprint: !!(k.ShiftLeft || k.ShiftRight) || (joy.on && joy.sprint), fire: mode === 'play' && mouse.l && tool === 'gun' && vm.switchT <= 0,
    reload: reloadReq, yaw: cam.yaw, pitch: cam.pitch, ads: mode === 'play' && mouse.r && tool === 'gun',
  };
  if (MP.role === 'client') { const lp = sim.s.players[PID]; if (lp) Object.assign(lp.input, inp); }
  else netCmd(Object.assign({ t: 'input' }, inp));
  reloadReq = false;
}

/* ============================================================
 * 菜单 / 流程
 * ============================================================ */
function show(id, on) { $(id).hidden = !on; }
function newGame(state, prebuilt) {
  const gc = gameCfg();
  sim = prebuilt || (state ? new Sim({ state }) : new Sim({ map: gc.map, endless: gc.endless, difficulty: gc.diff, seed: gc.seed, mut: gc.mut, tal: PROG.team(), daily: gc.daily }));
  if (!state && !prebuilt) sim.addPlayer(PID, MP.name || '你', false, PROG.personal(), selCls);
  sim.drainEvents();
  acc = 0; clearTags(); for (const k in teamVis) delete teamVis[k];
  for (const k of pingMarks) if (k.el) k.el.remove(); pingMarks.length = 0; MP.ping = null; MP.qc = null; MP.ch = null; $('chatLog').innerHTML = '';
  diff = sim.s.diff;
  trapIndex = new Map(); slotCache = null; pathDirCache.clear();
  corpses.length = 0; decals.length = 0; bossFx = null; slowmoT = 0; buildFx.clear(); railFx.length = blinkFx.length = auraFx.length = fireFx.length = 0;
  parts.length = 0; tracers.length = 0; rings.length = 0; lights.length = 0;
  const p = sim.s.players[PID]; cam.yaw = p ? p.yaw : 0; cam.pitch = 0;
  tool = 'gun'; buildHotbar(); selectTool('gun'); for (const el of document.querySelectorAll('#hotbar [data-id]')) el.classList.toggle('sel', el.dataset.id === 'gun');
  buildMinimap(sim);
  $('feed').innerHTML = '';
  for (const k in cache) delete cache[k];
  if (labOpen) toggleLab(false);
  if (shopOpen) toggleShop(false);
  setText('diffTag', DIFFS[diff].name);
  endTimer = 0;
}
/* ---------- 新手引导：一步一步教会基本操作，每一步完成后自动进入下一步 ---------- */
const K_ = id => TOUCH ? '' : keyName(keyOf(id));
const TUT_STEPS = [
  { t: '移动', d: () => TOUCH ? '用左半屏的摇杆走动，推到底会冲刺' : `用 ${K_('KeyW')}${K_('KeyA')}${K_('KeyS')}${K_('KeyD')} 走动，按住 ${K_('ShiftLeft')} 冲刺`, ok: T0 => T0.moved > 4 },
  { t: '转动视角', d: () => TOUCH ? '在右半屏滑动手指转动视角' : '移动鼠标转动视角，四处看看', ok: T0 => T0.turned > 1.5 },
  { t: '选择陷阱', d: () => TOUCH ? '点顶部陷阱栏的「地面」分组，再点展开的「毒刺陷阱」' : '按 1 打开地面陷阱，再按 2 选择毒刺陷阱（1-5 打开分组，再按数字选组内第几个；Tab 查看全部陷阱说明）', ok: () => tool !== 'gun' },
  { t: '放置陷阱', d: () => TOUCH ? '对准红色箭头所在的通道地面，按「放置」' : '对准地上有红色箭头的怪物通道，按左键放置（右键收起）', ok: (T0, s) => s.traps.some(t => t.kind === 'floor') },
  { t: '墙壁陷阱', d: () => TOUCH ? '在陷阱栏的「墙壁」分组选「激光发射器」，对准通道两侧的墙壁放置' : '按 2 再按 1 选激光发射器，对准通道两侧的墙壁放置：光束会横贯整个通道', ok: (T0, s) => s.traps.some(t => t.kind === 'wall') },
  { t: '升级陷阱', d: () => TOUCH ? '对准一个陷阱，点「升级」' : `对准一个陷阱按 ${K_('KeyE')} 升级（${K_('KeyX')} 拆除，布防阶段全额返还）`, ok: (T0, s) => s.traps.some(t => t.lv >= 2) },
  { t: '开战', d: () => TOUCH ? '准备好了就点「开战」，提前开战还有金币奖励' : `准备好了按 ${K_('KeyG')} 提前开战，剩余倒计时会换成金币奖励`, ok: (T0, s) => s.phase === 'wave' },
  { t: '射击', d: () => TOUCH ? '按「开火」射击，按「瞄准」开镜；打死 3 只怪' : '左键射击、右键瞄准，打头伤害更高；打死 3 只怪', ok: (T0, s, p) => p.kills >= 3 },
  { t: '更多玩法', d: () => TOUCH ? '「军械」买新武器，走到紫色「科」科研舱按「互动」研究科技。守住这一波吧！' : `${K_('KeyB')} 打开军械库买新武器；走到小地图上紫色「科」的科研舱按 ${K_('KeyF')} 研究科技；${K_('KeyH')} 查看图鉴。守住这一波吧！`, ok: T0 => T0.stepT > 9 },
];
// 每一步要高亮的东西：els = 界面上要点的按钮，zone = 手机上要拖动的半屏，keys = 电脑上要按的键（显示成按键图标）
const popOpen = g => popGrp === g;
const TUT_HI = [
  () => TOUCH ? { zone: 'left' } : { keys: ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft'].map(k => keyName(keyOf(k))) },
  () => TOUCH ? { zone: 'right' } : { keys: ['移动鼠标'] },
  () => ({ els: [popOpen('floor') ? '#trapPop [data-id="spike"]' : '#hotbar .grp[data-grp="floor"]'], keys: popOpen('floor') ? ['2'] : ['1', '2'] }),
  () => TOUCH ? { els: ['#tbFire'], aim: 1 } : { keys: ['鼠标左键'] },
  () => tool === 'laser' ? (TOUCH ? { els: ['#tbFire'], aim: 1 } : { keys: ['鼠标左键'] }) : ({ els: [popOpen('wall') ? '#trapPop [data-id="laser"]' : '#hotbar .grp[data-grp="wall"]'], keys: popOpen('wall') ? ['1'] : ['2', '1'] }),
  () => TOUCH ? { els: ['#tbUp'] } : { keys: [keyName(keyOf('KeyE'))] },
  () => TOUCH ? { els: ['#tbReady'] } : { keys: [keyName(keyOf('KeyG'))] },
  () => TOUCH ? { els: ['#tbFire', '#tbAds'], aim: 1 } : { keys: ['鼠标左键', '鼠标右键'] },
  () => TOUCH ? { els: ['#touchUI [data-k="KeyB"]', '#touchUI [data-k="Tab"]'] } : { keys: [keyName(keyOf('KeyB')), 'Tab', keyName(keyOf('KeyH'))] },
];
const Tut = { on: false, i: 0, moved: 0, turned: 0, stepT: 0, lx: 0, lz: 0, lyaw: 0 };
// 把高亮圈 / 指示箭头 / 按键图标摆到位，并把引导卡片挪到不挡住目标的位置
function tutHighlight() {
  const box = $('tutHi'), card = $('tut');
  // 打开了陷阱一览 / 军械库等面板时，引导卡片和高亮先让开，关掉面板再出来
  const cover = Tut.on && (mode === 'pause' || anyPanel() || anyFullPage());
  card.style.visibility = cover ? 'hidden' : '';
  if (!Tut.on || mode !== 'play' || !TUT_HI[Tut.i] || cover) { box.hidden = true; return; }
  box.hidden = false;
  const H = TUT_HI[Tut.i](), rects = [];
  for (const sel of H.els || []) {
    const el = document.querySelector(sel);
    if (!el || el.hidden || el.offsetParent === null) continue;
    const r = el.getBoundingClientRect(); if (r.width < 2) continue;
    rects.push(r);
  }
  const key = JSON.stringify([rects.map(r => [r.left | 0, r.top | 0, r.width | 0, r.height | 0]), H.zone || '', H.keys || [], popGrp || '', innerWidth, innerHeight]);
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    let html = rects.map(r => `<i class="ring" style="left:${r.left - 5}px;top:${r.top - 5}px;width:${r.width + 10}px;height:${r.height + 10}px"></i><b class="arrow${r.top < innerHeight / 2 ? ' up' : ''}" style="left:${r.left + r.width / 2}px;top:${r.top < innerHeight / 2 ? r.bottom + 14 : r.top - 14}px"></b>`).join('');
    if (H.zone) html += `<div class="zone ${H.zone}"><span>${H.zone === 'left' ? '在这里按住拖动，走到通道里' : '在这里滑动，转动视角'}</span></div>`;
    if (H.keys && !TOUCH) html += `<div class="keys">${H.keys.map(k => `<kbd>${k}</kbd>`).join('')}</div>`;
    box.innerHTML = html;
    // 手机：引导卡片放到不和目标重叠的位置（上方 → 中间 → 左下）
    if (TOUCH) {
      const pop = $('trapPop'), avoid = rects.slice();
      if (pop && !pop.hidden) avoid.push(pop.getBoundingClientRect());
      // 需要瞄准的步骤：屏幕中间（准星和放置预览）也不能挡
      if (H.aim) { const cx = innerWidth / 2, cy = innerHeight / 2; avoid.push({ left: cx - 100, right: cx + 100, top: cy - 50, bottom: cy + 90 }); }
      // 量位置时先关掉过渡动画，否则量到的是动画起点；选好后再带动画移过去
      const prev = card.dataset.pos || 'top'; let pick = 'low';
      card.style.transition = 'none';
      for (const pos of ['top', 'left', 'mid', 'low']) {
        card.dataset.pos = pos;
        const c = card.getBoundingClientRect();
        if (!avoid.some(r => r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top)) { pick = pos; break; }
      }
      card.dataset.pos = prev; void card.offsetWidth;
      card.style.transition = ''; card.dataset.pos = pick;
    }
  }
}
function tutDone() { try { return localStorage.getItem('jhsw-tut') === '1'; } catch (e) { return true; } }
function tutSetDone() { try { localStorage.setItem('jhsw-tut', '1'); } catch (e) { /* 无存储 */ } }
function startTutorial() {
  if (MP.role !== 'solo') { toast('联机房间里不能进行新手引导，先离开房间', true); return; }
  const S = new Sim({ map: 'station', difficulty: 'normal', seed: 7, tal: PROG.team() });
  S.addPlayer(PID, MP.name || '你', false, PROG.personal(), selCls);
  S.s.gold += 600;
  beginPlay(S, true);
  Tut.on = true; Tut.i = 0; Tut.moved = 0; Tut.turned = 0; Tut.stepT = 0;
  const p = sim.s.players[PID]; Tut.lx = p.x; Tut.lz = p.z; Tut.lyaw = cam.yaw;
  renderTut();
}
function stopTutorial(done) {
  if (!Tut.on) return;
  Tut.on = false; $('tut').hidden = true; $('tut').style.visibility = ''; $('tutHi').hidden = true; tutSetDone();
  if (done) { banner('新手引导完成', '接下来就靠你守住水晶了！在主菜单可以随时重新打开引导'); Snd.play('clear'); }
}
function renderTut() {
  const st = TUT_STEPS[Tut.i]; if (!st) return;
  $('tut').hidden = false;
  setText('tutStep', `新手引导 ${Tut.i + 1} / ${TUT_STEPS.length}`); setText('tutT', st.t); setText('tutD', st.d());
  $('tutBar').style.width = (Tut.i / TUT_STEPS.length * 100).toFixed(1) + '%';
}
function updateTut(dt) {
  if (!Tut.on || !sim) return;
  if (mode !== 'play' && mode !== 'pause') { stopTutorial(false); return; }
  const s = sim.s, p = s.players[PID]; if (!p) return;
  Tut.moved += Math.hypot(p.x - Tut.lx, p.z - Tut.lz); Tut.lx = p.x; Tut.lz = p.z;
  let dy = cam.yaw - Tut.lyaw; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2; Tut.turned += Math.abs(dy); Tut.lyaw = cam.yaw;
  if (mode === 'play') Tut.stepT += dt;
  tutHighlight();
  // 引导中布防倒计时不走（直到玩家自己开战）
  if (s.phase === 'build' && Tut.i < 6) s.timer = Math.max(s.timer, 40);
  const st = TUT_STEPS[Tut.i];
  if (st && st.ok(Tut, s, p)) {
    Tut.i++; Tut.stepT = 0; Snd.play('upgrade');
    if (Tut.i >= TUT_STEPS.length) { stopTutorial(true); return; }
    $('tut').classList.remove('pop'); void $('tut').offsetWidth; $('tut').classList.add('pop');
    renderTut();
  }
}
function startGame() {
  if (MP.role === 'host') { hostStartGame(); return; }
  if (MP.role === 'client') return;
  beginPlay(null, true);
}
// 进入一局：S 为预先构建好的 Sim（联机），gesture 表示由点击触发（可以请求锁定鼠标）
function beginPlay(S, gesture) {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  Snd.init(); Snd.ambient(true);
  newGame(null, S);
  mode = 'play';
  show('menu', false); show('end', false); show('pause', false); show('help', false); show('hud', true);
  const n = Object.keys(sim.s.players).length, lanes = sim.lanes.length;
  feed('布防阶段：沿红色路线在通道地面、墙壁、天花板布置陷阱', '');
  feed(TOUCH ? '点顶部陷阱栏选择陷阱，对准位置按「放置」；对准陷阱可升级 / 拆除' : '按 1-5 打开陷阱分组、再按数字选择（Tab 查看全部），左键放置；对准陷阱按 E 升级、X 拆除', '');
  if (MP.role !== 'solo') feed(`联机房间 ${MP.code.toUpperCase()} · ${n} 名玩家 · 金币全队共享`, 'good');
  banner('布防阶段', `${lanes} 个出怪口的怪物会沿红色路线冲向核心水晶 · ` + (n > 1 ? '全员按 G 准备后提前开战' : '按 G 提前开战'));
  if (gesture) requestLock();
  if (gesture && TOUCH) goFullscreen();
  if (TOUCH) requestAnimationFrame(applyTouchLayout);
  if (MP.role !== 'client') ensureBgTicker();
}
function pauseGame() {
  if (mode !== 'play') return;
  mode = 'pause';
  $('pauseTitle').textContent = MP.role === 'solo' ? '已暂停' : '菜单';
  $('pauseNote').hidden = MP.role === 'solo';
  $('quitBtn').textContent = sim && sim.s.endless && MP.role !== 'client' && sim.s.wave >= 1 ? '结算并退出（计入排行榜）' : MP.role === 'host' ? '结束本局，回到房间' : MP.role === 'client' ? '离开房间' : '返回主菜单';
  show('pause', true);
  for (const k in keys) keys[k] = false; mouse.l = mouse.r = mouse.any = false;
}
function resumeGame() {
  if (mode !== 'pause') return;
  mode = 'play'; show('pause', false); show('help', false);
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  Snd.init();
  requestLock();
}
function openHelp(tab) {
  if (mode === 'play') { pauseGame(); }
  buildHelp();
  if (tab) setHelpTab(tab);
  show('help', true);
  $('help').scrollTop = 0;
  if (document.pointerLockElement) document.exitPointerLock();
}
function closeHelp() { show('help', false); }
function setHelpTab(id) {
  for (const b of document.querySelectorAll('[data-htab]')) {
    if (b.tagName === 'BUTTON') b.setAttribute('aria-selected', b.dataset.htab === id ? 'true' : 'false');
    else b.hidden = b.dataset.htab !== id;
  }
  $('help').scrollTop = 0;
}
function openSettings(tab) {
  if (mode === 'play') pauseGame();
  setSetTab(tab || 'gen');
  renderKeyList();
  show('settings', true);
  if (document.pointerLockElement) document.exitPointerLock();
}
function closeSettings() { cancelKeyCapture(); show('settings', false); }
function setSetTab(id) {
  for (const b of document.querySelectorAll('[data-stab]')) {
    if (b.tagName === 'BUTTON') b.setAttribute('aria-selected', b.dataset.stab === id ? 'true' : 'false');
    else b.hidden = b.dataset.stab !== id;
  }
}
/* ---------- 改键 ---------- */
let keyCapture = null;
function renderKeyList() {
  const box = $('keyList'); if (!box) return;
  box.innerHTML = '';
  for (const [act, label] of KEY_ACTIONS) {
    const row = document.createElement('div'); row.className = 'keyRow';
    const sp = document.createElement('span'); sp.textContent = label;
    const b = document.createElement('button'); b.type = 'button'; b.dataset.act = act; b.textContent = keyName(keyOf(act));
    if (keyCapture === act) { b.classList.add('wait'); b.textContent = '按下新按键…'; }
    b.addEventListener('click', ev => { ev.stopPropagation(); keyCapture = act; renderKeyList(); });
    row.append(sp, b); box.appendChild(row);
  }
}
function finishKeyCapture(code) {
  const act = keyCapture; keyCapture = null;
  if (!act || code === 'Escape') { renderKeyList(); return; }
  if (KEY_FIXED.has(code)) { toast(`${keyName(code)} 不能用来改键`, true); renderKeyList(); return; }
  // 冲突：和占用这个键的动作互换
  const other = KEY_ACTIONS.map(a => a[0]).find(a => a !== act && keyOf(a) === code);
  const old = keyOf(act);
  if (other) settings.keys[other] = old;
  settings.keys[act] = code;
  for (const [a] of KEY_ACTIONS) if (settings.keys[a] === a) delete settings.keys[a];
  rebuildKeys(); saveSettings(); renderKeyList(); fillCtrlHelp();
  toast(other ? `${KEY_ACTIONS.find(a => a[0] === act)[1]} → ${keyName(code)}（与「${KEY_ACTIONS.find(a => a[0] === other)[1]}」互换）` : `${KEY_ACTIONS.find(a => a[0] === act)[1]} → ${keyName(code)}`);
}
function cancelKeyCapture() { if (keyCapture) { keyCapture = null; renderKeyList(); } }
addEventListener('mousedown', e => {
  if (!keyCapture || e.button === 0 || e.button === 2) return;
  e.preventDefault(); finishKeyCapture('Mouse' + (e.button === 1 ? 3 : e.button + 1));
}, true);
function fillCtrlHelp() {
  const box = $('ctrlHelp'); if (!box) return;
  const K = a => `<span class="kb">${keyName(keyOf(a))}</span>`;
  box.innerHTML = [
    `${K('KeyW')}${K('KeyA')}${K('KeyS')}${K('KeyD')}移动 · ${K('ShiftLeft')}冲刺`, `${K('Space')}跳跃 · ${K('KeyR')}换弹`,
    '<span class="kb">左键</span>射击 / 放置陷阱', '<span class="kb">右键</span>瞄准 / 收起陷阱',
    `<span class="kb">1-5</span>打开陷阱分组，再按数字选择 · <span class="kb">Tab</span>陷阱一览 · ${K('KeyQ')}步枪 / 切枪`, `${K('KeyE')}升级 · ${K('KeyX')}拆除陷阱`,
    `${K('KeyB')}军械库 · ${K('KeyF')}互动`, `${K('KeyC')}手雷 · ${K('KeyZ')}轨道打击`,
    `${K('KeyT')}标记 · ${K('KeyV')}快捷消息 · <span class="kb">Enter</span>打字聊天`, `${K('KeyG')}提前开战 / 联机准备`,
    `${K('KeyM')}大地图 · ${K('KeyH')}图鉴`, `<span class="kb">Esc</span>${K('KeyP')}暂停 / 设置`,
  ].map(h => `<div>${h}</div>`).join('');
  const mk = document.querySelector('#menu .keys');
  if (mk) mk.innerHTML = box.innerHTML;
}
/* ---------- 触屏按钮：自定义位置 / 大小 / 透明度 ---------- */
const TB_DRAG = ['tbFire', 'tbJump', 'tbReload', 'tbAds', 'tbNade', 'tbUlt', 'tbSwap', 'tbUtil', 'tbCtx'];
let tbEdit = null, tbEditFrom = '';
function applyTouchLayout() {
  const ui = $('touchUI'); if (!ui) return;
  ui.style.setProperty('--tbs', settings.tb.scale || 1);
  ui.style.setProperty('--tba', settings.tb.alpha || 1);
  for (const id of TB_DRAG) {
    const el = $(id), pos = settings.tb.pos[id];
    if (!el) continue;
    if (!pos) { el.style.left = el.style.top = el.style.right = el.style.bottom = el.style.transform = ''; continue; }
    if (!el.offsetWidth) continue;   // 界面未显示时尺寸未知，进入游戏后再排
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.right = el.style.bottom = 'auto'; el.style.transform = 'none';
    el.style.left = clamp(pos[0] * innerWidth - w / 2, 0, Math.max(0, innerWidth - w)) + 'px';
    el.style.top = clamp(pos[1] * innerHeight - h / 2, 0, Math.max(0, innerHeight - h)) + 'px';
  }
}
function openTouchEditor() {
  if (!TOUCH) return;
  tbEditFrom = mode;
  show('settings', false); show('pause', false);
  if (mode === 'menu') { show('hud', true); document.body.classList.add('tEditOnly'); }
  $('touchUI').classList.add('editing');
  requestAnimationFrame(applyTouchLayout);
}
function closeTouchEditor() {
  $('touchUI').classList.remove('editing');
  document.body.classList.remove('tEditOnly');
  if (tbEditFrom === 'menu') show('hud', false); else show('pause', true);
  openSettings('touch');
}
function initTouchEditor() {
  const ui = $('touchUI');
  for (const id of TB_DRAG) { const el = $(id); if (el) el.dataset.drag = id; }
  ui.addEventListener('pointerdown', e => {
    if (!ui.classList.contains('editing')) return;
    if (e.target.closest('#teBar')) return;
    const el = e.target.closest('[data-drag]');
    e.stopPropagation(); e.preventDefault();
    if (!el) return;
    const r = el.getBoundingClientRect();
    tbEdit = { el, id: el.dataset.drag, dx: e.clientX - r.left, dy: e.clientY - r.top, pid: e.pointerId };
    el.style.right = el.style.bottom = 'auto'; el.style.transform = 'none';
    el.style.left = r.left + 'px'; el.style.top = r.top + 'px';
  }, true);
  addEventListener('pointermove', e => {
    if (!tbEdit || e.pointerId !== tbEdit.pid) return;
    const el = tbEdit.el, w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = clamp(e.clientX - tbEdit.dx, 0, innerWidth - w) + 'px';
    el.style.top = clamp(e.clientY - tbEdit.dy, 0, innerHeight - h) + 'px';
  });
  const up = e => {
    if (!tbEdit || e.pointerId !== tbEdit.pid) return;
    const r = tbEdit.el.getBoundingClientRect();
    settings.tb.pos[tbEdit.id] = [Math.round((r.left + r.width / 2) / innerWidth * 1000) / 1000, Math.round((r.top + r.height / 2) / innerHeight * 1000) / 1000];
    tbEdit = null; saveSettings();
  };
  addEventListener('pointerup', up); addEventListener('pointercancel', up);
  // touchUI 屏蔽了 touchstart 默认行为（不会合成 click），这里用 pointerup
  $('teDone').addEventListener('pointerup', e => { e.stopPropagation(); closeTouchEditor(); });
  $('teReset').addEventListener('pointerup', e => { e.stopPropagation(); settings.tb.pos = {}; saveSettings(); applyTouchLayout(); });
  addEventListener('resize', () => setTimeout(applyTouchLayout, 50));
  applyTouchLayout();
}
/* ---------- 无尽排行榜 ---------- */
const LB_DM = { normal: 1, hard: 1.4, hell: 1.9 };
function endlessScore(s) { const mut = (s.mut || []).reduce((a, id) => a + (MUT[id] ? MUT[id].w : 0), 1); return Math.round((s.wave * 1000 + s.stats.kills * 2 + Math.ceil(s.crystal.hp) * 5) * (LB_DM[s.diff] || 1) * mut); }
function lbBase() {
  const r = relayBase();
  if (r) return r.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  return 'https://jhsw-game.xialuoxi.com';
}
function lbLocal() { try { return JSON.parse(localStorage.getItem('jhsw-lb') || '{}'); } catch (e) { return {}; } }
function lbLocalAdd(e) {
  const all = lbLocal(), list = (all[e.map] || []).concat([e]).sort((a, b) => b.score - a.score || a.t - b.t).slice(0, 20);
  all[e.map] = list; try { localStorage.setItem('jhsw-lb', JSON.stringify(all)); } catch (err) { /* 无存储 */ }
  return list.indexOf(e) + 1;
}
async function lbFetch(path, opt) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, tm = setTimeout(() => ctl && ctl.abort(), 6000);
  try { const r = await fetch(lbBase() + path, Object.assign({ signal: ctl && ctl.signal, cache: 'no-store' }, opt || {})); return await r.json(); } finally { clearTimeout(tm); }
}
// 无尽模式结算：本机记录 + 上传在线榜（单人或房主上传一次）
function submitEndless() {
  const s = sim.s;
  if (!s.endless || s.lbDone || s.wave < 1) return null;
  s.lbDone = true;
  const names = Object.values(s.players).sort((a, b) => a.slot - b.slot).map(q => cleanName(q.name) || '特工');
  const e = { map: s.map, diff: s.diff, wave: s.wave, kills: s.stats.kills, hp: Math.ceil(s.crystal.hp), mut: (s.mut || []).slice(), n: Math.max(1, names.length), name: names.join('、').slice(0, 12) || '特工', t: Date.now() };
  e.score = endlessScore(s);
  const localRank = lbLocalAdd(e);
  const out = { score: e.score, localRank, online: null };
  if (MP.role !== 'client') {
    lbFetch('/lb', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(e) })
      .then(j => { if (j && j.ok) { out.online = j.rank; if (mode === 'end') setText('endLb', `本局得分 ${e.score.toLocaleString()} · 在线榜 ${j.rank ? '第 ' + j.rank + ' 名' : '未进前 50'} · 本机第 ${localRank} 名`); } })
      .catch(() => { if (mode === 'end') setText('endLb', `本局得分 ${e.score.toLocaleString()} · 本机第 ${localRank} 名（在线榜暂时连不上）`); });
  }
  return out;
}
let lbMap = 'station', lbSrc = 'online';
function openLb() {
  lbMap = selMap; show('lb', true);
  const tabs = $('lbTabs'); tabs.innerHTML = '';
  for (const d of MAP_LIST) { const b = document.createElement('button'); b.type = 'button'; b.textContent = d.name; b.dataset.lbmap = d.id; b.addEventListener('click', () => { lbMap = d.id; renderLb(); }); tabs.appendChild(b); }
  renderLb();
}
async function renderLb() {
  for (const b of document.querySelectorAll('[data-lbmap]')) b.setAttribute('aria-selected', b.dataset.lbmap === lbMap ? 'true' : 'false');
  for (const b of document.querySelectorAll('[data-lbsrc]')) b.setAttribute('aria-pressed', b.dataset.lbsrc === lbSrc ? 'true' : 'false');
  const box = $('lbList'), want = lbMap + lbSrc;
  const draw = (list, note) => {
    if (lbMap + lbSrc !== want) return;
    $('lbNote').textContent = note || '';
    box.innerHTML = '';
    if (!list.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = '还没有记录。去这张地图打一局无尽模式吧！'; box.appendChild(li); return; }
    const myName = cleanName(MP.name || '');
    list.forEach((e, i) => {
      const li = document.createElement('li');
      if (myName && String(e.name).includes(myName)) li.classList.add('me');
      const rk = document.createElement('span'); rk.className = 'rk'; rk.textContent = i + 1;
      const nm = document.createElement('b'); nm.textContent = e.name;
      const sc = document.createElement('em'); sc.textContent = (e.score | 0).toLocaleString();
      const sm = document.createElement('small');
      const dt = new Date(e.t || 0);
      sm.textContent = `第 ${e.wave} 波 · ${DIFFS[e.diff] ? DIFFS[e.diff].name : ''}${e.mut && e.mut.length ? ' · 突变×' + e.mut.length : ''} · ${e.n || 1} 人 · 击杀 ${e.kills} · ${dt.getMonth() + 1}/${dt.getDate()}`;
      li.append(rk, nm, sc, sm); box.appendChild(li);
    });
  };
  if (lbSrc === 'local') { draw((lbLocal()[lbMap] || []), '只保存在这台设备上'); return; }
  draw([], '正在获取…');
  try { const j = await lbFetch('/lb?map=' + lbMap); draw((j && j.list) || [], '全服前 20 名'); }
  catch (e) { draw(lbLocal()[lbMap] || [], '在线榜连不上，先显示本机记录'); }
}
// 第一次点击 / 按键时启动声音（浏览器要求用户手势），主菜单放舒缓的音乐
addEventListener('pointerdown', () => { Snd.init(); if (mode === 'menu' && Snd.ctx) Music.set('calm'); }, { capture: true });
addEventListener('keydown', () => { Snd.init(); if (mode === 'menu' && Snd.ctx) Music.set('calm'); }, { capture: true });
function toMenu() {
  if (Snd.ctx) Music.set('calm');
  if (Tut.on) stopTutorial(false);
  showBest();
  mode = 'menu'; sim = null; Snd.ambient(false);
  if (MP.role === 'host') { MP.gid = null; hostPresence(); lobbyAd(); }
  if (MP.role === 'client') MP.gid = null;
  clearTags(); renderMP();
  corpses.length = 0; decals.length = 0; bossFx = null; slowmoT = 0;
  show('hud', false); show('pause', false); show('end', false); show('help', false); show('menu', true);
  if (document.pointerLockElement) document.exitPointerLock();
  makeDemo();
  goScreen(MP.role !== 'solo' ? 'mp' : 'home');
}
function showEnd() {
  mode = 'end';
  show('pause', false); show('help', false);
  if (document.pointerLockElement) document.exitPointerLock();
  const s = sim.s, win = s.phase === 'victory';
  $('endTitle').textContent = win ? `胜利 · ${sim.def.name}守住了` : (s.endless ? (s.quit ? `无尽模式 · 主动结算 · 坚持到第 ${s.wave} 波` : `无尽模式结束 · 坚持到第 ${s.wave} 波`) : '失败 · 核心水晶被摧毁');
  const lbr = submitEndless();
  setText('endLb', lbr ? `本局得分 ${lbr.score.toLocaleString()} · 本机第 ${lbr.localRank} 名${MP.role === 'client' ? '' : ' · 正在上传在线榜…'}` : '');
  $('endLb').hidden = !lbr;
  $('end').classList.toggle('lose', !win);
  const total = s.stats.dmgGun + s.stats.dmgTrap || 1;
  const dur = Math.max(0, s.time - s.stats.startTime);
  const rows = [
    ['地图', sim.def.name + (s.endless ? ' · 无尽' : '') + (s.daily ? ' · 每日挑战' : '')], ['难度', DIFFS[s.diff].name + (s.mut && s.mut.length ? ` · ${s.mut.map(id => MUT[id].name).join('·')}` : '')], ['到达波次', s.endless ? `第 ${s.wave} 波` : `${s.wave} / ${sim.waves.length}`], ['水晶剩余', `${Math.ceil(s.crystal.hp)} / ${s.crystal.max}`],
    ['击杀', s.stats.kills], ['漏怪', s.stats.leaks], ['用时', `${Math.floor(dur / 60)} 分 ${Math.floor(dur % 60)} 秒`],
    ['陷阱输出', `${Math.round(s.stats.dmgTrap).toLocaleString()}（${Math.round(s.stats.dmgTrap / total * 100)}%）`],
    ['枪械输出', `${Math.round(s.stats.dmgGun).toLocaleString()}（${Math.round(s.stats.dmgGun / total * 100)}%）`],
    ['建造陷阱', `${s.stats.built} 个`], ['总花费', `${s.stats.spent.toLocaleString()} 金币`],
  ];
  $('endStats').innerHTML = rows.map(r => `<div><dt>${r[0]}</dt><dd>${r[1]}</dd></div>`).join('');
  // 各类陷阱输出占比（按伤害从高到低）
  {
    const bt = s.stats.byTrap || {}, ent = Object.entries(bt).filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]);
    const sum = ent.reduce((a, [, v]) => a + v, 0) || 1, top = ent.length ? ent[0][1] : 1;
    const NAME = { device: '地图机关', other: '其他（自爆 / 连锁）' };
    $('endTrapList').innerHTML = ent.map(([k, v]) => {
      const t = TRAP[k], pct = v / sum * 100;
      return `<li style="--cc: var(--c-${t ? t.cat : 'gun'})"><span class="ic">${svgIcon(t ? k : 'ult')}</span><b>${t ? t.name : NAME[k] || k}</b><span class="bar"><i style="width:${(v / top * 100).toFixed(1)}%"></i></span><em>${Math.round(v).toLocaleString()}<strong>${pct >= 9.95 ? pct.toFixed(0) : pct.toFixed(1)}%</strong></em></li>`;
    }).join('');
    $('endTraps').hidden = !ent.length;
  }
  // 联机：每名玩家的击杀与枪械伤害
  const ps = Object.values(s.players).sort((a, b) => a.slot - b.slot);
  const team = $('endTeam');
  team.hidden = ps.length < 2;
  team.innerHTML = '';
  for (const q of ps) {
    const li = document.createElement('li');
    li.style.setProperty('--tc', TEAM_CSS[q.slot % 4]);
    const nm = document.createElement('b'); nm.textContent = q.name + (q.id === PID ? '（你）' : '');
    const st = document.createElement('span'); st.textContent = `击杀 ${q.kills} · 枪械伤害 ${Math.round(q.dmg).toLocaleString()}`;
    li.append(nm, st); team.appendChild(li);
  }
  $('againBtn').hidden = MP.role === 'client';
  $('againBtn').textContent = MP.role === 'host' ? '全队再来一局' : '再来一局';
  $('menuBtn').textContent = MP.role === 'solo' ? '返回主菜单' : '回到房间';
  $('endWait').hidden = MP.role !== 'client';
  // 评级：胜利按水晶剩余与漏怪评 S/A/B/C，失败按到达波次
  const hpF = s.crystal.hp / s.crystal.max;
  const NW = sim.waves.length, extra = s.wave - NW;
  const grade = s.endless ? (extra >= 15 ? 'S' : extra >= 10 ? 'A' : extra >= 5 ? 'B' : extra >= 1 ? 'C' : 'D')
    : win ? (hpF >= 1 ? 'S' : hpF >= 0.7 ? 'A' : hpF >= 0.4 ? 'B' : 'C') : (s.wave >= NW - 2 ? 'C' : 'D');
  const md = s.daily ? 'daily:' + s.daily : s.endless ? 'endless' : 'std';
  const key = bestKey(s.map, s.diff, md), label = s.daily ? `每日挑战 ${s.daily}` : `${sim.def.name} · ${DIFFS[s.diff].name}${s.endless ? ' · 无尽' : ''}`;
  const stars0 = PROG.stars();
  const locked0 = Object.keys(UNLOCKS).filter(id => !UNLOCKS[id].ok());
  { const me0 = s.players[PID]; if (me0 && !s._killsCounted) { s._killsCounted = true; PROG.addKills(me0.kills); } }
  const all = loadBest(), best = all[key] || null;
  const score = (win ? 1000 : 0) + s.wave * 50 + Math.ceil(s.crystal.hp);
  const isNew = !best || score > best.score;
  if (isNew) { all[key] = { score, wave: s.wave, hp: Math.ceil(s.crystal.hp), win: win || (best && best.win) || false, grade }; try { localStorage.setItem('jhsw-best2', JSON.stringify(all)); } catch (e) { /* 无存储 */ } }
  if (s.daily && win) PROG.addDailyWin(s.daily);
  const gained = PROG.stars() - stars0;
  $('endStar').hidden = gained <= 0;
  if (gained > 0) $('endStar').textContent = `获得 ★ ×${gained} · 可用星星 ${PROG.stars() - PROG.spent()}，到主菜单「天赋」里加点`;
  const newly = locked0.filter(id => UNLOCKS[id].ok());
  if (newly.length) { $('endStar').hidden = false; $('endStar').textContent = (gained > 0 ? $('endStar').textContent + ' · ' : '') + `解锁新陷阱：${newly.map(id => TRAP[id].name).join('、')}！下一局起可以在「重型」分组里使用`; buildHotbar(); }
  $('endGrade').textContent = grade;
  $('endGrade').className = 'grade g' + grade;
  $('endBest').textContent = isNew ? `新纪录 · ${label}` : `${label} 最佳：${best.win ? '通关' : '第 ' + best.wave + ' 波'} · 水晶 ${best.hp} · 评级 ${best.grade}`;
  show('end', true);
}

// 菜单背景：演示局
function makeDemo() {
  demo = new Sim({ map: selMap, difficulty: 'normal', seed: 7 });
  demo.s.gold = 99999; pathDirCache.clear();
  const put = (t, sl) => demo.apply({ t: 'build', trap: t, slot: sl });
  const foci = (demo.def.foci || [demo.def.focus]).map(([x, z]) => ({ x: x * T, z: z * T }));
  const pick = (cat, n) => {
    for (const f of foci) {
      const near = demo.listSlots(cat).filter(sl => !demo.trapAtSlot(sl)).map(sl => { const w = demo.trapWorld(sl); return { sl, d: Math.hypot(w.x - f.x, w.z - f.z) }; }).sort((a, b) => a.d - b.d);
      near.slice(0, n).forEach(o => o.sl._ok = true);
      for (const o of near.slice(0, n)) yieldSlot(cat, o.sl);
    }
  };
  let queue = [];
  const yieldSlot = (cat, sl) => queue.push([cat, sl]);
  { const hv = demo.listSlots('heavy').map(sl => ({ sl, d: Math.min(...foci.map(f => Math.hypot((sl.x + 1) * T - f.x, (sl.z + 1) * T - f.z))) })).sort((a, b) => a.d - b.d)[0]; if (hv) put('rail', hv.sl); }
  pick('floor', 5); pick('ceil', 1); pick('pad', 3); pick('wall', 8);
  const plan = { floor: ['tesla', 'slow', 'spike', 'spike', 'push'], ceil: ['crusher'], pad: ['sentry', 'aa', 'sentry'], wall: ['laser', 'flame', 'laser', 'laser', 'flame', 'laser', 'laser', 'flame'] };
  const idx = { floor: 0, ceil: 0, pad: 0, wall: 0 };
  for (const [cat, sl] of queue) { const list = plan[cat]; put(list[idx[cat]++ % list.length], sl); }
  demo.apply({ t: 'ready' });
  demo.drainEvents();
  trapIndex = new Map();
}

/* ============================================================
 * 主循环
 * ============================================================ */
// 推进世界：单机/房主按固定步长推进 Sim；队友只预测自己并平滑镜像
function worldStep(sdt, render) {
  if (!sim) return;
  acc += sdt;
  let n = 0;
  while (acc >= STEP && n < 8) {
    if (mode === 'play' || mode === 'pause') sendInput();
    if (MP.role === 'client') {
      const lp = sim.s.players[PID];
      if (lp) {
        lp.ox = lp.x; lp.oy = lp.y; lp.oz = lp.z;
        if (!lp.dead && mode !== 'end') { sim.movePlayer(lp, STEP); if (sim.weapon(lp, STEP)) clientShoot(lp); }
      }
    } else {
      if (MP.role === 'host') hostPump();
      sim.step(STEP);
      if (MP.role === 'host') hostCollect();
    }
    if (render) handleEvents(sim);
    else for (const e of sim.drainEvents()) if ((e.type === 'victory' || e.type === 'defeat') && endTimer <= 0) endTimer = 2.2;
    acc -= STEP; n++;
  }
  if (n >= 8) acc = 0;
  if (MP.role === 'client') { NP.smoothMirror(sim, sdt, timeNow, PID); clientPresence(false); }
  else if (MP.role === 'host') hostSend(false);
}
let lastT = performance.now(), acc = 0, demoCamD = 6, demoYaw = 0;
const LIGHTS = [];
function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  timeNow += dt;
  adaptQuality(dt); fpsMeter(dt);
  if (slowmoT > 0) { slowmoT -= dt; timeScale = slowmoT > 0.5 ? 0.3 : lerp(1, 0.3, slowmoT / 0.5); } else timeScale = 1;
  const sdt = dt * timeScale;
  const fxdt = mode === 'pause' ? 0 : sdt;
  const S = mode === 'menu' ? demo : sim;
  if (!S) return;
  // 模拟
  if (mode === 'menu') {
    acc += dt;
    while (acc >= STEP) { demo.step(STEP); demo.drainEvents(); acc -= STEP; }
    if (demo.s.phase === 'victory' || demo.s.phase === 'defeat' || (demo.s.phase === 'build')) { if (demo.s.phase !== 'build' || demo.s.wave > 2) makeDemo(); else demo.apply({ t: 'ready' }); }
    frameAlpha = acc / STEP;
  } else if (mode === 'play' || mode === 'end' || (mode === 'pause' && MP.role !== 'solo')) {
    worldStep(sdt, true);
    frameAlpha = acc / STEP;
    if (endTimer > 0) { endTimer -= dt; if (endTimer <= 0 && (mode === 'play' || mode === 'pause')) showEnd(); }
  }
  simNow = S.s.time + frameAlpha * STEP;
  trapIndex.clear(); for (const tr of S.s.traps) trapIndex.set(tr.id, tr);
  // 炮台客户端瞄准平滑
  for (const tr of S.s.traps) if (tr.type === 'sentry' || tr.type === 'aa' || tr.type === 'rail' || tr.type === 'mortar' || tr.type === 'gatling') {
    const tgt = tr.aimYaw || 0;
    if (tr.cAim === undefined) tr.cAim = tgt;
    let d = tgt - tr.cAim; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
    tr.cAim += d * Math.min(1, dt * 12);
  }

  // 摄像机
  let ex, ey, ez, yaw, pitch, fov = settings.fov || 75;
  if (mode === 'menu') {
    const pth = demo.paths[demo.lanes[0]], tmp = { x: 0, z: 0, dx: 0, dz: 0 };
    demoCamD += dt * 3.2; if (demoCamD > pth.len - 8) demoCamD = 4;
    pathAt(pth, demoCamD, tmp);
    const ahead = { x: 0, z: 0, dx: 0, dz: 0 }; pathAt(pth, demoCamD + 6, ahead);
    const ty = Math.atan2(-(ahead.x - tmp.x), -(ahead.z - tmp.z));
    let dd = ty - demoYaw; while (dd > Math.PI) dd -= Math.PI * 2; while (dd < -Math.PI) dd += Math.PI * 2;
    demoYaw += dd * Math.min(1, dt * 1.5);
    ex = tmp.x - tmp.dz * 1.6; ey = 3.4; ez = tmp.z + tmp.dx * 1.6; yaw = demoYaw; pitch = -0.12;
  } else {
    const p = sim.s.players[PID];
    const a = frameAlpha;
    const px = lerp(p.ox, p.x, a), py = lerp(p.oy, p.y, a), pz = lerp(p.oz, p.z, a);
    const moving = (keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD) && p.ground && mode === 'play';
    if (moving) cam.bob += dt * (keys.ShiftLeft || keys.ShiftRight ? 13 : 9);
    cam.ads = lerp(cam.ads, mode === 'play' && mouse.r && tool === 'gun' && !p.dead ? 1 : 0, Math.min(1, dt * 12));
    ex = px; ey = py + (p.dead ? 0.4 : 1.62) + (moving ? Math.sin(cam.bob * 2) * 0.035 : 0); ez = pz;
    yaw = cam.yaw; pitch = cam.pitch;
    const sprinting = (keys.ShiftLeft || keys.ShiftRight) && keys.KeyW && p.ground && mode === 'play';
    cam.sprintF = lerp(cam.sprintF || 0, sprinting ? 1 : 0, Math.min(1, dt * 6));
    const sniperAds = tool === 'gun' && p.wpn === 'sniper';
    fov = lerp((settings.fov || 75) + cam.sprintF * 7, sniperAds ? 20 : 50, cam.ads);
    const scope = sniperAds && cam.ads > 0.85 && mode !== 'end';
    if (cache.scope !== scope) { cache.scope = scope; $('scope').hidden = !scope; }
    // 脚步与心跳
    if (moving) { cam.step = (cam.step || 0) + dt * (sprinting ? 2.6 : 1.9); if (cam.step > 1) { cam.step = 0; Snd.play('step'); } }
    if (!p.ground) cam.air = true; else if (cam.air) { cam.air = false; cam.land = 0.12; Snd.play('land'); }
    if (cam.land > 0) { cam.land -= dt; ey -= cam.land * 0.6; }
    if (!p.dead && p.hp < 35 && mode === 'play') { cam.heart = (cam.heart || 0) - dt; if (cam.heart <= 0) { cam.heart = 0.85; Snd.play('heart'); } }
  }
  if (cam.shake > 0) {
    yaw += rnd(-1, 1) * cam.shake * 0.012; pitch += rnd(-1, 1) * cam.shake * 0.012; ey += rnd(-1, 1) * cam.shake * 0.04;
    cam.shake = Math.max(0, cam.shake - dt * 2.2);
  }
  setupCamera(ex, ey, ez, yaw, pitch, fov);
  if (mode === 'play') aim = computeAim();

  // 视角模型状态
  vm.kick = Math.max(0, vm.kick - dt * 7); vm.flash -= dt; vm.switchT = Math.max(0, vm.switchT - dt);
  crystalHitT = Math.max(0, crystalHitT - dt * 1.5);

  // ---------- 绘制 ----------
  if (!staticCache.has(S.def.id)) staticCache.set(S.def.id, [buildStatic(S)]);
  const statics = staticCache.get(S.def.id);
  const TH = themeOf(S);
  const SK = window.__skip || {};
  if (!SK.portal) drawPortals(S, dt);
  if (!SK.crystal) drawCrystal(S);
  for (const tr of S.s.traps) {
    if (Math.abs(tr.wx - cam.x) > 70 || Math.abs(tr.wz - cam.z) > 70) continue;
    if (E.inView(tr.wx, tr.wy + 1.4, tr.wz, TRAP[tr.type].big ? 4 : 2.6) || (tr.line && tr.activeT > 0)) drawTrap(S, tr);
    if (tr.type === 'tesla' && simNow - tr.fireT < 0.14 && tr.targets) {
      for (const id of tr.targets) {
        const m = S._mById.get(id); if (!m) continue;
        let x0 = tr.wx, y0 = 2.75, z0 = tr.wz; const x1 = m.x, y1 = m.y + MON[m.type].body[0], z1 = m.z;
        for (let k = 1; k <= 4; k++) {
          const f = k / 4, jx = k < 4 ? rnd(-0.35, 0.35) : 0, jy = k < 4 ? rnd(-0.35, 0.35) : 0, jz = k < 4 ? rnd(-0.35, 0.35) : 0;
          const xn = lerp(tr.wx, x1, f) + jx, yn = lerp(2.75, y1, f) + jy, zn = lerp(tr.wz, z1, f) + jz;
          E.pushBeam('box', x0, y0, z0, xn, yn, zn, 0.06, 0.06, c(0.85, 0.75, 1, 1, 1, 0, true));
          E.pushBeam('box', x0, y0, z0, xn, yn, zn, 0.22, 0.22, c(0.6, 0.4, 1, 0.25, 1, 0, true));
          x0 = xn; y0 = yn; z0 = zn;
        }
      }
    }
    if (tr.type === 'flame' && tr.activeT > 0 && tr.line && Math.random() < 0.85) {
      const d = DIRS[tr.dir], len = tr.line.length * T;
      particle({ x: tr.wx - d[0] * 0.45, y: 1.1 + rnd(-0.1, 0.1), z: tr.wz - d[1] * 0.45, vx: -d[0] * len * 2.6 + rnd(-0.8, 0.8), vy: rnd(-0.3, 0.9), vz: -d[1] * len * 2.6 + rnd(-0.8, 0.8), life: 0.38, s0: 0.25, s1: 1.25, c: [1, rnd(0.35, 0.6), 0.1], drag: 1.2, a0: 0.75 });
    }
    if (tr.disT > 0 && Math.random() < 0.15) burst(tr.wx, tr.wy + 1, tr.wz, 1, { c: [0.45, 0.85, 1], sp0: 1, sp1: 3, s0: 0.06, l0: 0.1, l1: 0.25 });
    if (tr.type === 'laser' && tr.activeT > 0 && tr.line && S._bk) {
      for (const idx of tr.line) { const arr = S._bk.get(idx); if (!arr) continue; for (const m of arr) if (!m.dead && Math.random() < 0.35) burst(m.x, MON[m.type].fly ? m.y : 1.5, m.z, 1, { c: [1, 0.45, 0.4], sp0: 1, sp1: 4, s0: 0.06, l0: 0.1, l1: 0.25, grav: 6 }); }
    }
    if (tr.type === 'slow' && Math.random() < (tr.activeT > 0 ? 0.5 : 0.06)) particle({ x: tr.wx + rnd(-1, 1), y: 0.15, z: tr.wz + rnd(-1, 1), vy: rnd(0.4, 1.0), life: rnd(0.8, 1.4), s0: 0.07, s1: 0.0, c: [0.6, 0.85, 1], grav: 0, drag: 0 });
    const bt = buildFx.get(tr.id);
    if (bt !== undefined) {
      const k = (timeNow - bt) / 0.55;
      if (k >= 1) buildFx.delete(tr.id);
      else {
        const hh = TRAP[tr.type].block ? 3.2 : (TRAP[tr.type].cat === 'pad' ? 2 : 1.4);
        const by = tr.kind === 'ceil' ? tr.wy - hh : tr.kind === 'wall' ? tr.wy - 0.7 : tr.wy;
        const bw = TRAP[tr.type].big ? T * 2 : T;
        E.push('box', tr.wx, by + hh / 2, tr.wz, 0, bw * 0.96, hh, bw * 0.96, c(0.4, 1, 0.85, 0.1 * (1 - k), 1, 0, true));
        E.push('box', tr.wx, by + k * hh, tr.wz, 0, bw, 0.04, bw, c(0.5, 1, 0.9, 1 - k, 1, 0, true));
      }
    }
  }
  S_cur = S;
  if (S.outdoor) E.push('sphere', cam.x, cam.y, cam.z, 0, 480, 480, 480, col(1, 1, 1, 1, 0, 0, 18, false, true));
  drawLava(S);
  drawShells(fxdt);
  for (const m of S.s.monsters) { const md = MON[m.type]; if (E.inView(m.x, m.y + md.body[0], m.z, md.head[0] + md.body[1] + 1.2)) drawMonster(m, frameAlpha); }
  // 调试：显示命中判定球（window.__hitboxes = true）
  if (window.__hitboxes) for (const m of S.s.monsters) {
    const def = MON[m.type], hf = def.head[2] || 0, k = frameAlpha;
    const mx = lerp(m.ox, m.x, k), my = lerp(m.oy, m.y, k), mz = lerp(m.oz, m.z, k);
    E.push('sphere', mx + m.fx * hf, my + def.head[0], mz + m.fz * hf, 0, def.head[1] * 2, def.head[1] * 2, def.head[1] * 2, c(1, 0.85, 0.1, 0.45, 1, 0, true, true));
    E.push('sphere', mx, my + def.body[0], mz, 0, def.body[1] * 2, def.body[1] * 2, def.body[1] * 2, c(0.2, 1, 0.5, 0.18, 1, 0, true, true));
    if (window.__ruler) for (let h = 0; h <= 7; h += 0.1) { const maj = Math.abs(h - Math.round(h)) < 0.01, half = Math.abs(h * 2 - Math.round(h * 2)) < 0.01; E.push('box', mx + window.__ruler, my + h, mz, 0, maj ? 0.5 : half ? 0.3 : 0.14, 0.012, 0.02, maj ? c(1, 0.2, 0.2, 1, 1) : half ? c(1, 1, 1, 1, 1) : c(0.6, 0.6, 0.6, 1, 0.6)); }
  }
  drawCorpses(fxdt);
  drawDecals(fxdt);
  updateBossFx(fxdt);
  drawProj(S, frameAlpha);
  drawStrikes(fxdt);
  drawDevices(S, fxdt);
  drawLabs(S, fxdt);
  if (mode !== 'menu') drawPings(dt);
  if (mode !== 'menu') { drawOtherPlayers(S, frameAlpha, dt); drawBuildOverlay(); }
  { const mt = mode === 'play' && sim && myMount(); if (mt && mt.type === 'mortar') { updateMortarAim(mt); drawMortarAim(mt); if (mouse.l) tryMortarFire(mt); } else mortarAim = null; }
  if (mode === 'play' && aim && aim.trap && !(aim.slot && aim.can && aim.can.ok)) {
    const tr = aim.trap, yy = tr.kind === 'ceil' ? tr.wy - 0.05 : tr.wy + 0.05;
    if (tr.kind === 'wall') E.push('ring', tr.wx - DIRS[tr.dir][0] * 0.4, tr.wy - 1.45, tr.wz - DIRS[tr.dir][1] * 0.4, 0, 0.9, 1, 0.9, c(1, 0.75, 0.3, 0.8, 1, 0, true));
    else E.push('ring', tr.wx, yy, tr.wz, timeNow, T * (TRAP[tr.type].big ? 1.15 : 0.62), 1, T * (TRAP[tr.type].big ? 1.15 : 0.62), c(1, 0.75, 0.3, 0.8, 1, 0, true));
  }
  // 子弹轨迹
  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i]; t.t += fxdt;
    if (t.t > t.life) { tracers.splice(i, 1); continue; }
    const k = 1 - t.t / t.life, cc = t.c || [1, 0.85, 0.5];
    // 拖尾：只画子弹前段，随时间向命中点推进
    const f0 = Math.max(0, t.t / t.life - 0.15), f1 = Math.min(1, t.t / t.life + 0.55);
    const ax = lerp(t.x1, t.x2, f0), ay = lerp(t.y1, t.y2, f0), az = lerp(t.z1, t.z2, f0), bx = lerp(t.x1, t.x2, f1), by = lerp(t.y1, t.y2, f1), bz = lerp(t.z1, t.z2, f1);
    const tw = t.w || 1;
    if (tw > 1) {
      // 狙击：整条电磁轨迹，逐渐变细消散
      E.pushBeam('box', t.x1, t.y1, t.z1, t.x2, t.y2, t.z2, 0.03 * tw * k, 0.03 * tw * k, c(cc[0], cc[1], cc[2], k, 1, 0, true));
      E.pushBeam('box', t.x1, t.y1, t.z1, t.x2, t.y2, t.z2, 0.14 * tw * k, 0.14 * tw * k, c(cc[0], cc[1], cc[2], k * 0.2, 1, 0, true));
      continue;
    }
    E.pushBeam('box', ax, ay, az, bx, by, bz, 0.022, 0.022, c(cc[0], cc[1], cc[2], k, 1, 0, true));
    E.pushBeam('box', ax, ay, az, bx, by, bz, 0.09, 0.09, c(cc[0], cc[1] * 0.8, cc[2] * 0.6, k * 0.25, 1, 0, true));
  }
  // 冲击环
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i]; r.t += fxdt;
    if (r.t > r.life) { rings.splice(i, 1); continue; }
    if (r.t < 0) continue;
    if (r.vy) r.y += r.vy * fxdt;
    const f = r.t / r.life, rr = lerp(r.r0, r.r1, Math.sqrt(f));
    E.push('ring', r.x, r.y, r.z, 0, rr, 1, rr, c(r.c[0], r.c[1], r.c[2], 1 - f, 1, 0, true));
  }
  // 粒子
  for (let i = parts.length - 1; i >= 0; i--) {
    const q = parts[i]; q.t += fxdt;
    if (q.t >= q.life) { parts.splice(i, 1); continue; }
    q.vy -= q.grav * fxdt;
    const dr = Math.exp(-q.drag * fxdt); q.vx *= dr; q.vy *= dr; q.vz *= dr;
    q.x += q.vx * fxdt; q.y += q.vy * fxdt; q.z += q.vz * fxdt;
    if (q.bounce && q.y < 0.05) { q.y = 0.05; q.vy = -q.vy * 0.35; q.vx *= 0.6; q.vz *= 0.6; }
    const f = q.t / q.life, s = lerp(q.s0, q.s1, f), al = q.a0 * (1 - f * f);
    if (q.g === 'box') E.push('box', q.x, q.y, q.z, q.t * 6, s, s, s, c(q.c[0], q.c[1], q.c[2], q.add ? al : Math.min(1, al * 1.5), q.add ? 1 : 0.15, 0, q.add));
    else E.push('sphere', q.x, q.y, q.z, 0, s, s, s, c(q.c[0], q.c[1], q.c[2], al, q.add ? 1 : 0.15, 0, q.add));
  }
  if ((mode === 'play' || mode === 'pause') && !SK.vm) drawViewmodel(dt);

  // 光源
  LIGHTS.length = 0;
  const cp = S.crystalPos, cf = S.s.crystal.hp / S.s.crystal.max;
  LIGHTS.push({ x: cp.x, y: 3, z: cp.z, r: 20, c: [lerp(1, 0.37, cf), lerp(0.3, 0.89, cf), lerp(0.3, 1, cf)], i: 1.3 + crystalHitT });
  for (const lane of S.lanes) { if (laneState(S, lane) === 'closed') continue; const p0 = S.paths[lane].pts[0]; LIGHTS.push({ x: p0.x, y: 2.5, z: p0.z, r: 13, c: laneState(S, lane) === 'soon' ? [1, 0.7, 0.2] : [1, 0.25, 0.2], i: 1.2 }); }
  for (let i = lights.length - 1; i >= 0; i--) { const L = lights[i]; L.t += dt; if (L.t > L.life) { lights.splice(i, 1); continue; } LIGHTS.push({ x: L.x, y: L.y, z: L.z, r: L.r, c: L.c, i: L.i * (1 - L.t / L.life) }); }
  for (const tr of S.s.traps) if ((tr.type === 'laser' || tr.type === 'flame') && tr.activeT > 0 && LIGHTS.length < 40) LIGHTS.push({ x: tr.wx - DIRS[tr.dir][0], y: 1.5, z: tr.wz - DIRS[tr.dir][1], r: 6, c: tr.type === 'laser' ? [1, 0.25, 0.3] : [1, 0.55, 0.2], i: 1.1 });
  const boss = S.s.bossId && S._mById.get(S.s.bossId);
  if (boss) LIGHTS.push({ x: boss.x, y: 4.5, z: boss.z, r: 10, c: [1, 0.4, 0.25], i: 1.2 });
  LIGHTS.sort((a, b) => Math.hypot(a.x - cam.x, a.z - cam.z) - a.r * 0.5 - (Math.hypot(b.x - cam.x, b.z - cam.z) - b.r * 0.5));
  const dark = S.s.mut && S.s.mut.includes('blackout') && mode !== 'menu';
  const sc3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  E.flush({
    vp: VP, eye: [cam.x, cam.y, cam.z], sky: dark ? sc3(TH.sky, 0.35) : TH.sky, ground: dark ? sc3(TH.ground, 0.35) : TH.ground, sunDir: [0.45, -0.74, 0.5], sunCol: dark ? sc3(TH.sun, 0.3) : TH.sun,
    fog: dark ? sc3(TH.fog, 0.4) : TH.fog, fogD: dark ? 0.03 : (TH.fogD || 0.0105), lights: LIGHTS.slice(0, 12),
    bloom: 0.85, bloomThr: 0.92, vig: 0.85, detail: settings.detail === 'low' || quality.autoLow ? 0.25 : 1, detailDist: settings.detail === 'low' || quality.autoLow ? 36 : 64,
    tint: mode !== 'menu' && cf < 0.3 ? [0.6, 0.02, 0.05, 0.22 * (0.5 + 0.5 * Math.sin(timeNow * 5))] : (timeScale < 1 ? [0.9, 0.6, 0.3, 0.15] : null),
  }, SK.static ? [] : statics);

  if ((mode === 'play' || mode === 'pause' || mode === 'end') && !SK.hud) { updateHUD(dt); updateNums(dt); updateTags(); updateTeam(); }
}

/* ============================================================
 * 启动（支持热更新恢复）
 * ============================================================ */
function bestKey(map, d, md) { return `${map}|${d}|${md === true ? 'endless' : md === false || !md ? 'std' : md}`; }
function loadBest() { try { return JSON.parse(localStorage.getItem('jhsw-best2') || '{}'); } catch (e) { return {}; } }
function bestText(r, endless) { return r ? (endless ? `最佳 第 ${r.wave} 波 · ${r.grade}` : (r.win ? `已通关 · ${r.grade}` : `最佳 第 ${r.wave} 波`)) : ''; }
function showBest() {
  const all = loadBest(), md = selMode === 'endless' ? 'endless' : 'std', en = selMode === 'endless';
  document.querySelectorAll('[data-diff]').forEach(b => { const el = b.querySelector('em'); if (el) el.textContent = selMode === 'daily' ? '' : bestText(all[bestKey(selMap, b.dataset.diff, md)], en); });
  document.querySelectorAll('.mapCard').forEach(b => { const el = b.querySelector('.mc-b'); if (el) el.textContent = selMode === 'daily' ? '' : (bestText(all[bestKey(b.dataset.map, diff, md)], en) || '未挑战'); });
  const d = dailySpec(todayStr()), dr = all[bestKey(d.map, d.diff, 'daily:' + d.date)];
  $('dailyBest').textContent = PROG.dailyWins().includes(d.date) ? '今日已通关 ★' : dr ? `今日最佳 第 ${dr.wave} 波` : '';
  $('starTag').textContent = `★ ${PROG.stars() - PROG.spent()}`;
}
function drawThumb(cv, def) {
  const S = new Sim({ map: def.id }), k = 3;
  cv.width = S.W * k; cv.height = S.H * k;
  const g = cv.getContext('2d');
  const C = { [TILE.WALL]: '#0b1017', [TILE.LANE]: '#33475a', [TILE.FLOOR]: '#465260', [TILE.PAD]: '#6b5730', [TILE.BASE]: '#1f5a6c', [TILE.SPAWN]: '#7a2a30' };
  paintTiles(g, S, k, C);
  g.strokeStyle = 'rgba(255,110,95,.8)'; g.lineWidth = 1;
  for (const l of S.lanes) { g.beginPath(); S.paths[l].pts.forEach((p, i) => { const X = p.x / T * k, Y = p.z / T * k; i ? g.lineTo(X, Y) : g.moveTo(X, Y); }); g.stroke(); }
  for (const l of S.lanes) { const p0 = S.paths[l].pts[0]; g.fillStyle = S.laneFrom(l) > 1 ? '#ffb547' : '#ff5266'; g.beginPath(); g.arc(p0.x / T * k, p0.z / T * k, 3.2, 0, Math.PI * 2); g.fill(); }
  const cp = S.crystalPos; g.fillStyle = '#5fe3ff'; g.beginPath(); g.arc(cp.x / T * k, cp.z / T * k, 4, 0, Math.PI * 2); g.fill();
}
function buildMapCards() {
  const box = $('mapCards'); box.innerHTML = '';
  for (const def of MAP_LIST) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'mapCard'; btn.dataset.map = def.id;
    const lanes = Object.keys(def.lanes).length, late = def.laneFrom ? Object.keys(def.laneFrom).length : 0;
    btn.innerHTML = `<canvas aria-hidden="true"></canvas><span class="mc-n"><i>${String(def.order).padStart(2, '0')}</i>${def.name}</span><span class="mc-s">出怪口 ×${lanes}${late ? `（${late} 个中途开启）` : ''} · ${def.waves.length} 波</span><span class="mc-b"></span>`;
    try { drawThumb(btn.querySelector('canvas'), def); } catch (e) { console.warn(e); }
    btn.addEventListener('click', () => { if (selMap === def.id || selMode === 'daily') return; selMap = def.id; refreshSel(); makeDemo(); });
    box.appendChild(btn);
  }
}
/* ---------- 主菜单导航：首页 → 单人游戏 / 多人游戏 → 开局设置（关卡 → 模式 → 难度 → 职业）---------- */
let menuScr = 'home', setupStep = 0;
const SETUP_STEPS = 4;
function goScreen(scr) {
  menuScr = scr;
  const m = $('menu'); m.dataset.scr = scr;
  for (const el of m.querySelectorAll(':scope > [data-scr]')) el.hidden = el.dataset.scr !== scr;
  if (scr === 'setup') setStep(setupStep);
  renderMP(); updateMenuSum();
  const f = m.querySelector(`:scope > [data-scr="${scr}"] ${scr === 'home' ? '.hBtn.primary' : '.backBtn'}`);
  if (f && !TOUCH) f.focus({ preventScroll: true });
}
function setStep(i) {
  setupStep = Math.max(0, Math.min(SETUP_STEPS - 1, i));
  for (const el of document.querySelectorAll('#menu .step')) el.hidden = +el.dataset.step !== setupStep;
  for (const li of document.querySelectorAll('#stepper li')) {
    const k = +li.dataset.stepi;
    li.className = k === setupStep ? 'cur' : k < setupStep ? 'done' : '';
    li.querySelector('button').setAttribute('aria-current', k === setupStep ? 'step' : 'false');
  }
  const last = setupStep === SETUP_STEPS - 1;
  $('stepNext').hidden = last; $('startBtn').hidden = !last;
  $('stepPrev').hidden = setupStep === 0;
  const st = document.querySelector('#menu .steps'); if (st) st.scrollTop = 0;
}
function setupBack() {
  if (setupStep > 0) { setStep(setupStep - 1); return; }
  goScreen(MP.role !== 'solo' ? 'mp' : 'home');
}
function setupMenuNav() {
  $('soloBtn').addEventListener('click', () => { if (MP.role !== 'solo') { goScreen('mp'); return; } setupStep = 0; goScreen('setup'); });
  $('mpBtn').addEventListener('click', () => goScreen('mp'));
  for (const b of document.querySelectorAll('#menu [data-back]')) b.addEventListener('click', () => goScreen(b.dataset.back));
  $('setupBack').addEventListener('click', setupBack);
  $('stepPrev').addEventListener('click', () => setStep(setupStep - 1));
  $('stepNext').addEventListener('click', () => setStep(setupStep + 1));
  for (const li of document.querySelectorAll('#stepper li')) li.querySelector('button').addEventListener('click', () => setStep(+li.dataset.stepi));
  // 房间里的“下一步”：房主去选关卡，队友直接去选职业
  $('roomNext').addEventListener('click', () => { setupStep = MP.role === 'client' ? SETUP_STEPS - 1 : 0; goScreen('setup'); });
  addEventListener('keydown', e => {
    if (mode !== 'menu' || e.key !== 'Escape' || anyFullPage()) return;
    if (menuScr === 'setup') setupBack(); else if (menuScr === 'mp') goScreen('home');
  });
  goScreen('home');
}
function anyFullPage() { return ['settings', 'help', 'talents', 'lb'].some(id => $(id) && !$(id).hidden); }
function updateMenuSum() {
  const room = MP.role !== 'solo' ? ` · 房间 ${MP.code.toUpperCase()}` : '';
  const txt = `${MAPS[selMap].name} · ${DIFFS[diff].name}${selMode === 'endless' ? ' · 无尽' : selMode === 'daily' ? ' · 每日挑战' : ' · 标准'} · ${CLS[selCls].name}${selMut.length ? ` · 突变×${selMut.length}` : ''}${room}`;
  const d = $('dSum'); if (d) d.textContent = txt;
  const el = $('mSum'); if (!el) return;
  el.textContent = txt;
}
function refreshSel() {
  setTimeout(updateMenuSum, 0);
  const hc = MP.role === 'client' && MP.hostPres && MP.hostPres.cfg;
  const prevMap = selMap;
  if (hc && MAPS[hc.m] && DIFFS[hc.d]) {
    selMode = hc.mo === 'daily' || hc.mo === 'endless' ? hc.mo : (hc.e ? 'endless' : 'std');
    selMap = hc.m; diff = hc.d; selMut = Array.isArray(hc.mut) ? hc.mut.filter(id => MUT[id]) : [];
  } else if (selMode === 'daily') {
    const d = dailySpec(todayStr()); selMap = d.map; diff = d.diff; selMut = d.mut.slice();
  }
  selEndless = selMode === 'endless';
  if (selMap !== prevMap && mode === 'menu' && demo) makeDemo();
  const lockSel = MP.role === 'client', lockDaily = selMode === 'daily';
  document.querySelectorAll('[data-mode]').forEach(b => { b.disabled = lockSel; });
  document.querySelectorAll('.mapCard, [data-diff]').forEach(b => { b.disabled = lockSel || lockDaily; });
  document.querySelectorAll('.mapCard').forEach(b => b.setAttribute('aria-pressed', b.dataset.map === selMap ? 'true' : 'false'));
  document.querySelectorAll('[data-diff]').forEach(b => b.setAttribute('aria-pressed', b.dataset.diff === diff ? 'true' : 'false'));
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === selMode ? 'true' : 'false'));
  renderMutChips(lockSel || lockDaily);
  const devs = MAPS[selMap].devices || [];
  $('mapDesc').textContent = (selMode === 'daily' ? `今日挑战（${todayStr()}）：${MAPS[selMap].name} · ${DIFFS[diff].name} · 突变 ${selMut.map(id => MUT[id].name).join('、')}。每天组合都不同，通关得 1 颗星。` : '') + MAPS[selMap].desc + (devs.length ? ` 地图机关：${[...new Set(devs.map(d => DEVICE[d.type].name))].join('、')}（走到控制台按 F）。` : '') + ((MAPS[selMap].labs || []).length ? ' 科研舱（小地图「科」）可研究全队科技、补给弹药。' : '') + (selEndless ? ' 无尽模式：剧本波次之后无限出怪，怪物越来越强，比拼坚持的波数。' : '');
  showBest();
  if (MP.role === 'host') { hostPresence(); lobbyAd(); }
  if (MP.role !== 'client') {
    if (selMode !== 'daily') customSel = { map: selMap, diff, mut: selMut.slice() };
    try { localStorage.setItem('jhsw-sel', JSON.stringify({ map: customSel.map, diff: customSel.diff, mode: selMode, mut: customSel.mut })); } catch (e) { /* 无存储 */ }
  }
  renderMP();
}
const MAPN = id => (MAPS[id] ? MAPS[id].name : id);
function syncCls() { document.querySelectorAll('[data-cls]').forEach(b => b.setAttribute('aria-pressed', b.dataset.cls === selCls ? 'true' : 'false')); updateMenuSum(); }
function renderMutChips(locked) {
  const box = $('mutChips');
  if (!box.firstChild) {
    for (const m of MUTATORS) {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.mut = m.id; b.title = m.desc; b.textContent = m.name;
      b.addEventListener('click', () => { if (selMode === 'daily' || MP.role === 'client') return; selMut = selMut.includes(m.id) ? selMut.filter(x => x !== m.id) : selMut.concat(m.id); refreshSel(); });
      box.appendChild(b);
    }
  }
  for (const b of box.children) { b.setAttribute('aria-pressed', selMut.includes(b.dataset.mut) ? 'true' : 'false'); b.disabled = locked; }
  const sc = 1 + selMut.reduce((a, id) => a + MUT[id].w, 0);
  $('mutScore').textContent = selMut.length ? `难度系数 ×${sc.toFixed(2)} · ${selMut.map(id => MUT[id].desc).join('；')}` : '不选也可以';
}
// 天赋面板
function renderTalents() {
  const total = PROG.stars(), left = total - PROG.spent();
  $('talStars').textContent = `★ 可用 ${left} / 共获得 ${total}`;
  const box = $('talList'); box.innerHTML = '';
  for (const t of TALENTS) {
    const r = Math.min(t.max, PROG.tal[t.id] | 0);
    const row = document.createElement('div'); row.className = 'talRow' + (r ? ' has' : '');
    const nm = document.createElement('b'); nm.textContent = (t.team ? '◆ ' : '') + t.name;
    const ds = document.createElement('span'); ds.className = 'td'; ds.textContent = r ? t.desc(r) : `每级：${t.desc(1)}`;
    const pips = document.createElement('span'); pips.className = 'pips';
    for (let i = 0; i < t.max; i++) { const pi = document.createElement('i'); if (i < r) pi.className = 'on'; pips.appendChild(pi); }
    const bt = document.createElement('span'); bt.className = 'bt';
    const minus = document.createElement('button'); minus.type = 'button'; minus.textContent = '−'; minus.disabled = r <= 0; minus.setAttribute('aria-label', '降低 ' + t.name);
    const plus = document.createElement('button'); plus.type = 'button'; plus.textContent = '+'; plus.disabled = r >= t.max || left <= 0; plus.setAttribute('aria-label', '提升 ' + t.name);
    minus.addEventListener('click', () => { PROG.tal[t.id] = r - 1; PROG.save(); renderTalents(); showBest(); });
    plus.addEventListener('click', () => { PROG.tal[t.id] = r + 1; PROG.save(); renderTalents(); showBest(); });
    bt.append(minus, plus);
    row.append(nm, bt, ds, pips); box.appendChild(row);
  }
}
let mpNoteText = '', mpNoteBad = false;
function mpNote(t, bad) { mpNoteText = t || ''; mpNoteBad = !!bad; renderMP(); if (t && mode !== 'menu') feed(t, bad ? 'bad' : ''); }
function peerName(peer) {
  if (peer === myPeer()) return MP.name;
  if (MP.role === 'host') return cleanName((MP.pres.get(peer) || {}).n) || '队友';
  const g = MP.game && MP.game.peers().find(p => p.peer === peer);
  return cleanName(g && g.presence && g.presence.n) || '队友';
}
// 主菜单里的联机面板
function renderMP() {
  const box = $('mpBox');
  if (!box || mode !== 'menu') return;
  const st = $('mpStatus'), on = MP.status === 'on';
  if (MP.status === 'init') st.textContent = '连接中…';
  else if (!on) st.textContent = '不可用';
  else st.textContent = MP.connected ? `在线 ${Math.max(1, MP.lobbyPeers.length)} 人` : '重新连接中…';
  $('mpOff').hidden = on || MP.status === 'init';
  const sr = $('srvRow');
  if (sr) {
    sr.hidden = HAS_CLAUDE || !!window.__RELAY_SAME_ORIGIN || MP.role !== 'solo';
    const inp = $('srvIn'); if (document.activeElement !== inp && !inp.dataset.edit) inp.value = (MP.server || '').replace(/^wss?:\/\//, '');
  }
  if (MP.via === 'relay' && on && !MP.connected && MP.status === 'on') st.textContent = '连接服务器中…';
  const inRoom = MP.role !== 'solo';
  $('mpIdle').hidden = !on || inRoom;
  $('mpRoom').hidden = !inRoom;
  $('hostBtn').disabled = !MP.connected || MP.joining;
  const note = $('mpNote'); note.textContent = mpNoteText; note.className = 'mpNote' + (mpNoteBad ? ' bad' : ''); note.hidden = !mpNoteText;
  // 房间列表
  if (on && !inRoom) {
    const ads = MP.lobbyPeers.filter(p => !p.isMe && p.presence && p.presence.ad && p.presence.ad.c).map(p => ({ peer: p.peer, ad: p.presence.ad }));
    const list = $('roomList');
    const key = JSON.stringify(ads.map(a => a.ad)) + MP.joining + '|' + (MP.pwFor || '');
    if (list.dataset.key !== key) {
      list.dataset.key = key;
      list.innerHTML = '';
      if (!ads.length) { const e = document.createElement('p'); e.className = 'fine'; e.textContent = MP.via === 'relay' ? '暂时没有房间。创建一个后，连在同一个服务器上的朋友（网页或安卓版）就能在这里看到并加入。' : '暂时没有房间。创建一个，再把这个页面分享给朋友，他们打开后就能在这里看到并加入。'; list.appendChild(e); }
      for (const { peer, ad } of ads.slice(0, 8)) {
        const row = document.createElement('div'); row.className = 'roomRow';
        const info = document.createElement('div');
        const nm = document.createElement('b'); nm.textContent = `${ad.lk ? '🔒 ' : ''}${cleanName(ad.n) || '玩家'} 的房间`;
        const sub = document.createElement('span');
        const ver = ad.v === NP.VERSION;
        sub.textContent = `${ad.mo === 'daily' ? '每日挑战 · ' : ''}${MAPN(ad.m)} · ${DIFFS[ad.d] ? DIFFS[ad.d].name : ''}${ad.e ? ' · 无尽' : ''}${ad.mu ? ` · 突变×${ad.mu | 0}` : ''} · ${ad.p | 0}/4 人 · ${ad.ph === 'play' ? (ad.w ? `战斗中 · 第 ${ad.w | 0} 波` : '布防中') : '等待开始'}${ver ? '' : ' · 版本不同'}`;
        info.append(nm, sub);
        const b = document.createElement('button'); b.type = 'button'; b.className = 'ghostBtn small';
        b.textContent = (ad.p | 0) >= 4 ? '已满' : '加入'; b.disabled = (ad.p | 0) >= 4 || !ver || MP.joining;
        b.dataset.code = String(ad.c).replace(/[^a-z0-9]/g, '').slice(0, 8); b.dataset.peer = peer;
        if (ad.lk) b.dataset.lock = '1';
        row.append(info, b);
        if (ad.lk && MP.pwFor === b.dataset.code) {
          // 有密码的房间：在这一行展开密码输入
          row.classList.add('pwOpen');
          const pr = document.createElement('div'); pr.className = 'pwRow';
          const inp = document.createElement('input'); inp.maxLength = 16; inp.placeholder = '输入房间密码'; inp.autocomplete = 'off'; inp.spellcheck = false; inp.className = 'pwIn';
          const go = document.createElement('button'); go.type = 'button'; go.className = 'ghostBtn small'; go.textContent = '进入';
          go.dataset.pwgo = b.dataset.code; go.dataset.peer = peer;
          inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') go.click(); });
          pr.append(inp, go); row.appendChild(pr);
          b.hidden = true;
          setTimeout(() => inp.focus(), 0);
        }
        list.appendChild(row);
      }
    }
  }
  // 房间内：玩家列表
  if (inRoom) {
    const host = MP.role === 'host';
    $('roomTitle').textContent = `${(host ? MP.pk : MP.hostPres && MP.hostPres.lk) ? '🔒 ' : ''}房间 ${MP.code.toUpperCase()}`;
    $('roomRole').textContent = host ? '你是房主' : '队友';
    let roster = host ? [myPeer(), ...MP.roster] : (MP.hostPres && Array.isArray(MP.hostPres.roster) ? MP.hostPres.roster : []);
    roster = roster.filter(Boolean).slice(0, 4);
    const ol = $('roster'); ol.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const li = document.createElement('li');
      li.style.setProperty('--tc', TEAM_CSS[i]);
      const peer = roster[i];
      if (peer) { li.textContent = peerName(peer) + (i === 0 ? '（房主）' : '') + (peer === myPeer() ? ' · 你' : ''); }
      else { li.textContent = '空位'; li.className = 'empty'; }
      ol.appendChild(li);
    }
    $('leaveBtn').textContent = host ? '解散房间' : '离开房间';
  }
  // 开始按钮
  const sb = $('startBtn');
  if (MP.role === 'host') { sb.textContent = `开始联机（${1 + MP.roster.length} 人）`; sb.disabled = false; }
  else if (MP.role === 'client') { sb.textContent = MP.hostPres && MP.hostPres.ph === 'play' ? '正在进入战局…' : '等待房主开始'; sb.disabled = true; }
  else { sb.textContent = '开始游戏'; sb.disabled = false; }
  // 导航相关文字
  const rn = $('roomNext'); if (rn) rn.textContent = MP.role === 'client' ? '下一步：选择职业' : '下一步：选择关卡';
  const ms = $('mpSub'); if (ms) ms.textContent = inRoom ? `在房间 ${MP.code.toUpperCase()} 中 · ${MP.role === 'host' ? 1 + MP.roster.length : (MP.hostPres && Array.isArray(MP.hostPres.roster) ? MP.hostPres.roster.length : 1)} 人` : on && MP.connected ? `创建或加入房间 · 在线 ${Math.max(1, MP.lobbyPeers.length)} 人` : '创建或加入房间，最多 4 人合作';
  const ss = $('soloSub'); if (ss) ss.textContent = inRoom ? '先离开联机房间' : '选择关卡、模式、难度和职业';
  const tl = $('setupTitle'); if (tl) tl.textContent = inRoom ? `联机房间 ${MP.code.toUpperCase()}${MP.role === 'client' ? ' · 房主设置' : ''}` : '单人游戏';
  if (!inRoom && menuScr === 'setup' && renderMP.wasRoom) goScreen('mp');
  renderMP.wasRoom = inRoom;
}
function bindUI() {
  buildMapCards();
  document.querySelectorAll('[data-diff]').forEach(b => b.addEventListener('click', () => { if (selMode === 'daily') return; diff = b.dataset.diff; refreshSel(); }));
  document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
    const m = b.dataset.mode;
    if (m === selMode) return;
    if (selMode === 'daily') { selMap = customSel.map; diff = customSel.diff; selMut = customSel.mut.slice(); }
    selMode = m; refreshSel();
  }));
  $('talentBtn').addEventListener('click', () => { renderTalents(); show('talents', true); });
  const cb = $('clsSeg');
  for (const c of CLASSES) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.cls = c.id;
    b.innerHTML = `<b>${c.name}</b><small>${c.desc}</small>`;
    b.addEventListener('click', () => { selCls = c.id; try { localStorage.setItem('jhsw-cls', c.id); } catch (e) { /* 无存储 */ } syncCls(); if (MP.role === 'client') clientPresence(true); });
    cb.appendChild(b);
  }
  syncCls();
  $('talClose').addEventListener('click', () => show('talents', false));
  $('talReset').addEventListener('click', () => { PROG.tal = {}; PROG.save(); renderTalents(); showBest(); });
  $('dailySub').textContent = (() => { const d = dailySpec(todayStr()); return `${MAPS[d.map].name} · ${DIFFS[d.diff].name}`; })();
  refreshSel();
  // 第一次点「进入战场」（单人）时自动进入新手引导
  $('startBtn').addEventListener('click', () => { if (MP.role === 'solo' && !tutDone() && selMode === 'std' && !selMut.length) startTutorial(); else startGame(); });
  $('resumeBtn').addEventListener('click', resumeGame);
  $('helpBtn').addEventListener('click', () => openHelp());
  $('menuHelpBtn').addEventListener('click', () => openHelp());
  $('helpClose').addEventListener('click', closeHelp);
  for (const b of document.querySelectorAll('button[data-htab]')) b.addEventListener('click', () => setHelpTab(b.dataset.htab));
  $('settingsBtn').addEventListener('click', () => openSettings());
  $('menuSetBtn').addEventListener('click', () => openSettings());
  $('settingsClose').addEventListener('click', closeSettings);
  for (const b of document.querySelectorAll('button[data-stab]')) b.addEventListener('click', () => { cancelKeyCapture(); setSetTab(b.dataset.stab); });
  $('setKeysTab').hidden = TOUCH; $('setTouchTab').hidden = !TOUCH;
  $('ctrlTouch').hidden = !TOUCH; $('ctrlHelp').hidden = TOUCH;
  const arBtn = $('autoReadyBtn');
  const syncAR = () => { arBtn.setAttribute('aria-pressed', settings.autoReady ? 'true' : 'false'); arBtn.textContent = settings.autoReady ? '开' : '关'; };
  arBtn.addEventListener('click', () => { settings.autoReady = !settings.autoReady; syncAR(); saveSettings(); });
  syncAR();
  $('keysReset').addEventListener('click', () => { settings.keys = {}; rebuildKeys(); saveSettings(); renderKeyList(); fillCtrlHelp(); toast('已恢复默认按键'); });
  const tbS = $('tbScale'), tbA = $('tbAlpha');
  tbS.value = settings.tb.scale || 1; tbA.value = settings.tb.alpha || 1;
  const syncTB = () => { setText('tbScaleV', Math.round(settings.tb.scale * 100) + '%'); setText('tbAlphaV', Math.round(settings.tb.alpha * 100) + '%'); };
  tbS.addEventListener('input', () => { settings.tb.scale = +tbS.value; syncTB(); applyTouchLayout(); saveSettings(); });
  tbA.addEventListener('input', () => { settings.tb.alpha = +tbA.value; syncTB(); applyTouchLayout(); saveSettings(); });
  syncTB();
  $('touchEditBtn').addEventListener('click', openTouchEditor);
  $('touchResetBtn').addEventListener('click', () => { settings.tb = { pos: {}, scale: 1, alpha: 1 }; tbS.value = 1; tbA.value = 1; syncTB(); saveSettings(); applyTouchLayout(); toast('已恢复默认布局'); });
  initChat();
  for (const b of document.querySelectorAll('.pClose')) b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); const k = b.dataset.close; if (k === 'shop') toggleShop(false); else if (k === 'book') toggleBook(false); else if (k === 'lab') toggleLab(false); else if (k === 'evo') closeEvo(); else if (k === 'qchat') toggleQuick(false); });
  fillCtrlHelp();
  $('quitBtn').addEventListener('click', () => {
    // 无尽模式：单人 / 房主中途退出时结算当前成绩（上传排行榜），而不是直接丢掉
    if (sim && sim.s.endless && MP.role !== 'client' && sim.s.wave >= 1 && sim.s.phase !== 'victory' && sim.s.phase !== 'defeat') {
      sim.s.quit = true; sim.s.phase = 'defeat'; sim.ev('defeat');
      if (MP.role === 'host') hostSend(true);
      show('pause', false); showEnd(); return;
    }
    if (MP.role === 'client') { leaveRoom(true); mpNote('已离开房间'); }
    toMenu();
  });
  $('lbBtn').addEventListener('click', openLb);
  $('tutBtn').addEventListener('click', startTutorial);
  $('tutSkip').addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); stopTutorial(false); toast('已跳过新手引导，可在主菜单重新打开'); });
  $('lbClose').addEventListener('click', () => show('lb', false));
  for (const b of document.querySelectorAll('[data-lbsrc]')) b.addEventListener('click', () => { lbSrc = b.dataset.lbsrc; renderLb(); });
  $('againBtn').addEventListener('click', () => { if (MP.role === 'client') return; show('end', false); startGame(); });
  $('menuBtn').addEventListener('click', toMenu);
  $('nick').value = MP.name;
  $('nick').addEventListener('change', () => { setNick($('nick').value); $('nick').value = MP.name; });
  $('nick').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); });
  $('roomPw').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); });
  $('hostBtn').addEventListener('click', () => { setNick($('nick').value); createRoom(); });
  $('leaveBtn').addEventListener('click', () => { leaveRoom(); });
  $('roomList').addEventListener('click', e => {
    const go = e.target.closest('button[data-pwgo]');
    if (go) { const inp = go.parentNode.querySelector('input'); setNick($('nick').value); joinRoom(go.dataset.pwgo, go.dataset.peer, inp ? inp.value : ''); return; }
    const b = e.target.closest('button[data-code]');
    if (!b) return;
    if (b.dataset.lock) { MP.pwFor = b.dataset.code; renderMP(); return; }
    setNick($('nick').value); joinRoom(b.dataset.code, b.dataset.peer);
  });
  initRoom();
  const fovR = $('fovR'), bloomBtn = $('bloomBtn');
  fovR.value = settings.fov; setText('fovV', settings.fov + '°');
  fovR.addEventListener('input', () => { settings.fov = +fovR.value; setText('fovV', settings.fov + '°'); saveSettings(); });
  const syncBloom = () => { E.setPost(settings.bloom); bloomBtn.setAttribute('aria-pressed', settings.bloom ? 'true' : 'false'); bloomBtn.textContent = settings.bloom && E.postAvailable() ? '开' : '关'; };
  if (!E.postAvailable()) { bloomBtn.disabled = true; bloomBtn.title = '当前显卡不支持'; }
  bloomBtn.addEventListener('click', () => { settings.bloom = !settings.bloom; syncBloom(); saveSettings(); });
  const shakeBtn = $('shakeBtn');
  const syncShake = () => { const on = settings.shake !== false; shakeBtn.setAttribute('aria-pressed', on ? 'true' : 'false'); shakeBtn.textContent = on ? '开' : '关'; };
  syncShake();
  shakeBtn.addEventListener('click', () => { settings.shake = settings.shake === false; if (!settings.shake) cam.shake = 0; syncShake(); saveSettings(); });
  const fpsBtn = $('fpsBtn');
  const syncFps = () => { fpsBtn.setAttribute('aria-pressed', settings.showFps ? 'true' : 'false'); fpsBtn.textContent = settings.showFps ? '开' : '关'; $('fpsTag').hidden = !settings.showFps; };
  syncFps();
  fpsBtn.addEventListener('click', () => { settings.showFps = !settings.showFps; syncFps(); saveSettings(); });
  const detBtn = $('detailBtn');
  if (!settings.detail) settings.detail = TOUCH ? 'low' : 'high';
  const syncDet = () => { const hi = settings.detail !== 'low'; detBtn.setAttribute('aria-pressed', hi ? 'true' : 'false'); detBtn.textContent = hi ? '高' : '低'; };
  syncDet();
  detBtn.addEventListener('click', () => { settings.detail = settings.detail === 'low' ? 'high' : 'low'; syncDet(); saveSettings(); });
  syncBloom();
  const sens = $('sens'), vol = $('vol');
  sens.value = settings.sens; vol.value = settings.vol;
  setText('sensV', settings.sens.toFixed(1)); setText('volV', Math.round(settings.vol * 100) + '%');
  sens.addEventListener('input', () => { settings.sens = +sens.value; setText('sensV', settings.sens.toFixed(1)); saveSettings(); });
  vol.addEventListener('input', () => { settings.vol = +vol.value; setText('volV', Math.round(settings.vol * 100) + '%'); Snd.setVol(settings.vol); saveSettings(); });
  const mus = $('musVol'); if (settings.music === undefined) settings.music = 0.5;
  mus.value = settings.music; setText('musV', Math.round(settings.music * 100) + '%');
  mus.addEventListener('input', () => { settings.music = +mus.value; setText('musV', Math.round(settings.music * 100) + '%'); Snd.init(); Snd.setMusic(settings.music); saveSettings(); });
  if (TOUCH) { $('touchHelp').hidden = false; document.querySelector('label[for="sens"]').textContent = '视角灵敏度'; }
  else if (matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) $('touchNote').hidden = false;
  if (!HAS_CLAUDE && !window.__RELAY_SAME_ORIGIN) $('mpOff').textContent = '填写自建联机服务器的地址后点「连接」，就能和打开同一服务器网页或安卓版的朋友联机。';
  $('srvBtn').addEventListener('click', () => setServer($('srvIn').value));
  $('srvIn').addEventListener('input', e => { e.target.dataset.edit = '1'; });
  $('srvIn').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.target.blur(); setServer(e.target.value); } });
  $('srvIn').addEventListener('blur', e => { delete e.target.dataset.edit; });
  document.querySelectorAll('#qchat li').forEach((li, i) => li.addEventListener('pointerdown', e => { e.preventDefault(); if (quickOpen) sendQuick(i); }));
  initTouch();
  if (TOUCH) initTouchEditor();
  setupMenuNav();
  document.querySelector('#menu').addEventListener('click', e => { if (e.target.closest && e.target.closest('[data-cls], [data-diff], [data-mode], .mapCard, [data-mut], .mutChips button')) setTimeout(updateMenuSum, 0); });
  updateMenuSum();
  buildHelp();
}
/* ============================================================
 * 触屏操作：左半屏浮动摇杆移动，右半屏滑动转向，右下角动作按钮
 * ============================================================ */
const joy = { on: false, id: null, ox: 0, oy: 0, x: 0, z: 0, sprint: false };
const lookT = { id: null, x: 0, y: 0 };
const fireT = { id: null, x: 0, y: 0 };
const WSHORT = { rifle: '步枪', shotgun: '霰弹', sniper: '狙击', rocket: '火箭' };
function tapKey(code, up) {
  window.dispatchEvent(new KeyboardEvent(up ? 'keyup' : 'keydown', { code }));
  if (up === undefined) window.dispatchEvent(new KeyboardEvent('keyup', { code }));
}
function touchLook(dx, dy) {
  if (mode !== 'play') return;
  const k = 0.0052 * settings.sens * (1 - cam.ads * (cache.scope ? 0.75 : 0.4));
  cam.yaw -= dx * k;
  cam.pitch = clamp(cam.pitch - dy * k, -1.5, 1.5);
}
function goFullscreen() {
  if (window.__APK) return;
  try {
    const de = document.documentElement;
    if (!document.fullscreenElement && de.requestFullscreen) de.requestFullscreen({ navigationUI: 'hide' }).then(() => { try { screen.orientation.lock('landscape').catch(() => {}); } catch (e) { /* 不支持 */ } }).catch(() => {});
  } catch (e) { /* 不支持全屏 */ }
}
function setJoy(e) {
  const R = 50, dead = 0.16;
  const rx = e.clientX - joy.ox, ry = e.clientY - joy.oy, L = Math.hypot(rx, ry);
  const n = Math.min(1, L / R), mag = n < dead ? 0 : (n - dead) / (1 - dead);
  joy.x = L ? rx / L * mag : 0; joy.z = L ? -ry / L * mag : 0;
  joy.sprint = L > R * 1.1 && -ry > Math.abs(rx) * 1.2;
  const k = L > R ? R / L : 1;
  $('joy').firstChild.style.transform = `translate(${(rx * k).toFixed(1)}px,${(ry * k).toFixed(1)}px)`;
}
function initTouch() {
  if (!TOUCH) return;
  document.body.classList.add('touch');
  fallbackLook = true;
  const ui = $('touchUI'); ui.hidden = false;
  // 阻止系统手势（缩放、双击、长按菜单）与模拟鼠标事件
  ui.addEventListener('touchstart', e => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  ui.addEventListener('contextmenu', e => e.preventDefault());
  const jEl = $('joy');
  $('tzMove').addEventListener('pointerdown', e => {
    if (joy.id !== null) return;
    Snd.init();
    joy.id = e.pointerId; joy.on = true; joy.ox = e.clientX; joy.oy = e.clientY; joy.x = joy.z = 0; joy.sprint = false;
    jEl.style.left = e.clientX + 'px'; jEl.style.top = e.clientY + 'px'; jEl.classList.add('on');
    jEl.firstChild.style.transform = '';
  });
  $('tzLook').addEventListener('pointerdown', e => {
    if (lookT.id !== null) return;
    Snd.init();
    lookT.id = e.pointerId; lookT.x = e.clientX; lookT.y = e.clientY;
  });
  const fire = $('tbFire');
  fire.addEventListener('pointerdown', e => {
    e.preventDefault(); Snd.init();
    fireT.id = e.pointerId; fireT.x = e.clientX; fireT.y = e.clientY;
    if (mode !== 'play') return;
    if (tool !== 'gun') { tryPlace(); return; }
    mouse.l = true; fire.classList.add('on');
  });
  addEventListener('pointermove', e => {
    if (e.pointerId === joy.id) setJoy(e);
    else if (e.pointerId === lookT.id) { touchLook(e.clientX - lookT.x, e.clientY - lookT.y); lookT.x = e.clientX; lookT.y = e.clientY; }
    else if (e.pointerId === fireT.id) { touchLook(e.clientX - fireT.x, e.clientY - fireT.y); fireT.x = e.clientX; fireT.y = e.clientY; }
  });
  const end = e => {
    if (e.pointerId === joy.id) { joy.id = null; joy.on = false; joy.x = joy.z = 0; joy.sprint = false; jEl.classList.remove('on'); }
    if (e.pointerId === lookT.id) lookT.id = null;
    if (e.pointerId === fireT.id) { fireT.id = null; mouse.l = false; fire.classList.remove('on'); }
  };
  addEventListener('pointerup', end); addEventListener('pointercancel', end);
  // 普通按钮：按下即触发对应按键；data-hold 的按钮按住生效
  ui.querySelectorAll('.tb[data-k], .tb[data-hold]').forEach(b => {
    b.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation(); Snd.init();
      if (b.dataset.hold) { tapKey(b.dataset.hold, false); b.classList.add('on'); }
      else tapKey(b.dataset.k);
    });
    if (b.dataset.hold) {
      const rel = () => { tapKey(b.dataset.hold, true); b.classList.remove('on'); };
      b.addEventListener('pointerup', rel); b.addEventListener('pointercancel', rel); b.addEventListener('pointerleave', rel);
    }
  });
  $('tbAds').addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    if (mode !== 'play') return;
    if (tool !== 'gun') { selectTool('gun'); mouse.r = false; return; }
    mouse.r = !mouse.r;
  });
  // 切到后台 / 暂停时松开所有触控
  const reset = () => { joy.id = lookT.id = fireT.id = null; joy.on = false; joy.x = joy.z = 0; mouse.l = mouse.r = false; jEl.classList.remove('on'); fire.classList.remove('on'); };
  addEventListener('blur', reset);
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
}
// 安卓返回键：逐层关闭面板 / 暂停；在主菜单时返回 false 让应用退出
window.__back = () => {
  if (mode === 'play') {
    if (bookOpen) toggleBook(false); else if (chatOpen) closeChat(); else if (labOpen) toggleLab(false); else if (shopOpen) toggleShop(false); else if (evoTrap !== null) closeEvo(); else if (quickOpen) toggleQuick(false); else pauseGame();
    return true;
  }
  if (!$('help').hidden) { show('help', false); return true; }
  if (!$('lb').hidden) { show('lb', false); return true; }
  if (!$('talents').hidden) { show('talents', false); return true; }
  if (mode === 'pause') { resumeGame(); return true; }
  if (mode === 'end') { toMenu(); return true; }
  return false;
};
function updateTouchHUD(p, lo, di) {
  if (mode !== 'play') { if (joy.on || mouse.l || mouse.r) { joy.on = false; joy.id = lookT.id = fireT.id = null; mouse.l = mouse.r = false; $('joy').classList.remove('on'); } }
  const s = sim.s;
  const fire = $('tbFire'), build = tool !== 'gun';
  fire.classList.toggle('build', build);
  setText('tbFireL', build ? '放置' : '开火');
  $('tbAds').classList.toggle('on', !build && mouse.r);
  setText('tbAds', build ? '收起' : '瞄准');
  if (p) {
    setText('tbAmmo', p.reloadT > 0 ? '…' : String(p.ammo));
    $('tbReload').classList.toggle('low', p.ammo <= 6);
    setText('tbNadeN', String(p.nades)); $('tbNade').classList.toggle('empty', p.nades < 1);
    setText('tbUltN', p.energy >= 100 ? '就绪' : Math.floor(p.energy) + '%'); $('tbUlt').classList.toggle('ready', p.energy >= 100);
    setText('tbWpn', WSHORT[p.wpn] || '步枪');
  }
  const nearUse = mode === 'play' && p && !p.dead && (nearLabObj() || nearDevice() >= 0 || myMount() || nearGatling());
  $('tbUse').hidden = !nearUse && !labOpen;
  const tr = aim && aim.trap && (tool === 'gun' || !aim.slot || (aim.can && !aim.can.ok));
  $('tbUp').hidden = !tr || aim.trap.lv >= MAX_LV;
  $('tbSell').hidden = !tr;
  $('tbReady').hidden = s.phase !== 'build';
  if (s.phase === 'build') setText('tbReady', p && p.ready && Object.keys(s.players).length > 1 ? '取消准备' : '开战');
  $('tbQuick').hidden = MP.role === 'solo';
  void lo; void di;
}

function start(data) {
  bindUI();
  makeDemo();
  if (data && data.state) {
    try {
      newGame(JSON.parse(data.state));
      if (data.tool) selectTool(data.tool);
      cam.yaw = data.yaw || 0; cam.pitch = data.pitch || 0;
      mode = 'pause'; show('menu', false); show('hud', true); show('pause', true);
    } catch (e) { console.warn('恢复失败', e); }
  }
  requestAnimationFrame(t => { lastT = t; frame(t); });
}
try {
  window.claude?.hot?.snapshot?.(() => ({ state: sim && (mode === 'play' || mode === 'pause') ? sim.serialize() : null, tool, yaw: cam.yaw, pitch: cam.pitch }));
} catch (e) { /* 无热更新环境 */ }
window.__td = { get sim() { return sim; }, get mode() { return mode; }, get MP() { return MP; }, get PID() { return PID; }, pauseGame, startGame, selectTool, keys, mouse, cam, LocalNet, tryPlace, get aim() { return aim; }, stats: () => E.stats(), E, Tut, renderTut };
const hot = window.claude && window.claude.hot;
if (hot && hot.ready) hot.ready(start); else start((hot && hot.data) || {});
})();

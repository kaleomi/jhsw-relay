// 用假的 Cloudflare 运行时测试 worker.js（含休眠唤醒、附件上限、重连替换）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } };
// --- 假运行时 ---
class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
globalThis.WebSocketRequestResponsePair = class { constructor(a, b) { this.a = a; this.b = b; } };
globalThis.Response = class { constructor(body, init) { init = init || {}; this.status = init.status || 200; this.webSocket = init.webSocket; this.body = body; this.headers = init.headers || {}; } };
let DO = null; const pending = [];
class FakeWS {
  constructor() { this.readyState = 1; this.inbox = []; this.att = null; this.other = null; this.server = false; }
  send(s) { if (this.readyState !== 1) throw new Error('closed'); if (this.server) this.other.inbox.push(JSON.parse(s)); else pending.push(() => DO.webSocketMessage(this.other, s)); }
  serializeAttachment(a) { const j = JSON.stringify(a); if (j && j.length > 2048) throw new Error('attachment too big'); this.att = a === null ? null : JSON.parse(j); }
  deserializeAttachment() { return this.att === null ? null : JSON.parse(JSON.stringify(this.att)); }
  close(code) { if (this.readyState === 3) return; this.readyState = 3; this.code = code; const o = this.other; if (o.readyState === 1) { o.readyState = 3; o.code = code; if (!this.server) pending.push(() => DO.webSocketClose(o, code, '')); } }
}
globalThis.WebSocketPair = class { constructor() { const c = new FakeWS(), s = new FakeWS(); c.other = s; s.other = c; s.server = true; this[0] = c; this[1] = s; } };
const accepted = [];
const store = new Map();
const ctx = { acceptWebSocket: ws => accepted.push(ws), getWebSockets: () => accepted.filter(w => w.readyState !== 3 || true), setWebSocketAutoResponse() {}, storage: { get: async k => store.get(k), put: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } } };
// 载入 worker.js（替换 cloudflare:workers 导入）
const src = fs.readFileSync(path.join(DIR, '../worker.js'), 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'const DurableObject = globalThis.__DO;').replace("'./room-core.js'", JSON.stringify(pathToFileURL(path.join(DIR, '../room-core.js')).href)).replace("'./board-core.js'", JSON.stringify(pathToFileURL(path.join(DIR, '../board-core.js')).href));
globalThis.__DO = DurableObject;
const tmp = path.join(DIR, '_worker_tmp.mjs'); fs.writeFileSync(tmp, src);
const { Room } = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);
const flush = async () => { while (pending.length) await pending.shift()(); };
DO = new Room(ctx, {});
const connect = async (room, peer) => { const r = await DO.fetch({ url: `https://x/ws?room=${room}&peer=${peer}` }); ok(r.status === 101, 'status'); return r.webSocket; };
const send = (ws, o) => ws.send(JSON.stringify(o));
// 1) 两人进入
const A = await connect('jhsw-ab12', 'aaaaaa11');
const B = await connect('jhsw-ab12', 'bbbbbb22');
await flush();
ok(A.inbox[0].t === 'hello' && A.inbox[0].peers.length === 1, 'A hello');
ok(B.inbox[0].t === 'hello' && B.inbox[0].peers.length === 2, 'B hello sees 2');
ok(A.inbox.some(m => m.t === 'join' && m.peer === 'bbbbbb22'), 'A sees B join');
// 2) presence + emit
send(A, { t: 'p', d: { host: 1, n: '房主' } }); send(B, { t: 'p', d: { n: '队友' } });
send(A, { t: 'e', topic: 'snap', d: { q: 1, k: 0 } });
await flush();
ok(B.inbox.some(m => m.t === 'pres' && m.peer === 'aaaaaa11' && m.presence.host === 1), 'B sees A pres');
ok(B.inbox.some(m => m.t === 'msg' && m.topic === 'snap' && m.from === 'aaaaaa11'), 'B gets snap');
ok(!A.inbox.some(m => m.t === 'msg'), 'no self echo from server');
// 3) 休眠唤醒：新建实例，状态来自附件
DO = new Room(ctx, {});
const C = await connect('jhsw-ab12', 'cccccc33');
await flush();
const hc = C.inbox[0];
ok(hc.peers.length === 3 && hc.peers.find(p => p.peer === 'aaaaaa11').presence.host === 1, 'presence survives hibernation');
// 4) 大 presence（>2KB 附件上限）
send(B, { t: 'p', d: { big: 'x'.repeat(2500) } }); await flush();
ok(A.inbox.some(m => m.t === 'pres' && m.peer === 'bbbbbb22' && m.presence.big), 'big presence relayed');
ok(!C.inbox.some(m => m.t === 'err'), 'no error on big presence');
// 5) 重连替换：B 用同一 peer 再连
const B2 = await connect('jhsw-ab12', 'bbbbbb22'); await flush();
ok(B.readyState === 3, 'old B closed');
ok(!A.inbox.some(m => m.t === 'leave' && m.peer === 'bbbbbb22'), 'no leave on replace');
ok(B2.inbox[0].peers.filter(p => p.peer === 'bbbbbb22').length === 1, 'single B in hello');
// 6) 离开
C.close(1000); await flush();
ok(A.inbox.some(m => m.t === 'leave' && m.peer === 'cccccc33'), 'A sees C leave');
// 7) 满员
const extra = []; for (let i = 0; i < 7; i++) extra.push(await connect('jhsw-ab12', 'dddddd' + i + i)); await flush();
const live = accepted.filter(w => w.readyState === 1);
ok(extra[6].readyState === 3 && extra[5].readyState === 1 && extra[6].inbox.some(m => m.code === 'full'), 'room full rejects 9th');
console.log(fails ? fails + ' 项失败' : 'worker 模拟测试全部通过', '| live sockets', live.length);
// 8) 房间密码（新房间 = 新的 Durable Object）
accepted.length = 0; DO = new Room(ctx, {});
const P1 = await DO.fetch({ url: 'https://x/ws?room=jhsw-pw01&peer=pppppp11&pw=abc123' }).then(r => r.webSocket);
const P2 = await DO.fetch({ url: 'https://x/ws?room=jhsw-pw01&peer=pppppp22&pw=wrong1' }).then(r => r.webSocket);
const P3 = await DO.fetch({ url: 'https://x/ws?room=jhsw-pw01&peer=pppppp33&pw=abc123' }).then(r => r.webSocket);
const P4 = await DO.fetch({ url: 'https://x/ws?room=jhsw-pw01&peer=pppppp44' }).then(r => r.webSocket);
await flush();
ok(P2.readyState === 3 && P2.inbox.some(m => m.code === 'bad_password'), 'wrong password rejected');
ok(P3.readyState === 1 && P3.inbox[0].t === 'hello', 'right password accepted');
ok(P4.readyState === 3, 'missing password rejected');
DO = new Room(ctx, {});   // 休眠唤醒后密码仍然有效
const P5 = await DO.fetch({ url: 'https://x/ws?room=jhsw-pw01&peer=pppppp55&pw=nope99' }).then(r => r.webSocket); await flush();
ok(P5.readyState === 3, 'password survives hibernation');
console.log(fails ? fails + ' 项失败' : '密码测试通过');
// 排行榜
{
  const post = o => DO.fetch({ url: 'https://x/lb', method: 'POST', text: async () => JSON.stringify(o) }).then(r => ({ st: r.status, j: JSON.parse(r.body) }));
  const r1 = await post({ map: 'station', diff: 'hard', wave: 20, kills: 500, hp: 60, name: '甲', mut: ['horde'], n: 2 });
  const r2 = await post({ map: 'station', diff: 'normal', wave: 25, kills: 800, hp: 100, name: '乙', mut: [], n: 1 });
  const bad = await post({ map: 'nope', diff: 'hard', wave: 3 });
  ok(r1.st === 200 && r1.j.rank === 1, 'lb first');
  ok(r2.j.rank === 2 && r2.j.list.length === 2, 'lb rank by score');
  ok(bad.st === 400, 'lb rejects bad map');
  const g = JSON.parse((await DO.fetch({ url: 'https://x/lb?map=station', method: 'GET' })).body);
  ok(g.list.length === 2 && g.list[0].name === '甲', 'lb get');
  console.log(fails ? fails + ' 项失败' : '排行榜测试通过');
}

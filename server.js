/* 晶核守卫 · 联机中转服务器（Node.js 版，零依赖）
 * 用法：node server.js [端口]      （默认 8080，也可用环境变量 PORT）
 * 打开 http://服务器地址:端口/ 即可游玩；WebSocket 地址为 ws(s)://服务器地址:端口/ws
 * 放在 HTTPS 反向代理（Nginx / Caddy）后面时，手机浏览器即可用 wss:// 安全连接。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { RoomCore, validPeer, validRoom, validPw, LIMITS } from './room-core.js';
import { sanitize, insert, MAPS, CORS } from './board-core.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.argv[2] || process.env.PORT || 8080);
const PAGE = path.join(DIR, 'public', 'index.html');
let pageCache = null;
function page() {
  const st = fs.statSync(PAGE);
  if (!pageCache || pageCache.mtime !== st.mtimeMs) { const raw = fs.readFileSync(PAGE); pageCache = { mtime: st.mtimeMs, raw, gz: zlib.gzipSync(raw) }; }
  return pageCache;
}

/* ---------- 极简 WebSocket（RFC 6455，仅文本帧） ---------- */
class Sock {
  constructor(socket) {
    this.s = socket; this.buf = Buffer.alloc(0); this.open = true; this.att = null; this.frag = null;
    this.onmessage = null; this.onclose = null;
    socket.setNoDelay(true);
    socket.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    const end = () => { if (!this.open) return; this.open = false; this.onclose && this.onclose(); };
    socket.on('close', end); socket.on('error', end);
  }
  parse() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1], op = b0 & 15, fin = b0 & 128, masked = b1 & 128;
      let len = b1 & 127, o = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); o = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); o = 10; }
      if (len > LIMITS.msgBytes * 2) { this.close(1009, 'too big'); return; }
      const need = o + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let data = this.buf.subarray(o + (masked ? 4 : 0), need);
      if (masked) { const k = this.buf.subarray(o, o + 4); data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= k[i & 3]; }
      this.buf = this.buf.subarray(need);
      if (op === 8) { this.close(1000, ''); return; }
      if (op === 9) { this.frame(10, data); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2) { if (fin) this.onmessage && this.onmessage(data.toString('utf8')); else this.frag = [data]; }
      else if (op === 0 && this.frag) { this.frag.push(data); if (fin) { const all = Buffer.concat(this.frag); this.frag = null; this.onmessage && this.onmessage(all.toString('utf8')); } }
    }
  }
  frame(op, payload) {
    if (!this.open) return;
    const n = payload.length;
    const head = n < 126 ? Buffer.from([128 | op, n]) : n < 65536 ? Buffer.from([128 | op, 126, n >> 8, n & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 128 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    this.s.write(Buffer.concat([head, payload]));
  }
  send(str) { this.frame(1, Buffer.from(str, 'utf8')); }
  close(code, reason) {
    if (!this.open) return;
    const r = Buffer.from(reason || '', 'utf8'), p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code || 1000, 0); r.copy(p, 2);
    this.frame(8, p); this.open = false; this.s.end(); this.onclose && this.onclose();
  }
}

/* ---------- 房间 ---------- */
const rooms = new Map();
function roomOf(name) {
  let r = rooms.get(name);
  if (!r) {
    const socks = new Set();
    r = { socks, core: null };
    r.core = new RoomCore({
      list: () => [...socks],
      send: (s, str) => s.send(str),
      close: (s, code, reason) => s.close(code, reason),
      get: s => s.att,
      set: (s, a) => { s.att = a; },
    }, name);
    rooms.set(name, r);
  }
  return r;
}

/* ---------- 无尽排行榜（保存在 server.js 同目录的 leaderboard.json） ---------- */
const LB_FILE = path.join(DIR, 'leaderboard.json');
let board = {};
try { board = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')) || {}; } catch (e) { board = {}; }
let saveT = null;
const saveBoard = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.writeFileSync(LB_FILE, JSON.stringify(board)); } catch (e) { /* 只读目录时只保存在内存 */ } }, 500); };
function handleBoard(req, res, url) {
  const send = (o, st) => { res.writeHead(st || 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS }); res.end(JSON.stringify(o)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let o = null; try { o = JSON.parse(body); } catch (e) { o = null; }
      const e = sanitize(o);
      if (!e) { send({ ok: false, error: 'bad' }, 400); return; }
      const r = insert(board[e.map], e); board[e.map] = r.list; saveBoard();
      send({ ok: true, rank: r.rank, score: e.score, list: r.list.slice(0, 20) });
    });
    return;
  }
  const map = url.searchParams.get('map');
  if (map && MAPS.includes(map)) { send({ ok: true, map, list: (board[map] || []).slice(0, 20) }); return; }
  const all = {}; for (const m of MAPS) all[m] = (board[m] || []).slice(0, 10);
  send({ ok: true, maps: all });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  if (url.pathname === '/lb') { handleBoard(req, res, url); return; }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    let pg; try { pg = page(); } catch (e) { res.writeHead(404); res.end('public/index.html 不存在'); return; }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...(gz ? { 'content-encoding': 'gzip' } : {}) });
    res.end(gz ? pg.gz : pg.raw); return;
  }
  res.writeHead(404); res.end('not found');
});
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const room = url.searchParams.get('room') || 'lobby', peer = url.searchParams.get('peer'), pw = url.searchParams.get('pw') || '';
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key || !validRoom(room) || !validPeer(peer) || !validPw(pw)) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const ws = new Sock(socket), r = roomOf(room);
  r.socks.add(ws);
  ws.onmessage = msg => r.core.message(ws, msg);
  ws.onclose = () => { r.core.closed(ws); r.socks.delete(ws); if (!r.socks.size) rooms.delete(room); };
  if (!r.core.open(ws, peer, pw)) { r.socks.delete(ws); }
});
server.listen(PORT, () => console.log(`晶核守卫联机服务器已启动：http://localhost:${PORT}/`));

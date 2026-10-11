/* 晶核守卫 · 联机中转：房间逻辑（Cloudflare Durable Object 与 Node 服务器共用）
 *
 * 每个房间一组 WebSocket 连接；服务器只负责转发，不运行游戏逻辑（游戏由房主的浏览器运行）。
 * 客户端 → 服务器：{t:'p', d:{…presence 增量，null 表示删除}} | {t:'e', topic, d} | {t:'ping'}
 * 服务器 → 客户端：{t:'hello', me, peers:[{peer, presence, at}]} | {t:'join'|'pres', peer, presence, at}
 *                 {t:'leave', peer} | {t:'msg', topic, from, d} | {t:'pong'} | {t:'err', code}
 */
export const LIMITS = { msgBytes: 16384, presBytes: 4096, roomPeers: 8, lobbyPeers: 300 };
export const validPeer = s => typeof s === 'string' && /^[a-z0-9]{6,32}$/.test(s);
export const validRoom = s => typeof s === 'string' && /^[a-z0-9-]{1,40}$/.test(s);

// io：{ list(), send(sock, str), close(sock, code, reason), get(sock) → {peer, pres, at} | null, set(sock, att) }
export class RoomCore {
  constructor(io, name) { this.io = io; this.name = name; }
  live(s) { const a = this.io.get(s); return a && !a.replaced ? a : null; }
  others(sock) { return this.io.list().filter(s => s !== sock && this.live(s)); }
  peersJSON() { return this.io.list().map(s => this.live(s)).filter(Boolean).map(a => ({ peer: a.peer, presence: a.pres, at: a.at })); }
  bcast(obj, except) { const str = JSON.stringify(obj); for (const s of this.others(except)) this.io.send(s, str); }
  // 新连接：返回 false 表示拒绝
  open(sock, peer) {
    const lobby = this.name === 'lobby';
    // 同一玩家重连：踢掉旧连接（不广播离开）
    for (const s of this.io.list()) {
      const a = s !== sock && this.io.get(s);
      if (a && a.peer === peer) { a.replaced = true; this.io.set(s, a); this.io.close(s, 4000, 'replaced'); }
    }
    const n = this.others(sock).length;
    if (n >= (lobby ? LIMITS.lobbyPeers : LIMITS.roomPeers)) {
      this.io.send(sock, JSON.stringify({ t: 'err', code: 'full' }));
      this.io.close(sock, 4003, 'full');
      return false;
    }
    const att = { peer, pres: {}, at: Date.now() };
    this.io.set(sock, att);
    this.io.send(sock, JSON.stringify({ t: 'hello', me: peer, room: this.name, peers: this.peersJSON() }));
    this.bcast({ t: 'join', peer, presence: att.pres, at: att.at }, sock);
    return true;
  }
  message(sock, raw) {
    const a = this.io.get(sock);
    if (!a || a.replaced) return;
    const size = typeof raw === 'string' ? raw.length : raw.byteLength;
    if (size > LIMITS.msgBytes) { this.io.send(sock, JSON.stringify({ t: 'err', code: 'too_big' })); return; }
    let m;
    try { m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'ping') { this.io.send(sock, '{"t":"pong"}'); return; }
    if (m.t === 'p' && m.d && typeof m.d === 'object') {
      const next = m.full ? {} : Object.assign({}, a.pres);
      for (const k in m.d) { if (m.d[k] === null) delete next[k]; else next[k] = m.d[k]; }
      if (JSON.stringify(next).length > LIMITS.presBytes) { this.io.send(sock, JSON.stringify({ t: 'err', code: 'too_big' })); return; }
      a.pres = next; a.at = Date.now();
      this.io.set(sock, a);
      this.bcast({ t: 'pres', peer: a.peer, presence: next, at: a.at }, sock);
      return;
    }
    if (m.t === 'e' && typeof m.topic === 'string' && m.topic.length <= 32) {
      this.bcast({ t: 'msg', topic: m.topic, from: a.peer, d: m.d }, sock);
    }
  }
  closed(sock) {
    const a = this.io.get(sock);
    if (!a) return;
    this.io.set(sock, null);
    if (a.replaced) return;
    // 同一玩家还有别的连接（重连抢先到达）就不广播离开
    if (this.others(sock).some(s => this.io.get(s).peer === a.peer)) return;
    this.bcast({ t: 'leave', peer: a.peer }, sock);
  }
}

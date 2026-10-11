/* ============================================================
 * 晶核守卫 · 自建中转服务器客户端
 * 用 WebSocket 实现与 claude.ai 房间服务相同的接口（emit / on / presence / peers / onPeers /
 * connected / onConnection / leave / join），游戏联机代码无需区分底层用的是哪一种。
 * ============================================================ */
(function (root) {
'use strict';
const LIMIT = 4096;
const bytes = o => new TextEncoder().encode(JSON.stringify(o)).length;
const randId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => (b % 36).toString(36)).join('');

// base：'wss://example.workers.dev'；me：本标签页的玩家 id（大厅与房间共用）
function openRoom(base, name, me, opts) {
  const persistent = !!opts.persistent;   // 大厅：断线后一直重连；对局房间：重连失败即报错
  const topicL = new Map(), peerL = new Set(), connL = new Set(), errL = new Set();
  const peers = new Map();   // peer → { presence, updatedAt }
  let ws = null, isOpen = false, closed = false, myPres = {}, snap = [], tries = 0, pingT = 0, retryT = 0, firstHello = null;
  const fail = code => { const err = { code }; for (const fn of errL) { try { fn(err); } catch (e) { /* 忽略 */ } } };
  const mkPeer = (peer, v) => Object.freeze({ peer, by: null, isMe: peer === me, sameTab: peer === me, kind: 'viewer', guest: false, presence: Object.freeze(v.presence || {}), updatedAt: v.updatedAt || 0 });
  const rebuild = (joined, left, updated) => {
    snap = Object.freeze([...peers].map(([p, v]) => mkPeer(p, v)));
    const ch = { peers: snap, joined: snap.filter(p => joined.includes(p.peer)), left: left.map(p => mkPeer(p, { presence: {} })), updated: snap.filter(p => updated.includes(p.peer)) };
    for (const fn of peerL) { try { fn(ch); } catch (e) { console.warn(e); } }
  };
  const setConn = v => { if (v === isOpen) return; isOpen = v; for (const fn of connL) { try { fn(v); } catch (e) { /* 忽略 */ } } };
  function connect() {
    if (closed) return;
    const url = `${base.replace(/\/+$/, '')}/ws?room=${encodeURIComponent(name)}&peer=${me}` + (opts.pw ? `&pw=${encodeURIComponent(opts.pw)}` : '');
    try { ws = new WebSocket(url); } catch (e) { scheduleRetry(); return; }
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'hello') {
        tries = 0;
        const before = new Set(peers.keys()), now = new Set();
        const joined = [], updated = [];
        for (const p of m.peers || []) {
          now.add(p.peer);
          const v = p.peer === me ? { presence: myPres, updatedAt: Date.now() } : { presence: p.presence || {}, updatedAt: p.at || 0 };
          if (before.has(p.peer)) updated.push(p.peer); else joined.push(p.peer);
          peers.set(p.peer, v);
        }
        if (!now.has(me)) { peers.set(me, { presence: myPres, updatedAt: Date.now() }); if (!before.has(me)) joined.push(me); }
        const left = [...before].filter(p => !now.has(p) && p !== me);
        for (const p of left) peers.delete(p);
        setConn(true);
        // 重连后把自己的 presence 补发一遍
        if (Object.keys(myPres).length) ws.send(JSON.stringify({ t: 'p', d: myPres, full: 1 }));
        rebuild(joined, left, updated);
        if (firstHello) { firstHello.resolve(); firstHello = null; }
      } else if (m.t === 'join' || m.t === 'pres') {
        if (m.peer === me) return;
        const had = peers.has(m.peer);
        peers.set(m.peer, { presence: m.presence || {}, updatedAt: m.at || Date.now() });
        rebuild(had ? [] : [m.peer], [], had ? [m.peer] : []);
      } else if (m.t === 'leave') {
        if (m.peer === me || !peers.delete(m.peer)) return;
        rebuild([], [m.peer], []);
      } else if (m.t === 'msg') {
        const fns = topicL.get(m.topic);
        if (fns) { const msg = { peer: m.from, by: null, isMe: false, sameTab: false, kind: 'viewer', guest: false, topic: m.topic, data: m.d }; for (const fn of fns) { try { fn(msg); } catch (e) { console.warn(e); } } }
      } else if (m.t === 'err' && (m.code === 'full' || m.code === 'bad_password')) {
        const code = m.code === 'full' ? 'room_full' : 'bad_password';
        closed = true; fail(code); if (firstHello) { firstHello.reject({ code }); firstHello = null; }
      }
    };
    ws.onclose = () => {
      ws = null; setConn(false);
      if (closed) return;
      scheduleRetry();
    };
    ws.onerror = () => { /* 交给 onclose */ };
  }
  function scheduleRetry() {
    tries++;
    if (!persistent && tries > 4) {
      closed = true;
      if (firstHello) { firstHello.reject({ code: 'unavailable' }); firstHello = null; }
      fail('disconnected'); return;
    }
    clearTimeout(retryT);
    retryT = setTimeout(connect, Math.min(10000, 600 * Math.pow(1.8, tries)));
  }
  pingT = setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"t":"ping"}'); }, 20000);
  peers.set(me, { presence: {}, updatedAt: Date.now() });
  snap = Object.freeze([mkPeer(me, peers.get(me))]);
  const ready = new Promise((resolve, reject) => { firstHello = { resolve, reject }; });
  connect();
  const room = {
    name,
    ready,
    emit(topic, data) {
      if (closed) return Promise.reject({ code: 'invalid_argument', message: 'left' });
      if (bytes(data) > LIMIT) return Promise.reject({ code: 'invalid_argument', message: 'too big' });
      if (!ws || ws.readyState !== 1) return Promise.reject({ code: 'unavailable' });
      ws.send(JSON.stringify({ t: 'e', topic, d: data }));
      const fns = topicL.get(topic);
      if (fns) setTimeout(() => { const msg = { peer: me, by: null, isMe: true, sameTab: true, kind: 'viewer', guest: false, topic, data }; for (const fn of fns) { try { fn(msg); } catch (e) { console.warn(e); } } }, 0);
      return Promise.resolve();
    },
    on(topic, fn, err) {
      if (!topicL.has(topic)) topicL.set(topic, new Set());
      topicL.get(topic).add(fn); if (err) errL.add(err);
      return () => { topicL.get(topic).delete(fn); if (err) errL.delete(err); };
    },
    presence(patch) {
      if (closed) return Promise.reject({ code: 'invalid_argument' });
      const next = Object.assign({}, myPres);
      for (const k in patch) { if (patch[k] === null) delete next[k]; else next[k] = patch[k]; }
      if (bytes(next) > LIMIT) return Promise.reject({ code: 'invalid_argument', message: 'too big' });
      myPres = next;
      peers.set(me, { presence: JSON.parse(JSON.stringify(next)), updatedAt: Date.now() });
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'p', d: patch }));
      rebuild([], [], [me]);
      return Promise.resolve();
    },
    peers() { return snap; },
    onPeers(fn, err) {
      peerL.add(fn); if (err) errL.add(err);
      setTimeout(() => { if (!closed && peerL.has(fn)) fn({ peers: snap, joined: snap, left: [], updated: [] }); }, 0);
      return () => { peerL.delete(fn); if (err) errL.delete(err); };
    },
    connected() { return isOpen; },
    onConnection(fn, err) { connL.add(fn); if (err) errL.add(err); setTimeout(() => { if (connL.has(fn)) fn(isOpen); }, 0); return () => { connL.delete(fn); if (err) errL.delete(err); }; },
    leave() {
      if (!closed) { closed = true; clearInterval(pingT); clearTimeout(retryT); if (ws) { try { ws.close(1000); } catch (e) { /* 忽略 */ } } setConn(false); }
      return Promise.resolve();
    },
    get closed() { return closed; },
  };
  return room;
}

// 连接中转服务器，返回「大厅」房间；lobby.join(name) 进入对局房间
function connect(base) {
  const me = randId();
  const lobby = openRoom(base, 'lobby', me, { persistent: true });
  lobby.join = async (name, o) => {
    const r = openRoom(base, name, me, { persistent: false, pw: o && o.pw });
    await Promise.race([r.ready, new Promise((_, rej) => setTimeout(() => rej({ code: 'timeout' }), 10000))]).catch(e => { r.leave(); throw e; });
    return r;
  };
  lobby.me = me;
  return lobby;
}
// 把用户输入的地址整理成 ws(s)://host
function normalize(addr) {
  let a = String(addr || '').trim();
  if (!a) return '';
  if (!/^[a-z]+:\/\//i.test(a)) a = (/^(localhost|127\.|10\.|192\.168\.)/.test(a) ? 'ws://' : 'wss://') + a;
  a = a.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  try { const u = new URL(a); if (!/^wss?:$/.test(u.protocol)) return ''; return `${u.protocol}//${u.host}`; } catch (e) { return ''; }
}
root.JHSWRelay = { connect, normalize };
})(typeof window !== 'undefined' ? window : globalThis);

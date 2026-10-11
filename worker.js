/* 晶核守卫 · 联机中转服务器（Cloudflare Workers + Durable Objects 版）
 * 静态页面（public/index.html）由 Workers 静态资源提供；/ws 由每个房间一个的 Durable Object 处理。
 * 使用 WebSocket 休眠 API：房间里没人说话时不计算时长，免费额度足够日常小队游玩。
 */
import { DurableObject } from 'cloudflare:workers';
import { RoomCore, validPeer, validRoom, validPw } from './room-core.js';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('需要 WebSocket', { status: 426 });
      const room = url.searchParams.get('room') || 'lobby', peer = url.searchParams.get('peer');
      if (!validRoom(room) || !validPeer(peer) || !validPw(url.searchParams.get('pw'))) return new Response('参数错误', { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req);
    }
    if (url.pathname === '/health') return new Response('ok');
    return env.ASSETS.fetch(req);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.mem = new Map();        // 内存中的玩家状态（休眠唤醒后从附件恢复）
    this.dead = new WeakSet();   // 已关闭的连接
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    this.core = new RoomCore({
      list: () => this.ctx.getWebSockets().filter(ws => !this.dead.has(ws) && ws.readyState !== 2 && ws.readyState !== 3),
      send: (ws, str) => { try { ws.send(str); } catch (e) { /* 连接已断 */ } },
      close: (ws, code, reason) => { try { ws.close(code, reason); } catch (e) { /* 已关闭 */ } },
      get: ws => {
        if (this.dead.has(ws)) return null;
        if (this.mem.has(ws)) return this.mem.get(ws);
        let a = null; try { a = ws.deserializeAttachment(); } catch (e) { a = null; }
        if (a) { if (!a.pres) a.pres = {}; this.mem.set(ws, a); }
        return a;
      },
      set: (ws, a) => {
        this.mem.set(ws, a);
        if (!a) { this.dead.add(ws); return; }
        try {
          // 附件上限 2KB：presence 太大时只保存身份，完整内容留在内存里
          ws.serializeAttachment(JSON.stringify(a).length < 1900 ? a : { peer: a.peer, at: a.at, replaced: a.replaced });
        } catch (e) { /* 忽略 */ }
      },
    }, 'lobby');
  }
  async fetch(req) {
    const url = new URL(req.url);
    this.core.name = url.searchParams.get('room') || 'lobby';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    this.core.open(server, url.searchParams.get('peer'), url.searchParams.get('pw') || '');
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, msg) { this.core.message(ws, msg); }
  async webSocketClose(ws, code) {
    this.core.closed(ws); this.dead.add(ws); this.mem.delete(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, ''); } catch (e) { /* 已关闭 */ }
  }
  async webSocketError(ws) { this.core.closed(ws); this.dead.add(ws); this.mem.delete(ws); }
}

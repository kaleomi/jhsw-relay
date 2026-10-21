/* 晶核守卫 · 云存档（Cloudflare 与 Node 两个版本共用）
 * 玩家把本机进度打包成一段存档码上传，服务器发一个 8 位提取码；换手机后输入提取码即可取回。
 * 上传时同时发一把只有上传者知道的钥匙，之后用同一个提取码覆盖更新需要这把钥匙。
 */
export const SAVE_MAX = 60000;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉容易看错的 I / O / 0 / 1
export function newCode(rand) {
  rand = rand || Math.random; let s = '';
  for (let i = 0; i < 8; i++) s += ALPHA[Math.floor(rand() * ALPHA.length)];
  return s;
}
export function newKey(rand) {
  rand = rand || Math.random; const A = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let s = '';
  for (let i = 0; i < 24; i++) s += A[Math.floor(rand() * A.length)];
  return s;
}
export const normCode = c => String(c || '').toUpperCase().replace(/[\s-]/g, '');
export const validCode = c => typeof c === 'string' && /^[A-HJ-NP-Z2-9]{8}$/.test(c);
export const validKey = k => typeof k === 'string' && /^[A-Za-z0-9]{16,40}$/.test(k);
// 存档码：JHSW 开头，只含 base64 / 分隔字符
export const validData = d => typeof d === 'string' && d.length <= SAVE_MAX && /^JHSW\d\.[A-Za-z0-9+/=_-]+$/.test(d);
// 处理一次上传：old 为已存的记录（没有为 undefined）；返回 { st, body, rec }
export function handleUpload(old, body, code) {
  if (!body || !validData(body.data)) return { st: 400, body: { ok: false, error: 'bad' } };
  if (old) {
    if (!validKey(body.key) || body.key !== old.key) return { st: 403, body: { ok: false, error: 'key' } };
    const rec = { data: body.data, key: old.key, t: Date.now() };
    return { st: 200, body: { ok: true, code, key: old.key, t: rec.t }, rec };
  }
  if (body.key) return { st: 404, body: { ok: false, error: 'missing' } };   // 想覆盖的提取码已不存在
  const rec = { data: body.data, key: newKey(), t: Date.now() };
  return { st: 200, body: { ok: true, code, key: rec.key, t: rec.t }, rec };
}

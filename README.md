# 晶核守卫

第一人称塔防射击：在通道的地面、墙壁、天花板和炮台位布置陷阱，守住核心水晶。支持电脑（键鼠）和手机（触屏横屏），最多 4 人联机合作。

这个仓库就是一个可以直接部署到 Cloudflare 的联机服务器：它提供游戏网页，并在玩家之间转发联机消息（游戏逻辑由房主的设备运行）。

## 一键部署到 Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kaleomi/jhsw-game)

**正式服：<https://jhsw-game.xialuoxi.com/>**

点按钮 → 登录（或免费注册）Cloudflare → 按页面提示确认即可。部署完成后会得到 `https://jhsw-relay.<你的子域>.workers.dev` 这样的网址：

- 电脑 / 手机浏览器打开网址就能玩，联机大厅里能看到同一服务器上的房间；
- 安卓版在主菜单「联机合作」里填上这个网址、点「连接」即可一起玩。

打开 `网址/health` 显示 `ok` 说明服务器正常。

> `workers.dev` 在中国大陆访问可能不稳定，有大陆队友时可以在 Cloudflare 后台绑定自己的域名。

## 手动部署

```bash
npx wrangler login
npx wrangler deploy
```

不用 Cloudflare 也可以：任意装有 Node.js 18+ 的机器上运行 `node server.js 8080`（零依赖），然后打开 `http://IP:8080/`。

## 目录

| 路径 | 内容 |
|---|---|
| `worker.js`、`wrangler.toml` | Cloudflare Workers + Durable Objects 版服务器 |
| `server.js` | Node.js 版服务器（零依赖） |
| `room-core.js` | 两个版本共用的房间转发逻辑 |
| `public/index.html` | 构建好的游戏（单文件） |
| `game-src/` | 游戏源码：`python3 build.py` 重新生成 `public/index.html` 与 `dist/晶核守卫.html` |
| `android/` | 安卓 WebView 外壳与打包脚本（工具链与签名密钥不在仓库里） |
| `test/` | 服务器测试：`node test/worker-sim.test.js` |

修改游戏后：`cd game-src && python3 build.py`，提交并推送，Cloudflare 会自动重新部署（使用一键部署时已自动连好仓库）。

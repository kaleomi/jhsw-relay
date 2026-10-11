# 构建：把各模块内联成单文件游戏
#   ../public/index.html   —— 自建服务器版（同源联机，Cloudflare / Node 服务器使用）
#   ../dist/晶核守卫.html   —— 通用单文件版（安卓 APK 打包用）
import os, re
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, 'index.src.html'), encoding='utf-8').read()
for key, fn in [('ENGINE', 'engine.js'), ('SIM', 'sim.js'), ('PROTO', 'proto.js'), ('RELAY', 'relay.js'), ('ASSETS', 'assets.js'), ('GAME', 'game.js')]:
    code = open(os.path.join(HERE, fn), encoding='utf-8').read()
    assert '</script' not in code, fn
    src = src.replace('/*__%s__*/' % key, '\n' + code + '\n')
os.makedirs(os.path.join(HERE, '../dist'), exist_ok=True)
open(os.path.join(HERE, '../dist/晶核守卫.html'), 'w', encoding='utf-8').write(src)
srv = ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
       '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">'
       '<meta name="theme-color" content="#05080c"><script>window.__RELAY_SAME_ORIGIN = true;</script></head><body>' + src + '</body></html>')
open(os.path.join(HERE, '../public/index.html'), 'w', encoding='utf-8').write(srv)
print('built', len(src))

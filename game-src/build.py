import sys
src = open('index.src.html', encoding='utf-8').read()
for key, fn in [('ENGINE', 'engine.js'), ('SIM', 'sim.js'), ('PROTO', 'proto.js'), ('RELAY', 'relay.js'), ('ASSETS', 'assets.js'), ('GAME', 'game.js')]:
    code = open(fn, encoding='utf-8').read()
    assert '</script' not in code, fn
    src = src.replace('/*__%s__*/' % key, '\n' + code + '\n')
open('晶核守卫.html', 'w', encoding='utf-8').write(src)
import re
tsrc = re.sub(r'<link[^>]+fonts[^>]+>', '', src)
test = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + tsrc + '</body></html>'
open(sys.argv[1] if len(sys.argv) > 1 else 'test.html', 'w', encoding='utf-8').write(test)
print('built', len(src))
# 自建服务器版：同源中转 + 手机 viewport
srv = ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
       '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">'
       '<meta name="theme-color" content="#05080c"><script>window.__RELAY_SAME_ORIGIN = true;</script></head><body>' + src + '</body></html>')
import os
os.makedirs('server/public', exist_ok=True)
open('server/public/index.html', 'w', encoding='utf-8').write(srv)

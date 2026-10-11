# 晶核守卫 → Android APK（WebView 外壳，离线单机）
# 工具链：aapt2（Apktool 预编译）、javac、d8（r8 jar）、apksigner（apksig 源码编译）、android.jar（API 34）
import os, re, shutil, subprocess, sys, zipfile
ROOT = os.path.dirname(os.path.abspath(__file__))
# 工具目录：tools/aapt2、tools/r8/r8-master.jar、tools/apksigner.jar、tools/plat/android-34/android.jar
T = os.environ.get('JHSW_TOOLS', os.path.join(ROOT, 'tools')); P = ROOT; B = os.path.join(ROOT, 'build')
ANDROID_JAR = os.path.join(T, 'plat/android-34/android.jar')
VERSION_CODE, VERSION_NAME = sys.argv[1] if len(sys.argv) > 1 else '1', sys.argv[2] if len(sys.argv) > 2 else '1.0'
def run(*cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    out = '\n'.join(l for l in (r.stdout + r.stderr).splitlines() if 'JAVA_TOOL_OPTIONS' not in l and not l.startswith('warning: [options]'))
    if r.returncode: print(out); sys.exit(f'失败：{cmd[0]}')
    return out
shutil.rmtree(B, ignore_errors=True); os.makedirs(B)
# 1) 游戏页面：去掉在线字体、加移动端 viewport、标记安卓版
src = open(os.path.join(ROOT, '../dist/晶核守卫.html'), encoding='utf-8').read()
src = re.sub(r'<link[^>]+fonts\.(googleapis|gstatic)[^>]*>\n?', '', src)
html = ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">'
        '<script>window.__APK = true;</script></head><body>' + src + '</body></html>')
os.makedirs(os.path.join(P, 'assets'), exist_ok=True)
open(os.path.join(P, 'assets/index.html'), 'w', encoding='utf-8').write(html)
# 2) 资源编译 + 链接
run(os.path.join(T, 'aapt2'), 'compile', '--dir', os.path.join(P, 'res'), '-o', os.path.join(B, 'res.zip'))
run(os.path.join(T, 'aapt2'), 'link', '-I', ANDROID_JAR, '--manifest', os.path.join(P, 'AndroidManifest.xml'),
    '-A', os.path.join(P, 'assets'), '--min-sdk-version', '24', '--target-sdk-version', '34',
    '--version-code', VERSION_CODE, '--version-name', VERSION_NAME, '-o', os.path.join(B, 'base.apk'), os.path.join(B, 'res.zip'))
# 3) Java → class → dex
cls = os.path.join(B, 'classes'); os.makedirs(cls)
srcs = [os.path.join(dp, f) for dp, _, fs in os.walk(os.path.join(P, 'src')) for f in fs if f.endswith('.java')]
run('javac', '-source', '8', '-target', '8', '-bootclasspath', ANDROID_JAR, '-encoding', 'UTF-8', '-Xlint:-options', '-d', cls, *srcs)
classes = [os.path.join(dp, f) for dp, _, fs in os.walk(cls) for f in fs if f.endswith('.class')]
run('java', '-cp', os.path.join(T, 'r8/r8-master.jar'), 'com.android.tools.r8.D8', '--release', '--min-api', '24', '--output', B, *classes)
# 4) 拼进 APK（index.html 压缩存放；resources.arsc 保持不压缩）
with zipfile.ZipFile(os.path.join(B, 'base.apk'), 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(os.path.join(B, 'classes.dex'), 'classes.dex')
# 4b) zipalign：未压缩条目数据按 4 字节对齐（0xD935 扩展字段填充）
import struct
src_apk, aligned = os.path.join(B, 'base.apk'), os.path.join(B, 'aligned.apk')
with zipfile.ZipFile(src_apk) as zin, open(aligned, 'wb') as raw:
    with zipfile.ZipFile(raw, 'w') as zout:
        for zi in zin.infolist():
            data = zin.read(zi.filename)
            nz = zipfile.ZipInfo(zi.filename, date_time=zi.date_time); nz.compress_type = zi.compress_type; nz.external_attr = zi.external_attr
            if zi.compress_type == zipfile.ZIP_STORED:
                off = raw.tell() + 30 + len(zi.filename.encode('utf-8')) + 6
                pad = (-off) % 4
                nz.extra = struct.pack('<HHH', 0xD935, 2 + pad, 4) + b'\0' * pad
            zout.writestr(nz, data)
os.replace(aligned, src_apk)
# 5) 签名（v1 + v2 + v3），apksigner 会对齐未压缩条目
ks = os.environ.get('JHSW_KEYSTORE', os.path.join(ROOT, 'jhsw-release.jks'))   # 签名密钥不要提交到仓库
if not os.path.exists(ks):
    run('keytool', '-genkeypair', '-keystore', ks, '-storepass', os.environ.get('JHSW_KS_PASS', 'change-me'), '-keypass', os.environ.get('JHSW_KS_PASS', 'change-me'), '-alias', 'jhsw',
        '-keyalg', 'RSA', '-keysize', '2048', '-validity', '12000', '-dname', 'CN=JingHe ShouWei, O=JHSW, C=CN')
out = os.path.join(ROOT, '../dist', f'晶核守卫-v{VERSION_NAME}.apk')
run('java', '-jar', os.path.join(T, 'apksigner.jar'), 'sign', '--ks', ks, '--ks-pass', 'pass:' + os.environ.get('JHSW_KS_PASS', 'change-me'), '--ks-key-alias', 'jhsw',
    '--min-sdk-version', '24', '--out', out, os.path.join(B, 'base.apk'))
print(run('java', '-jar', os.path.join(T, 'apksigner.jar'), 'verify', '--verbose', '--min-sdk-version', '24', out).strip())
print(run(os.path.join(T, 'aapt2'), 'dump', 'badging', out).split('\n')[0:8])
print('APK', out, os.path.getsize(out))

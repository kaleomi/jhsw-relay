# 美术图片：把 art/ 目录里按约定命名的图片压缩后内联成 window.TD_ART
# 文件名（不含扩展名）就是槽位名，见 art/PROMPTS.md；支持 png / jpg / jpeg / webp。
# 有 Pillow 时自动缩放并转成 webp；没有 Pillow 时只内联已经足够小（< 400KB）的 webp / jpg。
import os, base64, io, json

# 槽位：名字 -> (宽, 高, 质量)
SLOTS = {}
for k in ['me', 'prism', 'qian', 'hq', 'han', 'rust']:
    SLOTS['p_' + k] = (256, 256, 82)          # 角色头像（正方形）
for k in ['station', 'fortress', 'furnace', 'abyss', 'outpost', 'canyon', 'cryolab']:
    SLOTS['ch_' + k] = (960, 540, 74)         # 章节插图（16:9）
for k in ['boss', 'siege', 'colossus', 'brood']:
    SLOTS['boss_' + k] = (960, 540, 74)       # BOSS 登场卡（16:9）
SLOTS['menu_bg'] = (1600, 900, 72)             # 主菜单海报（16:9）
SLOTS['prologue'] = (1600, 900, 70)            # 序章背景（16:9）

EXTS = ('.png', '.jpg', '.jpeg', '.webp')


def _encode(path, size, q):
    try:
        from PIL import Image
    except ImportError:
        if os.path.getsize(path) > 400_000 or not path.lower().endswith(('.webp', '.jpg', '.jpeg')):
            print('  [art] 跳过（没有 Pillow，图片太大或不是 webp/jpg）:', os.path.basename(path))
            return None
        mime = 'image/webp' if path.lower().endswith('.webp') else 'image/jpeg'
        return 'data:%s;base64,%s' % (mime, base64.b64encode(open(path, 'rb').read()).decode())
    im = Image.open(path).convert('RGB')
    W, H = size
    # 居中裁成目标比例，再缩放
    r = W / H
    if im.width / im.height > r:
        nw = int(im.height * r); x0 = (im.width - nw) // 2; im = im.crop((x0, 0, x0 + nw, im.height))
    else:
        nh = int(im.width / r); y0 = (im.height - nh) // 2; im = im.crop((0, y0, im.width, y0 + nh))
    if im.width > W:
        im = im.resize((W, H), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=q, method=6)
    return 'data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode()


def art_js(art_dir):
    out = {}
    if os.path.isdir(art_dir):
        for fn in sorted(os.listdir(art_dir)):
            name, ext = os.path.splitext(fn)
            if ext.lower() not in EXTS:
                continue
            if name not in SLOTS:
                print('  [art] 未知槽位，忽略:', fn)
                continue
            uri = _encode(os.path.join(art_dir, fn), *SLOTS[name])
            if uri:
                out[name] = uri
    total = sum(len(v) for v in out.values())
    if out:
        print('  [art] 内联 %d 张图片，共 %.0f KB：%s' % (len(out), total / 1024, ', '.join(sorted(out))))
    return 'window.TD_ART = ' + json.dumps(out, ensure_ascii=False) + ';'

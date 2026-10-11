# 生成应用图标：深色底 + 发光的青色晶核 + 防御环
from PIL import Image, ImageDraw, ImageFilter
import os, sys
RES = sys.argv[1]
def crystal(size, pad_frac, bg):
    S = size * 4  # 超采样
    im = Image.new('RGBA', (S, S), (5, 8, 12, 255) if bg else (0, 0, 0, 0))
    cx, cy = S / 2, S / 2
    r = S * (0.5 - pad_frac)
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    # 防御环
    ring_r = r * 0.92
    g.ellipse([cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r], outline=(95, 227, 255, 200), width=int(S * 0.022))
    # 晶体轮廓（拉长的六边形）
    w, h = r * 0.46, r * 0.82
    pts = [(cx, cy - h), (cx + w, cy - h * 0.32), (cx + w * 0.82, cy + h * 0.42), (cx, cy + h), (cx - w * 0.82, cy + h * 0.42), (cx - w, cy - h * 0.32)]
    g.polygon(pts, fill=(95, 227, 255, 255))
    blur = glow.filter(ImageFilter.GaussianBlur(S * 0.035))
    im = Image.alpha_composite(im, blur)
    im = Image.alpha_composite(im, glow)
    d = ImageDraw.Draw(im)
    # 刻面
    d.polygon([(cx, cy - h), (cx - w, cy - h * 0.32), (cx - w * 0.82, cy + h * 0.42), (cx, cy + h), (cx, cy - h)], fill=(170, 245, 255, 255))
    d.polygon([(cx, cy - h), (cx + w, cy - h * 0.32), (cx + w * 0.82, cy + h * 0.42), (cx, cy + h)], fill=(40, 170, 220, 255))
    d.polygon([(cx - w, cy - h * 0.32), (cx, cy - h * 0.1), (cx + w, cy - h * 0.32), (cx, cy - h)], fill=(225, 252, 255, 255))
    d.line([(cx - w * 0.82, cy + h * 0.42), (cx, cy + h * 0.15), (cx + w * 0.82, cy + h * 0.42)], fill=(20, 120, 170, 255), width=int(S * 0.008))
    # 琥珀色炮台点缀
    for ang in (35, 145, 215, 325):
        import math
        a = math.radians(ang)
        px, py = cx + math.cos(a) * ring_r, cy + math.sin(a) * ring_r
        k = S * 0.03
        d.rectangle([px - k, py - k, px + k, py + k], fill=(255, 181, 71, 255))
    return im.resize((size, size), Image.LANCZOS)
legacy = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
for dpi, px in legacy.items():
    os.makedirs(f'{RES}/mipmap-{dpi}', exist_ok=True)
    im = crystal(px, 0.06, True)
    # 圆角方形
    m = Image.new('L', (px * 4, px * 4), 0); ImageDraw.Draw(m).rounded_rectangle([0, 0, px * 4 - 1, px * 4 - 1], radius=px * 4 * 0.2, fill=255)
    im.putalpha(m.resize((px, px), Image.LANCZOS))
    im.save(f'{RES}/mipmap-{dpi}/ic_launcher.png')
    fg = crystal(int(px * 2.25), 0.5 - 0.5 * 0.56, False)   # 108dp 前景层，内容落在 66dp 安全区里
    fg.save(f'{RES}/mipmap-{dpi}/ic_fg.png')
crystal(512, 0.06, True).save(os.path.join(os.path.dirname(RES), 'icon512.png'))
print('ok')

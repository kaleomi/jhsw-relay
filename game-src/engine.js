/* ============================================================
 * 迷你 WebGL2 实例化渲染器（无第三方依赖）
 * - 每帧：begin() → 若干 push*() → flush()
 * - 每个实例 = 模型矩阵 + 颜色 + 参数(自发光, 受击闪白, 面板缝, 无雾) + 动画(帧A, 帧B, 插值, 是否蒙皮)
 * - 蒙皮网格：骨骼矩阵预先烘焙进半精度浮点纹理，顶点着色器按帧取用
 * - 后期：HDR 多重采样 → 泛光（亮部提取 + 两级高斯模糊）→ 柔和高光压缩 + 暗角
 * ============================================================ */
(function (root) {
'use strict';

const FLOATS = 28;

/* ---------- 基础几何体 ---------- */
function geoBox() {
  const P = [], N = [];
  const f = (n, a, b, c, d) => { P.push(...a, ...b, ...c, ...a, ...c, ...d); for (let i = 0; i < 6; i++) N.push(...n); };
  const h = 0.5;
  f([1, 0, 0], [h, -h, -h], [h, h, -h], [h, h, h], [h, -h, h]);
  f([-1, 0, 0], [-h, -h, h], [-h, h, h], [-h, h, -h], [-h, -h, -h]);
  f([0, 1, 0], [-h, h, -h], [-h, h, h], [h, h, h], [h, h, -h]);
  f([0, -1, 0], [-h, -h, h], [-h, -h, -h], [h, -h, -h], [h, -h, h]);
  f([0, 0, 1], [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]);
  f([0, 0, -1], [h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]);
  return { P, N };
}
function geoCyl(n, top) {
  const P = [], N = [], r = 0.5, rt = top === undefined ? 0.5 : top;
  for (let i = 0; i < n; i++) {
    const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const ny = (r - rt);
    const n0 = [c0, ny, s0], n1 = [c1, ny, s1];
    P.push(c0 * r, -0.5, s0 * r, c1 * r, -0.5, s1 * r, c1 * rt, 0.5, s1 * rt); N.push(...n0, ...n1, ...n1);
    P.push(c0 * r, -0.5, s0 * r, c1 * rt, 0.5, s1 * rt, c0 * rt, 0.5, s0 * rt); N.push(...n0, ...n1, ...n0);
    if (rt > 0) { P.push(0, 0.5, 0, c0 * rt, 0.5, s0 * rt, c1 * rt, 0.5, s1 * rt); N.push(0, 1, 0, 0, 1, 0, 0, 1, 0); }
    P.push(0, -0.5, 0, c1 * r, -0.5, s1 * r, c0 * r, -0.5, s0 * r); N.push(0, -1, 0, 0, -1, 0, 0, -1, 0);
  }
  return { P, N };
}
function geoSphere(lat, lon) {
  const P = [], N = [];
  const v = (i, j) => { const t = i / lat * Math.PI, p = j / lon * Math.PI * 2; return [Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p)]; };
  for (let i = 0; i < lat; i++) for (let j = 0; j < lon; j++) {
    const a = v(i, j), b = v(i + 1, j), c = v(i + 1, j + 1), d = v(i, j + 1);
    for (const q of [a, b, c, a, c, d]) { P.push(q[0] * 0.5, q[1] * 0.5, q[2] * 0.5); N.push(q[0], q[1], q[2]); }
  }
  return { P, N };
}
function geoOct() {
  const P = [], N = [];
  const V = [[0.5, 0, 0], [-0.5, 0, 0], [0, 0.5, 0], [0, -0.5, 0], [0, 0, 0.5], [0, 0, -0.5]];
  const F = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]];
  for (const f of F) {
    const a = V[f[0]], b = V[f[1]], c = V[f[2]];
    const nx = Math.sign(a[0] + b[0] + c[0]), ny = Math.sign(a[1] + b[1] + c[1]), nz = Math.sign(a[2] + b[2] + c[2]);
    const l = Math.hypot(nx, ny, nz);
    P.push(...a, ...b, ...c); for (let i = 0; i < 3; i++) N.push(nx / l, ny / l, nz / l);
  }
  return { P, N };
}
function geoRing(n, inner) {
  const P = [], N = [];
  for (let i = 0; i < n; i++) {
    const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    P.push(c0 * inner, 0, s0 * inner, c0, 0, s0, c1, 0, s1, c0 * inner, 0, s0 * inner, c1, 0, s1, c1 * inner, 0, s1 * inner);
    for (let k = 0; k < 6; k++) N.push(0, 1, 0);
  }
  return { P, N };
}
function geoDisc(n) {
  const P = [], N = [];
  for (let i = 0; i < n; i++) {
    const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
    P.push(0, 0, 0, Math.cos(a0) * 0.5, 0, Math.sin(a0) * 0.5, Math.cos(a1) * 0.5, 0, Math.sin(a1) * 0.5);
    N.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
  }
  return { P, N };
}

/* ---------- 场景着色器 ---------- */
const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNor;
layout(location=2) in vec4 aM0;
layout(location=3) in vec4 aM1;
layout(location=4) in vec4 aM2;
layout(location=5) in vec4 aM3;
layout(location=6) in vec4 aCol;
layout(location=7) in vec4 aPar;
layout(location=8) in vec4 aVCol;
layout(location=9) in vec4 aJnt;
layout(location=10) in vec4 aWgt;
layout(location=11) in vec4 aAnim;
uniform mat4 uVP;
uniform highp sampler2D uBones;
out vec3 vW; out vec3 vN; out vec4 vCol; out vec4 vPar; out vec3 vL;
mat4 bone(int b, int row) {
  vec4 r0 = texelFetch(uBones, ivec2(b * 3, row), 0);
  vec4 r1 = texelFetch(uBones, ivec2(b * 3 + 1, row), 0);
  vec4 r2 = texelFetch(uBones, ivec2(b * 3 + 2, row), 0);
  return mat4(vec4(r0.x, r1.x, r2.x, 0.0), vec4(r0.y, r1.y, r2.y, 0.0), vec4(r0.z, r1.z, r2.z, 0.0), vec4(r0.w, r1.w, r2.w, 1.0));
}
void main(){
  vec3 p = aPos, n = aNor;
  if (aAnim.w > 0.5) {
    int ra = int(aAnim.x + 0.5), rb = int(aAnim.y + 0.5);
    mat4 S = mat4(0.0);
    for (int i = 0; i < 4; i++) {
      float w = aWgt[i];
      if (w <= 0.0) continue;
      int b = int(aJnt[i] + 0.5);
      S += bone(b, ra) * (w * (1.0 - aAnim.z)) + bone(b, rb) * (w * aAnim.z);
    }
    p = (S * vec4(p, 1.0)).xyz; n = mat3(S) * n;
  }
  mat4 M = mat4(aM0, aM1, aM2, aM3);
  vec4 w = M * vec4(p, 1.0);
  vW = w.xyz;
  vec3 s2 = vec3(dot(aM0.xyz, aM0.xyz), dot(aM1.xyz, aM1.xyz), dot(aM2.xyz, aM2.xyz));
  vN = mat3(M) * (n / max(s2, vec3(1e-8)));
  vL = aPos;
  vCol = vec4(aCol.rgb * aVCol.rgb, aCol.a); vPar = aPar;
  gl_Position = uVP * w;
}`;
const FS = `#version 300 es
precision highp float;
in vec3 vW; in vec3 vN; in vec4 vCol; in vec4 vPar; in vec3 vL;
uniform vec3 uEye; uniform vec3 uSky; uniform vec3 uGround; uniform vec3 uSunDir; uniform vec3 uSunCol;
uniform vec3 uFogCol; uniform float uFogD; uniform int uNL; uniform float uEmit; uniform float uDetail;
uniform vec4 uLP[12]; uniform vec3 uLC[12];
out vec4 o;
/* ---- 程序化纹理：值噪声 / 分形噪声 ---- */
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float DET = 1.0;
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { if (float(i) >= 1.0 + DET * 3.0) break; s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s / (1.0 - pow(0.5, 1.0 + DET * 3.0));
}
float seamLine(float v, float w) { float g = abs(fract(v) - 0.5); return smoothstep(0.5 - w, 0.5, g); }
void main(){
  // 远处像素细节逐渐关掉：40 米外只剩 1 层噪声，省掉大部分纹理计算
  DET = uDetail * clamp(1.35 - length(vW - uEye) / 40.0, 0.0, 1.0);
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 base = vCol.rgb;
  vec3 V = normalize(uEye - vW);
  float m = vPar.z;
  /* 天空穹顶：不受光照，按视线方向做渐变 + 太阳光晕 */
  if (m > 17.5) {
    vec3 d = -V;
    float up = clamp(d.y, -0.2, 1.0);
    vec3 col = mix(uFogCol, uSky * vec3(0.55, 0.68, 0.95), smoothstep(0.0, 0.55, up));
    col = mix(col, uFogCol * 0.8, smoothstep(0.0, -0.2, up));
    float sd = max(dot(d, -uSunDir), 0.0);
    col += uSunCol * (pow(sd, 400.0) * 3.0 + pow(sd, 18.0) * 0.35);
    float cl = fbm(d.xz / max(d.y + 0.15, 0.08) * 1.6) * smoothstep(0.02, 0.3, up);
    col = mix(col, vec3(1.0, 0.96, 0.92) * (0.75 + 0.3 * sd), smoothstep(0.55, 0.85, cl) * 0.55);
    o = vec4(col, 1.0); return;
  }
  // 平面投影的世界坐标纹理坐标（物体基本都是轴对齐的）
  vec3 aN = abs(N);
  vec2 uv = aN.y > 0.6 ? vW.xz : (aN.x > aN.z ? vW.zy : vW.xy);
  float spec = 0.12, shin = 24.0, ao = 1.0;
  vec3 bump = vec3(0.0);
  if (m > 9.5) {
    float g1 = fbm(uv * 0.55), n2 = vn(uv * 7.0);
    if (m < 10.5) {          // 10 金属地板：拼板 + 防滑纹 + 划痕 + 污渍
      float s1 = max(seamLine(uv.x / 1.2, 0.02), seamLine(uv.y / 1.2, 0.02));
      vec2 q = uv * 9.0; float tread = step(0.82, abs(sin(q.x + q.y) * sin(q.x - q.y)));
      float scr = smoothstep(0.93, 1.0, vn(vec2(uv.x * 0.6, uv.y * 22.0))) * 0.5 + smoothstep(0.95, 1.0, vn(vec2(uv.x * 25.0, uv.y * 0.5))) * 0.4;
      base *= (0.78 + 0.32 * g1) * (1.0 - s1 * 0.55) * (1.0 + tread * 0.12) * (1.0 + scr * 0.35 * DET);
      spec = 0.55 * (0.6 + 0.4 * g1); shin = 48.0;
    } else if (m < 11.5) {   // 11 混凝土 / 地砖：大块砖缝 + 斑点 + 裂纹
      float s1 = max(seamLine(uv.x / 2.4, 0.012), seamLine(uv.y / 2.4, 0.012));
      float crack = smoothstep(0.007, 0.0, abs(fbm(uv * 0.7 + 3.0) - 0.5)) * DET * step(0.55, vn(uv * 0.21));
      base *= (0.82 + 0.26 * g1) * (0.94 + 0.12 * n2) * (1.0 - s1 * 0.4) * (1.0 - crack * 0.16);
      spec = 0.08;
    } else if (m < 12.5) {   // 12 墙板：竖向板材 + 横缝 + 铆钉 + 底部积灰
      float py = vW.y;
      float sx = seamLine(uv.x / 1.2, 0.015), sy = seamLine(py / 1.6, 0.02);
      vec2 rq = vec2(fract(uv.x / 1.2), fract(py / 1.6));
      float riv = smoothstep(0.045, 0.02, length(vec2(min(rq.x, 1.0 - rq.x) * 1.2, (min(rq.y, 1.0 - rq.y)) * 1.6) - vec2(0.09, 0.09)));
      float streak = vn(vec2(uv.x * 3.0, py * 0.25)) * smoothstep(3.0, 0.0, py);
      base *= (0.84 + 0.22 * g1) * (1.0 - max(sx, sy) * 0.5) * (1.0 + riv * 0.5) * (1.0 - streak * 0.25 * DET);
      ao = mix(0.55, 1.0, smoothstep(0.0, 1.4, py));
      spec = 0.32; shin = 32.0;
    } else if (m < 13.5) {   // 13 岩石：沉积层 + 颜色斑驳 + 凹凸
      float w = fbm(uv * 0.35);
      float strata = sin(vW.y * 2.6 + w * 6.0);
      base *= (0.78 + 0.3 * g1) * (0.9 + 0.12 * strata) * (0.95 + 0.1 * n2);
      float e = 0.15, f0 = fbm(uv * 1.3);
      vec2 grad = vec2(fbm(uv * 1.3 + vec2(e, 0.0)) - f0, fbm(uv * 1.3 + vec2(0.0, e)) - f0) / e;
      bump = vec3(grad.x, 0.0, grad.y) * 0.6 * DET;
      spec = 0.05;
    } else if (m < 14.5) {   // 14 沙土地面：颗粒 + 碎石
      vec2 c = floor(uv * 3.0); vec2 f = fract(uv * 3.0) - 0.5;
      float peb = smoothstep(0.18, 0.1, length(f - (vec2(h21(c), h21(c + 7.0)) - 0.5) * 0.6)) * step(0.6, h21(c + 3.0));
      base *= (0.8 + 0.3 * g1) * (0.9 + 0.2 * vn(uv * 18.0)) * (1.0 - peb * 0.3 * DET);
      spec = 0.04;
    } else if (m < 15.5) {   // 15 钢格栅：条形镂空
      float bar = seamLine(uv.x / 0.24, 0.2);
      float rim2 = max(seamLine(uv.x / 1.2, 0.03), seamLine(uv.y / 1.2, 0.03));
      base *= mix(0.62, 0.9, max(bar, rim2)) * (0.85 + 0.2 * g1);
      spec = 0.12; shin = 24.0;
    } else if (m < 16.5) {   // 16 警示条纹（黄黑斜纹）
      float st = step(0.5, fract((uv.x + uv.y) * 1.4));
      base = mix(vec3(0.08, 0.08, 0.09), base, st) * (0.85 + 0.2 * g1);
      spec = 0.25;
    } else {                 // 17 天花板：方格吊顶
      float s1 = max(seamLine(uv.x / 1.2, 0.04), seamLine(uv.y / 1.2, 0.04));
      base *= (0.8 + 0.25 * g1) * (1.0 - s1 * 0.5);
      spec = 0.1;
    }
    if (dot(bump, bump) > 0.0) {
      // 把凹凸梯度投到法线所在平面
      vec3 t = aN.y > 0.6 ? vec3(bump.x, 0.0, bump.z) : (aN.x > aN.z ? vec3(0.0, bump.z, bump.x) : vec3(bump.x, bump.z, 0.0));
      N = normalize(N - t + N * dot(N, t));
    }
  } else if (vPar.z > 0.0) {
    vec3 g = abs(fract(vL * vPar.z + 0.5) - 0.5);
    float seam = smoothstep(0.47, 0.5, max(g.x, g.z));
    base *= (1.0 - seam * 0.35) * (0.92 + 0.12 * vn(vL.xz * 5.0 + vL.y * 3.0));
    spec = 0.25;
  } else if (vPar.x < 0.5 && vCol.a > 0.99) {
    // 普通模型：按模型局部坐标加一点磨损 / 斑驳（跟着物体走，不会“游动”）
    base *= 0.9 + 0.14 * vn(vL.xz * 7.0 + vL.y * 5.0) * (0.4 + 0.6 * DET);
    spec = 0.2;
  }
  vec3 lit = mix(uGround, uSky, N.y * 0.5 + 0.5) * ao;
  float ndl = max(dot(N, -uSunDir), 0.0);
  lit += uSunCol * ndl;
  vec3 H = normalize(V - uSunDir);
  vec3 sp = uSunCol * pow(max(dot(N, H), 0.0), shin) * spec * step(0.0, ndl);
  for (int i = 0; i < 12; i++) {
    if (i >= uNL) break;
    vec3 L = uLP[i].xyz - vW; float d = length(L);
    float a = clamp(1.0 - d / uLP[i].w, 0.0, 1.0); a *= a;
    vec3 Ld = L / max(d, 0.001);
    lit += uLC[i] * a * (max(dot(N, Ld), 0.0) * 0.8 + 0.2);
    sp += uLC[i] * a * pow(max(dot(N, normalize(Ld + V)), 0.0), shin) * spec * 1.4;
  }
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  vec3 col = base * lit + base * rim * 0.18 + sp;
  col = mix(col, base * uEmit, min(vPar.x, 1.0));
  col += vec3(vPar.y);
  float dist = length(vW - uEye);
  float f = 1.0 - exp(-uFogD * uFogD * dist * dist);
  col = mix(col, uFogCol, f * (1.0 - vPar.w));
  o = vec4(col, vCol.a);
}`;

/* ---------- 后期着色器 ---------- */
const PVS = `#version 300 es
out vec2 vUv;
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const P_BRIGHT = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uTex; uniform vec2 uTx; uniform float uThr; out vec4 o;
void main(){
  vec3 c = texture(uTex, vUv + uTx * vec2(-1.0, -1.0)).rgb + texture(uTex, vUv + uTx * vec2(1.0, -1.0)).rgb
         + texture(uTex, vUv + uTx * vec2(-1.0, 1.0)).rgb + texture(uTex, vUv + uTx * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  o = vec4(c * max(l - uThr, 0.0) / max(l, 1e-4), 1.0);
}`;
const P_BLUR = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uTex; uniform vec2 uDir; out vec4 o;
void main(){
  vec3 c = texture(uTex, vUv).rgb * 0.227027;
  c += (texture(uTex, vUv + uDir * 1.3846).rgb + texture(uTex, vUv - uDir * 1.3846).rgb) * 0.316216;
  c += (texture(uTex, vUv + uDir * 3.2308).rgb + texture(uTex, vUv - uDir * 3.2308).rgb) * 0.070270;
  o = vec4(c, 1.0);
}`;
const P_COMP = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uScene; uniform sampler2D uB1; uniform sampler2D uB2;
uniform float uBloom; uniform float uVig; uniform vec3 uTint; uniform float uTintA; out vec4 o;
void main(){
  vec3 c = texture(uScene, vUv).rgb;
  c += (texture(uB1, vUv).rgb * 0.75 + texture(uB2, vUv).rgb * 1.1) * uBloom;
  vec3 k = 0.82 + 0.18 * (1.0 - exp(-(c - 0.82) / 0.18));
  c = mix(c, k, step(0.82, c));
  vec2 q = vUv - 0.5;
  c *= 1.0 - dot(q, q) * uVig;
  c = mix(c, uTint, uTintA * smoothstep(0.15, 0.75, length(q)));
  o = vec4(c, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(gl, vs, fs, names) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const U = {};
  for (const n of names) U[n] = gl.getUniformLocation(p, n);
  return { p, U };
}

/* ---------- 渲染器 ---------- */
function create(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  const main = program(gl, VS, FS, ['uVP', 'uEye', 'uSky', 'uGround', 'uSunDir', 'uSunCol', 'uFogCol', 'uFogD', 'uNL', 'uLP', 'uLC', 'uBones', 'uEmit', 'uDetail']);
  const U = main.U;
  const halfOK = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
  let post = null;
  try {
    post = {
      bright: program(gl, PVS, P_BRIGHT, ['uTex', 'uTx', 'uThr']),
      blur: program(gl, PVS, P_BLUR, ['uTex', 'uDir']),
      comp: program(gl, PVS, P_COMP, ['uScene', 'uB1', 'uB2', 'uBloom', 'uVig', 'uTint', 'uTintA']),
      vao: gl.createVertexArray(), w: 0, h: 0,
    };
  } catch (e) { console.warn('后期着色器不可用', e); post = null; }
  let postOn = !!post;

  // 默认常量属性：顶点色白色、无骨骼
  gl.vertexAttrib4f(8, 1, 1, 1, 1);
  gl.vertexAttrib4f(9, 0, 0, 0, 0);
  gl.vertexAttrib4f(10, 0, 0, 0, 0);
  const dummyTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, dummyTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1, 1, 0, gl.RGBA, gl.HALF_FLOAT, new Uint16Array(4));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  const geoms = {};
  const GN = [];
  function setupInstanceAttribs(ib) {
    gl.bindBuffer(gl.ARRAY_BUFFER, ib);
    for (let k = 0; k < 6; k++) {
      gl.enableVertexAttribArray(2 + k);
      gl.vertexAttribPointer(2 + k, 4, gl.FLOAT, false, FLOATS * 4, k * 16);
      gl.vertexAttribDivisor(2 + k, 1);
    }
    gl.enableVertexAttribArray(11);
    gl.vertexAttribPointer(11, 4, gl.FLOAT, false, FLOATS * 4, 24 * 4);
    gl.vertexAttribDivisor(11, 1);
  }
  function addPrimitive(name, d) {
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    const n = d.P.length / 3, data = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) { data.set(d.P.slice(i * 3, i * 3 + 3), i * 6); data.set(d.N.slice(i * 3, i * 3 + 3), i * 6 + 3); }
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    const ib = gl.createBuffer(); setupInstanceAttribs(ib);
    gl.bindVertexArray(null);
    geoms[name] = { name, vao, ib, count: n, indexed: false, tex: dummyTex };
    GN.push(name);
  }
  const defs = { box: geoBox(), cyl: geoCyl(18), cone: geoCyl(18, 0), sphere: geoSphere(10, 18), oct: geoOct(), ring: geoRing(48, 0.9), disc: geoDisc(24), frustum: geoCyl(10, 0.32), pipe: geoCyl(8), ball: geoSphere(4, 7) };   // ball：粒子专用的低面数球   // pipe：低面数圆柱，用于大量重复的静态管线
  for (const name in defs) addPrimitive(name, defs[name]);

  // 外部网格：{pos Float32Array, nrm Int8Array(4/顶点), col Uint8Array(4), jnt Uint8Array(4), wgt Uint8Array(4), idx, bones Uint16Array(half), nb, nf}
  function addMesh(name, m) {
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const buf = (arr, loc, size, type, norm) => {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, type, norm, 0, 0);
    };
    buf(m.pos, 0, 3, gl.FLOAT, false);
    buf(m.nrm, 1, 4, gl.BYTE, true);
    buf(m.col, 8, 4, gl.UNSIGNED_BYTE, true);
    buf(m.jnt, 9, 4, gl.UNSIGNED_BYTE, false);
    buf(m.wgt, 10, 4, gl.UNSIGNED_BYTE, true);
    const eb = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eb); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
    const ib = gl.createBuffer(); setupInstanceAttribs(ib);
    gl.bindVertexArray(null);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, m.nb * 3, m.nf, 0, gl.RGBA, gl.HALF_FLOAT, m.bones);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    geoms[name] = { name, vao, ib, count: m.idx.length, indexed: true, itype: m.idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, tex };
    GN.push(name);
    for (const L of dyn) for (const M of L) M[name] = { arr: new Float32Array(FLOATS * 32), n: 0 };
    stream[name] = gl.createBuffer();
  }

  const mkBuckets = () => {
    const b = [];
    for (let L = 0; L < 2; L++) { b[L] = []; for (let m = 0; m < 3; m++) { b[L][m] = {}; for (const g of GN) b[L][m][g] = { arr: new Float32Array(FLOATS * 64), n: 0 }; } }
    return b;
  };
  const dyn = mkBuckets();
  let cur = dyn;
  function slot(geom, layer, mode) {
    const bk = cur[layer][mode][geom];
    if ((bk.n + 1) * FLOATS > bk.arr.length) { const na = new Float32Array(bk.arr.length * 2); na.set(bk.arr); bk.arr = na; }
    return bk;
  }
  let LAYER = 0;
  function setLayer(l) { LAYER = l; }
  const ANIM = new Float32Array(4);
  function anim(ra, rb, t) { if (ra === undefined) { ANIM[0] = ANIM[1] = ANIM[2] = ANIM[3] = 0; } else { ANIM[0] = ra; ANIM[1] = rb; ANIM[2] = t; ANIM[3] = 1; } }
  function modeOf(a, add) { return add ? 2 : (a < 0.999 ? 1 : 0); }

  function pushBasis(g, x, y, z, ax, ay, az, bx, by, bz, cx, cy, cz, r, gg, b, a, emit, flash, panel, add, nofog) {
    const bk = slot(g, LAYER, modeOf(a, add)); const o = bk.n * FLOATS, A = bk.arr;
    A[o] = ax; A[o + 1] = ay; A[o + 2] = az; A[o + 3] = 0;
    A[o + 4] = bx; A[o + 5] = by; A[o + 6] = bz; A[o + 7] = 0;
    A[o + 8] = cx; A[o + 9] = cy; A[o + 10] = cz; A[o + 11] = 0;
    A[o + 12] = x; A[o + 13] = y; A[o + 14] = z; A[o + 15] = 1;
    A[o + 16] = r; A[o + 17] = gg; A[o + 18] = b; A[o + 19] = a;
    A[o + 20] = emit || 0; A[o + 21] = flash || 0; A[o + 22] = panel || 0; A[o + 23] = nofog ? 1 : 0;
    A[o + 24] = ANIM[0]; A[o + 25] = ANIM[1]; A[o + 26] = ANIM[2]; A[o + 27] = ANIM[3];
    bk.n++;
  }
  function push(g, x, y, z, yaw, sx, sy, sz, c) {
    const cy = Math.cos(yaw), sy_ = Math.sin(yaw);
    pushBasis(g, x, y, z, cy * sx, 0, -sy_ * sx, 0, sy, 0, sy_ * sz, 0, cy * sz, c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8]);
  }
  function pushR(g, x, y, z, yaw, pitch, roll, sx, sy, sz, c) {
    const cy = Math.cos(yaw), sY = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    const a0x = cy, a0y = 0, a0z = -sY, a1x = sY * sp, a1y = cp, a1z = cy * sp, a2x = sY * cp, a2y = -sp, a2z = cy * cp;
    const c0x = cr * a0x + sr * a1x, c0y = cr * a0y + sr * a1y, c0z = cr * a0z + sr * a1z;
    const c1x = -sr * a0x + cr * a1x, c1y = -sr * a0y + cr * a1y, c1z = -sr * a0z + cr * a1z;
    pushBasis(g, x, y, z, c0x * sx, c0y * sx, c0z * sx, c1x * sy, c1y * sy, c1z * sy, a2x * sz, a2y * sz, a2z * sz, c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8]);
  }
  function pushBeam(g, x1, y1, z1, x2, y2, z2, w, h, c, alongY) {
    let dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const L = Math.hypot(dx, dy, dz) || 1e-4; dx /= L; dy /= L; dz /= L;
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(dy) > 0.95) { ux = 1; uy = 0; }
    let xx = uy * dz - uz * dy, xy = uz * dx - ux * dz, xz = ux * dy - uy * dx;
    const xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
    const yx = dy * xz - dz * xy, yy = dz * xx - dx * xz, yz = dx * xy - dy * xx;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, mz = (z1 + z2) / 2;
    if (alongY) pushBasis(g, mx, my, mz, xx * w, xy * w, xz * w, dx * L, dy * L, dz * L, yx * h, yy * h, yz * h, c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8]);
    else pushBasis(g, mx, my, mz, xx * w, xy * w, xz * w, yx * h, yy * h, yz * h, dx * L, dy * L, dz * L, c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8]);
  }

  /* ----- 静态场景：按 16 米一块分区，每块带包围盒，绘制时做视锥裁剪 + 由近到远排序 ----- */
  let stMain = null, stDetail = null;
  function beginStatic() { stMain = mkBuckets(); stDetail = mkBuckets(); cur = stMain; setLayer(0); anim(); }
  // 小装饰物（管线、箱子、碎石…）单独存放，远处不画
  function setDetail(on) { if (stMain) cur = on ? stDetail : stMain; }
  const CH = 16;
  function endStatic() {
    const batch = [];
    const split = (st, detail) => {
      for (let m = 0; m < 3; m++) for (const g of GN) {
        const bk = st[0][m][g]; if (!bk || !bk.n) continue;
        const A = bk.arr, cells = new Map();
        const ringK = g === 'ring' || g === 'disc' ? 2.2 : 1.05;
        for (let i = 0; i < bk.n; i++) {
          const o = i * FLOATS;
          const ex = 0.5 * ringK * (Math.hypot(A[o], A[o + 1], A[o + 2]) + Math.hypot(A[o + 4], A[o + 5], A[o + 6]) + Math.hypot(A[o + 8], A[o + 9], A[o + 10]));
          const x = A[o + 12], y = A[o + 13], z = A[o + 14];
          const key = ex > CH ? 'big' : Math.floor(x / CH) + ',' + Math.floor(z / CH);
          let c = cells.get(key);
          if (!c) { c = { idx: [], box: [1e9, 1e9, 1e9, -1e9, -1e9, -1e9], big: key === 'big' }; cells.set(key, c); }
          c.idx.push(i);
          const b = c.box;
          if (x - ex < b[0]) b[0] = x - ex; if (y - ex < b[1]) b[1] = y - ex; if (z - ex < b[2]) b[2] = z - ex;
          if (x + ex > b[3]) b[3] = x + ex; if (y + ex > b[4]) b[4] = y + ex; if (z + ex > b[5]) b[5] = z + ex;
        }
        for (const c of cells.values()) {
          const data = new Float32Array(c.idx.length * FLOATS);
          c.idx.forEach((i, k) => data.set(A.subarray(i * FLOATS, (i + 1) * FLOATS), k * FLOATS));
          const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
          const b = c.box;
          batch.push({ mode: m, g, buf, n: c.idx.length, box: c.big ? null : b, cx: (b[0] + b[3]) / 2, cz: (b[2] + b[5]) / 2, detail, d: 0 });
        }
      }
    };
    split(stMain, false); split(stDetail, true);
    cur = dyn; stMain = stDetail = null;
    return batch;
  }
  /* ----- 视锥：从 VP 矩阵取 6 个平面，物体 / 分块不在视野内就不画 ----- */
  const FR = new Float32Array(24);
  function setFrustum(m) {
    const rows = [[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]], [m[2], m[6], m[10], m[14]], [m[3], m[7], m[11], m[15]]];
    const pl = [[3, 0, 1], [3, 0, -1], [3, 1, 1], [3, 1, -1], [3, 2, 1], [3, 2, -1]];
    pl.forEach(([a, b, sg], i) => {
      const x = rows[a][0] + sg * rows[b][0], y = rows[a][1] + sg * rows[b][1], z = rows[a][2] + sg * rows[b][2], w = rows[a][3] + sg * rows[b][3];
      const L = Math.hypot(x, y, z) || 1;
      FR[i * 4] = x / L; FR[i * 4 + 1] = y / L; FR[i * 4 + 2] = z / L; FR[i * 4 + 3] = w / L;
    });
  }
  function inView(x, y, z, r) {
    for (let i = 0; i < 24; i += 4) if (FR[i] * x + FR[i + 1] * y + FR[i + 2] * z + FR[i + 3] < -r) return false;
    return true;
  }
  function boxInView(b) {
    for (let i = 0; i < 24; i += 4) {
      const px = FR[i] >= 0 ? b[3] : b[0], py = FR[i + 1] >= 0 ? b[4] : b[1], pz = FR[i + 2] >= 0 ? b[5] : b[2];
      if (FR[i] * px + FR[i + 1] * py + FR[i + 2] * pz + FR[i + 3] < 0) return false;
    }
    return true;
  }

  const stream = {}; for (const g of GN) stream[g] = gl.createBuffer();
  function drawBucket(g, data, n, buf, isStatic) {
    const G = geoms[g];
    gl.bindVertexArray(G.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    if (!isStatic) gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * FLOATS), gl.STREAM_DRAW);
    for (let k = 0; k < 6; k++) gl.vertexAttribPointer(2 + k, 4, gl.FLOAT, false, FLOATS * 4, k * 16);
    gl.vertexAttribPointer(11, 4, gl.FLOAT, false, FLOATS * 4, 24 * 4);
    gl.bindTexture(gl.TEXTURE_2D, G.tex);
    stats.verts += G.count * n; if (stats.byG) stats.byG[g] = (stats.byG[g] || 0) + G.count * n;
    if (G.indexed) gl.drawElementsInstanced(gl.TRIANGLES, G.count, G.itype, 0, n);
    else gl.drawArraysInstanced(gl.TRIANGLES, 0, G.count, n);
  }

  /* ----- 后期渲染目标 ----- */
  function mkTex(w, h) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    if (halfOK) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, fb, w, h };
  }
  function freeTarget(T) { if (!T) return; gl.deleteTexture(T.t); gl.deleteFramebuffer(T.fb); }
  function ensureTargets(w, h) {
    if (post.w === w && post.h === h && post.ms) return true;
    try {
      if (post.ms) { gl.deleteFramebuffer(post.ms.fb); gl.deleteRenderbuffer(post.ms.c); gl.deleteRenderbuffer(post.ms.d); }
      [post.scene, post.a, post.b, post.c, post.d].forEach(freeTarget);
      const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0);
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      const c = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, c);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, halfOK ? gl.RGBA16F : gl.RGBA8, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, c);
      const d = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, d);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, d);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('MSAA 帧缓冲不完整');
      post.ms = { fb, c, d };
      post.scene = mkTex(w, h);
      const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1), w4 = Math.max(1, w >> 2), h4 = Math.max(1, h >> 2);
      post.a = mkTex(w2, h2); post.b = mkTex(w2, h2); post.c = mkTex(w4, h4); post.d = mkTex(w4, h4);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('后期帧缓冲不完整');
      post.w = w; post.h = h;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return true;
    } catch (e) {
      console.warn('关闭泛光：', e.message); postOn = false; post = null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return false;
    }
  }
  function pass(prog, target, setup) {
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : canvas.width, target ? target.h : canvas.height);
    setup(prog.U);
    gl.bindVertexArray(post.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function blur(src, tmp, dst) {
    pass(post.blur, tmp, U2 => { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.t); gl.uniform1i(U2.uTex, 0); gl.uniform2f(U2.uDir, 1 / src.w, 0); });
    pass(post.blur, dst, U2 => { gl.bindTexture(gl.TEXTURE_2D, tmp.t); gl.uniform1i(U2.uTex, 0); gl.uniform2f(U2.uDir, 0, 1 / tmp.h); });
  }

  const LP = new Float32Array(48), LC = new Float32Array(36);
  let stats = { draws: 0, inst: 0, post: false };
  function flush(cam, staticList) {
    const w = canvas.width, h = canvas.height;
    const usePost = postOn && post && ensureTargets(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, usePost ? post.ms.fb : null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(cam.fog[0], cam.fog[1], cam.fog[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(main.p);
    gl.uniformMatrix4fv(U.uVP, false, cam.vp);
    gl.uniform3fv(U.uEye, cam.eye); gl.uniform3fv(U.uSky, cam.sky); gl.uniform3fv(U.uGround, cam.ground);
    gl.uniform3fv(U.uSunDir, cam.sunDir); gl.uniform3fv(U.uSunCol, cam.sunCol); gl.uniform3fv(U.uFogCol, cam.fog);
    gl.uniform1f(U.uFogD, cam.fogD);
    gl.uniform1f(U.uEmit, usePost ? 2.4 : 1.5);
    gl.uniform1f(U.uDetail, cam.detail === undefined ? 1 : cam.detail);
    gl.uniform1i(U.uBones, 0); gl.activeTexture(gl.TEXTURE0);
    const nl = Math.min(12, cam.lights.length);
    for (let i = 0; i < nl; i++) {
      const L = cam.lights[i];
      LP[i * 4] = L.x; LP[i * 4 + 1] = L.y; LP[i * 4 + 2] = L.z; LP[i * 4 + 3] = L.r;
      LC[i * 3] = L.c[0] * L.i; LC[i * 3 + 1] = L.c[1] * L.i; LC[i * 3 + 2] = L.c[2] * L.i;
    }
    gl.uniform1i(U.uNL, nl); gl.uniform4fv(U.uLP, LP); gl.uniform3fv(U.uLC, LC);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    stats.draws = 0; stats.inst = 0; stats.culled = 0; stats.verts = 0; stats.byG = window.__vstat ? {} : null; stats.post = usePost;
    for (let L = 0; L < 2; L++) {
      if (L === 1) gl.clear(gl.DEPTH_BUFFER_BIT);
      for (let m = 0; m < 3; m++) {
        if (m === 0) { gl.disable(gl.BLEND); gl.depthMask(true); }
        else { gl.enable(gl.BLEND); gl.depthMask(false); if (m === 1) gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); else gl.blendFunc(gl.SRC_ALPHA, gl.ONE); }
        if (L === 0 && staticList) {
          // 不透明分块由近到远画（早期深度测试能省掉大量被挡住的像素）；透明 / 叠加分块保持原顺序
          const vis = [];
          const ex = cam.eye[0], ez = cam.eye[2], dd = cam.detailDist || 60;
          for (const batch of staticList) for (const it of batch) {
            if (it.mode !== m) continue;
            if (it.box) {
              if (!boxInView(it.box)) { stats.culled++; continue; }
              const dx = Math.max(it.box[0] - ex, 0, ex - it.box[3]), dz = Math.max(it.box[2] - ez, 0, ez - it.box[5]);
              it.d = Math.hypot(dx, dz);
              if (it.detail && it.d > dd) { stats.culled++; continue; }
            } else it.d = 1e9;
            vis.push(it);
          }
          if (m === 0) vis.sort((a, b) => a.d - b.d);
          for (const it of vis) { drawBucket(it.g, null, it.n, it.buf, true); stats.draws++; stats.inst += it.n; }
        }
        for (const g of GN) {
          const bk = dyn[L][m][g];
          if (bk.n) { drawBucket(g, bk.arr, bk.n, stream[g], false); stats.draws++; stats.inst += bk.n; bk.n = 0; }
        }
      }
    }
    gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
    if (usePost) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, post.ms.fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, post.scene.fb);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE0);
      pass(post.bright, post.a, U2 => { gl.bindTexture(gl.TEXTURE_2D, post.scene.t); gl.uniform1i(U2.uTex, 0); gl.uniform2f(U2.uTx, 0.5 / w, 0.5 / h); gl.uniform1f(U2.uThr, cam.bloomThr || 0.95); });
      blur(post.a, post.b, post.a);
      pass(post.blur, post.c, U2 => { gl.bindTexture(gl.TEXTURE_2D, post.a.t); gl.uniform1i(U2.uTex, 0); gl.uniform2f(U2.uDir, 0, 0); });
      blur(post.c, post.d, post.c);
      blur(post.c, post.d, post.c);
      pass(post.comp, null, U2 => {
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, post.scene.t); gl.uniform1i(U2.uScene, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, post.a.t); gl.uniform1i(U2.uB1, 1);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, post.c.t); gl.uniform1i(U2.uB2, 2);
        gl.uniform1f(U2.uBloom, cam.bloom === undefined ? 0.9 : cam.bloom); gl.uniform1f(U2.uVig, cam.vig === undefined ? 0.9 : cam.vig);
        const tn = cam.tint || [0, 0, 0, 0];
        gl.uniform3f(U2.uTint, tn[0], tn[1], tn[2]); gl.uniform1f(U2.uTintA, tn[3]);
      });
      gl.activeTexture(gl.TEXTURE0);
      gl.bindVertexArray(null);
    }
  }

  return {
    gl, geoms, push, pushR, pushBeam, pushBasis, setLayer, beginStatic, endStatic, setDetail, setFrustum, inView, boxInView, flush, addMesh, anim,
    stats: () => stats, postAvailable: () => !!post, setPost: v => { postOn = !!v && !!post; }, postOn: () => postOn,
  };
}

/* ---------- 矩阵 ---------- */
function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect; out[5] = f; out[10] = (far + near) / (near - far); out[11] = -1; out[14] = 2 * far * near / (near - far);
  return out;
}
function viewFPS(out, ex, ey, ez, yaw, pitch) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const fx = -sy * cp, fy = sp, fz = -cy * cp;
  const rx = cy, ry = 0, rz = -sy;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  out[0] = rx; out[4] = ry; out[8] = rz; out[12] = -(rx * ex + ry * ey + rz * ez);
  out[1] = ux; out[5] = uy; out[9] = uz; out[13] = -(ux * ex + uy * ey + uz * ez);
  out[2] = -fx; out[6] = -fy; out[10] = -fz; out[14] = fx * ex + fy * ey + fz * ez;
  out[3] = 0; out[7] = 0; out[11] = 0; out[15] = 1;
  return out;
}
function mul(out, a, b) {
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return out;
}

root.Engine = { create, perspective, viewFPS, mul };
})(typeof window !== 'undefined' ? window : globalThis);

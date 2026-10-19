// ─────────────────────────────────────────────
// Frame player: pre-rendered Blender turntables + real-time lighting.
//
// Each frame is one WebP sheet holding 5 light passes + an alpha mask (see
// tools/render/pack_frames.py). Light adds linearly, so the fragment shader
// recombines the passes with per-chapter colors and live intensities:
//   • key lights (top softbox, left/right strips) take the chapter's core color
//   • the rim light takes the chapter's halo color
//   • the cursor shifts weight between the left and right strips, so highlights
//     appear to slide across the metal, like tilting a watch under a lamp
// Adjacent frames cross-fade, so the ±40° turn feels continuous.
// Then AgX tone mapping (same curve family as Blender's AgX) → screen.
// ─────────────────────────────────────────────

const TURN = {   // same feel as the live 3D turntable
  limit: 0.7, sensitivity: 0.004, friction: 3.2, spring: 45, edgeResist: 0.35, smooth: 14, maxThrow: 1.5,
};
const RING = matchMedia("(max-width: 860px)").matches ? 5 : 8;   // decoded frames kept around the current one

const registry = (window.__luma ??= { viewers: [] });
const loads = [];
function reportProgress() {
  const p = loads.reduce((a, l) => a + (l.done ? 1 : l.p), 0) / Math.max(1, loads.length);
  dispatchEvent(new CustomEvent("luma:progress", { detail: { p } }));
  if (loads.every((l) => l.done)) { window.__lumaModelsReady = true; dispatchEvent(new Event("luma:models-ready")); }
}

const VERT = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D A, B;          // two neighbouring frame sheets
uniform float t;                 // cross-fade 0..1 between them
uniform vec3 cTop, cLeft, cRight, cRim, cEnv;   // light color * intensity (linear)
uniform float exposure;

vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 cell(sampler2D T, float col, float row) {   // sheet is 3x2; row 1 = top row of the image
  return srgbToLinear(texture(T, vec2((col + uv.x) / 3.0, (row + uv.y) / 2.0)).rgb);
}
vec4 shade(sampler2D T) {
  vec3 c = cell(T, 0., 1.) * cTop + cell(T, 1., 1.) * cLeft + cell(T, 2., 1.) * cRight
         + cell(T, 0., 0.) * cRim + cell(T, 1., 0.) * cEnv;
  float a = texture(T, vec2((2.0 + uv.x) / 3.0, uv.y / 2.0)).r;
  return vec4(c, a);
}

// AgX (as in three.js): soft highlight roll-off, deep blacks stay black
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 color) {
  const mat3 toRec2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 fromRec2020 = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
                          vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
                          vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
                           vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
                           vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  color = inset * (toRec2020 * color);
  color = clamp((log2(max(color, 1e-10)) + 12.47393) / 16.500, 0.0, 1.0);
  color = outset * agxContrast(color);
  color = pow(max(color, 0.0), vec3(2.2));
  return clamp(fromRec2020 * color, 0.0, 1.0);
}

void main() {
  vec4 m = mix(shade(A), shade(B), t);
  float a = clamp(m.a, 0.0, 1.0);
  vec3 c = agx(m.rgb / max(a, 1e-4) * exposure);           // tone-map the un-premultiplied color
  // "Punchy" look (like Blender's AgX - Punchy): a little more saturation and contrast
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = clamp(mix(vec3(l), c, 1.25), 0.0, 1.0);
  c = clamp((c - 0.5) * 1.08 + 0.5, 0.0, 1.0);
  c = pow(c, vec3(1.0 / 2.2));                               // to display (sRGB-ish)
  o = vec4(c * a, a);                                        // premultiplied for the page behind
}`;

function cssRgb(el, prop, fallback) {
  const v = getComputedStyle(el).getPropertyValue(prop).trim() || fallback;
  const [r, g, b] = v.split(",").map((x) => +x / 255);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const m = Math.max(lin(r), lin(g), lin(b), 1e-4);
  return [lin(r) / m, lin(g) / m, lin(b) / m];   // hue only; brightness comes from the intensity
}

function createPlayer(stage) {
  const base = stage.dataset.frames.replace(/\/$/, "");
  const load = { p: 0, done: false };
  loads.push(load);
  const stats = { name: stage.closest("section")?.id ?? "stage", url: base, loadMs: null, bytes: 0,
    visible: false, failed: false, info: { triangles: 0, calls: 0, textures: 0, geometries: 0 } };
  registry.viewers.push({ stats });

  const canvas = document.createElement("canvas");
  canvas.className = "watch-canvas";
  stage.appendChild(canvas);
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false });
  if (!gl) { stats.failed = true; load.done = true; reportProgress(); return; }

  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog); gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(prog, n);
  gl.uniform1i(U("A"), 0); gl.uniform1i(U("B"), 1);

  // Chapter light colors from the page theme (style.css: --core-rgb / --halo-rgb)
  const core = cssRgb(stage, "--core-rgb", "236, 232, 225");
  const halo = cssRgb(stage, "--halo-rgb", "74, 104, 138");

  // ─── Loading: fetch every frame (center first, then outward); decode a ring around the view ───
  let N = 0, center = 0;
  const blobs = [];            // compressed frames (small)
  const tex = new Map();       // frame index → { t: WebGLTexture, used: time }
  const decoding = new Set();
  const t0 = performance.now();

  async function decode(i) {
    if (tex.has(i) || decoding.has(i) || !blobs[i]) return;
    decoding.add(i);
    try {
      // flip at decode: browsers ignore UNPACK_FLIP_Y_WEBGL for ImageBitmap uploads
      const bmp = await createImageBitmap(blobs[i], { imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" });
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      bmp.close();
      tex.set(i, { t, used: performance.now() });
      dirty = 2;
      // keep GPU memory bounded: drop the frames farthest from the current view
      while (tex.size > RING * 2 + 1) {
        let far = -1, farD = -1;
        for (const k of tex.keys()) { const d = Math.abs(k - pos); if (d > farD) { farD = d; far = k; } }
        gl.deleteTexture(tex.get(far).t); tex.delete(far);
      }
      stats.info.textures = tex.size;
    } finally { decoding.delete(i); }
  }
  function prefetchAround(f) {
    const c = Math.round(f);
    for (let d = 0; d <= RING; d++) { decode(c + d); decode(c - d); }
  }

  fetch(`${base}/manifest.json`).then((r) => r.json()).then(async (m) => {
    N = m.frames; center = (N - 1) / 2; pos = center;
    const order = [...Array(N).keys()].sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
    let got = 0;
    await Promise.all(order.map(async (i, k) => {
      await new Promise((r) => setTimeout(r, k * 15));       // stagger: center frames go first
      const b = await fetch(`${base}/f${String(i).padStart(2, "0")}.webp`).then((r) => r.blob());
      blobs[i] = b; stats.bytes += b.size; got++;
      load.p = got / N;
      if (i === Math.round(center)) { await decode(i); stage.classList.add("loaded"); }
      if (got >= Math.min(N, 9) && !load.done) { load.done = true; stats.loadMs = Math.round(performance.now() - t0); }
      reportProgress();
      prefetchAround(pos);
    }));
  }).catch((e) => { console.error("Frames failed:", e); stats.failed = true; load.done = true; reportProgress(); });

  // ─── Drag input + turntable physics (same as the 3D viewer) ───
  let yaw = 0, shown = 0, vel = 0, dragging = false, lastX = 0, lastT = 0, pos = 0;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true; lastX = e.clientX; lastT = performance.now(); vel = 0;
    canvas.setPointerCapture(e.pointerId); stage.classList.add("touched");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const now = performance.now(), dt = Math.max(1, now - lastT) / 1000;
    let d = (e.clientX - lastX) * TURN.sensitivity;
    if (Math.abs(yaw) > TURN.limit && Math.sign(d) === Math.sign(yaw)) d *= TURN.edgeResist;
    yaw += d; vel = vel * 0.6 + (d / dt) * 0.4; lastX = e.clientX; lastT = now;
  });
  const release = () => {
    dragging = false;
    if (performance.now() - lastT > 80) vel = 0;
    vel = Math.max(-TURN.maxThrow, Math.min(TURN.maxThrow, vel));
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  // ─── Live light: the cursor's position over the chapter tilts the light left/right ───
  let lightX = 0, lightTarget = 0;
  stage.closest("section").addEventListener("pointermove", (e) => {
    const r = stage.getBoundingClientRect();
    lightTarget = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
  });

  function step(dt) {
    if (!dragging) {
      yaw += vel * dt; vel *= Math.exp(-TURN.friction * dt);
      const over = Math.abs(yaw) - TURN.limit;
      if (over > 0) { vel += -Math.sign(yaw) * over * TURN.spring * dt; vel *= Math.exp(-6 * dt); }
      if (Math.abs(vel) < 0.002) vel = 0;
    }
    shown += (yaw - shown) * (1 - Math.exp(-TURN.smooth * dt));
    lightX += (lightTarget - lightX) * (1 - Math.exp(-3 * dt));   // slow, soft light drift
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dpr = Math.min(devicePixelRatio, 2);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    dirty = 2;
  }
  new ResizeObserver(resize).observe(canvas);

  function nearestReady(i) {
    for (let d = 0; d < N; d++) { if (tex.has(i - d)) return i - d; if (tex.has(i + d)) return i + d; }
    return -1;
  }

  let visible = false, dirty = 2, last = 0, lastPos = -1, lastLight = 9;
  function frame(now) {
    if (!visible) return;
    const dt = Math.min((now - last) / 1000 || 0.016, 0.05); last = now;
    step(dt);
    if (N) {
      pos = Math.max(0, Math.min(N - 1, center + (shown / TURN.limit) * center));
      prefetchAround(pos);
    }
    const moved = Math.abs(pos - lastPos) > 1e-3 || Math.abs(lightX - lastLight) > 1e-3;
    if ((moved || dirty > 0) && N) {
      const i0 = Math.floor(pos), i1 = Math.min(N - 1, i0 + 1);
      const a = nearestReady(i0), b = tex.has(i1) ? i1 : a;
      if (a >= 0) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        // square image, centered and fitted inside the canvas
        const s = Math.min(canvas.width, canvas.height);
        gl.viewport((canvas.width - s) / 2, (canvas.height - s) / 2, s, s);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex.get(a).t);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex.get(b).t);
        gl.uniform1f(U("t"), a === i0 && b === i1 ? pos - i0 : 0);
        const k = lightX * 0.55;                                    // ±55% balance between strips
        const mul = (c, s) => c.map((x) => x * s);
        gl.uniform3fv(U("cTop"), mul(core, 1.0));
        gl.uniform3fv(U("cLeft"), mul(core, 1.0 - k));
        gl.uniform3fv(U("cRight"), mul(core, 1.0 + k));
        gl.uniform3fv(U("cRim"), mul(halo, 1.4));
        gl.uniform3fv(U("cEnv"), [1, 1, 1]);
        gl.uniform1f(U("exposure"), 4.0 * (+stage.dataset.exposure || 1));   // undo the -2 EV render headroom
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        lastPos = pos; lastLight = lightX; if (dirty > 0) dirty--;
      }
    }
    requestAnimationFrame(frame);
  }
  new IntersectionObserver(([e]) => {
    const was = visible;
    visible = stats.visible = e.isIntersecting;
    if (visible && !was) { last = performance.now(); dirty = 2; requestAnimationFrame(frame); }
  }).observe(stage);
}

document.querySelectorAll(".chapter-stage[data-frames]").forEach(createPlayer);
reportProgress();

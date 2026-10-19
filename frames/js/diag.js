// ─────────────────────────────────────────────
// Diagnostics overlay. Loaded only when the URL has ?diag (see main.js).
// Shows: FPS + frame times (with a small graph), page/intro timing,
// per-model load time, size and GPU stats, device info and memory.
// ─────────────────────────────────────────────
(() => {
  const panel = document.createElement("aside");
  panel.className = "diag";
  panel.innerHTML = `
    <header><b>DIAG</b><button type="button" aria-label="Minimize">–</button></header>
    <canvas width="220" height="44"></canvas>
    <pre></pre>`;
  document.body.append(panel);

  const style = document.createElement("style");
  style.textContent = `
    .diag { position: fixed; left: 12px; bottom: 12px; z-index: 70; width: 244px;
      background: rgba(3,4,6,.88); color: #ece8e1; border: 1px solid rgba(236,232,225,.14);
      font: 11px/1.5 ui-monospace, Consolas, monospace; direction: ltr; text-align: left;
      backdrop-filter: blur(8px); padding: 8px 10px; }
    .diag header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; letter-spacing: .2em; }
    .diag button { background: none; border: 0; color: inherit; font: inherit; cursor: pointer; padding: 0 4px; }
    .diag canvas { display: block; width: 220px; height: 44px; margin-bottom: 6px; }
    .diag pre { margin: 0; white-space: pre-wrap; }
    .diag.min canvas, .diag.min pre { display: none; }
    .diag .bad { color: #ff6b6b; } .diag .warn { color: #e8c37a; } .diag .ok { color: #8fd19e; }`;
  document.head.append(style);
  panel.querySelector("button").onclick = () => panel.classList.toggle("min");

  // ─── Frame timing: our own rAF loop measures how often the browser paints ───
  const frames = [];            // frame durations (ms), last ~3 s
  let last = performance.now();
  (function tick(now) {
    frames.push(now - last); last = now;
    if (frames.length > 180) frames.shift();
    requestAnimationFrame(tick);
  })(last);

  const graph = panel.querySelector("canvas").getContext("2d");
  function drawGraph() {
    const W = 220, H = 44;
    graph.clearRect(0, 0, W, H);
    // guide lines at 60 fps (16.7 ms) and 30 fps (33.3 ms)
    graph.fillStyle = "rgba(236,232,225,.12)";
    for (const ms of [16.7, 33.3]) graph.fillRect(0, H - (ms / 50) * H, W, 1);
    const bw = W / 180;
    frames.forEach((ms, i) => {
      const h = Math.min(H, (ms / 50) * H);
      graph.fillStyle = ms > 33.4 ? "#ff6b6b" : ms > 17.5 ? "#e8c37a" : "#8fd19e";
      graph.fillRect(i * bw, H - h, Math.max(1, bw - .3), h);
    });
  }

  const pre = panel.querySelector("pre");
  const cls = (v, warn, bad, higherIsWorse = true) =>
    (higherIsWorse ? v >= bad : v <= bad) ? "bad" : (higherIsWorse ? v >= warn : v <= warn) ? "warn" : "ok";
  const ms = (v) => (v == null ? "—" : `${Math.round(v)} ms`);
  const mb = (b) => (b ? `${(b / 1048576).toFixed(1)} MB` : "—");

  // GPU name (where the browser allows it)
  let gpu = "—";
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    if (ext) gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL).replace(/ANGLE \(|\)$/g, "").slice(0, 42);
  } catch {}

  function render() {
    const recent = frames.slice(-60);
    const avg = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
    const fps = 1000 / avg;
    const sorted = [...frames].sort((a, b) => b - a);
    const low1 = 1000 / (sorted[Math.floor(sorted.length * 0.01)] || avg);   // "1% low" fps
    const worst = sorted[0] || 0;

    const nav = performance.getEntriesByType("navigation")[0] || {};
    const res = performance.getEntriesByType("resource");
    const transfer = res.reduce((a, r) => a + (r.transferSize || 0), 0);
    const t = window.__lumaTiming || {};
    const mem = performance.memory;

    const lines = [];
    lines.push(`FPS       <span class="${cls(fps, 50, 30, false)}">${fps.toFixed(0)}</span>  (1% low ${low1.toFixed(0)})`);
    lines.push(`frame     ${avg.toFixed(1)} ms  worst <span class="${cls(worst, 34, 60)}">${worst.toFixed(0)} ms</span>`);
    lines.push(``);
    lines.push(`TTFB      ${ms(nav.responseStart)}`);
    lines.push(`DOM ready ${ms(nav.domContentLoadedEventEnd)}`);
    lines.push(`load      ${ms(nav.loadEventEnd || null)}`);
    lines.push(`opened    <span class="${cls(t.opened || 0, 2500, 3500)}">${ms(t.opened)}</span>  (${t.how || "waiting"})`);
    lines.push(`requests  ${res.length}  ·  ${mb(transfer) === "—" ? "cached" : mb(transfer)}`);
    for (const { stats: s } of window.__luma?.viewers || []) {
      lines.push(``);
      lines.push(`▸ ${s.name}${s.failed ? ' <span class="bad">FAILED</span>' : ""}${s.visible ? "  ●" : ""}`);
      lines.push(`  model   ${mb(s.bytes)}  in <span class="${cls(s.loadMs ?? 99999, 1500, 3000)}">${ms(s.loadMs)}</span>`);
      lines.push(`  tris    ${s.info.triangles.toLocaleString()}  calls ${s.info.calls}`);
      lines.push(`  gpu mem ${s.info.textures} tex · ${s.info.geometries} geo`);
    }
    lines.push(``);
    lines.push(`viewport  ${innerWidth}×${innerHeight} @${devicePixelRatio}x`);
    if (mem) lines.push(`JS heap   ${mb(mem.usedJSHeapSize)} / ${mb(mem.jsHeapSizeLimit)}`);
    lines.push(`GPU       ${gpu}`);
    pre.innerHTML = lines.join("\n");
    drawGraph();
  }
  render();
  setInterval(render, 500);
})();

// ─────────────────────────────────────────────
// v1 base: navbar flare, chapter reveal, active nav link.
// ─────────────────────────────────────────────

// ─── Navbar flare ───
// The CSS reads --fx / --fy. Here we move them: they follow the mouse when it's near the bar,
// and drift slowly along the bar otherwise, so the light is always moving a little.
const nav = document.getElementById("nav");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

let target = { x: 0.3, y: 0 };   // where the flare wants to be (0–1 of the bar's size)
let pos = { x: 0.3, y: 0 };      // where it is now (eases toward target)
let mouseNear = false;

window.addEventListener("pointermove", (e) => {
  const r = nav.getBoundingClientRect();
  // "Near" = within 120px below the bar, so the light reacts before you reach it
  mouseNear = e.clientY < r.bottom + 120;
  if (mouseNear) {
    target.x = (e.clientX - r.left) / r.width;
    target.y = (e.clientY - r.top) / r.height;
  }
});

function tick(t) {
  if (!mouseNear) {
    // Idle drift: a slow sine across the bar, hugging the top edge
    target.x = 0.5 + Math.sin(t / 9000) * 0.38;
    target.y = 0;
  }
  // Ease 3.5% of the way each frame: a slow, calm follow instead of snapping
  pos.x += (target.x - pos.x) * 0.035;
  pos.y += (target.y - pos.y) * 0.035;
  nav.style.setProperty("--fx", `${pos.x * 100}%`);
  nav.style.setProperty("--fy", `${pos.y * 100}%`);
  requestAnimationFrame(tick);
}
if (!reduceMotion) requestAnimationFrame(tick);

// ─── Eased scrolling ───
// One scroll animation used everywhere (snap, logo, links), so all motion has the same feel.
// easeInOutCubic: starts gently, glides through the middle, settles softly.
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
let anim = null;   // the running scroll animation, if any

function glideTo(y, duration) {
  cancelGlide();
  const from = scrollY, dist = y - from;
  if (Math.abs(dist) < 2) return;
  if (reduceMotion) return scrollTo({ top: y, behavior: "instant" });
  // Longer distances take a little longer, within a calm 650–1100ms window
  const dur = duration ?? Math.min(1100, Math.max(650, Math.abs(dist) * 0.7));
  const start = performance.now();
  anim = { raf: 0 };
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    scrollTo({ top: from + dist * easeInOut(t), behavior: "instant" });
    if (t < 1) anim.raf = requestAnimationFrame(step);
    else anim = null;
  };
  anim.raf = requestAnimationFrame(step);
}
function cancelGlide() { if (anim) { cancelAnimationFrame(anim.raf); anim = null; } }

// Grabbing the scrollbar or touching the screen takes over from an animation in progress.
for (const ev of ["touchstart", "mousedown"]) addEventListener(ev, cancelGlide, { passive: true });

// ─── Chapter-by-chapter scrolling ───
const snapTargets = [...document.querySelectorAll(".chapter, .contact")];
const CHAPTER_GLIDE = 850;   // ms for one chapter step: one smooth motion, starts on the first wheel tick
const tops = () => snapTargets.map((s) => s.offsetTop);
const maxScroll = () => document.documentElement.scrollHeight - innerHeight;
const nearestIndex = (y) => tops().reduce((best, t, i, all) => (Math.abs(t - y) < Math.abs(all[best] - y) ? i : best), 0);

// A section much taller than the screen (phones, long contact page) scrolls normally
// inside itself; it only hands over to the next chapter once you reach its edge.
function canScrollInside(dir) {
  const vh = innerHeight, y = scrollY;
  const s = snapTargets.find((el) => y + vh / 2 >= el.offsetTop && y + vh / 2 < el.offsetTop + el.offsetHeight);
  if (!s || s.offsetHeight <= vh * 1.25) return false;
  return dir > 0 ? y + vh < s.offsetTop + s.offsetHeight - 2 : y > s.offsetTop + 2;
}

function step(dir) {
  const i = Math.max(0, Math.min(snapTargets.length - 1, nearestIndex(scrollY) + dir));
  glideTo(Math.min(tops()[i], maxScroll()), CHAPTER_GLIDE);
}

// Wheel / trackpad: the first tick of a scroll starts the glide immediately.
// Everything after that in the same gesture (including trackpad momentum, which keeps
// firing for a second or more) is absorbed, so one swipe = exactly one chapter.
let lastWheel = 0, prevAbs = 0, locked = false;
addEventListener("wheel", (e) => {
  if (e.ctrlKey) return;                       // pinch-zoom: leave it to the browser
  const now = performance.now(), quiet = now - lastWheel, abs = Math.abs(e.deltaY);
  lastWheel = now;
  const dir = Math.sign(e.deltaY);
  if (!dir || canScrollInside(dir)) { prevAbs = abs; return; }   // native scroll inside a tall section
  e.preventDefault();
  if (locked) {
    // Unlock when the glide is done AND this is a new gesture: a pause, or a fresh push
    // (momentum only ever decays, so a jump in strength means the user swiped again)
    const fresh = quiet > 180 || (abs > prevAbs * 1.6 && abs > 25);
    if (anim || !fresh) { prevAbs = abs; return; }
    locked = false;
  }
  prevAbs = abs;
  if (abs < 4) return;                         // ignore sensor noise and leftover momentum crumbs
  locked = true;
  step(dir);
}, { passive: false });

// Keyboard: arrows / Page keys / space move one chapter, Home/End jump to the ends
addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select, [contenteditable]")) return;
  const map = { ArrowDown: 1, PageDown: 1, " ": e.shiftKey ? -1 : 1, ArrowUp: -1, PageUp: -1 };
  if (e.key in map) {
    if (canScrollInside(map[e.key])) return;
    e.preventDefault();
    if (!anim) step(map[e.key]);
  } else if (e.key === "Home") { e.preventDefault(); glideTo(0, CHAPTER_GLIDE); }
  else if (e.key === "End") { e.preventDefault(); glideTo(maxScroll(), CHAPTER_GLIDE); }
});

// Touch and scrollbar dragging stay native (hijacking finger swipes feels bad on phones).
// When such a scroll ends, ease to the nearest chapter in the direction travelled.
let touchStartY = 0, idleTimer = 0, touching = false;
addEventListener("touchstart", () => { touching = true; touchStartY = scrollY; }, { passive: true });
addEventListener("touchend", () => { touching = false; scheduleSettle(); }, { passive: true });
addEventListener("scroll", () => {
  if (anim || performance.now() - lastWheel < 400) return;   // our glide, or a wheel scroll
  scheduleSettle();
}, { passive: true });
function scheduleSettle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (anim || touching || reduceMotion || performance.now() - lastWheel < 400) return;
    const y = scrollY, dir = Math.sign(y - touchStartY);
    if (canScrollInside(dir || 1)) return;
    const all = tops();
    const target = dir > 0 ? all.find((t) => t >= y - 2) : dir < 0 ? [...all].reverse().find((t) => t <= y + 2) : all[nearestIndex(y)];
    touchStartY = Math.min(target ?? y, maxScroll());
    glideTo(touchStartY);
  }, 120);
}

// ─── Logo = back to top; in-page links use the same glide ───
document.getElementById("logo").addEventListener("click", (e) => {
  e.preventDefault();
  glideTo(0);
  history.replaceState(null, "", location.pathname);   // drop any #hash from the URL
});
document.querySelectorAll('a[href^="#"]:not(#logo)').forEach((a) => {
  a.addEventListener("click", (e) => {
    const target = document.querySelector(a.getAttribute("href"));
    if (!target) return;
    e.preventDefault();
    glideTo(target.offsetTop);
  });
});

// ─── Load intro: wait for the models, then open ───
// The light line grows with download progress. The page opens once the 3D models are
// ready, but never earlier than MIN_LINE (so the line has time to draw) and never later
// than MAX_WAIT (a slow connection still gets a page; the watch fades in when it arrives).
const MIN_LINE = 700, MAX_WAIT = 2800;
const root = document.documentElement;
const introEl = document.querySelector(".intro");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
window.__lumaTiming = { start: performance.now() };

const setLine = (p) => introEl?.style.setProperty("--p", p.toFixed(3));
requestAnimationFrame(() => setLine(0.25));      // start drawing right away
addEventListener("luma:progress", (e) => setLine(0.25 + 0.75 * e.detail.p));

const modelsReady = new Promise((resolve) => {
  if (window.__lumaModelsReady) return resolve("ready");
  addEventListener("luma:models-ready", () => resolve("ready"), { once: true });
});

(async () => {
  let how = "reduced-motion";
  if (!reduceMotion) {
    [how] = await Promise.all([Promise.race([modelsReady, sleep(MAX_WAIT).then(() => "timeout")]), sleep(MIN_LINE)]);
    setLine(1);
    await sleep(350);                             // let the line reach full width before opening
  }
  root.classList.add("opened");
  playWoosh();
  Object.assign(window.__lumaTiming, { opened: performance.now(), how });
  setTimeout(() => introEl?.remove(), 1500);
  setTimeout(() => chapters.forEach((s) => io.observe(s)), reduceMotion ? 0 : 450);
})();

// ─── Opening sound: a soft "woosh" as the halves part ───
// Synthesized (no audio file): filtered noise whose pitch rises and falls while it drifts
// slightly left→right, at low volume. Plays once per browser session.
// Browsers block sound until the visitor has interacted with the site, so on a cold first
// visit it may stay silent. We never play it late: if audio isn't allowed right now, skip it.
function playWoosh() {
  try {
    if (reduceMotion || sessionStorage.getItem("luma-woosh")) return;
    sessionStorage.setItem("luma-woosh", "1");
  } catch { /* storage blocked: still fine to try once */ }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state !== "running") { ctx.close(); return; }   // autoplay blocked: stay silent
    const t = ctx.currentTime, dur = 1.5;
    const noise = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = noise;

    const band = ctx.createBiquadFilter();     // the "air": a band of noise sweeping up then down
    band.type = "bandpass"; band.Q.value = 0.9;
    band.frequency.setValueAtTime(320, t);
    band.frequency.exponentialRampToValueAtTime(1600, t + 0.6);
    band.frequency.exponentialRampToValueAtTime(420, t + dur);

    const gain = ctx.createGain();              // quiet swell and a long soft tail
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.045, t + 0.55);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    const pan = ctx.createStereoPanner();      // a gentle drift across the stereo field
    pan.pan.setValueAtTime(-0.25, t);
    pan.pan.linearRampToValueAtTime(0.25, t + dur);

    src.connect(band).connect(gain).connect(pan).connect(ctx.destination);
    src.start(t);
    src.stop(t + dur);
    src.onended = () => ctx.close();
  } catch { /* no Web Audio: no sound, nothing else changes */ }
}

// ─── Chapters: reveal on scroll (observing starts once the intro opens) ───
const chapters = [...document.querySelectorAll(".chapter")];
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) e.target.classList.add("in-view");
}, { threshold: 0.15 });

// ─── Diagnostics overlay: open the site with ?diag ───
if (new URLSearchParams(location.search).has("diag")) {
  const s = document.createElement("script");
  s.src = "js/diag.js";
  document.body.append(s);
}

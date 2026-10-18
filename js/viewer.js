// ─────────────────────────────────────────────
// Real-time 3D viewer for a .glb watch model.
// Any .chapter-stage with data-model="path.glb" gets a viewer.
// Lighting is tuned to the site palette: ceramic-white key light + cool steel rim.
// ─────────────────────────────────────────────
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// ─── Turntable feel ───
// The watch only turns left/right, like on a jeweller's turntable.
// Drag sets the angle, letting go keeps the motion gliding (inertia), friction slows it,
// and a soft spring brings it back if it passes the edge. No up/down, no idle wobble.
const TURN = {
  limit: 0.7,        // ±40° either way
  sensitivity: 0.004,// radians per dragged pixel
  friction: 3.2,     // higher = stops sooner; glide distance ≈ throw speed / friction
  spring: 45,        // pull-back strength past the limit
  edgeResist: 0.35,  // dragging past the limit moves at 35% speed (rubber-band)
  smooth: 14,        // displayed angle eases toward the real one, for a silky feel
  tilt: -0.12,       // fixed forward tilt, reads more natural than dead-on
  maxThrow: 1.5,     // top spin speed after letting go (rad/s) → at most ~27° of glide
};

// ─── Shared registry: loading progress for the intro, stats for /?diag ───
const registry = (window.__luma ??= { viewers: [] });
const loads = [];   // one { loaded, total, done } per model
function reportProgress() {
  const p = loads.reduce((a, l) => a + (l.done ? 1 : l.total ? l.loaded / l.total : 0), 0) / Math.max(1, loads.length);
  dispatchEvent(new CustomEvent("luma:progress", { detail: { p } }));
  if (loads.every((l) => l.done)) {
    window.__lumaModelsReady = true;
    dispatchEvent(new Event("luma:models-ready"));
  }
}

// /?tempdes: hook for future experiments (nothing gated on it right now)
const TEMPDES = document.documentElement.classList.contains("tempdes");
// Render quality: "demo" = sharp but not wasteful (AA on, up to 1.5x pixel density);
// add ?low to the URL to check how the page behaves on a weak device.
const LOW_QUALITY = new URLSearchParams(location.search).has("low");
const MAX_DPR = LOW_QUALITY ? 0.85 : 1.5;

// KHR_materials_variants: one model file can carry several material sets ("variants").
// three.js loads the default set; this swaps every mesh to the named variant's materials.
async function applyVariant(gltf, name) {
  const ext = gltf.userData.gltfExtensions?.KHR_materials_variants;
  const index = ext?.variants.findIndex((x) => x.name === name) ?? -1;
  if (index < 0) return;
  const jobs = [];
  gltf.scene.traverse((obj) => {
    const mapping = obj.isMesh && obj.userData.gltfExtensions?.KHR_materials_variants?.mappings
      .find((m) => m.variants.includes(index));
    if (mapping) jobs.push(gltf.parser.getDependency("material", mapping.material).then((mat) => {
      obj.material = mat;
      gltf.parser.assignFinalMaterial(obj);
    }));
  });
  await Promise.all(jobs);
}

// Recolor the strap and case frame (by material name), to match a chapter's theme
function applyTint(root, hex) {
  const tint = new THREE.Color(hex);
  root.traverse((obj) => {
    if (!obj.isMesh || !/Band|Bezel/i.test(obj.material.name)) return;
    obj.material = obj.material.clone();
    obj.material.color.copy(tint);
  });
}

// Read an "r, g, b" CSS custom property (set per chapter in style.css) as a THREE.Color
function cssColor(el, prop, fallback) {
  const v = getComputedStyle(el).getPropertyValue(prop).trim();
  return new THREE.Color(v ? `rgb(${v})` : fallback);
}

// Some models are Draco-compressed (much smaller files). The decoder is fetched only when needed.
const draco = new DRACOLoader().setDecoderPath("https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/gltf/");
const loader = new GLTFLoader().setDRACOLoader(draco);

function createViewer(stage) {
  const load = { loaded: 0, total: 0, done: false };
  loads.push(load);
  const stats = {
    name: stage.closest("section")?.id ?? "stage",
    url: stage.dataset.model, loadMs: null, bytes: 0, visible: false, failed: false,
    info: { triangles: 0, calls: 0, textures: 0, geometries: 0 },
  };
  const canvas = document.createElement("canvas");
  canvas.className = "watch-canvas";
  stage.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LOW_QUALITY, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_DPR));
  renderer.toneMappingExposure = 1.08;   // a touch brighter: metal reads cleaner on black
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  // Environment = what the metal reflects. A neutral studio room, kept dim so the page stays black.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 1.0;   // (r163+ only; older versions ignore it harmlessly)

  // Ceramic key light from the upper front, steel rim light from behind: matches the page's light
  // Light colors come from the chapter's CSS theme, so the 3D light matches the page light
  const coreColor = cssColor(stage, "--core-rgb", "#ece8e1");
  const haloColor = cssColor(stage, "--halo-rgb", "#4a688a");
  const key = new THREE.DirectionalLight(coreColor, 1.3);
  key.position.set(-2, 3, 4);
  // Spotlight straight from above, matching the CSS light cone: soft-edged (penumbra 1)
  const spot = new THREE.SpotLight(coreColor, 6, 0, 0.42, 1, 0);
  spot.position.set(0, 6, 1.2);
  scene.add(spot, spot.target);
  const rim = new THREE.DirectionalLight(haloColor, 3.0);
  rim.position.set(3, -1, -4);
  scene.add(key, rim);

  // near/far hug the scene (camera ~6.4 units away, watch within ±1.5): a tight range gives the
  // depth buffer enough precision for thin, stacked dial layers. near=0.01 made them flicker (z-fighting).
  const camera = new THREE.PerspectiveCamera(26, 1, 2, 14);

  const pivot = new THREE.Group();   // the turntable: we rotate this around Y
  pivot.rotation.x = TURN.tilt;
  scene.add(pivot);
  let mixer = null;
  const clock = new THREE.Clock();

  const t0 = performance.now();
  loader.load(stats.url, async (gltf) => {
    const model = gltf.scene;
    if (stage.dataset.variant) await applyVariant(gltf, stage.dataset.variant);
    if (stage.dataset.tint) applyTint(model, stage.dataset.tint);
    // data-hide="floor,shadow": drop helper objects some models ship with (they'd break the auto-fit)
    for (const name of (stage.dataset.hide || "").split(",").filter(Boolean)) {
      model.getObjectByName(name.trim())?.removeFromParent();
    }
    // data-glass="glass": replace that mesh's material with a clear, reflective crystal
    // (additive blending = it only ever adds highlights, never hides the dial behind it)
    if (stage.dataset.glass) {
      const glass = model.getObjectByName(stage.dataset.glass);
      if (glass) glass.material = new THREE.MeshPhysicalMaterial({
        color: 0x020205, transparent: true, opacity: 0.35, metalness: 0, roughness: 0,
        clearcoat: 1, blending: THREE.AdditiveBlending, depthWrite: false,
      });
    }
    // data-no-vertex-colors: some exports carry vertex colors that wash the materials out to white
    if ("noVertexColors" in stage.dataset) {
      model.traverse((o) => { if (o.isMesh && o !== model.getObjectByName(stage.dataset.glass)) o.material.vertexColors = false; });
    }
    // Per-model fixes from HTML: data-rotate="x,y,z" (degrees) turns the dial to face us,
    // data-zoom="1.4" enlarges models whose bracelet makes the bounding box (and so the dial) look small
    if (stage.dataset.rotate) {
      const [rx, ry, rz] = stage.dataset.rotate.split(",").map((d) => THREE.MathUtils.degToRad(+d || 0));
      model.rotation.set(rx, ry, rz);
      model.updateMatrixWorld(true);
    }
    stats.loadMs = Math.round(performance.now() - t0);

    // Fit: center the model at the origin and scale it to a known size, whatever units it came in
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    const fit = (1.78 * (+stage.dataset.zoom || 1)) / Math.max(size.x, size.y, size.z);   // ~11% smaller: present, not bulky
    pivot.scale.setScalar(fit);
    pivot.add(model);
    pivot.position.y = 0.2;    // lift it so it stands above the CSS pedestal pool

    // Distance at which a 2.4-unit object fills ~80% of the view
    camera.position.set(0, 0, (2.4 / 0.8) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))));

    // The model ships with an animated second hand: play it
    if (gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      gltf.animations.forEach((clip) => mixer.clipAction(clip).play());
    }
    stage.classList.add("loaded");
    markDirty();
    renderer.compile(scene, camera);   // upload shaders/textures now, so the first visible frame doesn't stutter
    load.done = true; reportProgress();
  }, (xhr) => {
    load.loaded = xhr.loaded; load.total = xhr.total; stats.bytes = xhr.total || xhr.loaded;
    reportProgress();
  }, (err) => {
    console.error("Model failed to load:", err);
    stats.failed = true; load.done = true; reportProgress();   // don't hold the intro hostage
  });

  // ─── Drag input (pointer events cover mouse, touch and pen) ───
  let yaw = 0, shown = 0, vel = 0;        // angle, displayed angle, angular velocity (rad/s)
  let dragging = false, lastX = 0, lastT = 0;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true; lastX = e.clientX; lastT = performance.now(); vel = 0;
    canvas.setPointerCapture(e.pointerId);   // keep receiving moves even if the cursor leaves the canvas
    stage.classList.add("touched");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const now = performance.now(), dt = Math.max(1, now - lastT) / 1000;
    let d = (e.clientX - lastX) * TURN.sensitivity;
    if (Math.abs(yaw) > TURN.limit && Math.sign(d) === Math.sign(yaw)) d *= TURN.edgeResist;
    yaw += d;
    // Smoothed velocity: blends new movement in, so a jittery last frame doesn't decide the throw
    vel = vel * 0.6 + (d / dt) * 0.4;
    lastX = e.clientX; lastT = now;
  });
  const release = () => {
    dragging = false;
    if (performance.now() - lastT > 80) vel = 0;   // held still before letting go = no throw
    vel = THREE.MathUtils.clamp(vel, -TURN.maxThrow, TURN.maxThrow);   // even a hard throw stays graceful
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  function stepTurntable(dt) {
    if (!dragging) {
      yaw += vel * dt;
      vel *= Math.exp(-TURN.friction * dt);                 // friction
      const over = Math.abs(yaw) - TURN.limit;
      if (over > 0) {                                       // spring back from past the edge
        vel += -Math.sign(yaw) * over * TURN.spring * dt;
        vel *= Math.exp(-6 * dt);                           // extra damping so it doesn't bounce
      }
      if (Math.abs(vel) < 0.002) vel = 0;
    }
    shown += (yaw - shown) * (1 - Math.exp(-TURN.smooth * dt));
    pivot.rotation.y = shown;
  }

  function resize() {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    markDirty();
  }
  new ResizeObserver(resize).observe(canvas);

  // Render on demand: a resting watch doesn't change, so we skip drawing it. Only motion
  // (drag, glide, easing, animation) or a resize/load costs GPU time.
  let visible = false, dirty = 3;           // draw a few frames after load/resize to settle
  const markDirty = () => (dirty = Math.max(dirty, 2));
  function frame(t) {
    if (!visible) return;
    const dt = Math.min(clock.getDelta(), 0.05);   // clamp: a tab switch shouldn't cause a huge jump
    mixer?.update(dt);
    stepTurntable(dt);
    const moving = mixer || dragging || vel !== 0 || Math.abs(yaw - shown) > 1e-4;
    if (!moving && dirty <= 0) { requestAnimationFrame(frame); return; }
    if (!moving) dirty--;
    renderer.render(scene, camera);
    const r = renderer.info;
    stats.info = { triangles: r.render.triangles, calls: r.render.calls, textures: r.memory.textures, geometries: r.memory.geometries };
    requestAnimationFrame(frame);
  }
  // Only render while the stage is on screen
  new IntersectionObserver(([e]) => {
    const was = visible;
    visible = stats.visible = e.isIntersecting;
    if (visible && !was) { clock.getDelta(); markDirty(); requestAnimationFrame(frame); }
  }).observe(stage);

  registry.viewers.push({ stats, renderer, scene });   // scene exposed for /?diag and debugging
}

document.querySelectorAll(".chapter-stage[data-model]").forEach(createViewer);
reportProgress();   // no models on the page = ready immediately

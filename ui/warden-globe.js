/* warden-globe.js: Warden's orchestrator globe, drawn here, in three.js.
 *
 * ui/agent-globe.js draws Warden's motif FLATTENED to 2D, because a shaded WebGL planet would
 * fight a CRT terminal. Karim, 2026-08-20: "I really want the exact same three JS Warden globe
 * that we have." So this is the real one: not a tribute, a port. The geometry, the opacities,
 * the spin rates and the breathing wave are the numbers out of Warden's own files, copied
 * rather than re-derived, because the whole request was that it be the same object.
 *
 * WHAT IT DRAWS, and where each part comes from:
 *   the lattice   two additive icosahedron wireframes, an outer at radius 1 subdivided once
 *                 and an inner at 0.55, from web/viz/views/hud/HudGlobe.tsx.
 *   the cradle    two thin great-circle rings at radius 1.22, gyrating on different axes, from
 *                 web/viz/shared/scene/AgentCore.tsx. Warden's one bold move: a ringed,
 *                 governed body reads as the authority next to loose lattice moons.
 *   the heart     Claude's sunburst, twelve rays seated on the directions of an icosahedron's
 *                 vertices so the spark reads as a star from any orbit angle. Also AgentCore.
 *                 This app's agent IS Claude, so this is the honest mark rather than a choice.
 *   the halo      one additive radial sprite, from web/viz/views/hud/hudGlow.ts.
 *
 * NO BLOOM PASS, AND WARDEN DOES NOT HAVE ONE HERE EITHER. The war room gets its glow from a
 * real postprocessing pass. Warden's own small-canvas globe cannot: the canvas is transparent
 * so the panel behind it shows through, and an EffectComposer render target has no alpha to
 * give back. hudGlow.ts says exactly that, and answers it with the sprite this file draws. So
 * the halo here is not an approximation of Warden's bloom, it is the same answer Warden gives
 * on the same kind of surface.
 *
 * THE SAME PUBLIC SHAPE AS agent-globe.js, on purpose. create() returns start / stop / tune /
 * running and nothing else, so ui/driver-chat.js can mount either file without knowing which,
 * and a person who wants the flat globe back flips one word. `tune({rate, gain})` is still how
 * the panel says how hard the agent is working, and the two numbers land on Warden's own dials
 * rather than on new ones: see WORKING and liveness() below.
 *
 * WHAT IT COSTS, AND WHEN. three.js is 735 KB and it is NOT loaded by the script tag: it is
 * pulled in by dynamic import the first time a globe is actually started. A window with no
 * agent panel never pays for it, and neither does a browser that falls back to the 2D globe:
 * the probe below answers before the import is started, so nothing under /vendor is ever
 * fetched on a machine that cannot use it.
 *
 * The WebGL contexts are the honest cost, and there are two: one per canvas, taken at mount
 * by that same probe, held for the life of the window. A context handed back on every stop
 * cannot be reliably taken up again (the canvas keeps the lost one, and restoring it is
 * asynchronous and refusable), and a globe that comes back dead is worse than an idle
 * context on a page whose budget is about sixteen. What is NOT held is the work: one rAF per
 * running globe, dropped when the globe is stopped and when the tab is hidden, and
 * driver-chat.js guarantees exactly one of the two is ever turning.
 *
 * IT IS NOT A BUTTON AND IT IS NOT A CONTROL, the same rule agent-globe.js states: this file
 * draws, and does nothing else. It registers one listener, on visibilitychange, for the battery
 * reason above, and it is removed on stop.
 */

'use strict';

var PhosphorWardenGlobe = (function () {
  /* Vendored, pinned, local. See ui/vendor/README.md for the version, the hashes and where the
     files were copied from. Never a CDN: this app must run offline, and a remote script tag on
     a page that holds an approval button is a hole nobody would put there on purpose. */
  var THREE_URL = '/vendor/three.module.min.js';

  var loading = null; // the one in-flight import, shared by every globe on the page
  var THREE = null;

  function loadThree() {
    if (THREE) return Promise.resolve(THREE);
    if (!loading) {
      loading = import(THREE_URL).then(function (mod) {
        THREE = mod;
        return mod;
      });
    }
    return loading;
  }

  /* Can this canvas hold a WebGL context AT ALL. Asked on the real canvas with the attributes
     three is about to ask for, and asked SYNCHRONOUSLY, before create() returns: the caller
     needs a yes or no now so it can mount the 2D globe instead, and it cannot wait on an import
     to find out. A wallet app may never show an empty box because a GPU said no.

     The context this opens is the one three goes on to use. getContext with the same type hands
     back the context the canvas already has, so this is a probe and an acquisition in one call
     rather than a context spent to answer a question. */
  function canHoldWebgl(canvas) {
    var attrs = { alpha: true, antialias: true, powerPreference: 'high-performance' };
    try {
      return !!(canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs));
    } catch (err) {
      return false;
    }
  }

  // ── Warden's animation contract, verbatim ────────────────────────────────────────────────
  // web/viz/shared/scene/AgentCore.tsx. These two functions are what make the globe read as
  // working or resting, so they are copied rather than reinterpreted.

  /** Working roots get a slightly faster gyro cradle; idle roots stay calm. */
  function agentCoreSpinMultiplier(working) {
    return working ? 1.35 : 1;
  }

  /** Working roots breathe at the core; idle roots stay visually steady. */
  function agentCorePulseState(working, wave) {
    if (!working) return { heartScale: 1, ringScale: 1, glowMultiplier: 1 };
    var w = Math.max(-1, Math.min(1, wave));
    var crest = (w + 1) / 2;
    return {
      heartScale: 1.04 + w * 0.08,
      ringScale: 1.02 + w * 0.05,
      glowMultiplier: 1 + crest * 0.28,
    };
  }

  /* WHAT COUNTS AS WORKING, from the one number the panel hands over. Warden reads a status
     enum; this file is given a spin rate, and it must not grow a second input that only one of
     the two globes understands. 1 is the rate the idle globe has always turned at, so every
     setting ABOVE it is an agent doing something: driver-chat.js sends 2.4 while an answer is
     being written and 1.7 while the child comes up, and 0.5 while it waits. */
  var WORKING = 1;

  /* Warden's liveness band, mapped onto the panel's gain dial. hudLiveness() returns 1 for a
     working agent and 0.16 for an idle one (HudGlobe.tsx); driver-chat.js asks for 1.5 while
     the agent writes and 0.8 while it rests, and the panel-filling idle globe never tunes at
     all, so it sits at 1. Anchoring the two ends means `thinking` lands exactly on Warden's
     working body, and the resting states sit above Warden's idle rather than on it, which is
     deliberate: Warden's idle globe is a dim moon in a constellation and this one is a whole
     panel asking to be pressed. */
  var LIVE_FLOOR = 0.16;
  var LIVE_LO = 0.5;
  var LIVE_HI = 1.5;

  function liveness(drive) {
    var f = (drive - LIVE_LO) / (LIVE_HI - LIVE_LO);
    if (f < 0) f = 0;
    else if (f > 1) f = 1;
    return LIVE_FLOOR + (1 - LIVE_FLOOR) * f;
  }

  // ── geometry, all in local unit space ────────────────────────────────────────────────────

  /** A flat circle as a line loop in the XY plane: one gyro ring. AgentCore.ringGeometry. */
  function ringGeometry(radius, segments) {
    var seg = segments || 96;
    var pos = new Float32Array((seg + 1) * 3);
    for (var i = 0; i <= seg; i++) {
      var a = (i / seg) * Math.PI * 2;
      pos[i * 3] = Math.cos(a) * radius;
      pos[i * 3 + 1] = Math.sin(a) * radius;
      pos[i * 3 + 2] = 0;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return g;
  }

  /* Claude's sunburst: rays fired from the centre outward. They are seated on the 3D directions
     of an icosahedron's vertices so the spark reads as a radiant star from ANY orbit angle (a
     flat logo would vanish edge-on), with alternating ray lengths for the long/short cadence of
     the real mark. AgentCore.sunburstGeometry, unchanged. */
  function sunburstGeometry() {
    var t = (1 + Math.sqrt(5)) / 2;
    var verts = [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ];
    var pos = [];
    for (var i = 0; i < verts.length; i++) {
      var d = new THREE.Vector3(verts[i][0], verts[i][1], verts[i][2]).normalize();
      var inner = 0.1;
      var outer = 0.42 + (i % 2 === 0 ? 0.12 : 0); // long/short ray cadence
      pos.push(d.x * inner, d.y * inner, d.z * inner, d.x * outer, d.y * outer, d.z * outer);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }

  /* The soft halo behind the body, as a canvas-drawn radial sprite. hudGlow.ts, unchanged,
     including the reason for the stops: a linear ramp reads as a flat disc, and a ramp that
     ends above zero paints a visible square edge on a transparent canvas. One texture, built
     once, shared by every globe on the page. */
  var glowTex = null;

  function glowTexture() {
    if (glowTex) return glowTex;
    var size = 128;
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    if (!ctx) {
      glowTex = new THREE.Texture();
      return glowTex;
    }
    var g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.22, 'rgba(255,255,255,0.42)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.10)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    var tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    glowTex = tex;
    return tex;
  }

  function reduced() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (err) {
      return false;
    }
  }

  /* The palette comes off the page, not out of this file, exactly as the 2D globe reads it, and
     through the 2D globe's own parser so the two can never resolve the same token to different
     colours. The token is resolved from the CANVAS rather than the root because the calm
     screen's tokens hang off body[data-view='basic']. agent-globe.js carries the long version
     of this reasoning; this file only has to agree with it. */
  function readRgb(colorVar, fallback, canvas) {
    if (window.PhosphorGlobe && PhosphorGlobe.readRgb) {
      return PhosphorGlobe.readRgb(colorVar, fallback, canvas);
    }
    return fallback;
  }

  function create(canvas, opts) {
    if (!canvas || !canvas.getContext) return null;
    /* The one place a caller learns this globe cannot run. Answered before the import is even
       started, so driver-chat.js gets its yes-or-no in the same tick it asked. */
    if (!canHoldWebgl(canvas)) return null;

    var options = opts || {};
    /* How loud this globe is allowed to be, from the surface that mounted it. The calm screen's
       blue is a low-chroma token and lands dimmer than the terminal's green at the same alpha,
       so it asks for more. Applied to every opacity at the end, after Warden's own maths. */
    var gain = typeof options.gain === 'number' ? options.gain : 1;
    /* The floor under the radius. The panel-filling globe must never shrink to a dot when the
       column is dragged narrow; the badge IS a dot and asks for 0. Same numbers as the 2D
       globe, so flipping the switch changes the drawing and not the size. */
    var minR = typeof options.minRadius === 'number' ? options.minRadius : 18;

    var rate = 1;
    var drive = 1;

    var running = false;
    var raf = 0;
    var last = 0;
    /* Time this globe has actually been ON SCREEN, summed frame by frame, which is what the
       breathing waves are read against. Wall-clock elapsed would make a globe that came back
       from a hidden tab jump to wherever its wave had got to while nobody was looking. The
       rotations are accumulated the same way, on the objects themselves. */
    var clock = 0;
    var frames = 0;
    var built = false;
    var sized = false;

    var renderer = null;
    var scene = null;
    var camera = null;
    var body = null;      // the lattice and everything inside it
    var ringA = null;
    var ringB = null;
    var heart = null;
    var halo = null;
    var outerMat = null;
    var innerMat = null;
    var ringMatA = null;
    var ringMatB = null;
    var heartMat = null;
    var haloMat = null;
    var base = null; // the globe's own colour, resampled off the page
    var tint = null; // the live colour: base, lerped toward white by liveness
    var white = null;

    /* Eased, never snapped: a state change glides. Warden lerps the same three values with the
       same time constants (1 - exp(-k*dt)), which is what stops a badge that has just been told
       the agent is writing from jumping to full brightness inside one frame. */
    var sim = { live: liveness(1), glow: 1, dim: 0 };

    /* Resampled a few times a second rather than cached once, for agent-globe.js's reason: the
       basic screen's palette hangs off an attribute the first state frame writes, which lands
       after this component is mounted, and there is no event that says the token moved. */
    var RESAMPLE_FRAMES = 20;

    function build() {
      base = new THREE.Color();
      tint = new THREE.Color();
      white = new THREE.Color('#ffffff');
      resolveColor();

      renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
      });
      renderer.setClearAlpha(0);
      // HudPanel.tsx sets these on its own canvas. Every material below is toneMapped:false, so
      // this changes nothing today; it is here so a material that is not stays Warden's.
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;

      scene = new THREE.Scene();
      /* Orthographic, one world unit to one CSS pixel, which is how Warden's HUD canvas is set
         up (HudPanel.tsx: left 0, right MAX_W, top 0, bottom -MAX_H, camera at z 40). Centred
         here rather than corner-anchored because this canvas holds exactly one globe. */
      camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
      camera.position.set(0, 0, 40);

      var outerGeo = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1, 1));
      var innerGeo = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.55, 0));
      var ringGeo = ringGeometry(1.22);
      var heartGeo = sunburstGeometry();

      function lineMat(opacity) {
        return new THREE.LineBasicMaterial({
          transparent: true,
          opacity: opacity,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        });
      }

      halo = new THREE.Sprite(
        (haloMat = new THREE.SpriteMaterial({
          map: glowTexture(),
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        })),
      );
      halo.scale.setScalar(4.4);
      halo.renderOrder = -1;

      body = new THREE.Group();
      outerMat = lineMat(0.6);
      innerMat = lineMat(0.35);
      body.add(new THREE.LineSegments(outerGeo, outerMat));
      body.add(new THREE.LineSegments(innerGeo, innerMat));

      // The gyro cradle: two great circles on different axes. ringB's rotation is AgentCore's.
      ringMatA = lineMat(0.34);
      ringMatB = lineMat(0.28);
      ringA = new THREE.Group();
      ringA.add(new THREE.LineLoop(ringGeo, ringMatA));
      ringB = new THREE.Group();
      ringB.rotation.set(Math.PI * 0.5, 0, Math.PI * 0.18);
      ringB.add(new THREE.LineLoop(ringGeo, ringMatB));

      heartMat = lineMat(0.9);
      heart = new THREE.Group();
      heart.add(new THREE.LineSegments(heartGeo, heartMat));

      body.add(ringA);
      body.add(ringB);
      body.add(heart);

      // The halo sits outside the body group so the body's breathing scale does not compound
      // with the halo's own, which is how HudGlobe has it.
      scene.add(halo);
      scene.add(body);
      built = true;
    }

    function resolveColor() {
      var rgb = readRgb(options.colorVar || '--green', [51, 255, 102], canvas);
      base.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
    }

    /* The backing store follows the CSS box times DPR, capped at 2 for the 2D globe's reason: a
       third device pixel on a one-pixel line buys nothing and costs the whole surface again.
       Warden caps at the same place (HudPanel.tsx, dpr={[1,2]}). */
    function fit() {
      var box = canvas.getBoundingClientRect();
      var w = Math.max(1, Math.round(box.width));
      var h = Math.max(1, Math.round(box.height));
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (camera.right !== w / 2 || camera.top !== h / 2) {
        camera.left = -w / 2;
        camera.right = w / 2;
        camera.top = h / 2;
        camera.bottom = -h / 2;
        camera.updateProjectionMatrix();
      }
      if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
      // false: three must not write the CSS size back, the stylesheets own that. Forced on the
      // first frame as well as on a change, because three has to be told the size it is drawing
      // at even when the canvas already happens to carry those numbers.
      if (!sized || canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        renderer.setSize(w, h, false);
        sized = true;
      }
      return { w: w, h: h };
    }

    /* One frame. Every number below is Warden's, from HudGlobe.tsx for the lattice and the halo
       and from AgentCore.tsx for the cradle and the heart. The two places this file departs are
       marked; there are no others. */
    function draw(dt) {
      var box = fit();
      if (++frames % RESAMPLE_FRAMES === 0) resolveColor();

      clock += dt;
      var t = clock;
      var working = rate > WORKING;
      /* dt is 0 on the single frame a reduced-motion reader gets, and an easing step of zero
         would hold every value at the state the globe was mounted in. So a still frame lands
         on its target rather than creeping toward one it will never be asked to reach again. */
      var k = dt > 0 ? 1 - Math.exp(-6 * dt) : 1;
      sim.live += (liveness(drive) - sim.live) * k;

      /* THE ONE DEPARTURE IN THE MOTION. Warden picks between two body speeds off a status
         enum (0.42 working, 0.16 idle). This file is given a continuous rate instead, so the
         idle speed is scaled by it: the panel's four settings land on 0.08, 0.16, 0.27 and
         0.38 rad/s, which puts the resting globe exactly on Warden's idle and a working one
         within a whisker of Warden's 0.42. The cradle keeps Warden's own step function. */
      body.rotation.y += dt * 0.16 * rate;
      body.rotation.x += dt * 0.06;

      var spin = agentCoreSpinMultiplier(working);
      var pulse = agentCorePulseState(working, Math.sin(t * 2.2));
      ringA.scale.setScalar(pulse.ringScale);
      ringB.scale.setScalar(pulse.ringScale);
      heart.scale.setScalar(pulse.heartScale);
      ringA.rotation.y += dt * 0.22 * spin;
      ringA.rotation.x += dt * 0.05 * spin;
      ringB.rotation.x += dt * 0.18 * spin;
      ringB.rotation.z -= dt * 0.07 * spin;
      heart.rotation.y += dt * 0.3;
      heart.rotation.z += dt * 0.11;

      /* AgentCore's own glow and dim easing. `active` is Warden's hover lift and is always
         false here: the 2D globe's rule is that this file draws and reads no state, and a
         globe that listened for its own pointer would be the panel's second opinion about
         what is being pressed. `dimmed` is the resting badge and nothing else: the idle globe
         is an invitation, not a moon, so it is never dimmed. */
      var targetGlow = pulse.glowMultiplier * (1 + Math.sin(t * 1.4) * 0.03);
      sim.glow += (targetGlow - sim.glow) * (dt > 0 ? 1 - Math.exp(-5 * dt) : 1);
      sim.dim += ((drive < 1 ? 1 : 0) - sim.dim) * k;
      var coreK = (1 - sim.dim * 0.66) * sim.glow;

      tint.copy(base).lerp(white, sim.live * 0.4);
      var breath = working ? 1 + Math.sin(t * 2.2) * 0.05 : 1;
      var heat = 0.34 + sim.live * 0.72;

      outerMat.color.copy(tint);
      innerMat.color.copy(tint);
      ringMatA.color.copy(base).lerp(white, 0.3); // AgentCore keeps the cradle a hair toward
      ringMatB.color.copy(ringMatA.color);        // white so it stays legible over the lattice
      heartMat.color.copy(base);                  // the heart stays the pure brand hue
      haloMat.color.copy(tint);

      outerMat.opacity = clamp01(Math.min(1, 0.5 * heat + 0.16) * gain);
      innerMat.opacity = clamp01(Math.min(1, 0.34 * heat + 0.08) * gain);
      ringMatA.opacity = clamp01(0.34 * coreK * gain);
      ringMatB.opacity = clamp01(0.28 * coreK * gain);
      heartMat.opacity = clamp01(0.9 * coreK * gain);
      haloMat.opacity = clamp01(Math.min(1, 0.2 + heat * 0.5) * gain);

      /* Warden sizes the body off context occupancy, which this app has no equivalent of, so
         the globe fills its canvas instead, on the 2D globe's own fraction and floor: flipping
         the switch changes the drawing, not the size.

         THE HALO IS THE ONE THING THAT GIVES. Warden's sprite is 4.4 times the body radius and
         it has room, because a HUD globe is fifteen pixels in a canvas many times that. Here
         the canvas is cut to the globe, so 4.4 runs off the edge, and a radial gradient cut off
         before it reaches zero paints a bright SQUARE around the badge, which hudGlow.ts warns
         about in as many words. Capping the quad at the canvas means the gradient lands on zero
         exactly at every edge. The glow ends up tighter than Warden's; the alternative was a
         globe a quarter smaller than the one it replaces, and the lattice is the design. */
      var r = Math.max(minR, Math.min(box.w, box.h) * 0.30);
      body.scale.setScalar(r * breath);
      halo.scale.setScalar(Math.min(r * 4.4 * breath, Math.min(box.w, box.h)));

      renderer.render(scene, camera);
    }

    function clamp01(v) {
      return v > 1 ? 1 : v < 0 ? 0 : v;
    }

    function frame(now) {
      if (!running) return;
      if (!last) last = now;
      var dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      draw(dt);
      raf = requestAnimationFrame(frame);
    }

    /* A globe nobody can see is a battery bill. The rAF is dropped on the way out and picked up
       again on the way back, and the frame clock is reset with it so a tab that was away for a
       minute does not spin a minute of catch-up on its return. */
    function onVisibility() {
      if (!running) return;
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        return;
      }
      if (!raf) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    }

    /* One still frame and no loop, for a reader who has asked for reduced motion. The globe is
       still the right colour and the right brightness for the state it is in; it just does not
       turn. tune() re-draws it so a state change is still visible. */
    function still() {
      if (!built) return;
      draw(0);
    }

    function begin() {
      if (!built) build();
      if (reduced()) {
        still();
        return;
      }
      document.addEventListener('visibilitychange', onVisibility);
      if (!document.hidden) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    }

    return {
      /* Start turning. three is fetched on the first call and the loop begins when it lands, so
         a globe that is stopped again before the import resolves never starts one: `running` is
         the flag the callback checks, and it is set here rather than there. */
      start: function () {
        if (running) return;
        running = true;
        loadThree().then(function () {
          if (!running) return;
          begin();
        }, function () {
          /* An import that never lands leaves a blank canvas, and there is nothing this file
             can do about it from here: the caller already chose this globe over the 2D one and
             the panel around it still works. It is a local file on a loopback server, so the
             only way here is a build that shipped without ui/vendor. */
          running = false;
        });
      },
      stop: function () {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        last = 0;
        document.removeEventListener('visibilitychange', onVisibility);
        /* Cleared rather than left on the last frame: a stopped globe is not a dim globe, it is
           gone, and driver-chat.js is about to hide the element it lives in. */
        if (renderer) {
          try {
            renderer.clear();
          } catch (err) {
            /* a context already thrown away by the browser has nothing to clear */
          }
        }
      },
      /* How fast and how loud, from here on. Applied to the next frame rather than to the
         canvas, so a badge that is already turning changes speed where it is. */
      tune: function (next) {
        if (!next) return;
        if (typeof next.rate === 'number') rate = next.rate;
        if (typeof next.gain === 'number') drive = next.gain;
        if (running && reduced()) still();
      },
      running: function () {
        return running;
      },
    };
  }

  return { create: create };
})();

if (typeof module === 'object' && module.exports) module.exports = PhosphorWardenGlobe;

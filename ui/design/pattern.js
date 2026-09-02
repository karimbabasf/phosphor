/* Phosphor field: the afterglow.

   A WebGL shader, not geometry. Slow domain-warped noise lights the app's own
   green on the ground colour, very faintly, with a vignette that keeps the
   brightness off the edges where panels and text sit. It should read as the
   persistence on a phosphor screen: something the window is lit by rather than
   something drawn on it.

   It replaced a grid of opening squares. That field was legible but loud: it
   was the only high-contrast surface in a window whose whole job is to be
   quiet, and hard geometry behind soft panels fought the content instead of
   sitting under it.

   THE FIELD IS STILL THE STATUS LIGHT. Four intensities, and they are carried
   by how alive the glow is rather than by how sharp it is: idle drifts, working
   brightens and quickens, waiting nearly stops and breathes once, locked dims
   and loses its colour. Every state change eases over about 600 ms. Nothing
   jumps, because a background that snaps is a background you look at.

   Colour comes from --bg-0 and --ink at mount, so set_theme repaints the field
   with the rest of the window and refreshColors() is how it is told.

   window.PhosphorPattern
     mount(node, options) -> field

   field
     setState(name)    'idle' | 'working' | 'waiting' | 'locked'
     state             current name
     resize()          re-fit after a layout change
     refreshColors()   re-read the CSS custom properties after a theme change
     destroy()         drop the motion handle and the canvas
     stats()           motion handle stats, for the measurement harness

   Cheap on purpose. It paints at 30 fps behind the entire document, so the
   backing store is capped at 1x device pixels rather than the display's: a
   field with no edge in it has nothing for the extra pixels to resolve, and
   the upscale is invisible. prefers-reduced-motion paints one frame and stops.
   No WebGL means a static wash rather than a hole.
*/
(function () {
  'use strict';

  var FALLBACK_INK = [0.20, 1.00, 0.40];
  var FALLBACK_GROUND = [0.035, 0.035, 0.043];

  /* amp is how far the glow lifts off the ground, and it is the number that
     keeps this subtle: at 0.10 the brightest point of the field is a tenth of
     the way from the ground to full green. speed is drift, sat is how much
     colour survives, pulse is the slow breath only waiting uses. */
  var STATES = {
    idle:    { amp: 0.085, speed: 0.30, sat: 1.00, pulse: 0.00 },
    working: { amp: 0.140, speed: 1.00, sat: 1.00, pulse: 0.00 },
    waiting: { amp: 0.095, speed: 0.06, sat: 1.00, pulse: 1.00 },
    locked:  { amp: 0.045, speed: 0.12, sat: 0.18, pulse: 0.00 }
  };

  var EASE_TAU = 200; /* ms; about 600 ms to settle, the same as the old field */

  var VERT = [
    'attribute vec2 a_pos;',
    'void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }'
  ].join('\n');

  /* Value noise rather than a texture or a permutation table: four octaves of
     it, warped by two more, is all the structure a field this faint can show.
     Anything sharper is thrown away by the amplitude before it reaches a pixel. */
  var FRAG = [
    /* highp where the hardware has it. The hash below multiplies a sine by
       43758, which at mediump loses enough mantissa to break the noise into
       visible blocks, and a field whose whole job is to be smooth cannot pay
       that. mediump is the fallback rather than the default. */
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform vec2 u_res;',
    'uniform float u_time;',
    'uniform vec3 u_ink;',
    'uniform vec3 u_ground;',
    'uniform float u_amp;',
    'uniform float u_sat;',
    'uniform float u_pulse;',
    '',
    'float hash(vec2 p) {',
    '  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);',
    '}',
    '',
    'float noise(vec2 p) {',
    '  vec2 i = floor(p);',
    '  vec2 f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),',
    '             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);',
    '}',
    '',
    'float fbm(vec2 p) {',
    '  float v = 0.0;',
    '  float a = 0.5;',
    '  for (int i = 0; i < 4; i++) {',
    '    v += a * noise(p);',
    '    p *= 2.02;',
    '    a *= 0.5;',
    '  }',
    '  return v;',
    '}',
    '',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy / u_res;',
    '  vec2 p = uv * 2.6;',
    '  p.x *= u_res.x / max(u_res.y, 1.0);',
    '',
    '  vec2 q = vec2(fbm(p + vec2(0.0, u_time * 0.06)),',
    '                fbm(p + vec2(5.2, 1.3) - u_time * 0.05));',
    '  float f = fbm(p + 1.7 * q + vec2(u_time * 0.02, 0.0));',
    '',
    '  float glow = smoothstep(0.22, 0.86, f);',
    '',
    /* The breath only exists while waiting, so idle never pulses and the one
       state that means "a person has to look at this" is the one that moves
       differently rather than more. */
    '  float breath = 1.0 + u_pulse * 0.35 * sin(u_time * 0.9);',
    '',
    /* NO VIGNETTE, deliberately. A centre-bright field is the wrong shape for
       this window: pro caps its grid at 1440 and the field is what fills the
       margins, so the only part of it anyone sees is the part a vignette darkens
       most. An even field with panels laid over it puts the glow where there is
       no content and nothing where there is, which is the same result honestly. */
    '  float grey = dot(u_ink, vec3(0.2126, 0.7152, 0.0722));',
    '  vec3 ink = mix(vec3(grey), u_ink, u_sat);',
    '  vec3 col = u_ground + ink * glow * u_amp * breath;',
    '',
    /* A gradient this dark banks into visible bands on an 8-bit display. A
       sub-step of noise costs nothing and removes them. */
    '  col += (hash(gl_FragCoord.xy + fract(u_time)) - 0.5) * 0.006;',
    '',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /* ------------------------------------------------------------- colours */

  /* The tokens arrive as "#33FF66" from the stylesheet or "rgb(51, 255, 102)"
     once theme.js has written them, so both shapes are read. Anything else
     leaves the fallback in place rather than painting black on black. */
  function parseColour(raw) {
    if (typeof raw !== 'string') return null;
    var value = raw.trim();
    var hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value);
    if (hex) {
      var body = hex[1];
      if (body.length === 3) body = body[0] + body[0] + body[1] + body[1] + body[2] + body[2];
      return [
        parseInt(body.slice(0, 2), 16) / 255,
        parseInt(body.slice(2, 4), 16) / 255,
        parseInt(body.slice(4, 6), 16) / 255
      ];
    }
    var rgb = /^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/.exec(value);
    if (rgb) {
      return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
    }
    return null;
  }

  function readToken(name, fallback) {
    try {
      var raw = getComputedStyle(document.documentElement).getPropertyValue(name);
      return parseColour(raw) || fallback;
    } catch (err) {
      return fallback;
    }
  }

  /* ---------------------------------------------------------------- gl */

  function compile(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('field shader: ' + log);
    }
    return shader;
  }

  function buildProgram(gl) {
    var vert = compile(gl, gl.VERTEX_SHADER, VERT);
    var frag = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    var program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error('field program: ' + log);
    }
    return program;
  }

  /* The last resort. A field that cannot compile is still a surface the window
     sits on, so it gets the one static wash CSS can draw rather than nothing. */
  function mountFallback(node, ink) {
    var wash = document.createElement('div');
    wash.style.position = 'absolute';
    wash.style.inset = '0';
    wash.style.pointerEvents = 'none';
    wash.style.background =
      'radial-gradient(ellipse 120% 90% at 50% 42%, rgba(' +
      Math.round(ink[0] * 255) + ',' + Math.round(ink[1] * 255) + ',' + Math.round(ink[2] * 255) +
      ',0.05), transparent 70%)';
    node.appendChild(wash);
    return {
      state: 'idle',
      setState: function (name) { this.state = STATES[name] ? name : this.state; },
      resize: function () {},
      refreshColors: function () {},
      stats: function () { return { frames: 0, meanMs: 0, worstMs: 0 }; },
      destroy: function () { if (wash.parentNode) wash.parentNode.removeChild(wash); }
    };
  }

  /* -------------------------------------------------------------- mount */

  function mount(node, options) {
    if (!node) return null;
    var opts = options || {};
    var ink = readToken('--ink', FALLBACK_INK);
    var ground = readToken('--bg-0', FALLBACK_GROUND);

    var canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.pointerEvents = 'none';
    node.appendChild(canvas);

    /* The field is the only canvas that mounts before its own screen does, so
       it checks for the loop rather than assuming the tag above it ran. */
    if (!window.PhosphorMotion) {
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      return mountFallback(node, ink);
    }

    var gl = null;
    try {
      var attrs = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' };
      gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    } catch (err) {
      gl = null;
    }
    if (!gl) {
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      return mountFallback(node, ink);
    }

    var program;
    try {
      program = buildProgram(gl);
    } catch (err) {
      if (window.console && console.error) console.error('[field]', err);
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      return mountFallback(node, ink);
    }

    var buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(program);

    var uni = {
      res: gl.getUniformLocation(program, 'u_res'),
      time: gl.getUniformLocation(program, 'u_time'),
      ink: gl.getUniformLocation(program, 'u_ink'),
      ground: gl.getUniformLocation(program, 'u_ground'),
      amp: gl.getUniformLocation(program, 'u_amp'),
      sat: gl.getUniformLocation(program, 'u_sat'),
      pulse: gl.getUniformLocation(program, 'u_pulse')
    };

    var stateName = STATES[opts.state] ? opts.state : 'idle';
    var target = STATES[stateName];
    /* Current values start ON the target, so the first paint is the state the
       window is actually in rather than a fade up from idle. */
    var live = { amp: target.amp, speed: target.speed, sat: target.sat, pulse: target.pulse };
    var clock = 0;
    var lost = false;

    canvas.addEventListener('webglcontextlost', function (event) {
      event.preventDefault();
      lost = true;
    });
    canvas.addEventListener('webglcontextrestored', function () {
      lost = false;
    });

    function fit() {
      /* 1x, not the display's ratio: there is no edge in this field for a
         second device pixel to resolve, and it paints behind everything. */
      var size = window.PhosphorMotion.fitCanvas(canvas, 1);
      gl.viewport(0, 0, canvas.width, canvas.height);
      return size;
    }
    fit();

    function draw(now, since) {
      if (lost) return;
      var step = Math.min(since || 16, 64);

      /* Exponential ease toward the target, frame-rate independent, so a state
         change is a settle rather than a cut and a dropped frame cannot make it
         jump. */
      var k = 1 - Math.exp(-step / EASE_TAU);
      live.amp += (target.amp - live.amp) * k;
      live.speed += (target.speed - live.speed) * k;
      live.sat += (target.sat - live.sat) * k;
      live.pulse += (target.pulse - live.pulse) * k;

      /* Time advances by the eased speed rather than the wall clock, so slowing
         the drift never rewinds or skips the field. */
      clock += (step / 1000) * live.speed;

      gl.uniform2f(uni.res, canvas.width, canvas.height);
      gl.uniform1f(uni.time, clock);
      gl.uniform3f(uni.ink, ink[0], ink[1], ink[2]);
      gl.uniform3f(uni.ground, ground[0], ground[1], ground[2]);
      gl.uniform1f(uni.amp, live.amp);
      gl.uniform1f(uni.sat, live.sat);
      gl.uniform1f(uni.pulse, live.pulse);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    var handle = window.PhosphorMotion.register(node, draw, {
      fps: 30,
      isStatic: window.PhosphorMotion.reduced()
    });

    /* Reduced motion is a still field, not an absent one: the glow is painted
       once and left there. Turning the preference off starts it drifting
       without a reload. */
    var dropReduced = window.PhosphorMotion.onReducedChange(function () {
      handle.setStatic(window.PhosphorMotion.reduced());
    });

    var field = {
      state: stateName,
      setState: function (name) {
        if (!STATES[name] || name === stateName) return;
        stateName = name;
        target = STATES[name];
        field.state = name;
        handle.invalidate();
      },
      resize: function () {
        fit();
        handle.invalidate();
      },
      refreshColors: function () {
        ink = readToken('--ink', FALLBACK_INK);
        ground = readToken('--bg-0', FALLBACK_GROUND);
        handle.invalidate();
      },
      stats: function () { return handle.stats(); },
      destroy: function () {
        dropReduced();
        handle.destroy();
        gl.deleteProgram(program);
        gl.deleteBuffer(buffer);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };
    return field;
  }

  window.PhosphorPattern = { mount: mount };
})();

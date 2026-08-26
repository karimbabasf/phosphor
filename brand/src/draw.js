// Draws the PH0SPHOR wordmark: the face's own glyphs, a slash through each round
// letter, and a gap at the joins so the strokes stop short of meeting.
// Everything is found by reading the pixels of a first render, so the geometry
// follows the real outlines and survives a change of size or weight.
const DEFAULTS = {
  text: 'PH0SPHOR',
  size: 700,
  weight: 600,
  tracking: '0.055em',
  padX: 0.42,
  padY: 0.42,
  slashAt: [2, 6],        // the zero and the O
  slashOvershoot: 0.65,   // past the glyph edge, in stroke widths
  cutAt: [0, 1, 4, 5, 7], // P H P H R
  cutGap: 0.30,           // gap width, in stroke widths
  cutTopJoins: false,     // also break where the bowl leaves the stem at the top
  fg: '#000',
  bg: '#fff',             // null for no background, which knocks the mark out
  outline: 0,             // outline width, in stroke widths. 0 draws none
  outlineFg: '#000',
};

function drawMark(canvas, opts = {}) {
  const CFG = { ...DEFAULTS, ...opts };
  const font = `${CFG.weight} ${CFG.size}px Expose`;
  const setup = (ctx) => { ctx.font = font; ctx.letterSpacing = CFG.tracking; ctx.textBaseline = 'alphabetic'; };

  // ---- pass 1: plain render, read back as pixels ------------------------
  const s = document.createElement('canvas');
  const sx = s.getContext('2d', { willReadFrequently: true });
  setup(sx);
  const m = sx.measureText(CFG.text);
  const asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;

  const padX = Math.round(CFG.size * CFG.padX);
  const padY = Math.round(CFG.size * CFG.padY);
  const W = Math.round(m.actualBoundingBoxRight + m.actualBoundingBoxLeft + padX * 2);
  const H = Math.round(asc + desc + padY * 2);
  const originX = padX + m.actualBoundingBoxLeft;
  const baseline = padY + asc;

  s.width = W; s.height = H;
  setup(sx);
  sx.fillStyle = '#fff'; sx.fillRect(0, 0, W, H);
  sx.fillStyle = '#000';
  sx.fillText(CFG.text, originX, baseline);

  const data = sx.getImageData(0, 0, W, H).data;
  const isInk = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const i = (y * W + x) * 4;
    return data[i + 3] > 128 && data[i] < 128;
  };
  const runsRow = (y, x0, x1) => {
    const out = []; let st = -1;
    for (let x = x0; x <= x1; x++) {
      const on = isInk(x, y);
      if (on && st < 0) st = x;
      if (!on && st >= 0) { out.push([st, x - 1]); st = -1; }
    }
    if (st >= 0) out.push([st, x1]);
    return out;
  };
  const runsCol = (x, y0, y1) => {
    const out = []; let st = -1;
    for (let y = y0; y <= y1; y++) {
      const on = isInk(x, y);
      if (on && st < 0) st = y;
      if (!on && st >= 0) { out.push([st, y - 1]); st = -1; }
    }
    if (st >= 0) out.push([st, y1]);
    return out;
  };

  // one stroke weight for the whole mark, so every gap comes out the same
  const midY = Math.round(baseline - asc * 0.5);
  const midRuns = runsRow(midY, 0, W - 1).map(([a, b]) => b - a + 1);
  const stroke = midRuns.length ? Math.min(...midRuns) : CFG.size * 0.09;
  const gap = Math.max(2, Math.round(stroke * CFG.cutGap));

  // ---- per-letter ink boxes, found inside each glyph's own advance -------
  const adv = [];
  for (let i = 0; i <= CFG.text.length; i++) adv.push(sx.measureText(CFG.text.slice(0, i)).width);
  const letterBox = (i) => {
    const x0 = Math.max(0, Math.floor(originX + adv[i] - 2));
    const x1 = Math.min(W - 1, Math.ceil(originX + adv[i + 1] + 2));
    let l = 1e9, r = -1, t = 1e9, b = -1;
    for (let y = 0; y < H; y++) for (let x = x0; x <= x1; x++) {
      if (!isInk(x, y)) continue;
      if (x < l) l = x; if (x > r) r = x;
      if (y < t) t = y; if (y > b) b = y;
    }
    return { l, r, t, b, w: r - l, h: b - t };
  };
  const boxes = CFG.text.split('').map((_, i) => letterBox(i));

  // ---- pass 2: the real thing -------------------------------------------
  // The mark is built on its own transparent layer, so a join can be cut out of
  // it instead of painted over in the background colour. That is what lets the
  // same geometry give a knocked-out mark and an outline that follows the real
  // edge, gaps and all.
  const cx = canvas.getContext('2d');
  canvas.width = W; canvas.height = H;

  const ink = document.createElement('canvas');
  ink.width = W; ink.height = H;
  const ix = ink.getContext('2d');
  setup(ix);
  ix.fillStyle = '#000';
  ix.fillText(CFG.text, originX, baseline);

  // Slashes. Both run at the zero's angle, so they read as one system rather
  // than two letters that happen to be crossed.
  const z = boxes[CFG.slashAt[0]];
  const dl = Math.hypot(z.w, z.h);
  const ux = z.w / dl, uy = -z.h / dl;

  ix.strokeStyle = '#000';
  ix.lineCap = 'butt';
  for (const i of CFG.slashAt) {
    const box = boxes[i];
    // this letter's own stroke, off the row through its middle
    const rs = runsRow(Math.round(box.t + box.h / 2), box.l, box.r).map(([a, b]) => b - a + 1);
    const st = rs.length ? Math.min(...rs) : stroke;
    const ccx = box.l + box.w / 2, ccy = box.t + box.h / 2;
    // Walk out from the centre to find where the outline really ends. An
    // ellipse fit misses: these bowls are squarer than an ellipse, which leaves
    // a spur hanging off the corner.
    const edge = (sign) => {
      let last = 0;
      const lim = Math.hypot(box.w, box.h) / 2;
      for (let t = 0; t <= lim; t += 0.5) {
        const x = Math.round(ccx + sign * ux * t), y = Math.round(ccy + sign * uy * t);
        if (x < box.l || x > box.r || y < box.t || y > box.b) break;
        if (isInk(x, y)) last = t;
      }
      return last + st * CFG.slashOvershoot;
    };
    const rPos = edge(1), rNeg = edge(-1);
    ix.lineWidth = st;
    ix.beginPath();
    ix.moveTo(ccx - ux * rNeg, ccy - uy * rNeg);
    ix.lineTo(ccx + ux * rPos, ccy + uy * rPos);
    ix.stroke();
  }

  // Joins. A gap sits flush against the stem, so the stem stays whole and the
  // bar it carries starts a little way off it.
  const cuts = [];
  const barCut = (xLeft, run, capped) => {
    const h = capped ? Math.min(run[1] - run[0] + 1, Math.round(stroke * 1.7)) : run[1] - run[0] + 1;
    cuts.push({ x: xLeft, y: run[0] - 1, w: gap, h: h + 2 });
  };

  for (const i of CFG.cutAt) {
    const box = boxes[i];
    const ch = CFG.text[i];

    if (ch === 'H') {
      // crossbar, off both stems
      const stems = runsRow(Math.round(box.t + box.h * 0.12), box.l, box.r);
      if (stems.length < 2) continue;
      const left = stems[0], right = stems[stems.length - 1];
      const bar = runsCol(Math.round((left[1] + right[0]) / 2), box.t, box.b);
      if (!bar.length) continue;
      barCut(left[1] + 1, bar[0], false);
      cuts.push({ x: right[0] - gap, y: bar[0][0] - 1, w: gap, h: bar[0][1] - bar[0][0] + 3 });
      continue;
    }

    // P and R: the bowl, off the stem
    const low = runsRow(Math.round(box.b - box.h * 0.08), box.l, box.r);
    if (!low.length) continue;
    const stem = low[0];
    const bars = runsCol(Math.min(box.r, stem[1] + 3), box.t, box.b);
    if (bars[1]) barCut(stem[1] + 1, bars[1], true);          // bowl, bottom join
    if (CFG.cutTopJoins && bars[0]) barCut(stem[1] + 1, bars[0], true);
  }

  ix.globalCompositeOperation = 'destination-out';
  for (const c of cuts) ix.fillRect(c.x, c.y, c.w, c.h);
  ix.globalCompositeOperation = 'source-over';

  // ---- compositing ------------------------------------------------------
  const tint = (src, colour) => {
    const t = document.createElement('canvas');
    t.width = W; t.height = H;
    const tx = t.getContext('2d');
    tx.drawImage(src, 0, 0);
    tx.globalCompositeOperation = 'source-in';
    tx.fillStyle = colour; tx.fillRect(0, 0, W, H);
    return t;
  };

  // The outline is the mark's own shape grown outwards, so it follows the
  // slashes and the cut joins instead of the plain glyph. It has a ceiling: an
  // outline wider than half a gap meets itself across the gap and closes it.
  let outlineW = 0;
  if (CFG.outline > 0) {
    outlineW = Math.max(1, Math.min(Math.round(stroke * CFG.outline), Math.floor((gap - 2) / 2)));
    const grown = document.createElement('canvas');
    grown.width = W; grown.height = H;
    const gx = grown.getContext('2d');
    const steps = Math.max(64, Math.ceil(outlineW * 8));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      gx.drawImage(ink, Math.cos(a) * outlineW, Math.sin(a) * outlineW);
    }
    gx.drawImage(ink, 0, 0);
    cx.drawImage(tint(grown, CFG.outlineFg), 0, 0);
  }

  if (CFG.bg) {
    cx.globalCompositeOperation = 'destination-over';
    cx.fillStyle = CFG.bg; cx.fillRect(0, 0, W, H);
    cx.globalCompositeOperation = 'source-over';
  }
  cx.drawImage(tint(ink, CFG.fg), 0, 0);

  return { W, H, stroke, gap, cuts: cuts.length, boxes, outlineW,
           slashAngle: Math.round(Math.atan2(z.h, z.w) * 180 / Math.PI) };
}

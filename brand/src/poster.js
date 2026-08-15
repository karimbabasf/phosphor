// The wall version: the mark and one line under it, laid out on an A4 sheet.
const A4 = { w: 2480, h: 3508 };   // 210 x 297 mm at 300 dpi

const POSTER_DEFAULTS = {
  page: A4,
  markWidth: 0.72,    // the mark's ink, as a fraction of the sheet width
  text: 'headquarters',
  family: 'Menlo',
  subSize: 0.22,      // of the wordmark's cap height
  weight: 400,
  tracking: 0.42,     // em
  gap: 0.62,          // space under the wordmark, in cap heights
  optical: 0.44,      // 0.5 is dead centre; lower sits the block slightly high
  fg: '#000',
  bg: '#fff',
};

function drawPoster(canvas, markOpts = {}, subOpts = {}) {
  const P = { ...POSTER_DEFAULTS, ...subOpts };
  const probeSize = markOpts.size ?? 700;

  // measure once, then redraw the mark at the size that lands its ink on the target width
  const probe = document.createElement('canvas');
  const pi = drawMark(probe, { ...markOpts, size: probeSize });
  const probeInk = Math.max(...pi.boxes.map(b => b.r)) - Math.min(...pi.boxes.map(b => b.l));
  const size = Math.round(probeSize * (P.page.w * P.markWidth) / probeInk);

  const mc = document.createElement('canvas');
  const info = drawMark(mc, { ...markOpts, size });
  const left = Math.min(...info.boxes.map(b => b.l));
  const right = Math.max(...info.boxes.map(b => b.r));
  const top = Math.min(...info.boxes.map(b => b.t));
  const bottom = Math.max(...info.boxes.map(b => b.b));
  const cap = bottom - top;

  const cx = canvas.getContext('2d');
  canvas.width = P.page.w; canvas.height = P.page.h;
  cx.fillStyle = P.bg; cx.fillRect(0, 0, P.page.w, P.page.h);

  const px = Math.round(cap * P.subSize);
  cx.font = `${P.weight} ${px}px ${P.family}`;
  cx.letterSpacing = `${P.tracking}em`;
  const lm = cx.measureText(P.text);
  // the tracking also lands after the last letter; drop it so the line centres on its ink
  const lineW = lm.width - px * P.tracking;
  const lineAsc = lm.actualBoundingBoxAscent;

  // the block is the wordmark plus the gap plus the line, placed as one thing
  const blockH = cap + cap * P.gap + lineAsc;
  const blockTop = Math.round((P.page.h - blockH) * P.optical);

  // drawImage places the mark canvas, so offset by where its ink sits inside it
  cx.drawImage(mc, Math.round((P.page.w - (right - left)) / 2) - left, blockTop - top);

  cx.font = `${P.weight} ${px}px ${P.family}`;
  cx.letterSpacing = `${P.tracking}em`;
  cx.textBaseline = 'alphabetic';
  cx.fillStyle = P.fg;
  cx.fillText(P.text, Math.round((P.page.w - lineW) / 2), blockTop + cap + cap * P.gap + lineAsc);

  return { page: `${P.page.w}x${P.page.h}`, markSize: size, cap, subPx: px,
           marginTop: blockTop, marginSide: Math.round((P.page.w - (right - left)) / 2) };
}

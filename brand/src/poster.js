// The wall version: the mark, plus one quiet line under it.
const SUBLINE_DEFAULTS = {
  text: 'headquarters',
  family: 'Menlo',
  size: 0.13,        // of the wordmark's cap height
  weight: 400,
  tracking: 0.42,    // em
  gapAbove: 0.46,    // of the wordmark's cap height, from its ink bottom
  transform: null,   // or 'upper'
};

function drawPoster(canvas, markOpts = {}, subOpts = {}) {
  const SUB = { ...SUBLINE_DEFAULTS, ...subOpts };

  // the mark, on its own canvas, exactly as it ships
  const mc = document.createElement('canvas');
  const info = drawMark(mc, markOpts);

  // the wordmark's cap height and where its ink stops
  const capTop = Math.min(...info.boxes.map(b => b.t));
  const inkBottom = Math.max(...info.boxes.map(b => b.b));
  const cap = inkBottom - capTop;
  const sideMargin = Math.round((markOpts.size ?? 700) * 0.42);

  const label = SUB.transform === 'upper' ? SUB.text.toUpperCase() : SUB.text;
  const px = Math.round(cap * SUB.size);

  const cx = canvas.getContext('2d');
  cx.font = `${SUB.weight} ${px}px ${SUB.family}`;
  cx.letterSpacing = `${SUB.tracking}em`;
  const lm = cx.measureText(label);
  // letterSpacing also lands after the last letter; drop it so the line centres on its ink
  const lineW = lm.width - px * SUB.tracking;
  const lineAsc = lm.actualBoundingBoxAscent;

  const baseline = Math.round(inkBottom + cap * SUB.gapAbove + lineAsc);
  const W = info.W;
  const H = baseline + sideMargin;

  canvas.width = W; canvas.height = H;
  cx.fillStyle = markOpts.bg ?? '#fff';
  cx.fillRect(0, 0, W, H);
  cx.drawImage(mc, 0, 0);

  cx.font = `${SUB.weight} ${px}px ${SUB.family}`;
  cx.letterSpacing = `${SUB.tracking}em`;
  cx.textBaseline = 'alphabetic';
  cx.fillStyle = markOpts.fg ?? '#000';
  cx.fillText(label, Math.round((W - lineW) / 2), baseline);

  return { W, H, cap, px, lineW, family: SUB.family };
}

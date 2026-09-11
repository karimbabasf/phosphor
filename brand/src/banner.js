// The X (Twitter) header: the mark and one line under it, on a 1500 x 500 canvas.
// White on black, the way the app runs, minus the green. The block sits high and
// centred so the profile picture, which X lays over the bottom left corner, never
// touches it.
const X_HEADER = { w: 1500, h: 500 };

const BANNER_DEFAULTS = {
  page: X_HEADER,
  markWidth: 0.56,    // the mark's ink, as a fraction of the banner width
  text: 'agents that know blockchain',
  family: 'Menlo',
  weight: 400,
  tracking: 0.2,      // em. The poster line is a single word and takes 0.42; a sentence this long needs less
  subWidth: 1.0,      // the line's ink, as a fraction of the mark's ink width. Its size follows from this
  gap: 0.45,          // space under the wordmark, in cap heights
  optical: 0.40,      // 0.5 is dead centre; lower sits the block high, clear of the picture
  fg: '#fff',
  bg: '#000',
  guides: false,      // draw where X puts the profile picture, for checking only
};

function drawBanner(canvas, markOpts = {}, subOpts = {}) {
  const P = { ...BANNER_DEFAULTS, ...subOpts };
  const probeSize = markOpts.size ?? 700;

  // measure once, then redraw the mark at the size that lands its ink on the target width
  const probe = document.createElement('canvas');
  const pi = drawMark(probe, { ...markOpts, size: probeSize });
  const probeInk = Math.max(...pi.boxes.map(b => b.r)) - Math.min(...pi.boxes.map(b => b.l));
  const size = Math.round(probeSize * (P.page.w * P.markWidth) / probeInk);

  const mc = document.createElement('canvas');
  const info = drawMark(mc, { ...markOpts, size, fg: P.fg, bg: null });
  const left = Math.min(...info.boxes.map(b => b.l));
  const right = Math.max(...info.boxes.map(b => b.r));
  const top = Math.min(...info.boxes.map(b => b.t));
  const bottom = Math.max(...info.boxes.map(b => b.b));
  const cap = bottom - top;
  const inkW = right - left;

  const cx = canvas.getContext('2d');
  canvas.width = P.page.w; canvas.height = P.page.h;
  cx.fillStyle = P.bg; cx.fillRect(0, 0, P.page.w, P.page.h);

  // size the line so its ink spans the wanted width. Measure at 100px, then scale:
  // the tracking also lands after the last letter, so drop it before measuring
  const setFont = (px) => { cx.font = `${P.weight} ${px}px ${P.family}`; cx.letterSpacing = `${P.tracking}em`; };
  setFont(100);
  const per100 = cx.measureText(P.text).width - 100 * P.tracking;
  const px = Math.round((inkW * P.subWidth) / per100 * 100);
  setFont(px);
  const lm = cx.measureText(P.text);
  const lineW = lm.width - px * P.tracking;
  const lineAsc = lm.actualBoundingBoxAscent;
  const lineDesc = lm.actualBoundingBoxDescent;

  // the block is the wordmark plus the gap plus the line, placed as one thing
  const blockH = cap + cap * P.gap + lineAsc;
  const blockTop = Math.round((P.page.h - blockH) * P.optical);
  const markX = Math.round((P.page.w - inkW) / 2) - left;
  const baseline = Math.round(blockTop + cap + cap * P.gap + lineAsc);

  cx.drawImage(mc, markX, blockTop - top);
  setFont(px);
  cx.textBaseline = 'alphabetic';
  cx.fillStyle = P.fg;
  cx.fillText(P.text, Math.round((P.page.w - lineW) / 2), baseline);

  // X lays the profile picture over the bottom left, about a quarter of the width
  // across and a little over half its height into the header
  const avatar = { d: Math.round(P.page.w * 0.24), x: Math.round(P.page.w * 0.027) };
  avatar.y = P.page.h - Math.round(avatar.d * 0.53);
  if (P.guides) {
    cx.strokeStyle = '#f04a00'; cx.lineWidth = 3;
    cx.beginPath();
    cx.arc(avatar.x + avatar.d / 2, avatar.y + avatar.d / 2, avatar.d / 2, 0, Math.PI * 2);
    cx.stroke();
    cx.strokeRect(P.page.w * 0.05, P.page.h * 0.12, P.page.w * 0.9, P.page.h * 0.76);
  }

  return { page: `${P.page.w}x${P.page.h}`, markSize: size, cap, inkW, subPx: px, lineW: Math.round(lineW),
           blockTop, markBottom: blockTop + cap, lineBottom: baseline + Math.round(lineDesc),
           avatarTop: avatar.y, avatarRight: avatar.x + avatar.d };
}

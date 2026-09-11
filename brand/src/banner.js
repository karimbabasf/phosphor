// The X (Twitter) header: the mark and one line under it on a 1500 x 500 sheet, black on
// white, laid out like the Blast header so the two accounts sit side by side: the mark at the
// same cap height as the Blast wordmark, the line at the same size and on the same row.
const X_HEADER = { w: 1500, h: 500 };

const BANNER_DEFAULTS = {
  page: X_HEADER,
  cap: 82,            // the mark's cap height in px. The Blast wordmark measures 82 on its header
  markCenterY: 0.447, // the mark's vertical centre, as a fraction of the height (Blast: 223.5 / 500)
  text: 'agents that know blockchain',
  family: 'Manrope',  // Blast's display face, which its header line is set in
  weight: 400,
  subPx: 26,          // the Blast line measures 345 wide with a cap of 19 to 20, which is Manrope 26 untracked
  tracking: 0,        // em
  subTop: 0.656,      // the line's cap top, as a fraction of the height (Blast: 328 / 500)
  fg: '#000',
  bg: '#fff',
  guides: false,      // draw where X puts the profile picture, for checking only
};

function drawBanner(canvas, markOpts = {}, subOpts = {}) {
  const P = { ...BANNER_DEFAULTS, ...subOpts };
  const probeSize = markOpts.size ?? 700;

  // measure once, then redraw the mark at the size that lands its cap on the target height
  const probe = document.createElement('canvas');
  const pi = drawMark(probe, { ...markOpts, size: probeSize });
  const probeCap = Math.max(...pi.boxes.map(b => b.b)) - Math.min(...pi.boxes.map(b => b.t));
  const size = Math.round(probeSize * P.cap / probeCap);

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

  const markTop = Math.round(P.page.h * P.markCenterY - cap / 2);
  cx.drawImage(mc, Math.round((P.page.w - inkW) / 2) - left, markTop - top);

  cx.font = `${P.weight} ${P.subPx}px ${P.family}`;
  cx.letterSpacing = `${P.tracking}em`;
  cx.textBaseline = 'alphabetic';
  cx.fillStyle = P.fg;
  const lm = cx.measureText(P.text);
  // the tracking also lands after the last letter; drop it so the line centres on its ink
  const lineW = lm.actualBoundingBoxRight + lm.actualBoundingBoxLeft - P.subPx * P.tracking;
  const lineCap = cx.measureText('H').actualBoundingBoxAscent;
  const baseline = Math.round(P.page.h * P.subTop + lineCap);
  const lineX = Math.round((P.page.w - lineW) / 2 + lm.actualBoundingBoxLeft);
  cx.fillText(P.text, lineX, baseline);

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

  return { page: `${P.page.w}x${P.page.h}`, markSize: size, cap, inkW, markTop, markBottom: markTop + cap,
           subPx: P.subPx, lineW: Math.round(lineW), lineCap: Math.round(lineCap), lineTop: baseline - Math.round(lineCap),
           lineBottom: baseline + Math.round(lm.actualBoundingBoxDescent), avatarTop: avatar.y, avatarRight: avatar.x + avatar.d };
}

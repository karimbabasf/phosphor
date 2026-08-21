/* PHOSPHOR colours, applied.

   The server holds them (src/view/theme.ts) and this writes them onto :root, where every rule
   in style.css, basic.css and trade.css already reads them from. That is the whole reason the
   stylesheet was one hue behind a handful of custom properties: recolouring the app is setting
   five values, not editing a stylesheet.

   One file rather than a copy per page. Both windows carry the theme (the deck reads it on
   every state frame, the trading page on its own), and two implementations of "what is the
   ramp for this accent" would drift into two different greens on two screens of the same app.

   THE THREE TOKENS THIS FILE WILL NOT WRITE are --red, --red-dim and --red-ghost. They are the
   approval gate: pending asks, refusals, breached shares, the gate-disabled banner. The agent
   has no slot for them and this file has no line for them, so the alarm stays the one colour
   nothing in a session can move. The server refuses a background the gate red would be
   unreadable on, which is the other half of the same rule. */

'use strict';

(function () {
  var last = null;

  /* Same grammar the server enforces: hex, or nothing. Returns null on anything else, and the
     caller leaves the page alone rather than painting half a theme. A colour is the one
     agent-supplied string that reaches a stylesheet, so it is checked on both sides. */
  function triple(hex) {
    if (typeof hex !== 'string') return null;
    var value = hex.trim().toLowerCase();
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(value)) return null;
    if (value.length === 4) value = '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
    return (
      parseInt(value.slice(1, 3), 16) + ', ' + parseInt(value.slice(3, 5), 16) + ', ' + parseInt(value.slice(5, 7), 16)
    );
  }

  /* The bright tint, mixed from the accent toward white rather than carried as a sixth slot.
     One accent has to recolour the terminal coherently: a highlight that stayed green while
     everything else turned amber would read as a fault rather than a choice. */
  function lighten(rgb, amount) {
    var parts = rgb.split(', ');
    var out = [];
    for (var i = 0; i < 3; i++) out.push(Math.round(Number(parts[i]) + (255 - Number(parts[i])) * amount));
    return 'rgb(' + out.join(', ') + ')';
  }

  function apply(theme) {
    if (!theme || typeof theme !== 'object') return;
    var key = [theme.accent, theme.background, theme.up, theme.down, theme.agent].join('|');
    if (key === last) return;

    var accent = triple(theme.accent);
    var ground = triple(theme.background);
    if (accent === null || ground === null) return;
    last = key;

    var root = document.documentElement.style;
    root.setProperty('--bg', 'rgb(' + ground + ')');
    root.setProperty('--green', 'rgb(' + accent + ')');
    root.setProperty('--green-hi', lighten(accent, 0.45));
    /* The ramp, at the exact alphas style.css declares. Hierarchy on this page is brightness
       and opacity only, so the ramp has to move with the hue or the hierarchy comes apart. */
    root.setProperty('--green-dim', 'rgba(' + accent + ', 0.62)');
    root.setProperty('--green-faint', 'rgba(' + accent + ', 0.38)');
    root.setProperty('--green-ghost', 'rgba(' + accent + ', 0.22)');
    root.setProperty('--green-wash', 'rgba(' + accent + ', 0.10)');
    root.setProperty('--green-veil', 'rgba(' + accent + ', 0.06)');

    /* A canvas cannot read a custom property, so the chart engine is told directly. It is
       loaded before this on both pages; the guard covers the page that does not draw one. */
    if (typeof window.chartTheme === 'function') window.chartTheme(theme);
  }

  window.PhosphorTheme = { apply: apply, triple: triple, lighten: lighten };
})();

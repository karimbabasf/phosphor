/* PHOSPHOR colours, applied.

   The server holds them (src/view/theme.ts) and this writes them onto :root,
   where every rule in ui/design/*.css already reads them from. Recolouring the
   app is setting five values, not editing a stylesheet.

   The five slots are the MCP contract and they have not moved: accent,
   background, up, down, agent. What changed is where they land. The old build
   mapped accent onto a green ramp that was also the body text colour, so a
   recolour repainted every word in the window. This build paints text from
   --text, which no slot reaches, and maps the slots onto the four things that
   actually mean something: the action fill, the ground, and the two market
   directions, plus the agent's own colour.

     accent      -> --ink        the primary action fill, and the label on it
     background  -> --bg-0       the window ground, with --bg-1 to --bg-3 derived
     up          -> --up         price up, positive delta, the live dot
     down        -> --down       price down, negative delta, danger, No
     agent       -> --agent      the agent chip, the transcript accent, working

   THE TOKEN THIS FILE WILL NOT WRITE is --warn. It is the colour of waiting for
   a human: a pending ask, an unconfirmed send, a delayed feed. The agent has no
   slot for it and this file has no line for it, so the one colour that means
   "a person has to look at this" is the one colour nothing in a session can
   move. The server refuses a background it would be unreadable on, which is the
   other half of the same rule.

   THE COLOURWAY is the one thing in the theme that is not a colour. The window
   has one, green on warm charcoal, and it is the stylesheet itself: tokens.css keeps
   the tokens no slot reaches (the text, the amber, the lift) on :root, so the
   name rides along in the theme and nothing here acts on it. The text colour
   still cannot be named by anything in a session. */

'use strict';

(function () {
  var last = null;

  /* Same grammar the server enforces: hex, or nothing. Returns null on anything
     else, and the caller leaves the page alone rather than painting half a
     theme. A colour is the one agent-supplied string that reaches a stylesheet,
     so it is checked on both sides. */
  function rgb(hex) {
    if (typeof hex !== 'string') return null;
    var value = hex.trim().toLowerCase();
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(value)) return null;
    if (value.length === 4) value = '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
    return [
      parseInt(value.slice(1, 3), 16),
      parseInt(value.slice(3, 5), 16),
      parseInt(value.slice(5, 7), 16)
    ];
  }

  function css(parts) {
    return 'rgb(' + parts[0] + ', ' + parts[1] + ', ' + parts[2] + ')';
  }

  function alpha(parts, a) {
    return 'rgba(' + parts[0] + ', ' + parts[1] + ', ' + parts[2] + ', ' + a + ')';
  }

  /* The raised surfaces are mixed from the ground rather than carried as extra
     slots. A ground the agent lightens has to bring its panels with it, or a
     light background would put near-black panels on it and the window would
     invert. On a dark ground they lift toward a light of the ground's own hue
     (the ground scaled to full brightness, halfway to white), so warm charcoal
     gets warm layers and a cool ground cool ones; src/view/theme.ts
     raisedSurface() runs the same arithmetic. */
  function mix(from, to, amount) {
    var out = [];
    for (var i = 0; i < 3; i += 1) {
      out.push(Math.round(from[i] + (to[i] - from[i]) * amount));
    }
    return out;
  }

  function luminance(parts) {
    return (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
  }

  function liftOf(ground) {
    if (luminance(ground) > 0.5) return [0, 0, 0];
    var top = Math.max(ground[0], ground[1], ground[2]) || 1;
    return mix([255, 255, 255], [ground[0] * 255 / top, ground[1] * 255 / top, ground[2] * 255 / top], 0.5);
  }

  /* WCAG contrast, the same arithmetic the server runs, so the label on the
     action fill is chosen by what reads rather than by a guess at which side of
     mid-grey the accent fell on. */
  function relative(parts) {
    var out = 0;
    var weights = [0.2126, 0.7152, 0.0722];
    for (var i = 0; i < 3; i += 1) {
      var v = parts[i] / 255;
      out += weights[i] * (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    }
    return out;
  }

  function contrast(a, b) {
    var la = relative(a);
    var lb = relative(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /* The text colour, as the stylesheet resolved it. Read rather than derived so
     the canvas paints the same word the DOM does. */
  function readToken(name, fallback) {
    try {
      var raw = getComputedStyle(document.documentElement).getPropertyValue(name);
      return raw && raw.trim() ? raw.trim() : fallback;
    } catch (err) {
      return fallback;
    }
  }

  function apply(theme) {
    if (!theme || typeof theme !== 'object') return;
    var key = [theme.profile, theme.accent, theme.background, theme.up, theme.down, theme.agent].join('|');
    if (key === last) return;

    var accent = rgb(theme.accent);
    var ground = rgb(theme.background);
    var up = rgb(theme.up);
    var down = rgb(theme.down);
    var agent = rgb(theme.agent);
    if (accent === null || ground === null) return;
    last = key;

    var root = document.documentElement.style;
    var lift = liftOf(ground);

    root.setProperty('--bg-0', css(ground));
    root.setProperty('--bg-1', css(mix(ground, lift, 0.035)));
    root.setProperty('--bg-2', css(mix(ground, lift, 0.08)));
    root.setProperty('--bg-3', css(mix(ground, lift, 0.13)));
    root.setProperty('--line', css(mix(ground, lift, 0.11)));
    root.setProperty('--line-strong', css(mix(ground, lift, 0.17)));
    root.setProperty('--hi-rgb', lift.join(', '));

    root.setProperty('--ink', css(accent));
    /* The label on the action fill is the ground it sits on: black letters on
       the green button. The server holds the accent to 4.5:1 against the
       ground, so the ground always reads on it; white is kept only for an
       accent it would read better on, which the colourway itself never
       produces. */
    var groundOnAccent = contrast(ground, accent);
    var whiteOnAccent = contrast([255, 255, 255], accent);
    root.setProperty('--on-ink', groundOnAccent >= 4.5 || groundOnAccent >= whiteOnAccent ? css(ground) : '#FFFFFF');
    root.setProperty('--ink-wash', alpha(accent, 0.08));
    root.setProperty('--ink-edge', alpha(accent, 0.16));

    if (up) {
      root.setProperty('--up', css(up));
      root.setProperty('--up-wash', alpha(up, 0.14));
    }
    if (down) {
      root.setProperty('--down', css(down));
      root.setProperty('--down-wash', alpha(down, 0.14));
    }
    if (agent) {
      root.setProperty('--agent', css(agent));
      root.setProperty('--agent-edge', alpha(agent, 0.28));
    }

    canvas = {
      bg: css(ground),
      panel: css(mix(ground, lift, 0.035)),
      line: css(mix(ground, lift, 0.11)),
      text: readToken('--text', '#f8f0e8'),
      accent: css(accent),
      up: up ? css(up) : null,
      down: down ? css(down) : null
    };
    repaint();
  }

  /* A canvas cannot read a custom property, so the chart and the pattern are
     told directly. All of them are optional: the window paints correctly
     without any of them mounted, and the chart, which loads only when Trade
     first opens (ui/core/lazy.js), is told again once it is there. */
  var canvas = null;

  function repaint() {
    if (!canvas) return;
    if (typeof window.chartTheme === 'function') {
      try {
        window.chartTheme(canvas);
      } catch (err) {
        console.error('[theme] chart', err);
      }
    }
    if (window.PhosphorMini && typeof window.PhosphorMini.retheme === 'function') {
      try {
        window.PhosphorMini.retheme();
      } catch (err) {
        console.error('[theme] mini', err);
      }
    }
    if (typeof window.patternTheme === 'function') {
      try {
        window.patternTheme();
      } catch (err) {
        console.error('[theme] pattern', err);
      }
    }
  }

  window.PhosphorTheme = { apply: apply, repaint: repaint };
})();

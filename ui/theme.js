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
     background  -> --bg-0       the window ground, with --bg-1 and --bg-2 derived
     up          -> --up         price up, positive delta, the live dot
     down        -> --down       price down, negative delta, danger, No
     agent       -> --agent      the agent chip, the transcript accent, working

   THE TOKEN THIS FILE WILL NOT WRITE is --warn. It is the colour of waiting for
   a human: a pending ask, an unconfirmed send, a delayed feed. The agent has no
   slot for it and this file has no line for it, so the one colour that means
   "a person has to look at this" is the one colour nothing in a session can
   move. The server refuses a background it would be unreadable on, which is the
   other half of the same rule. */

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

  /* The two raised surfaces are mixed from the ground toward the accent's own
     luminance direction rather than carried as extra slots. A ground the agent
     lightens has to bring its panels with it, or a light background would put
     near-black panels on it and the window would invert. */
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

  function apply(theme) {
    if (!theme || typeof theme !== 'object') return;
    var key = [theme.accent, theme.background, theme.up, theme.down, theme.agent].join('|');
    if (key === last) return;

    var accent = rgb(theme.accent);
    var ground = rgb(theme.background);
    var up = rgb(theme.up);
    var down = rgb(theme.down);
    var agent = rgb(theme.agent);
    if (accent === null || ground === null) return;
    last = key;

    var root = document.documentElement.style;
    var lift = luminance(ground) > 0.5 ? [0, 0, 0] : [255, 255, 255];

    root.setProperty('--bg-0', css(ground));
    root.setProperty('--bg-1', css(mix(ground, lift, 0.035)));
    root.setProperty('--bg-2', css(mix(ground, lift, 0.07)));
    root.setProperty('--line', css(mix(ground, lift, 0.11)));
    root.setProperty('--line-strong', css(mix(ground, lift, 0.17)));

    root.setProperty('--ink', css(accent));
    /* The label on the action fill is the ground it sits on, so a white button
       carries dark text and a dark button carries light text without a sixth
       slot to get out of step. */
    root.setProperty('--on-ink', luminance(accent) > 0.55 ? css(ground) : '#FFFFFF');
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
      root.setProperty('--agent-wash', alpha(agent, 0.13));
      root.setProperty('--agent-edge', alpha(agent, 0.28));
    }

    /* A canvas cannot read a custom property, so the chart and the pattern are
       told directly. Both are optional: the window paints correctly without
       either of them mounted. */
    if (typeof window.chartTheme === 'function') {
      try {
        window.chartTheme({
          bg: css(ground),
          panel: css(mix(ground, lift, 0.035)),
          line: css(mix(ground, lift, 0.11)),
          text: '#EDEEF0',
          accent: css(accent),
          up: up ? css(up) : null,
          down: down ? css(down) : null
        });
      } catch (err) {
        console.error('[theme] chart', err);
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

  window.PhosphorTheme = { apply: apply };
})();

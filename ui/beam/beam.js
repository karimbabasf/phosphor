/* The beam: where the assistant's light lands. Interface stub; the flight,
   the scan and the decay are built in ui/beam/beam.js by the beam track.

     fire({ from, to, tone })  from: an element or {x, y}; to: a data-surface id;
                               tone: 'glow' | 'wait' | 'down'
     hold(id)                  start the scan on a surface (a tool in flight)
     release(id, ok)           stop the scan, glow and decay (rose when !ok)
     decay(id)                 glow once and fade, no flight
     surface(id)               the element for a surface id, or null */
(function () {
  'use strict';

  function surface(id) {
    if (!id) return null;
    return document.querySelector('[data-surface="' + String(id).replace(/"/g, '') + '"]');
  }

  function noop() {}

  window.PhosphorBeam = {
    fire: noop,
    hold: noop,
    release: noop,
    decay: noop,
    surface: surface
  };
})();

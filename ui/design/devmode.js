/* Developer mode: one switch, remembered on this Mac, that shows the jargon
   behind the plain words. Off by default. A screen marks an element with
   `data-dev-only` and it stays hidden until the switch is on; a screen that
   wants to swap words instead of hiding them subscribes and redraws.

   The switch is a person's own preference for their own window, so it lives
   in localStorage and not in the backend config. */
(function () {
  'use strict';

  var KEY = 'phosphor.developer';
  var subs = [];

  function read() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }

  function apply(on) {
    document.documentElement.dataset.developer = on ? 'true' : 'false';
  }

  function set(on) {
    on = !!on;
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) { /* private window */ }
    apply(on);
    for (var i = 0; i < subs.length; i++) {
      try { subs[i](on); } catch (e) { console.error('devmode subscriber', e); }
    }
  }

  function subscribe(fn) {
    subs.push(fn);
    return function () { subs = subs.filter(function (f) { return f !== fn; }); };
  }

  /* A labelled switch a screen can drop in. Same control everywhere, so the
     person learns it once. */
  function control(label) {
    var wrap = document.createElement('label');
    wrap.className = 'dev-switch';
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.checked = read();
    input.setAttribute('aria-checked', input.checked ? 'true' : 'false');
    input.addEventListener('change', function () {
      set(input.checked);
      input.setAttribute('aria-checked', input.checked ? 'true' : 'false');
    });
    var track = document.createElement('span');
    track.className = 'dev-switch-track';
    track.setAttribute('aria-hidden', 'true');
    var text = document.createElement('span');
    text.className = 'dev-switch-label';
    text.textContent = label || 'Show the technical details';
    wrap.appendChild(input);
    wrap.appendChild(track);
    wrap.appendChild(text);
    subscribe(function (on) {
      input.checked = on;
      input.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    return wrap;
  }

  apply(read());

  window.PhosphorDev = { on: read, set: set, toggle: function () { set(!read()); }, subscribe: subscribe, control: control };
})();

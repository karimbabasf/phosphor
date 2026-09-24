/* Phosphor icons. One authored set, drawn here on a 24 grid: a 1.5 px stroke
   with round caps and joins, and two tones, a soft fill of the body at a fifth
   of the ink under the stroke at full strength, so an icon reads as a shape
   before it reads as lines. Drawn by hand for this window, in the spirit of a
   bulk icon set, not copied from one.

   Injected once as a hidden sprite at the top of the body, the way the mark is
   in index.html; every use points at it with <use>, so the window holds one
   copy of each path and every copy is the colour of the element that holds it.
   Size comes from the parent's font size (.icon is 1em square) or from .icon-20
   and .icon-24 (components.css). Never an emoji, never a unicode glyph. */
(function () {
  'use strict';

  /* Each entry is [fills, strokes]. Fills are the body at a fifth of the ink;
     strokes carry the line. Both are path data on the 0 0 24 24 box. */
  var ICONS = {
    /* Two opposed arrows: what a swap is. */
    swap: [
      'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z',
      'M7 9h10M14 6l3 3-3 3M17 15H7M10 12l-3 3 3 3'
    ],
    /* An arrow down into a tray. */
    deposit: [
      'M4 15h16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
      'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3M12 4v10M8 10l4 4 4-4'
    ],
    /* An arrow up out of the same tray. */
    withdraw: [
      'M4 15h16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
      'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3M12 14V4M8 8l4-4 4 4'
    ],
    /* Up and to the right. */
    long: [
      'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z',
      'M8 16l8-8M10 8h6v6'
    ],
    /* Down and to the right. */
    short: [
      'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z',
      'M8 8l8 8M16 10v6h-6'
    ],
    /* A target: the ring, the inner ring and four ticks. */
    armed: [
      'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z',
      'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 3v2M12 19v2M3 12h2M19 12h2'
    ],
    /* A clock. */
    waiting: [
      'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z',
      'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7v5l3 2'
    ],
    /* A check in a circle. */
    done: [
      'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z',
      'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM8 12.5l2.5 2.5L16 9.5'
    ],
    /* A circle with a slash. */
    refused: [
      'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z',
      'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM6 6l12 12'
    ],
    /* A padlock, shut. */
    lock: [
      'M5 12a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z',
      'M5 12a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2zM8 10V7a4 4 0 0 1 8 0v3M12 14.5V16'
    ],
    /* The same padlock with the shackle lifted. */
    unlock: [
      'M5 12a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z',
      'M5 12a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2zM8 10V7a4 4 0 0 1 7.9-.9M12 14.5V16'
    ],
    /* A box with an arrow leaving its corner: opens outside the app. */
    external: [
      'M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
      'M11 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5M14 4h6v6M20 4l-9 9'
    ],
    /* Two sheets, the front one whole. */
    copy: [
      'M9 11a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2z',
      'M9 11a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2zM5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2'
    ],
    /* A funnel. */
    filter: [
      'M4 5h16l-6 7v6l-4 2v-8z',
      'M4 5h16l-6 7v6l-4 2v-8z'
    ],
    /* A chevron, its wedge filled. */
    'chevron-right': [
      'M9.5 6l6 6-6 6z',
      'M9.5 6l6 6-6 6'
    ],
    'chevron-down': [
      'M6 9.5l6 6 6-6z',
      'M6 9.5l6 6 6-6'
    ],
    /* A cross in a soft disc. */
    close: [
      'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z',
      'M8.5 8.5l7 7M15.5 8.5l-7 7'
    ],
    /* An eye, struck through. */
    hide: [
      'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z',
      'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM4 4l16 16'
    ],
    /* An eye. */
    show: [
      'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z',
      'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z'
    ],
    /* Four panes: the layout of the window. */
    layout: [
      'M4 5.5A1.5 1.5 0 0 1 5.5 4h4A1.5 1.5 0 0 1 11 5.5v4A1.5 1.5 0 0 1 9.5 11h-4A1.5 1.5 0 0 1 4 9.5zM13 5.5A1.5 1.5 0 0 1 14.5 4h4A1.5 1.5 0 0 1 20 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 13 9.5zM4 14.5A1.5 1.5 0 0 1 5.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 9.5 20h-4A1.5 1.5 0 0 1 4 18.5zM13 14.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5z',
      'M4 5.5A1.5 1.5 0 0 1 5.5 4h4A1.5 1.5 0 0 1 11 5.5v4A1.5 1.5 0 0 1 9.5 11h-4A1.5 1.5 0 0 1 4 9.5zM13 5.5A1.5 1.5 0 0 1 14.5 4h4A1.5 1.5 0 0 1 20 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 13 9.5zM4 14.5A1.5 1.5 0 0 1 5.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 9.5 20h-4A1.5 1.5 0 0 1 4 18.5zM13 14.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5z'
    ],
    /* A lens and its handle. */
    search: [
      'M11 4.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z',
      'M11 4.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.8 15.8L20.5 20.5'
    ],
    /* An arrow up: send. */
    send: [
      'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z',
      'M12 17V7M7.5 11.5L12 7l4.5 4.5'
    ],
    /* A square in a ring. */
    stop: [
      'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM9.5 9.5h5v5h-5z',
      'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM10 9.5h4a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-4a.5.5 0 0 1-.5-.5v-4a.5.5 0 0 1 .5-.5z'
    ],
    /* An arrow going round: try again. */
    retry: [
      'M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16z',
      'M20 12a8 8 0 1 1-8-8c2.2 0 4.2.9 5.7 2.3L20 8.5M20 4v4.5h-4.5'
    ],
    /* A triangle with a mark in it: something to know. */
    warning: [
      'M10.7 4.3L2.9 17.8a1.5 1.5 0 0 0 1.3 2.2h15.6a1.5 1.5 0 0 0 1.3-2.2L13.3 4.3a1.5 1.5 0 0 0-2.6 0z',
      'M10.7 4.3L2.9 17.8a1.5 1.5 0 0 0 1.3 2.2h15.6a1.5 1.5 0 0 0 1.3-2.2L13.3 4.3a1.5 1.5 0 0 0-2.6 0zM12 9v4.5M12 17v.01'
    ],
    /* Two links of a chain, struck through: no connection. */
    'link-off': [
      'M7 7h3v10H7a5 5 0 0 1 0-10zM14 7h3a5 5 0 0 1 0 10h-3z',
      'M9.5 17H7a5 5 0 0 1 0-10h2.5M14.5 7H17a5 5 0 0 1 3.9 8.1M9 12h2.5M4 4l16 16'
    ],
    /* The same two links, joined: a connection. Another agent, any client that
       connects. */
    link: [
      'M7 7h3v10H7a5 5 0 0 1 0-10zM14 7h3a5 5 0 0 1 0 10h-3z',
      'M9.5 17H7a5 5 0 0 1 0-10h2.5M14.5 7H17a5 5 0 0 1 0 10h-2.5M8.5 12h7'
    ],
    /* A shield with a tick in it: the recovery phrase, proven backed up. */
    shield: [
      'M12 3.2l7 2.7v5.3c0 4.4-2.9 8.1-7 9.4-4.1-1.3-7-5-7-9.4V5.9z',
      'M12 3.2l7 2.7v5.3c0 4.4-2.9 8.1-7 9.4-4.1-1.3-7-5-7-9.4V5.9zM9.2 12.1l2 2 3.7-3.9'
    ],
    /* A computer on its stand: this Mac. */
    mac: [
      'M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5V15H4z',
      'M4 15V6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5V15M4 15h16M2 18.5h20'
    ],
    /* A dial with its needle: a limit, how far toward it. */
    gauge: [
      'M4 16a8 8 0 0 1 16 0z',
      'M4 16a8 8 0 0 1 16 0M12 16l3.5-4.5M4 19.5h16'
    ],
    /* A key: its bow, its shaft and two teeth. */
    key: [
      'M8 9a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z',
      'M8 9a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM11.5 12.5H20M16.5 12.5v2.5M19.5 12.5v2'
    ],
    /* A bin with its lid: taking something off this Mac. */
    trash: [
      'M6 7h12l-1 12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z',
      'M4 7h16M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M10 11v6M14 11v6'
    ],
    /* A check on its own, no ring: the tick inside a box that is already the
       shape (the acknowledgement on Add money). */
    check: [
      '',
      'M6 12.5l4 4 8-9'
    ]
  };

  var NS = 'http://www.w3.org/2000/svg';
  var XLINK = 'http://www.w3.org/1999/xlink';

  function symbol(name) {
    var parts = ICONS[name];
    return '<symbol id="i-' + name + '" viewBox="0 0 24 24">'
      + '<path fill="currentColor" fill-opacity=".2" stroke="none" d="' + parts[0] + '"/>'
      + '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="' + parts[1] + '"/>'
      + '</symbol>';
  }

  /* The sprite, once, first thing in the body. Path data is this file's own,
     never anything that arrived over a wire, which is why innerHTML is safe
     here and nowhere else in the window. */
  function inject() {
    if (document.getElementById('phosphor-icons')) return;
    var host = document.createElement('div');
    var out = '';
    for (var name in ICONS) {
      if (Object.prototype.hasOwnProperty.call(ICONS, name)) out += symbol(name);
    }
    host.innerHTML = '<svg id="phosphor-icons" hidden aria-hidden="true" xmlns="' + NS + '">' + out + '</svg>';
    var sprite = host.firstChild;
    document.body.insertBefore(sprite, document.body.firstChild);
  }

  /* <svg class="icon {className}" aria-hidden="true"><use href="#i-{name}"/></svg>.
     An unknown name draws nothing rather than throwing, so a screen that asks
     for an icon this set has not drawn yet still renders its row. */
  function svg(name, className) {
    var node = document.createElementNS(NS, 'svg');
    node.setAttribute('class', 'icon' + (className ? ' ' + className : ''));
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('focusable', 'false');
    if (Object.prototype.hasOwnProperty.call(ICONS, name)) {
      var use = document.createElementNS(NS, 'use');
      use.setAttribute('href', '#i-' + name);
      use.setAttributeNS(XLINK, 'xlink:href', '#i-' + name);
      node.appendChild(use);
    }
    return node;
  }

  function has(name) {
    return Object.prototype.hasOwnProperty.call(ICONS, name);
  }

  function names() {
    return Object.keys(ICONS);
  }

  if (document.body) inject();
  else document.addEventListener('DOMContentLoaded', inject);

  window.PhosphorIcons = { svg: svg, has: has, names: names };
})();

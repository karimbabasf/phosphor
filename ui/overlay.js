/* overlay.js — one modal, reused by every "show me all of it" button on the deck.
 *
 * WHY IT EXISTS. The pro and trade decks fit one screen and never scroll, so three of the
 * app's records (the audit log, the policy, the transaction history) were being cut to fit
 * a rectangle: truncated lines, a capped panel, a table of eight columns in half a column of
 * deck. They are now behind buttons, and this is where they open. Scrolling is allowed in
 * here, and only in here.
 *
 * ONE mechanism, not one per view. A caller passes a title and a function that fills the
 * body; everything about being a dialog (escape, the focus trap, the backdrop, giving the
 * focus back to the button that opened it) is decided once, in this file.
 *
 * A REAL <dialog>, on purpose. showModal() puts the element in the top layer and makes the
 * rest of the document inert, so the focus trap is the browser's rather than a keydown
 * handler of ours that has to guess which elements are tabbable. Escape is the browser's
 * `cancel` event, intercepted only so the close runs through the one path below and the
 * trigger gets its focus back.
 *
 * Every string reaches the DOM through textContent, as everywhere else in this app. This
 * file writes no markup at all: it builds a shell, and the caller's build() fills it. */

'use strict';

var PhosphorOverlay = (function () {
  /* Long enough to be seen, short enough that a second look at the log is not a wait.
     The close timer is the fallback for an engine that does not fire transitionend. */
  var EXIT_MS = 220;

  var dialog = null;
  var panel = null;
  var titleNode = null;
  var bodyNode = null;
  var trigger = null;
  var onClose = null;
  var closing = false;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'ovl';
    /* Implicit under showModal() and written anyway: the attribute is what an audit of this
       file can check, and it costs nothing to state. */
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'ovl-title');

    panel = el('div', 'ovl-panel');

    var head = el('div', 'ovl-head');
    titleNode = el('h2', 'ovl-title', '');
    titleNode.id = 'ovl-title';
    var closeBtn = el('button', 'btn ovl-close', '[ CLOSE ]');
    closeBtn.type = 'button';
    head.appendChild(titleNode);
    head.appendChild(closeBtn);

    bodyNode = el('div', 'ovl-body');
    /* Focused on open rather than the close button: what a person came here to do is read,
       and a focused scroll box takes the arrow keys and Page Down immediately. Tab still
       reaches CLOSE, and Escape still closes from anywhere. */
    bodyNode.tabIndex = -1;

    panel.appendChild(head);
    panel.appendChild(bodyNode);
    dialog.appendChild(panel);
    document.body.appendChild(dialog);

    closeBtn.addEventListener('click', function () {
      close();
    });
    dialog.addEventListener('cancel', function (ev) {
      ev.preventDefault();
      close();
    });
    /* The backdrop is the dialog element itself: the panel inside it covers every pixel the
       dialog draws, so a click whose target is still the dialog landed outside the panel. */
    dialog.addEventListener('click', function (ev) {
      if (ev.target === dialog) close();
    });
  }

  function finish() {
    if (!closing) return;
    closing = false;
    dialog.close();
    bodyNode.textContent = '';
    var back = trigger;
    var after = onClose;
    trigger = null;
    onClose = null;
    // A button that has been re-rendered while the overlay was open is no longer on the
    // page, and focusing a detached node drops the focus to <body>.
    if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
    if (after) after();
  }

  function close() {
    if (!dialog || !dialog.open || closing) return;
    closing = true;
    dialog.removeAttribute('data-open');
    var timer = window.setTimeout(finish, EXIT_MS);
    panel.addEventListener('transitionend', function once(ev) {
      if (ev.target !== panel || ev.propertyName !== 'opacity') return;
      panel.removeEventListener('transitionend', once);
      window.clearTimeout(timer);
      finish();
    });
  }

  /* opts: { title, trigger, build(bodyElement), onClose() } */
  function open(opts) {
    var options = opts || {};
    if (!dialog) build();
    if (dialog.open) {
      // A second open with one already up: end the first outright rather than animating it
      // away underneath the new content.
      closing = true;
      finish();
    }
    trigger = options.trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    onClose = typeof options.onClose === 'function' ? options.onClose : null;
    titleNode.textContent = options.title || '';
    bodyNode.textContent = '';
    if (typeof options.build === 'function') options.build(bodyNode);
    dialog.showModal();
    bodyNode.scrollTop = 0;
    bodyNode.focus();
    /* Two frames, not one. The first lets the browser paint the closed state; flipping the
       attribute in the same frame as showModal() gives the transition nothing to run from
       in some engines and the panel simply appears. */
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        if (dialog.open && !closing) dialog.setAttribute('data-open', '1');
      });
    });
    return bodyNode;
  }

  function isOpen() {
    return Boolean(dialog && dialog.open && !closing);
  }

  return { open: open, close: close, isOpen: isOpen };
})();

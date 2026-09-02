/* Toast and confirm.

   The old build reached for window.confirm() on the flatten, close and disarm
   paths: an OS modal inside a Tauri window, unstyleable, and it blocks the
   render thread while the person decides about money. This is the replacement,
   and it is a real <dialog> so escape and the focus trap are the browser's. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;

  /* ---------- toast ---------- */

  var host = null;

  function toastHost() {
    if (host) return host;
    host = dom.el('div', 'toasts');
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
    return host;
  }

  function show(message, tone, ms) {
    var node = dom.el('div', 'toast', message);
    if (tone) node.dataset.tone = tone;
    toastHost().appendChild(node);
    var life = ms || (tone === 'down' ? 7000 : 4200);
    window.setTimeout(function () {
      node.dataset.leaving = 'true';
      window.setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 240);
    }, life);
    return node;
  }

  /* ---------- confirm ---------- */

  var dialog = null;
  var resolver = null;

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'confirm';

    var card = dom.el('div', 'confirm-card');
    var title = dom.el('h2', 'title');
    title.dataset.role = 'title';
    var body = dom.el('p', 'body dim');
    body.dataset.role = 'body';

    var actions = dom.el('div', 'screen-actions');
    var no = dom.el('button', 'btn btn-ghost');
    no.appendChild(dom.el('span', 'btn-label', 'Cancel'));
    var yes = dom.el('button', 'btn btn-primary');
    yes.dataset.role = 'confirm';
    yes.appendChild(dom.el('span', 'btn-label', 'Yes'));

    actions.appendChild(no);
    actions.appendChild(yes);
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(actions);
    dialog.appendChild(card);
    document.body.appendChild(dialog);

    dom.on(no, 'click', function () { finish(false); });
    dom.on(yes, 'click', function () { finish(true); });
    dom.on(dialog, 'cancel', function (event) {
      event.preventDefault();
      finish(false);
    });
    /* A click on the backdrop is a click outside the card, which is a cancel. */
    dom.on(dialog, 'click', function (event) {
      if (event.target === dialog) finish(false);
    });
    return dialog;
  }

  function finish(answer) {
    if (dialog && dialog.open) dialog.close();
    var done = resolver;
    resolver = null;
    if (done) done(answer);
  }

  function ask(options) {
    var opts = options || {};
    if (!dialog) build();
    dom.setText(dialog.querySelector('[data-role="title"]'), opts.title || 'Are you sure');
    dom.setText(dialog.querySelector('[data-role="body"]'), opts.body || '');
    var yes = dialog.querySelector('[data-role="confirm"]');
    dom.setText(yes.querySelector('.btn-label'), opts.confirm || 'Yes');
    yes.className = opts.tone === 'down' ? 'btn btn-danger' : 'btn btn-primary';
    yes.dataset.role = 'confirm';

    return new Promise(function (resolve) {
      resolver = resolve;
      dialog.showModal();
      /* Focus lands on Cancel, not on the destructive answer: a return press
         carried over from whatever the person was doing must not freeze the app. */
      var cancel = dialog.querySelector('.btn-ghost');
      if (cancel) cancel.focus();
    });
  }

  window.PhosphorToast = { show: show };
  window.PhosphorConfirm = { ask: ask };
})();

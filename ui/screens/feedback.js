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

  /* ---------- password ---------- */

  /* Asked at the moment it is needed and held nowhere. Resolves with the typed
     password, or with an empty string when the person backs out, so a caller
     cannot mistake a cancel for a blank password that the server would refuse
     anyway. */

  var pwDialog = null;
  var pwResolve = null;
  var pwExtra = '';

  function buildPassword() {
    pwDialog = document.createElement('dialog');
    pwDialog.className = 'confirm';

    var card = dom.el('form', 'confirm-card');
    var title = dom.el('h2', 'title');
    title.dataset.role = 'title';
    var body = dom.el('p', 'body dim');
    body.dataset.role = 'body';

    var field = dom.el('div', 'field');
    field.appendChild(dom.el('label', 'label', 'Password'));
    var input = dom.el('input', 'input');
    input.type = 'password';
    input.name = 'password';
    input.autocomplete = 'current-password';
    field.appendChild(input);

    var extra = dom.el('div', 'field');
    extra.hidden = true;
    var extraLabel = dom.el('label', 'label');
    extraLabel.dataset.role = 'extra-label';
    var extraInput = dom.el('input', 'input');
    extraInput.type = 'text';
    extraInput.dataset.role = 'extra-input';
    extra.appendChild(extraLabel);
    extra.appendChild(extraInput);

    var actions = dom.el('div', 'screen-actions');
    var no = dom.el('button', 'btn btn-ghost');
    no.type = 'button';
    no.appendChild(dom.el('span', 'btn-label', 'Cancel'));
    var yes = dom.el('button', 'btn btn-primary');
    yes.type = 'submit';
    yes.dataset.role = 'confirm';
    yes.appendChild(dom.el('span', 'btn-label', 'Continue'));
    actions.appendChild(no);
    actions.appendChild(yes);

    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(field);
    card.appendChild(extra);
    card.appendChild(actions);
    pwDialog.appendChild(card);
    document.body.appendChild(pwDialog);

    function finishPw(value) {
      pwExtra = extraInput.value.trim();
      input.value = '';
      if (pwDialog.open) pwDialog.close();
      var done = pwResolve;
      pwResolve = null;
      if (done) done(value);
    }

    dom.on(card, 'submit', function (event) {
      event.preventDefault();
      finishPw(input.value);
    });
    dom.on(no, 'click', function () { finishPw(''); });
    dom.on(pwDialog, 'cancel', function (event) {
      event.preventDefault();
      finishPw('');
    });
    dom.on(pwDialog, 'click', function (event) {
      if (event.target === pwDialog) finishPw('');
    });

    pwDialog.__refs = { title: title, body: body, input: input, yes: yes, extra: extra, extraLabel: extraLabel, extraInput: extraInput };
  }

  function askPassword(options) {
    var opts = options || {};
    if (!pwDialog) buildPassword();
    var refs = pwDialog.__refs;
    dom.setText(refs.title, opts.title || 'Your password');
    dom.setText(refs.body, opts.body || '');
    dom.setText(refs.yes.querySelector('.btn-label'), opts.confirm || 'Continue');
    refs.input.value = '';
    refs.extraInput.value = '';
    pwExtra = '';
    dom.setHidden(refs.extra, !opts.extra);
    if (opts.extra) {
      dom.setText(refs.extraLabel, opts.extra.label || '');
      refs.extraInput.placeholder = opts.extra.placeholder || '';
    }

    return new Promise(function (resolve) {
      pwResolve = resolve;
      pwDialog.showModal();
      refs.input.focus();
    });
  }

  window.PhosphorToast = { show: show };
  window.PhosphorConfirm = { ask: ask };
  window.PhosphorPassword = { ask: askPassword, extraValue: function () { return pwExtra; } };
})();

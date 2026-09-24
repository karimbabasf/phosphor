/* The terms of use, before anything else.

   The window does not open on the wallet, the lock or the first run until the
   person has accepted the terms at their current version: the app moves real
   money, and nobody should fund it on a footer link they never read. Four
   plain facts, the two pages opened in the browser, one button. The click is
   recorded by the app (state/terms.json and one audit line), and the terms
   leave only when the app says so.

   Where they are drawn depends on who is reading. A person with no wallet yet
   meets them as the first run's first step after the welcome, so the
   product's own moment is the first thing anyone sees; the first run draws
   them through `content()` and `accept()` below, the same words and the same
   write. A newer version over a wallet that already exists brings back this
   card, once, on the ink with the mark over it and the field behind it.

   lock.js asks `required()` and `firstRunOwns()` ahead of its own decision, so
   the lock stays down while this card is up, and `render()` on the lock is
   what this card calls when it goes, since accepting changes no lock slice. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;
  var store = window.PhosphorState;

  var host = null;
  var open_ = false;
  var button = null;
  var note = null;
  var fieldCanvas = null;
  var EASE = [0.16, 1, 0.3, 1];

  function boot() {
    host = document.getElementById('screen-terms');
    if (!host) return;
    store.select('terms', function () { render(); });
    store.select('lock', function () { render(); });
    render();
  }

  /* True while the app says the current terms are not accepted. A state with
     no terms slice at all (an older backend) asks for nothing. */
  function required(state) {
    /* No host, no card: the lock must then run as it always did rather than
       stand down for a screen that cannot open. */
    if (!host) return false;
    var whole = state || store.get() || {};
    var terms = whole.terms;
    return !!(terms && terms.accepted === false);
  }

  /* Whether the first run carries the terms as its own step: it is what the
     lock opens for a person with no wallet, or with a file another Mac made. */
  function firstRunOwns(state) {
    var whole = state || store.get() || {};
    var lock = whole.lock || {};
    var vault = whole.vault || {};
    var first = window.PhosphorFirstRun;
    if (!first || typeof first.open !== 'function') return false;
    return lock.state === 'no_wallet' || vault.foreign === true;
  }

  function render() {
    if (!host) return;
    var whole = store.get() || {};
    if (required(whole) && !firstRunOwns(whole)) open();
    else if (open_) close();
    else dom.setHidden(host, true);
  }

  function open() {
    if (!host || open_) return;
    open_ = true;
    dom.setAttr(document.body, 'data-locked', 'true');
    dom.setAttr(document.body, 'data-terms', 'true');
    setPageInert(true);
    dom.setHidden(host, false);
    dom.clear(host);
    var card = dom.el('div', 'screen-card terms-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'terms-title');
    card.setAttribute('tabindex', '-1');
    host.appendChild(card);
    mountField(card);
    var body = dom.el('div', 'screen-body terms-body');
    card.appendChild(body);
    draw(body);
    if (typeof card.focus === 'function') card.focus();
  }

  function close() {
    if (!open_) return;
    open_ = false;
    button = null;
    note = null;
    unmountField();
    dom.clear(host);
    dom.setHidden(host, true);
    dom.setAttr(document.body, 'data-terms', null);
    dom.setAttr(document.body, 'data-locked', null);
    setPageInert(false);
    /* The lock decides what the window shows next: the first run for a new
       wallet, Touch ID or the password for an existing one, nothing when the
       wallet is already open. Nothing in the lock slice moved, so it is asked. */
    var lock = window.PhosphorLock;
    if (lock && typeof lock.render === 'function') lock.render();
  }

  /* The first run's hairline field, behind this card too, so the two screens
     a person can meet first wear the same ground. */
  function mountField(card) {
    var Field = window.PhosphorField;
    if (!Field || typeof Field.mount !== 'function' || typeof document.createElement !== 'function') return;
    fieldCanvas = document.createElement('canvas');
    fieldCanvas.className = 'field-layer';
    fieldCanvas.setAttribute('aria-hidden', 'true');
    host.insertBefore(fieldCanvas, card);
    Field.mount(fieldCanvas, { clear: card, fps: 30 });
  }

  function unmountField() {
    var Field = window.PhosphorField;
    if (fieldCanvas && Field && typeof Field.unmount === 'function') Field.unmount();
    if (fieldCanvas && fieldCanvas.parentNode) fieldCanvas.parentNode.removeChild(fieldCanvas);
    fieldCanvas = null;
  }

  /* The card: the mark, the title, the terms, the button, arriving one
     behind the other the way the welcome does. */
  function draw(body) {
    var mark = dom.el('div', 'firstrun-mark terms-mark');
    mark.setAttribute('aria-hidden', 'true');
    var svg = dom.mark();
    if (svg) mark.appendChild(svg);
    body.appendChild(mark);

    var title = dom.el('h1', 'firstrun-welcome-title terms-title', 'Before you start');
    title.id = 'terms-title';
    body.appendChild(title);
    note = content(body);

    var row = dom.el('div', 'screen-actions');
    button = dom.el('button', 'btn btn-primary btn-lg');
    button.appendChild(dom.el('span', 'btn-label', 'Accept and continue'));
    dom.setAttr(button, 'data-pending-label', 'Saving');
    row.appendChild(button);
    body.appendChild(row);
    dom.on(button, 'click', onAccept);
    enter([mark, title, body.querySelector('.terms-facts'), row]);
  }

  function enter(nodes) {
    var Motion = window.Motion;
    if (!Motion || typeof Motion.animate !== 'function') return;
    var items = nodes.filter(function (n) { return n && n.style; });
    if (!items.length) return;
    var still = !!(window.PhosphorMotion && typeof window.PhosphorMotion.reduced === 'function' && window.PhosphorMotion.reduced());
    for (var i = 0; i < items.length; i += 1) items[i].style.opacity = '0';
    var run = Motion.animate(
      items,
      still ? { opacity: [0, 1] } : { opacity: [0, 1], y: [12, 0], filter: ['blur(6px)', 'blur(0px)'] },
      still ? { duration: 0.3, ease: EASE } : { duration: 0.4, ease: EASE, delay: typeof Motion.stagger === 'function' ? Motion.stagger(0.08, { startDelay: 0.2 }) : 0.2 }
    );
    var clear = function () {
      for (var k = 0; k < items.length; k += 1) {
        items[k].style.opacity = '';
        items[k].style.transform = '';
        items[k].style.filter = '';
      }
    };
    var finished = run && run.finished ? run.finished : run;
    Promise.resolve(finished).then(clear, clear);
  }

  /* The terms themselves: the line, four facts, the two pages, and the note
     that says which version is being accepted. Drawn into the card here and
     into the first run's step there. Returns the note, which carries what
     happened to the answer. */
  function content(body) {
    var state = store.get() || {};
    var terms = state.terms || {};
    var urls = terms.urls || {};

    body.appendChild(dom.el('p', 'terms-lead', 'Phosphor is alpha software that moves real money. Four things to know, then the rules in full.'));

    var facts = dom.el('ul', 'firstrun-facts terms-facts');
    facts.appendChild(fact('It moves real money, and it is alpha.', 'Transactions are final. Put in only what you can afford to lose.'));
    facts.appendChild(fact('Your keys are yours alone.', 'Nobody can reset, recover or freeze your wallet: not the author, not your assistant.'));
    facts.appendChild(fact('The venues are not ours.', 'NEAR Intents and Hyperliquid set their own rules and fees, and they can fail.'));
    facts.appendChild(fact('You are 18 or older.', 'And allowed to use these services where you live.'));
    body.appendChild(facts);

    var read = dom.el('p', 'terms-read');
    read.appendChild(dom.el('span', '', 'Read the full '));
    read.appendChild(link(urls.terms || 'https://phosphor.money/terms/', 'Terms of use'));
    read.appendChild(dom.el('span', '', ' and the '));
    read.appendChild(link(urls.privacy || 'https://phosphor.money/privacy/', 'Privacy page'));
    read.appendChild(dom.el('span', '', '. They open in your browser.'));
    body.appendChild(read);

    var said = dom.el('p', 'terms-note', 'By continuing you accept the Terms of use, dated ' + (terms.version || '') + '.');
    said.setAttribute('role', 'status');
    body.appendChild(said);
    return said;
  }

  function fact(lead, rest) {
    var item = dom.el('li', 'firstrun-fact terms-fact');
    var text = dom.el('p', 'firstrun-fact-text');
    text.appendChild(dom.el('span', 'firstrun-fact-lead', lead));
    text.appendChild(dom.el('span', '', ' ' + rest));
    item.appendChild(text);
    return item;
  }

  /* A real link, so it reads as one and opens with Enter. The shell hands a
     new-window request for an https url to the system browser and denies the
     window itself (main.rs open_in_browser); nothing else can come out of it.
     The url arrives on the state frame like everything else, so the one list
     writes it (core/links.js), against the product's own hosts. A url off that
     list leaves the words on the card without a link under them. */
  function link(href, label) {
    var a = dom.el('a', 'terms-link', label);
    var links = window.PhosphorLinks;
    if (!links || typeof links.setSiteHref !== 'function' || !links.setSiteHref(a, href)) return a;
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener');
    return a;
  }

  /* One write. It resolves with ok once the app says accepted, and the state
     learns the answer here, so every screen that reads the terms sees it. */
  function accept() {
    return api.termsAccept().then(function (answer) {
      if (answer && answer.accepted === true) {
        store.put(Object.assign({}, store.get() || {}, { terms: answer }));
        return { ok: true };
      }
      return { ok: false, reason: answer && answer.error ? answer.error : 'The app did not record the answer. Try again.' };
    }).catch(function (err) {
      return { ok: false, reason: net && typeof net.readable === 'function' ? net.readable(err) : String(err) };
    });
  }

  /* One click, one write. The button stays down until the app answers; the
     card goes when the state frame says accepted, not when the click lands,
     so a refused write leaves the card up with the reason under the button. */
  function onAccept() {
    if (!button || button.disabled) return;
    var shell = window.PhosphorShell;
    if (shell && typeof shell.setPending === 'function') shell.setPending(button, true);
    else button.disabled = true;
    dom.setText(note, 'Saving your answer.');
    accept().then(function (answer) {
      if (answer.ok) return;
      fail(answer.reason);
    });
  }

  function fail(reason) {
    if (!button) return;
    var shell = window.PhosphorShell;
    if (shell && typeof shell.setPending === 'function') shell.setPending(button, false);
    else button.disabled = false;
    dom.setText(note, reason);
  }

  /* Same pair as lock.js and firstrun.js: the page behind is hidden by the
     stylesheet and taken off the keyboard and the accessibility tree here. */
  function setPageInert(on) {
    var page = document.getElementById('page');
    if (!page) return;
    if ('inert' in page) page.inert = on;
    dom.setAttr(page, 'aria-hidden', on ? 'true' : null);
  }

  window.PhosphorTerms = {
    boot: boot,
    required: required,
    firstRunOwns: firstRunOwns,
    render: render,
    content: content,
    accept: accept
  };
})();

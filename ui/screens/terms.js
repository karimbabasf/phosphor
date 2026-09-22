/* The terms of use, before anything else.

   The window does not open on the wallet, the lock or the first run until the
   person has accepted the terms at their current version: the app moves real
   money, and nobody should fund it on a footer link they never read. One card
   on the ink in the first run's own clothes: four plain facts, the two pages
   opened in the browser, one button. The click is recorded by the app
   (state/terms.json and one audit line), and the card leaves only when the
   app says so. A newer version of the terms brings it back once.

   lock.js asks `required()` ahead of its own decision, so the lock and the
   first run stay down while this card is up, and `render()` on the lock is
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

  function boot() {
    host = document.getElementById('screen-terms');
    if (!host) return;
    store.select('terms', function () { render(); });
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

  function render() {
    if (!host) return;
    if (required()) open();
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
    var body = dom.el('div', 'screen-body');
    card.appendChild(body);
    draw(body);
    if (typeof card.focus === 'function') card.focus();
  }

  function close() {
    if (!open_) return;
    open_ = false;
    button = null;
    note = null;
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

  function draw(body) {
    var state = store.get() || {};
    var terms = state.terms || {};
    var urls = terms.urls || {};

    var title = dom.el('h1', 'firstrun-welcome-title', 'Before you start');
    title.id = 'terms-title';
    body.appendChild(title);
    body.appendChild(dom.el('p', 'firstrun-welcome-line', 'Phosphor is alpha software that moves real money. Four things to know, then the rules in full.'));

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

    note = dom.el('p', 'terms-note', 'By continuing you accept the Terms of use, dated ' + (terms.version || '') + '.');
    body.appendChild(note);

    var row = dom.el('div', 'screen-actions');
    button = dom.el('button', 'btn btn-primary btn-lg');
    button.appendChild(dom.el('span', 'btn-label', 'Accept and continue'));
    dom.setAttr(button, 'data-pending-label', 'Saving');
    row.appendChild(button);
    body.appendChild(row);
    dom.on(button, 'click', accept);
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

  /* One click, one write. The button stays down until the app answers; the
     card goes when the state frame says accepted, not when the click lands,
     so a refused write leaves the card up with the reason under the button. */
  function accept() {
    if (!button || button.disabled) return;
    var shell = window.PhosphorShell;
    if (shell && typeof shell.setPending === 'function') shell.setPending(button, true);
    else button.disabled = true;
    dom.setText(note, 'Saving your answer.');
    api.termsAccept().then(function (answer) {
      if (answer && answer.accepted === true) {
        store.put(Object.assign({}, store.get() || {}, { terms: answer }));
        return;
      }
      fail(answer && answer.error ? answer.error : 'The app did not record the answer. Try again.');
    }).catch(function (err) {
      fail(net && typeof net.readable === 'function' ? net.readable(err) : String(err));
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

  window.PhosphorTerms = { boot: boot, required: required, render: render };
})();

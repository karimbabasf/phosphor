/* First run: ten screens, each one card on the pattern field.

   This is the largest gap the product had. Before it, setting Phosphor up meant
   running a terminal command that printed addresses and then hand-editing a
   config file. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;
  var api = window.PhosphorApi;

  var STEPS = [
    'what', 'choose', 'password', 'words', 'prove', 'addresses',
    'money', 'connect', 'threshold', 'done'
  ];

  var host = null;
  var card = null;
  var step = 0;
  var draft = { path: 'create', password: '', mnemonic: [], threshold: 100, addresses: null };
  var open_ = false;

  function boot() {
    host = document.getElementById('screen-firstrun');
  }

  function open() {
    if (!host || open_) return;
    open_ = true;
    dom.setAttr(document.body, 'data-locked', 'true');
    dom.setHidden(host, false);
    dom.clear(host);
    /* The window's one field is already behind this, and the shell holds it at
       `locked` while there is no wallet. */
    card = dom.el('div', 'screen-card');
    host.appendChild(card);
    step = 0;
    draw();
  }

  function close() {
    draft.mnemonic = [];
    draft.password = '';
    open_ = false;
    dom.setHidden(host, true);
    dom.setAttr(document.body, 'data-locked', null);
    window.PhosphorShell.refresh({});
  }

  function go(next) {
    step = Math.max(0, Math.min(STEPS.length - 1, next));
    draw();
  }

  function draw() {
    dom.clear(card);
    if (step > 0) {
      card.appendChild(dom.el('p', 'screen-steps', 'Step ' + (step + 1) + ' of ' + STEPS.length));
    }
    var name = STEPS[step];
    if (name === 'what') screenWhat();
    else if (name === 'choose') screenChoose();
    else if (name === 'password') screenPassword();
    else if (name === 'words') screenWords();
    else if (name === 'prove') screenProve();
    else if (name === 'addresses') screenAddresses();
    else if (name === 'money') screenMoney();
    else if (name === 'connect') screenConnect();
    else if (name === 'threshold') screenThreshold();
    else if (name === 'done') screenDone();
    var focusable = card.querySelector('input, button');
    if (focusable) focusable.focus();
  }

  function actions(primaryLabel, onPrimary, options) {
    var opts = options || {};
    var row = dom.el('div', 'screen-actions');
    if (opts.back !== false && step > 0) {
      var back = dom.el('button', 'btn btn-ghost');
      back.appendChild(dom.el('span', 'btn-label', 'Back'));
      row.appendChild(back);
      dom.on(back, 'click', function () { go(step - 1); });
    }
    if (opts.skip) {
      var skip = dom.el('button', 'btn btn-quiet');
      skip.appendChild(dom.el('span', 'btn-label', opts.skip));
      row.appendChild(skip);
      dom.on(skip, 'click', function () { go(step + 1); });
    }
    var primary = dom.el('button', 'btn btn-primary btn-lg');
    primary.appendChild(dom.el('span', 'btn-label', primaryLabel));
    if (opts.disabled) primary.disabled = true;
    row.appendChild(primary);
    dom.on(primary, 'click', function () { onPrimary(primary); });
    card.appendChild(row);
    return primary;
  }

  /* 1 */
  function screenWhat() {
    card.appendChild(dom.el('h1', 'headline', 'Phosphor'));
    card.appendChild(dom.el('p', 'body', 'Phosphor lets your AI assistant use your money, without ever letting it spend your money. You decide. Every time.'));
    actions('Get started', function () { go(1); }, { back: false });
  }

  /* 2 */
  function screenChoose() {
    card.appendChild(dom.el('h1', 'title', 'Create or bring a wallet'));
    var options = dom.el('div', 'stack');
    options.appendChild(choice('Make a new wallet', 'A new wallet starts empty. You add money in a minute.', 'create'));
    options.appendChild(choice('I already have one', 'You will need your recovery words.', 'import'));
    card.appendChild(options);
    actions('Continue', function () { go(2); });
  }

  function choice(title, note, value) {
    var button = dom.el('button', 'choice');
    button.type = 'button';
    if (draft.path === value) button.dataset.chosen = 'true';
    button.appendChild(dom.el('span', 'title-sm', title));
    button.appendChild(dom.el('span', 'meta', note));
    dom.on(button, 'click', function () {
      draft.path = value;
      draw();
    });
    return button;
  }

  /* 3 */
  function screenPassword() {
    card.appendChild(dom.el('h1', 'title', 'Set a password'));
    card.appendChild(dom.el('p', 'body dim', 'This password locks the app and encrypts your keys on this computer. Nobody can reset it. Not us, not your assistant.'));

    var one = field('Password', 'new-password');
    var two = field('Password again', 'new-password');
    card.appendChild(one.node);
    card.appendChild(two.node);

    var strength = dom.el('p', 'meta');
    card.appendChild(strength);
    var error = dom.el('p', 'body down');
    error.hidden = true;
    card.appendChild(error);

    dom.on(one.input, 'input', function () {
      dom.setText(strength, strengthWords(one.input.value));
    });

    actions('Continue', function (button) {
      if (one.input.value.length < 8) return fail(error, 'Use at least eight characters.');
      if (one.input.value !== two.input.value) return fail(error, 'The two passwords do not match.');
      error.hidden = true;
      draft.password = one.input.value;
      if (draft.path === 'import') return go(5);

      window.PhosphorShell.setPending(button, true, 'Making your wallet');
      api.walletCreate(draft.password)
        .then(function (answer) {
          if (answer && answer.ok === false) {
            fail(error, walletProblem(answer.error));
            return;
          }
          /* The words come back exactly once, on this response, and are never
             served again. They live in this page's memory until the flow ends
             and nowhere else. */
          draft.mnemonic = Array.isArray(answer.mnemonic) ? answer.mnemonic : [];
          draft.addresses = answer.addresses || null;
          go(3);
        })
        .catch(function (err) { fail(error, net.readable(err)); })
        .finally(function () { window.PhosphorShell.setPending(button, false); });
    });
  }

  /* 4 */
  function screenWords() {
    card.appendChild(dom.el('h1', 'title', 'Save your recovery words'));
    card.appendChild(dom.el('p', 'body dim', 'These twelve words are the only way back to this wallet. Anyone who has them has your money.'));

    var grid = dom.el('ol', 'words');
    for (var i = 0; i < draft.mnemonic.length; i += 1) {
      var item = dom.el('li', 'word');
      item.appendChild(dom.el('span', 'meta mono', String(i + 1)));
      item.appendChild(dom.el('span', 'body mono', draft.mnemonic[i]));
      grid.appendChild(item);
    }
    card.appendChild(grid);

    var tools = dom.el('div', 'hstack-2');
    var copy = dom.el('button', 'btn btn-ghost');
    copy.appendChild(dom.el('span', 'btn-label', 'Copy'));
    var print = dom.el('button', 'btn btn-ghost');
    print.appendChild(dom.el('span', 'btn-label', 'Print'));
    tools.appendChild(copy);
    tools.appendChild(print);
    card.appendChild(tools);

    dom.on(copy, 'click', function () {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(draft.mnemonic.join(' ')).then(function () {
        dom.setText(copy.querySelector('.btn-label'), 'Copied');
      });
    });
    dom.on(print, 'click', function () { window.print(); });

    var check = dom.el('label', 'checkline');
    var box = dom.el('input');
    box.type = 'checkbox';
    check.appendChild(box);
    check.appendChild(dom.el('span', 'body', 'I have saved these somewhere that is not this computer.'));
    card.appendChild(check);

    var primary = actions('Continue', function () { go(4); }, { disabled: true });
    dom.on(box, 'change', function () { primary.disabled = !box.checked; });
  }

  /* 5 */
  function screenProve() {
    if (draft.path === 'import') return screenImport();
    card.appendChild(dom.el('h1', 'title', 'Prove it'));
    card.appendChild(dom.el('p', 'body dim', 'Type three of your words back, by their number.'));

    var picks = [2, 6, 10];
    var inputs = [];
    for (var i = 0; i < picks.length; i += 1) {
      var f = field('Word ' + (picks[i] + 1), 'off');
      f.input.type = 'text';
      card.appendChild(f.node);
      inputs.push(f.input);
    }

    var error = dom.el('p', 'body down');
    error.hidden = true;
    card.appendChild(error);
    var tries = 0;

    actions('Continue', function () {
      var ok = true;
      for (var i = 0; i < picks.length; i += 1) {
        if (inputs[i].value.trim().toLowerCase() !== draft.mnemonic[picks[i]]) ok = false;
      }
      if (ok) {
        error.hidden = true;
        go(5);
        return;
      }
      tries += 1;
      /* Wrong twice shows the list again rather than locking the person out. */
      if (tries >= 2) {
        go(3);
        return;
      }
      fail(error, 'One of those is not right. Check your list and try again.');
    });
  }

  function screenImport() {
    card.appendChild(dom.el('h1', 'title', 'Bring your wallet in'));
    card.appendChild(dom.el('p', 'body dim', 'Type your twelve recovery words, separated by spaces.'));
    var f = field('Recovery words', 'off');
    f.input.type = 'text';
    card.appendChild(f.node);
    var error = dom.el('p', 'body down');
    error.hidden = true;
    card.appendChild(error);

    actions('Continue', function (button) {
      var words = f.input.value.trim().split(/\s+/);
      if (words.length !== 12) return fail(error, 'That is ' + words.length + ' words. It should be twelve.');
      error.hidden = true;
      window.PhosphorShell.setPending(button, true, 'Bringing your wallet in');
      api.walletImport({ password: draft.password, mnemonic: words.join(' ') })
        .then(function (answer) {
          if (answer && answer.ok === false) {
            fail(error, walletProblem(answer.error));
            return;
          }
          draft.addresses = answer.addresses || null;
          go(5);
        })
        .catch(function (err) { fail(error, net.readable(err)); })
        .finally(function () { window.PhosphorShell.setPending(button, false); });
    });
  }

  /* 6 */
  function screenAddresses() {
    card.appendChild(dom.el('h1', 'title', 'Your addresses'));
    var body = dom.el('div', 'stack');
    card.appendChild(body);
    window.PhosphorMoneyIn.render(body);
    actions('Continue', function () { go(6); });
  }

  /* 7 */
  function screenMoney() {
    card.appendChild(dom.el('h1', 'title', 'Add money'));
    var state = window.PhosphorState.get() || {};
    var total = (state.wallet && state.wallet.totalUsd) || 0;
    var value = dom.el('p', 'balance mono');
    dom.setText(value, dom.usd(total));
    card.appendChild(value);
    card.appendChild(dom.el('p', 'body dim', total > 0
      ? 'Your money is here.'
      : 'Send anything to one of your addresses and it will appear here.'));

    if (total === 0) {
      var waiting = dom.el('div', 'hstack-2');
      waiting.appendChild(dom.el('span', 'spinner'));
      waiting.appendChild(dom.el('span', 'meta', 'Watching for a deposit'));
      card.appendChild(waiting);
    }

    actions('Continue', function () { go(7); }, {
      skip: 'Do this later'
    });
    card.appendChild(dom.el('p', 'meta', 'You can do this later. Your assistant cannot do anything useful until you do.'));
  }

  /* 8 */
  function screenConnect() {
    card.appendChild(dom.el('h1', 'title', 'Connect your assistant'));

    var built = dom.el('div', 'stack-2 connect-block');
    built.appendChild(dom.el('p', 'title-sm', 'Use the one built in'));
    var start = dom.el('button', 'btn btn-primary');
    start.appendChild(dom.el('span', 'btn-label', 'Start it'));
    built.appendChild(start);
    built.appendChild(dom.el('p', 'meta', 'This uses the Claude subscription already on this computer. Phosphor never sees your login.'));
    card.appendChild(built);

    var own = dom.el('div', 'stack-2 connect-block');
    own.appendChild(dom.el('p', 'title-sm', 'Use your own'));
    var row = dom.el('div', 'field-row');
    var line = dom.el('input', 'input');
    line.type = 'text';
    line.readOnly = true;
    line.value = 'Reading the connection line';
    var copy = dom.el('button', 'btn btn-ghost');
    copy.appendChild(dom.el('span', 'btn-label', 'Copy'));
    row.appendChild(line);
    row.appendChild(copy);
    own.appendChild(row);
    own.appendChild(dom.el('p', 'meta', 'Paste this into your terminal.'));
    var status = dom.el('div', 'hstack-2');
    status.appendChild(dom.el('span', 'dot'));
    var statusText = dom.el('span', 'meta', 'Nothing is connected yet.');
    status.appendChild(statusText);
    own.appendChild(status);
    card.appendChild(own);

    api.connection().then(function (data) {
      if (!data || data.missing || !data.command) {
        line.value = 'The connection line is not available yet.';
        return;
      }
      line.value = data.command;
      if (Array.isArray(data.connected) && data.connected.length) {
        dom.setText(statusText, data.connected[0].name + ' is connected.');
      }
    }).catch(function () {
      line.value = 'The connection line is not available yet.';
    });

    dom.on(copy, 'click', function () {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(line.value).then(function () {
        dom.setText(copy.querySelector('.btn-label'), 'Copied');
      });
    });
    dom.on(start, 'click', function () {
      window.PhosphorShell.setPending(start, true, 'Starting');
      api.driver({ action: 'start', chat: '' })
        .catch(function (err) { window.PhosphorToast.show(net.readable(err), 'down'); })
        .finally(function () { window.PhosphorShell.setPending(start, false); });
    });

    actions('Continue', function () { go(8); }, { skip: 'Do this later' });
  }

  /* 9 */
  function screenThreshold() {
    card.appendChild(dom.el('h1', 'title', 'Set the ask threshold'));

    var line = dom.el('div', 'hstack-2 threshold-line');
    line.appendChild(dom.el('span', 'body', 'Ask me before anything above'));
    var input = dom.el('input', 'input threshold-input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.value = String(draft.threshold);
    line.appendChild(input);
    card.appendChild(line);

    var presets = dom.el('div', 'hstack-2');
    [25, 100, 500].forEach(function (value) {
      var chip = dom.el('button', 'chip');
      chip.type = 'button';
      chip.appendChild(dom.el('span', '', '$' + value));
      presets.appendChild(chip);
      dom.on(chip, 'click', function () {
        input.value = String(value);
        draft.threshold = value;
      });
    });
    card.appendChild(presets);

    card.appendChild(dom.el('p', 'body dim', 'Below this, your limits decide on their own. Above it, nothing happens until you click.'));
    card.appendChild(dom.el('p', 'meta', 'You can change this any time. Changing it needs a click too.'));

    actions('Continue', function () {
      var value = parseInt(input.value, 10);
      draft.threshold = isFinite(value) && value > 0 ? value : 100;
      go(9);
    });
  }

  /* 10 */
  function screenDone() {
    card.appendChild(dom.el('h1', 'title', 'Done'));
    card.appendChild(dom.el('p', 'body', 'Your money is here. Your assistant is connected. Nothing moves unless you say so.'));
    actions('Open Phosphor', function () {
      close();
      window.PhosphorShell.setView('basic', { fromClick: true });
    }, { back: false });
  }

  /* ---------- helpers ---------- */

  function walletProblem(code) {
    if (code === 'wrong_password') return 'That password did not work.';
    if (code === 'exists') return 'There is already a wallet on this computer.';
    if (code === 'no_wallet') return 'There is no wallet on this computer.';
    return 'That did not work.';
  }

  /* A password input carries a name and an autocomplete hint so a password
     manager can offer to save it. The card is not a form because the flow's
     Continue moves between screens rather than submitting one. */
  function field(label, autocomplete) {
    var node = dom.el('div', 'field');
    node.appendChild(dom.el('label', 'label', label));
    var input = dom.el('input', 'input');
    input.type = 'password';
    input.name = autocomplete === 'off' ? 'word' : 'password';
    input.autocomplete = autocomplete;
    node.appendChild(input);
    return { node: node, input: input };
  }

  function fail(node, message) {
    dom.setText(node, message);
    node.hidden = false;
  }

  /* A strength line in words, not a bar. A bar tells a person a colour; a
     sentence tells them what to do about it. */
  function strengthWords(value) {
    var text = String(value || '');
    if (!text) return '';
    if (text.length < 8) return 'Too short. Use at least eight characters.';
    var classes = 0;
    if (/[a-z]/.test(text)) classes += 1;
    if (/[A-Z]/.test(text)) classes += 1;
    if (/[0-9]/.test(text)) classes += 1;
    if (/[^A-Za-z0-9]/.test(text)) classes += 1;
    if (text.length >= 16) return 'Long enough that length alone protects it.';
    if (classes >= 3) return 'Good. A mix this varied is hard to guess.';
    if (classes === 2) return 'Fine. A few more characters would be better.';
    return 'Weak. Add another kind of character, or make it longer.';
  }

  window.PhosphorFirstRun = {
    boot: boot,
    open: open,
    close: close,
    strengthWords: strengthWords
  };
})();

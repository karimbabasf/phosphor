/* Your vault's two small accounts: the allowance your assistant spends with
   no Touch ID, and the gas account that pays NEAR's fee for every move of
   the vault. Both are rows of Your vault (ui/screens/vault.js), drawn with
   the Vault's own pieces (`kit`), under the move (ui/screens/chip.js).

   THE ALLOWANCE (src/vault/allowance.ts, src/http/allowance.ts). Once the
   vault has moved, every swap, send, payout and Hyperliquid deposit spends
   from it. Its row says how much it holds of its size ("$63 of $100"), the
   sweep in one line, and offers a top-up when it falls under a quarter of
   its size. A top-up is only asked for here: it lands as a card in the
   conversation that waits for a click, and then one Touch ID that names the
   amount moves it from the vault. The assistant has no way to ask for one.

   THE GAS ACCOUNT (src/vault/gas-account.ts). Its id is derived from the
   wallet's key, never typed, and a payout to it is the way this app sends
   NEAR there: one click on its card and one Touch ID that names the gas
   account. Low means a vault move would be refused before anything is
   signed, so the row says so beside the way to fill it. A vault NEAR shows
   on another Mac's keys cannot pay it (state.vault.chip.elsewhere): the row
   then shows the account whole, to send NEAR to it from any NEAR wallet.
   Add NEAR does the same when what the payout would come from, the vault or
   after the move the allowance, holds no NEAR (state.vault.chip.sourceNear),
   with the swap that would fill it. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var net = window.PhosphorNet;

  // A top-up is offered under a quarter of the size (src/vault/allowance.ts LOW_SHARE).
  var LOW_SHARE = 0.25;
  // What the allowance may hold before the sweep sends the rest home: its size plus 10 percent.
  var OVER = 1.1;
  var TOP_UPS = [25, 50];
  var SIZES = [25, 50, 100, 250, 500];
  // One funding pays 0.1 to 1 NEAR (src/vault/gas-account.ts GAS_FUND_MIN_NEAR, GAS_FUND_MAX_NEAR).
  var GAS_CHOICES = [0.25, 0.5, 1];
  var GAS_MIN = 0.1;
  var GAS_MAX = 1;
  var WAITING = ['pending', 'pending_unlock', 'awaiting_touch'];

  var kit = null;
  var refs = {};
  var mounted = false;
  var slice = null;
  var current = {};
  // The last ask from each row, said under it while its card still waits.
  var asked = { allowance: null, gas: null };
  // Add NEAR found nothing to pay the gas account from, and the account shows whole instead.
  var direct = false;

  function button(label, kind, pending) {
    var node = dom.el('button', 'btn ' + (kind || 'btn-ghost btn-sm'));
    node.type = 'button';
    node.appendChild(dom.el('span', 'btn-label', label));
    if (pending) dom.setAttr(node, 'data-pending-label', pending);
    return node;
  }

  function setPending(node, on) {
    var shell = window.PhosphorShell;
    if (shell && typeof shell.setPending === 'function') shell.setPending(node, on);
    else node.disabled = !!on;
  }

  function refresh() {
    var shell = window.PhosphorShell;
    return shell && typeof shell.refresh === 'function' ? Promise.resolve(shell.refresh({})) : Promise.resolve();
  }

  function numberOf(value) {
    var raw = String(value === undefined || value === null ? '' : value).replace(/[$,\s]/g, '');
    var n = Number(raw);
    return raw !== '' && isFinite(n) ? n : null;
  }

  function cents(n) {
    return Math.floor(n * 100 + 1e-6) / 100;
  }

  function nearWords(n) {
    return String(Number(n.toFixed(4))) + ' NEAR';
  }

  // A quiet line that names an account: the words in Geist, the id in Geist Mono.
  function idLine(before, after) {
    var line = dom.el('p', 'vault-sub');
    line.appendChild(dom.el('span', '', before));
    var id = dom.el('span', 'vault-id');
    line.appendChild(id);
    if (after) line.appendChild(dom.el('span', '', after));
    return { line: line, id: id };
  }

  function short(id) {
    var s = String(id || '');
    var prefix = s.indexOf('0x') === 0 ? '0x' : '';
    var body = s.slice(prefix.length);
    return body.length > 20 ? prefix + body.slice(0, 8) + '...' + body.slice(-8) : s;
  }

  /* A money field pressed into the card, with a row of amounts beside it as
     one choice: the Vault's ask line, for dollars or NEAR. */
  function amountLine(name, unit, words) {
    var line = dom.el('div', 'vault-ask-line');
    var well = dom.el('label', 'vault-money');
    if (unit === '$') well.appendChild(dom.el('span', 'vault-money-sign', '$'));
    var input = dom.el('input', 'vault-money-input num');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.name = name;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', words);
    well.appendChild(input);
    if (unit !== '$') well.appendChild(dom.el('span', 'vault-money-sign', unit));
    line.appendChild(well);
    var chips = dom.el('div', 'vault-chips');
    chips.setAttribute('role', 'radiogroup');
    chips.setAttribute('aria-label', 'Common amounts');
    line.appendChild(chips);
    return { line: line, input: input, chips: chips };
  }

  function fillChips(field, values, words, pick) {
    dom.clear(field.chips);
    values.forEach(function (value) {
      var chip = dom.el('button', 'vault-chip num');
      chip.type = 'button';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', 'false');
      chip.dataset.value = String(value);
      chip.appendChild(dom.el('span', '', words(value)));
      dom.on(chip, 'click', function () {
        field.input.value = String(value);
        markChips(field);
        if (pick) pick();
      });
      field.chips.appendChild(chip);
    });
  }

  function markChips(field) {
    var typed = numberOf(field.input.value);
    var chips = field.chips.querySelectorAll('.vault-chip');
    for (var i = 0; i < chips.length; i += 1) {
      dom.setAttr(chips[i], 'aria-checked', typed !== null && Math.abs(Number(chips[i].dataset.value) - typed) < 1e-9 ? 'true' : 'false');
    }
  }

  /* ---------- the page ---------- */

  function mount(host, pieces) {
    if (mounted) return;
    kit = pieces;
    mounted = true;
    buildAllowance(host);
    buildGas(host);
  }

  function render(state, chipSlice) {
    if (!mounted) return;
    current = state || {};
    slice = chipSlice || null;
    settleAsks();
    paintAllowance();
    paintGas();
  }

  /* An ask's line stays while its card waits for the click, and goes once the
     card has its answer: the card says what happened. A card that never
     waited (the app could not set it up) keeps its line, which says where
     the reason is. */
  function settleAsks() {
    var rows = Array.isArray(current.proposals) ? current.proposals : [];
    ['allowance', 'gas'].forEach(function (which) {
      var ask = asked[which];
      if (!ask || !ask.id || !ask.waits) return;
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].id === ask.id) {
          if (WAITING.indexOf(rows[i].status) < 0) asked[which] = null;
          return;
        }
      }
    });
  }

  /* ---------- the allowance ---------- */

  function buildAllowance(host) {
    var r = kit.row('Allowance', 'allowance');
    r.node.setAttribute('data-reveal', 'allowance');
    refs.allow = r.node;
    refs.allowValue = dom.el('span', 'vault-row-value num');
    r.act.appendChild(refs.allowValue);
    refs.allowLine = kit.text();
    r.main.appendChild(refs.allowLine);
    refs.allowLow = dom.el('p', 'vault-warn');
    kit.append(refs.allowLow, kit.icon('warning', 'icon-16'));
    refs.allowLowText = dom.el('span', '');
    refs.allowLow.appendChild(refs.allowLowText);
    r.main.appendChild(refs.allowLow);
    refs.allowAccount = idLine('Account ');
    r.main.appendChild(refs.allowAccount.line);
    refs.allowAsked = kit.text('vault-sub');
    refs.allowAsked.setAttribute('role', 'status');
    r.main.appendChild(refs.allowAsked);
    var tools = dom.el('div', 'vault-actions');
    refs.topUpOpen = button('Top up', 'btn-ghost btn-sm');
    refs.sizeOpen = button('Change size', 'btn-quiet btn-sm');
    tools.appendChild(refs.topUpOpen);
    tools.appendChild(refs.sizeOpen);
    r.main.appendChild(tools);
    dom.on(refs.topUpOpen, 'click', openTopUp);
    dom.on(refs.sizeOpen, 'click', openSize);

    /* The top-up, in place: the amount, its card and its one Touch ID. */
    var top = dom.el('form', 'vault-confirm vault-topup');
    top.hidden = true;
    top.appendChild(dom.el('p', 'vault-confirm-text', 'From your vault\'s USDC. Its card in the conversation waits for your click, then one Touch ID names the amount.'));
    refs.topUpField = amountLine('top-up', '$', 'Top up, in dollars');
    top.appendChild(refs.topUpField.line);
    refs.topUpRoom = kit.text('vault-sub');
    top.appendChild(refs.topUpRoom);
    refs.topUpError = kit.problem();
    top.appendChild(refs.topUpError);
    var topTools = dom.el('div', 'vault-actions');
    refs.topUpGo = dom.el('button', 'btn btn-sm');
    refs.topUpGo.type = 'submit';
    refs.topUpGo.appendChild(dom.el('span', 'btn-label', 'Top up'));
    dom.setAttr(refs.topUpGo, 'data-pending-label', 'Asking');
    var topCancel = button('Cancel', 'btn-quiet btn-sm');
    topTools.appendChild(refs.topUpGo);
    topTools.appendChild(topCancel);
    top.appendChild(topTools);
    r.body.appendChild(top);
    refs.topUp = top;
    dom.on(refs.topUpField.input, 'input', function () {
      markChips(refs.topUpField);
      labelTopUp();
    });
    dom.on(topCancel, 'click', function () { close(refs.topUp, refs.topUpOpen); });
    dom.on(top, 'submit', function (event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      askTopUp();
    });

    /* The size, in place: what the assistant may spend with no Touch ID. */
    var size = dom.el('form', 'vault-confirm vault-size');
    size.hidden = true;
    size.appendChild(dom.el('p', 'vault-confirm-text', 'Your assistant spends up to this with no Touch ID. Anything over it plus 10 percent goes back to your vault on its own. Type 0 to turn it off.'));
    refs.sizeField = amountLine('allowance-size', '$', 'Allowance size, in dollars');
    fillChips(refs.sizeField, SIZES, kit.usdShort);
    size.appendChild(refs.sizeField.line);
    refs.sizeError = kit.problem();
    size.appendChild(refs.sizeError);
    var sizeTools = dom.el('div', 'vault-actions');
    refs.sizeGo = dom.el('button', 'btn btn-sm');
    refs.sizeGo.type = 'submit';
    refs.sizeGo.appendChild(dom.el('span', 'btn-label', 'Save'));
    dom.setAttr(refs.sizeGo, 'data-pending-label', 'Saving');
    var sizeCancel = button('Cancel', 'btn-quiet btn-sm');
    sizeTools.appendChild(refs.sizeGo);
    sizeTools.appendChild(sizeCancel);
    size.appendChild(sizeTools);
    r.body.appendChild(size);
    refs.size = size;
    dom.on(refs.sizeField.input, 'input', function () { markChips(refs.sizeField); });
    dom.on(sizeCancel, 'click', function () { close(refs.size, refs.sizeOpen); });
    dom.on(size, 'submit', function (event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      saveSize();
    });

    refs.allow.hidden = true;
    host.appendChild(r.node);
  }

  function allowanceOf() {
    var a = slice && slice.allowance;
    return a && typeof a === 'object' && typeof a.sizeUsd === 'number' ? a : null;
  }

  // What a top-up may add: the size plus 10 percent, less what the allowance holds.
  function roomOf(a) {
    if (!a || typeof a.balanceUsd !== 'number') return null;
    return Math.max(0, cents(a.sizeUsd * OVER - a.balanceUsd));
  }

  function fillOf(a) {
    if (!a || typeof a.balanceUsd !== 'number') return null;
    var fill = cents(a.sizeUsd - a.balanceUsd);
    return fill > 0 ? fill : null;
  }

  function paintAllowance() {
    var a = allowanceOf();
    dom.setHidden(refs.allow, !a);
    if (!a) return;
    var size = a.sizeUsd;
    var balance = typeof a.balanceUsd === 'number' ? a.balanceUsd : null;
    var off = size <= 0;
    var low = !off && balance !== null && balance < size * LOW_SHARE;
    dom.setText(refs.allowValue, off ? 'Off' : (balance === null ? 'Size ' + kit.usdShort(size) : kit.usdShort(cents(balance)) + ' of ' + kit.usdShort(size)));
    dom.setText(refs.allowLine, off
      ? 'Your assistant spends nothing without your Touch ID, and anything in the allowance goes back to your vault on its own.'
      : 'What your assistant spends with no Touch ID. Anything over ' + kit.usdShort(cents(size * OVER)) + ' goes back to your vault on its own, USDC first.');
    dom.setText(refs.allowLowText, balance === null
      ? 'Phosphor could not read the allowance just now. It reads it again in a moment.'
      : cents(balance) === 0
        ? 'Empty. Top it up from your vault so your assistant can spend without a Touch ID.'
        : 'Running low: under a quarter of its size. Top it up from your vault.');
    dom.setHidden(refs.allowLow, !(low || (balance === null && !off)));
    dom.setText(refs.allowAccount.id, a.account ? short(a.account) : '');
    dom.setHidden(refs.allowAccount.line, !a.account);
    dom.setText(refs.allowAsked, asked.allowance ? asked.allowance.line : '');
    dom.setHidden(refs.allowAsked, !asked.allowance);
    refs.topUpOpen.className = 'btn ' + (low ? 'btn-ghost btn-sm' : 'btn-quiet btn-sm');
    var room = roomOf(a);
    var formsShut = refs.topUp.hidden && refs.size.hidden;
    dom.setHidden(refs.topUpOpen, off || (room !== null && room < 0.01) || !formsShut);
    dom.setHidden(refs.sizeOpen, !formsShut);
  }

  function open(form, focus) {
    kit.grow(refs.allow, function () {
      dom.setHidden(form, false);
      paintAllowance();
      if (focus && focus.focus) focus.focus();
    }, form);
  }

  function close(form, back) {
    if (!form || form.hidden) return false;
    var row = form === refs.gasAdd ? refs.gas : refs.allow;
    kit.shrink(row, form, function () {
      dom.setHidden(form, true);
      paintAllowance();
      paintGas();
      if (back && !back.hidden && back.focus) back.focus();
    }, back);
    return true;
  }

  function openTopUp() {
    var a = allowanceOf();
    if (!a) return;
    asked.allowance = null;
    var fill = fillOf(a);
    var room = roomOf(a);
    var choices = TOP_UPS.filter(function (v) { return room === null || v <= room; });
    if (fill !== null && choices.indexOf(fill) < 0) choices.push(fill);
    fillChips(refs.topUpField, choices, function (v) { return v === fill ? 'Fill to ' + kit.usdShort(a.sizeUsd) : kit.usdShort(v); }, labelTopUp);
    refs.topUpField.input.value = String(fill !== null ? fill : (choices[0] || ''));
    markChips(refs.topUpField);
    labelTopUp();
    dom.setText(refs.topUpRoom, room === null ? '' : 'Up to ' + kit.usdShort(room) + ' now: more would go straight back to your vault.');
    dom.setHidden(refs.topUpRoom, room === null);
    kit.say(refs.topUpError, '');
    open(refs.topUp, refs.topUpField.input);
  }

  // From the moment the vault moved (ui/screens/chip.js): the allowance's row, its top-up open.
  function topUp() {
    if (!mounted || !allowanceOf()) return;
    kit.bringIntoView(refs.allow);
    if (refs.topUp.hidden) openTopUp();
    else if (refs.topUpField.input.focus) refs.topUpField.input.focus();
  }

  function labelTopUp() {
    var n = numberOf(refs.topUpField.input.value);
    dom.setText(refs.topUpGo.querySelector('.btn-label'), n !== null && n > 0 ? 'Top up ' + kit.usdShort(cents(n)) : 'Top up');
  }

  function askTopUp() {
    var a = allowanceOf();
    var n = numberOf(refs.topUpField.input.value);
    if (n === null || n <= 0) {
      kit.say(refs.topUpError, 'Type a number of dollars above 0.');
      return;
    }
    var usd = cents(n);
    var room = roomOf(a);
    if (room !== null && usd > room) {
      kit.say(refs.topUpError, 'That is more than the allowance can hold. Up to ' + kit.usdShort(room) + ' now.');
      return;
    }
    kit.say(refs.topUpError, '');
    setPending(refs.topUpGo, true);
    var low = !!a && typeof a.balanceUsd === 'number' && a.balanceUsd < a.sizeUsd * LOW_SHARE;
    net.postJson('/api/vault/allowance/top-up', { usd: usd, why: low ? 'low' : 'manual' })
      .then(function (answer) {
        if (!answer || answer.ok !== true) {
          kit.say(refs.topUpError, kit.refusalWords(answer, 'Phosphor could not ask for that top-up. Try again.'));
          return null;
        }
        var p = answer.proposal || {};
        var waits = WAITING.indexOf(p.status) >= 0 || !p.status;
        asked.allowance = {
          id: typeof p.id === 'string' ? p.id : null,
          waits: waits,
          line: waits
            ? 'Your top-up of ' + kit.usdShort(usd) + ' is on its card in the conversation. Approve it there; its Touch ID names the amount.'
            : 'Its card in the conversation says why the top-up of ' + kit.usdShort(usd) + ' did not go ahead.'
        };
        close(refs.topUp, refs.topUpOpen);
        return refresh();
      })
      .catch(function (err) { kit.say(refs.topUpError, routeWords(err)); })
      .finally(function () { setPending(refs.topUpGo, false); });
  }

  /* The allowance routes refuse with a sentence written for a person (a 400
     or a 409, src/http/allowance.ts); it reaches the screen only if it reads
     as one. Anything else is the app not answering. */
  function routeWords(err) {
    var own = err && (err.status === 400 || err.status === 409) ? String(err.message || '') : '';
    return own ? kit.refusalWords({ error: own }, net.readable(err)) : net.readable(err);
  }

  function openSize() {
    var a = allowanceOf();
    if (!a) return;
    refs.sizeField.input.value = String(a.sizeUsd);
    markChips(refs.sizeField);
    kit.say(refs.sizeError, '');
    open(refs.size, refs.sizeField.input);
  }

  function saveSize() {
    var n = numberOf(refs.sizeField.input.value);
    if (n === null || n < 0) {
      kit.say(refs.sizeError, 'Type a number of dollars, 0 or more.');
      return;
    }
    kit.say(refs.sizeError, '');
    setPending(refs.sizeGo, true);
    net.postJson('/api/vault/allowance/size', { usd: cents(n) })
      .then(function (answer) {
        if (!answer || answer.ok !== true) {
          kit.say(refs.sizeError, kit.refusalWords(answer, 'Phosphor could not save that size. Try again.'));
          return null;
        }
        asked.allowance = { id: null, line: 'Your allowance is now ' + kit.usdShort(answer.sizeUsd) + '. Anything over it plus 10 percent goes back to your vault.' };
        close(refs.size, refs.sizeOpen);
        return refresh();
      })
      .catch(function (err) { kit.say(refs.sizeError, routeWords(err)); })
      .finally(function () { setPending(refs.sizeGo, false); });
  }

  /* ---------- the gas account ---------- */

  function buildGas(host) {
    var r = kit.row('Gas account', 'gas');
    r.node.setAttribute('data-reveal', 'gas');
    refs.gas = r.node;
    refs.gasValue = dom.el('span', 'vault-row-value num');
    r.act.appendChild(refs.gasValue);
    refs.gasLine = kit.text('vault-text', 'Pays NEAR\'s small fee for every move of your vault.');
    r.main.appendChild(refs.gasLine);
    refs.gasLow = dom.el('p', 'vault-warn');
    kit.append(refs.gasLow, kit.icon('warning', 'icon-16'));
    refs.gasLowText = dom.el('span', '');
    refs.gasLow.appendChild(refs.gasLowText);
    r.main.appendChild(refs.gasLow);
    refs.gasId = idLine('A payout to it names ', ' in its Touch ID.');
    r.main.appendChild(refs.gasId.line);
    /* This Mac pays nothing to it (the vault opens with another Mac's key),
       or what the payout would come from holds no NEAR: the account is shown
       whole, to send NEAR to it straight. */
    refs.gasElsewhere = dom.el('div', 'vault-gas-elsewhere');
    refs.gasDirectLine = kit.text('vault-sub');
    refs.gasElsewhere.appendChild(refs.gasDirectLine);
    refs.gasWhole = dom.el('p', 'vault-mono');
    refs.gasElsewhere.appendChild(refs.gasWhole);
    var copyTools = dom.el('div', 'vault-actions');
    refs.gasCopy = button('Copy', 'btn-quiet btn-sm');
    copyTools.appendChild(refs.gasCopy);
    refs.gasElsewhere.appendChild(copyTools);
    refs.gasCopied = kit.text('vault-sub');
    refs.gasCopied.setAttribute('role', 'status');
    refs.gasCopied.hidden = true;
    refs.gasElsewhere.appendChild(refs.gasCopied);
    refs.gasSwap = kit.text('vault-sub', 'Or ask your assistant to swap a little USDC to NEAR (0.5 NEAR is enough), then add it here.');
    refs.gasElsewhere.appendChild(refs.gasSwap);
    refs.gasElsewhere.hidden = true;
    r.main.appendChild(refs.gasElsewhere);
    dom.on(refs.gasCopy, 'click', copyGas);
    refs.gasAsked = kit.text('vault-sub');
    refs.gasAsked.setAttribute('role', 'status');
    r.main.appendChild(refs.gasAsked);
    var tools = dom.el('div', 'vault-actions');
    refs.gasOpen = button('Add NEAR', 'btn-ghost btn-sm');
    tools.appendChild(refs.gasOpen);
    r.main.appendChild(tools);
    dom.on(refs.gasOpen, 'click', function () { openGas(); });

    var add = dom.el('form', 'vault-confirm vault-gas-add');
    add.hidden = true;
    refs.gasFrom = dom.el('p', 'vault-confirm-text');
    add.appendChild(refs.gasFrom);
    refs.gasField = amountLine('gas-near', 'NEAR', 'NEAR for the gas account');
    fillChips(refs.gasField, GAS_CHOICES, function (v) { return String(v); }, labelGas);
    add.appendChild(refs.gasField.line);
    refs.gasError = kit.problem();
    add.appendChild(refs.gasError);
    var addTools = dom.el('div', 'vault-actions');
    refs.gasGo = dom.el('button', 'btn btn-sm');
    refs.gasGo.type = 'submit';
    refs.gasGo.appendChild(dom.el('span', 'btn-label', 'Add NEAR'));
    dom.setAttr(refs.gasGo, 'data-pending-label', 'Asking');
    var addCancel = button('Cancel', 'btn-quiet btn-sm');
    addTools.appendChild(refs.gasGo);
    addTools.appendChild(addCancel);
    add.appendChild(addTools);
    r.body.appendChild(add);
    refs.gasAdd = add;
    dom.on(refs.gasField.input, 'input', function () {
      markChips(refs.gasField);
      labelGas();
    });
    dom.on(addCancel, 'click', function () { close(refs.gasAdd, refs.gasOpen); });
    dom.on(add, 'submit', function (event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      askGas();
    });

    refs.gas.hidden = true;
    host.appendChild(r.node);
  }

  function paintGas() {
    var on = !!slice;
    dom.setHidden(refs.gas, !on);
    if (!on) return;
    var gas = slice.gas && typeof slice.gas === 'object' ? slice.gas : null;
    var near = gas && typeof gas.near === 'string' ? gas.near : null;
    var empty = near !== null && Number(near) === 0;
    var low = !!gas && gas.low === true;
    dom.setText(refs.gasValue, near !== null ? near + ' NEAR' : '');
    // Before a move anyone asked for, an empty gas account is no worry: step 2 says what to do.
    var before = slice.state === 'none' || slice.state === 'ready';
    dom.setText(refs.gasLine, before ? 'Pays NEAR\'s small fee for every move of your vault, once you move it.' : 'Pays NEAR\'s small fee for every move of your vault.');
    dom.setText(refs.gasLowText, !gas
      ? 'Phosphor reads the gas account once the wallet has been open.'
      : near === null
        ? 'Phosphor could not read the gas account just now. It reads it again in a minute.'
        : empty
          ? 'Empty. Add NEAR before your vault can move.'
          : 'Low. Your vault\'s moves wait until it holds more NEAR.');
    dom.setHidden(refs.gasLow, before || !(low || !gas || near === null));
    if (direct && !nothingToPay()) direct = false;
    var straight = directOf();
    dom.setText(refs.gasDirectLine, straight === 'elsewhere'
      ? 'Your vault opens with another Mac\'s Touch ID key now, so this Mac cannot pay NEAR from it. Send 0.1 to 1 NEAR on NEAR straight to this account, from any NEAR wallet:'
      : (slice.state === 'done' ? 'Your allowance' : 'Your vault') + ' holds no NEAR yet. Send 0.1 to 1 NEAR on NEAR straight to this account, from any NEAR wallet:');
    dom.setHidden(refs.gasSwap, straight !== 'none');
    dom.setText(refs.gasId.id, gas && gas.account ? short(gas.account) : '');
    dom.setHidden(refs.gasId.line, !(gas && gas.account) || !!straight);
    dom.setText(refs.gasWhole, straight ? gas.account : '');
    dom.setHidden(refs.gasElsewhere, !straight);
    dom.setHidden(refs.gasCopy, !copier());
    if (!straight) dom.setHidden(refs.gasCopied, true);
    // A form opened before NEAR's word came: the payout it would ask for is refused, so it goes.
    if (straight === 'elsewhere' && !refs.gasAdd.hidden) dom.setHidden(refs.gasAdd, true);
    dom.setText(refs.gasAsked, asked.gas ? asked.gas.line : '');
    dom.setHidden(refs.gasAsked, !asked.gas);
    refs.gasOpen.className = 'btn ' + (low || !near ? 'btn-ghost btn-sm' : 'btn-quiet btn-sm');
    dom.setHidden(refs.gasOpen, !refs.gasAdd.hidden || !(gas && gas.account) || !!straight);
    // Where the NEAR comes from: the vault before the move, the allowance after it.
    dom.setText(refs.gasFrom, (slice.state === 'done'
      ? 'From your allowance, as a payout on NEAR.'
      : slice.state === 'broken'
        ? 'As a payout on NEAR.'
        : 'From your vault, as a payout on NEAR.') + ' Its card in the conversation waits for your click, then one Touch ID names the gas account.');
  }

  function labelGas() {
    var n = numberOf(refs.gasField.input.value);
    dom.setText(refs.gasGo.querySelector('.btn-label'), n !== null && n > 0 ? 'Add ' + nearWords(n) : 'Add NEAR');
  }

  /* Why NEAR goes to the gas account straight, when it does and the account
     has an id to show: NEAR shows the vault on another Mac's keys, or Add
     NEAR found nothing to pay it from. Null otherwise. */
  function directOf() {
    var gas = slice && slice.gas && typeof slice.gas === 'object' ? slice.gas : null;
    if (!gas || typeof gas.account !== 'string' || !gas.account) return null;
    if (slice.elsewhere === true) return 'elsewhere';
    return direct && nothingToPay() ? 'none' : null;
  }

  // The vault (before the move) or the allowance (after it) holds no NEAR, by the ledger's last read.
  function nothingToPay() {
    return !!slice && slice.sourceNear === 0 && slice.state !== 'broken' && slice.state !== 'checking';
  }

  function copier() {
    var pick = window.PhosphorNetPick;
    return !!pick && typeof pick.copyChecked === 'function';
  }

  // The account, copied and read back (ui/screens/netpick.js), so what lands is what is shown.
  function copyGas() {
    if (!directOf() || !copier()) return;
    window.PhosphorNetPick.copyChecked(slice.gas.account, function (words) {
      dom.setText(refs.gasCopied, words);
      dom.setHidden(refs.gasCopied, !words);
    }, 'account');
  }

  function openGas() {
    if (!mounted || !slice) return;
    kit.bringIntoView(refs.gas);
    // Nothing to pay it from: the account whole and the two ways to fill it, in place of the form.
    if (!directOf() && nothingToPay() && slice.gas && slice.gas.account) {
      asked.gas = null;
      kit.grow(refs.gas, function () {
        direct = true;
        dom.setHidden(refs.gasAdd, true);
        paintGas();
        if (refs.gasCopy.focus && !refs.gasCopy.hidden) refs.gasCopy.focus();
      }, refs.gasElsewhere);
      return;
    }
    if (directOf()) {
      if (refs.gasCopy.focus && !refs.gasCopy.hidden) refs.gasCopy.focus();
      return;
    }
    if (!refs.gasAdd.hidden) {
      if (refs.gasField.input.focus) refs.gasField.input.focus();
      return;
    }
    asked.gas = null;
    refs.gasField.input.value = '0.5';
    markChips(refs.gasField);
    labelGas();
    kit.say(refs.gasError, '');
    kit.grow(refs.gas, function () {
      dom.setHidden(refs.gasAdd, false);
      paintGas();
      if (refs.gasField.input.focus) refs.gasField.input.focus();
    }, refs.gasAdd);
  }

  function askGas() {
    var n = numberOf(refs.gasField.input.value);
    if (n === null || n < GAS_MIN || n > GAS_MAX || Number(n.toFixed(4)) !== n) {
      kit.say(refs.gasError, 'Add between 0.1 and 1 NEAR, with four places at most.');
      return;
    }
    kit.say(refs.gasError, '');
    setPending(refs.gasGo, true);
    net.postJson('/api/vault/gas/fund', { near: n })
      .then(function (answer) {
        if (!answer || answer.ok !== true) {
          kit.say(refs.gasError, kit.refusalWords(answer, 'Phosphor could not ask for that payout. Try again.'));
          // The vault is on another Mac's keys: the state that says so brings the account's id.
          return answer && answer.code === 'fund_elsewhere' ? refresh() : null;
        }
        var p = answer.proposal || {};
        var waits = WAITING.indexOf(p.status) >= 0 || !p.status;
        asked.gas = {
          id: typeof p.id === 'string' ? p.id : null,
          waits: waits,
          line: waits
            ? 'Your payout of ' + nearWords(n) + ' is on its card in the conversation. Approve it there; its Touch ID names the gas account.'
            : 'Its card in the conversation says why the payout of ' + nearWords(n) + ' did not go ahead.'
        };
        close(refs.gasAdd, refs.gasOpen);
        return refresh();
      })
      .catch(function (err) { kit.say(refs.gasError, net.readable(err)); })
      .finally(function () { setPending(refs.gasGo, false); });
  }

  // Escape puts away whatever this file has open, as the Vault's own rows do.
  function escape() {
    return close(refs.topUp, refs.topUpOpen) || close(refs.size, refs.sizeOpen) || close(refs.gasAdd, refs.gasOpen) || closeDirect();
  }

  // The account Add NEAR showed when there was nothing to pay it from goes away again.
  function closeDirect() {
    if (directOf() !== 'none') return false;
    kit.shrink(refs.gas, refs.gasElsewhere, function () {
      direct = false;
      paintGas();
      if (!refs.gasOpen.hidden && refs.gasOpen.focus) refs.gasOpen.focus();
    }, refs.gasOpen);
    return true;
  }

  // The tab left or the window locked: the asks' lines go, and the rows say what is true now.
  function rest() {
    asked.allowance = null;
    asked.gas = null;
    direct = false;
    if (!mounted) return;
    paintAllowance();
    paintGas();
  }

  window.PhosphorAllowance = {
    mount: mount,
    render: render,
    openGas: openGas,
    topUp: topUp,
    escape: escape,
    rest: rest
  };
})();

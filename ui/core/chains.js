(function () {
  /* The chain table, as the state frame last sent it. One copy for every card, because three
     cards each keeping five rows is how a payout on TON came out reading "ton". */
  var TABLE = {};

  /* The names a payout network went by before the window and the tools spoke one vocabulary.
     Proposals already written carry the long word, and a card drawn over that history has to
     name the chain exactly as it names a fresh one. */
  var OLD_NAMES = { ethereum: 'eth', arbitrum: 'arb', solana: 'sol', bitcoin: 'btc' };

  function set(rows) {
    if (!rows || typeof rows.length !== 'number') return;
    var next = {};
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      if (r && typeof r.id === 'string') next[r.id] = r;
    }
    TABLE = next;
  }

  function rowOf(id) {
    var key = String(id || '');
    return TABLE[key] || TABLE[OLD_NAMES[key]] || null;
  }

  /* The word, or the id itself when the frame has not landed yet. An id is a poor label and it
     is still better than an empty space where a chain should be. */
  function nameOf(id) {
    var row = rowOf(id);
    return row && row.name ? row.name : String(id || '');
  }

  function markOf(id) {
    var row = rowOf(id);
    return row && row.mark ? row.mark : '';
  }

  function colourOf(id) {
    var row = rowOf(id);
    return row && row.colour ? row.colour : '';
  }

  /* A name back to the id it was drawn from. The view names a place by its label and a draft
     names it by its id, so a card that compares the two needs the way back. */
  function idOf(name) {
    var text = String(name || '');
    for (var id in TABLE) {
      if (Object.prototype.hasOwnProperty.call(TABLE, id) && TABLE[id].name === text) return id;
    }
    return text;
  }

  window.PhosphorChains = { set: set, nameOf: nameOf, markOf: markOf, colourOf: colourOf, idOf: idOf };
})();

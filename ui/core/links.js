/* THE ONE LIST OF HOSTS THIS WINDOW WILL OPEN.

   There were three, and they disagreed: the send card knew six on an exact
   match, the receipt card knew seven on a suffix match, and the backend knew
   seven of its own (src/explorers.ts). So a hash on app.hyperliquid.xyz or on
   explorer.near-intents.org came back from the server as a link and the card
   printed it as plain text, and a fill mapped on the client became a link on
   any https host at all because the receipt checked the scheme alone.

   One list, suffix matched on a dot boundary, used by every card: subdomains
   count (sepolia.basescan.org is Basescan) and a host that merely ends in the
   letters does not (basescan.org.evil.com is nothing). The host comes from the
   URL parser rather than from the string, so an @, a backslash or a second
   scheme cannot smuggle one host past as another.

   Its own file, with nothing else in it and no side effect on load, because the
   three screens that ask it the question are loaded in three different orders
   and each of their tests builds its own window. */
(function () {
  'use strict';

  var HOSTS = [
    'basescan.org',
    'arbiscan.io',
    'etherscan.io',
    'solscan.io',
    'nearblocks.io',
    'mempool.space',
    'explorer.near-intents.org',
    'app.hyperliquid.xyz'
  ];

  /* The url when it is one this window opens, and null otherwise. Callers hand
     the answer straight to an href, so null is the only refusal there is. */
  function explorerUrl(url) {
    if (typeof url !== 'string' || url.slice(0, 8).toLowerCase() !== 'https://') return null;
    var host = '';
    try {
      var parsed = new URL(url);
      if (parsed.protocol !== 'https:') return null;
      host = parsed.hostname.toLowerCase();
    } catch (err) {
      return null;
    }
    for (var i = 0; i < HOSTS.length; i += 1) {
      var known = HOSTS[i];
      if (host === known || host.slice(-(known.length + 1)) === '.' + known) return url;
    }
    return null;
  }

  window.PhosphorLinks = {
    explorerUrl: explorerUrl,
    hosts: HOSTS
  };
})();

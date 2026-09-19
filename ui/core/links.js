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

   It is also the one place in ui/ that writes an href, and tests/unit/ui-links
   holds the window to that. Asking the list and then writing the anchor
   yourself is how the three disagreeing checks happened in the first place: the
   receipt kept a second link that checked nothing, in the same file as the one
   that was fixed, and nobody saw it for a release. A screen now hands over the
   anchor and the string the server sent, and a url off the list leaves the
   anchor with no href at all.

   Its own file, with nothing else in it and no side effect on load, because the
   screens that ask it the question are loaded in several different orders and
   each of their tests builds its own window. */
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

  /* The product's own pages, which the terms card links to off the same server
     frame as everything else. A separate list: an explorer is not the terms
     page, and a link to the terms page is not a link to a chain. */
  var SITES = [
    'phosphor.karimbabasf.com'
  ];

  function onList(url, hosts) {
    if (typeof url !== 'string' || url.slice(0, 8).toLowerCase() !== 'https://') return null;
    var host = '';
    try {
      var parsed = new URL(url);
      if (parsed.protocol !== 'https:') return null;
      host = parsed.hostname.toLowerCase();
    } catch (err) {
      return null;
    }
    for (var i = 0; i < hosts.length; i += 1) {
      var known = hosts[i];
      if (host === known || host.slice(-(known.length + 1)) === '.' + known) return url;
    }
    return null;
  }

  /* The url when it is one this window opens, and null otherwise. A caller that
     only wants to know whether there is somewhere to go asks these; a caller
     with an anchor in hand uses the two below. */
  function explorerUrl(url) {
    return onList(url, HOSTS);
  }

  function siteUrl(url) {
    return onList(url, SITES);
  }

  /* Refusing has to clear the attribute rather than skip it: an anchor being
     repainted (the deposit watcher reuses one node for every phase) would
     otherwise keep pointing at the url it was last given. */
  function write(anchor, safe) {
    if (safe === null) {
      anchor.removeAttribute('href');
      return false;
    }
    anchor.href = safe;
    return true;
  }

  /* Writes the href and says whether it did. */
  function setHref(anchor, url) {
    return write(anchor, explorerUrl(url));
  }

  function setSiteHref(anchor, url) {
    return write(anchor, siteUrl(url));
  }

  window.PhosphorLinks = {
    explorerUrl: explorerUrl,
    siteUrl: siteUrl,
    setHref: setHref,
    setSiteHref: setSiteHref,
    hosts: HOSTS,
    sites: SITES
  };
})();

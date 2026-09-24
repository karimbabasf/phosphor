// One sample per button family, built the way the screen builds it, so the sheet photographs
// the real stylesheet on the real structure rather than a bare <button> wearing the class.
//
// A recipe names the family (its class string as the screen writes it), the label the sample
// carries, the children the screen appends (in order, with their classes), the wrapper the
// stylesheet expects around it, and which extra states the family can enter beside the five
// every pressable has (rest, hover, active, focus, disabled): pending for anything that goes
// through PhosphorShell.setPending, and an "on" state for a control that stays lit
// (aria-selected, aria-pressed, aria-checked, aria-current, data-chosen, aria-expanded).
//
// Keep this list in step with the scan: the inventory script refuses to run the sheet when a
// scanned family has no recipe, so a new button family shows up here before it ships unseen.

export type Child = {
  tag: string;
  cls?: string;
  text?: string;
  icon?: string; // a name in ui/design/icons.js
  glyph?: string; // a name in ui/screens/cards.js GLYPHS, drawn on the same grid
  attrs?: Record<string, string>;
  children?: Child[];
};

export type Recipe = {
  family: string; // the class string, tokens in the order the screen writes them
  wrap?: string; // a class for the parent the stylesheet keys on (none: the column itself)
  wrapStyle?: string; // inline style for the wrapper when the parent's own rules need a nudge
  wide?: boolean; // a row that fills its column: the sample gets the whole column, one state per line
  wrapAttrs?: Record<string, string>; // attributes on the wrapper the stylesheet keys on
  attrs?: Record<string, string>;
  children: Child[];
  pending?: string; // the data-pending-label the screen sets, when it can wait
  on?: Record<string, string>; // the attribute that lights it, when it stays lit
  live?: boolean; // the dock's one breathing button: data-live="true" while the answer is the person's
  disables?: boolean; // the screen sets .disabled on it somewhere
  labelSelector?: string; // where the visible label lives, for the wrap and clip measurement
  iconOnly?: boolean; // no words on it: the label measures do not apply
  sentence?: boolean; // a row whose title is a sentence and wraps on a narrow column by design
};

const label = (text: string): Child => ({ tag: 'span', cls: 'btn-label', text });

export const RECIPES: readonly Recipe[] = [
  { family: 'btn btn-primary', children: [label('Yes')], pending: 'Approving', disables: true, live: true },
  { family: 'btn btn-primary btn-lg', children: [label('Create wallet')], pending: 'Waiting for Touch ID', disables: true },
  { family: 'btn btn-primary lock-unlock', wrap: 'lock-card', children: [label('Unlock')], pending: 'Unlocking', disables: true },
  { family: 'btn btn-ghost', children: [label('Keep running')] },
  { family: 'btn', children: [label('Start your assistant')], pending: 'Starting', disables: true },
  { family: 'btn btn-quiet btn-sm chat-sheet-go', wrap: 'chat-sheet-line', children: [label('Back it up')] },
  { family: 'btn btn-ghost mcard-cancel', wrap: 'mcard-buttons', children: [label('Cancel')], pending: 'Cancelling', disables: true },
  { family: 'btn btn-primary mcard-approve', wrap: 'mcard-buttons', children: [label('Approve')], pending: 'Approving', live: true, disables: true },
  { family: 'btn btn-ghost btn-sm mcard-retry', wrap: 'mcard-actions', children: [label('Try again')], disables: true },
  { family: 'btn btn-ghost btn-sm agent-retry', wrap: 'agent-note', children: [label('Retry')], pending: 'Starting', disables: true },
  { family: 'btn btn-ghost btn-lg', children: [label('Do this later')], disables: true },
  { family: 'btn btn-ghost btn-sm', children: [label('Try again')] },
  { family: 'btn btn-ghost btn-sm agent-connect-back', wrap: 'agent-connect-sheet', children: [label('Back')] },
  { family: 'btn btn-ghost btn-sm tcard-open', wrap: 'tcard-actions', children: [label('Open the deposit card')] },
  { family: 'btn btn-ghost btn-sm trade-more', children: [label('More')] },
  { family: 'btn btn-ghost activity-more', children: [label('Show more')], disables: true },
  { family: 'btn btn-ghost trade-act', children: [label('Close position')], on: { 'data-armed': 'true' }, disables: true },
  { family: 'btn btn-quiet', children: [label('Skip')] },
  { family: 'btn btn-quiet btn-sm', children: [label('Close')] },
  { family: 'btn btn-quiet btn-sm receipt-copy', children: [{ tag: 'svg', icon: 'copy' }, label('Copy')] },
  { family: 'btn btn-quiet btn-sm sendcard-copy', children: [label('Copy')] },
  { family: 'btn btn-quiet btn-sm tcard-copy', wrap: 'tcard-ref-value', wrapStyle: 'display: flex; align-items: center; gap: 4px', children: [label('Copy')] },
  { family: 'btn btn-sm', wrap: 'brake-actions', children: [label('Unfreeze')], pending: 'Unfreezing', disables: true },
  { family: 'btn btn-quiet btn-sm bal-done', wrap: 'bal-flow-head', children: [label('Done')] },
  { family: 'btn btn-lg', children: [label('Move my keys')], pending: 'Waiting for Touch ID', disables: true },
  { family: 'btn btn-ghost btn-sm pro-sum-fund', wrap: 'pro-sum-account', children: [label('Add some')] },
  { family: 'btn btn-ghost btn-sm agentrow-use', wrap: 'agentrow-act', attrs: { 'aria-label': 'Use Claude Code' }, children: [label('Use')], pending: 'Checking', disables: true },
  { family: 'btn btn-quiet btn-sm agentrow-copy', wrap: 'agentrow-cmd', children: [{ tag: 'svg', icon: 'copy' }, label('Copy')] },
  { family: 'btn btn-quiet btn-sm agentpick-again', wrap: 'agentpick-foot', children: [label('Check again')], pending: 'Checking' },
  { family: 'vault-seg-cell', wrap: 'vault-seg', attrs: { role: 'radio', 'aria-checked': 'false' }, children: [label('15 min')], pending: 'Saving', on: { 'aria-checked': 'true' }, labelSelector: '.btn-label' },
  { family: 'brake-btn', iconOnly: true, wrap: 'brake', attrs: { 'aria-label': 'Freeze everything', 'aria-expanded': 'false' }, children: [{ tag: 'svg', cls: 'icon' }], on: { 'aria-expanded': 'true' } },
  { family: 'notice-act', wrap: 'notice', children: [{ tag: 'span', text: 'Back it up' }], labelSelector: 'span' },
  { family: 'bal-add', wrap: 'bal-list', children: [{ tag: 'svg', icon: 'deposit', cls: 'icon' }, { tag: 'span', text: 'Add money' }], labelSelector: 'span' },
  { family: 'chip', children: [{ tag: 'span', text: '15 minutes' }], pending: 'Saving', on: { 'aria-pressed': 'true' }, labelSelector: 'span' },
  { family: 'chip suggest', wrap: 'suggestions', children: [{ tag: 'span', text: 'What do I hold?' }], labelSelector: 'span' },
  { family: 'chip connection-copy', wrap: 'connection-block', wrapStyle: 'position: relative; width: 320px; min-height: 52px', children: [label('Copy')] },
  { family: 'jump-latest', wrap: 'transcript-wrap', wrapStyle: 'position: relative; height: 48px', attrs: { 'data-on': 'true' }, children: [{ tag: 'svg', icon: 'chevron-down', cls: 'icon jump-glyph' }, label('Latest')] },
  { family: 'agent-waiting', wide: true, children: [{ tag: 'svg', icon: 'waiting', cls: 'icon agent-waiting-glyph' }, { tag: 'span', cls: 'agent-waiting-words', text: 'Waiting for your OK' }], labelSelector: '.agent-waiting-words' },
  { family: 'mcard-details-toggle', wrap: 'mcard-bar', attrs: { 'aria-expanded': 'false' }, children: [{ tag: 'svg', glyph: 'chevron', cls: 'mcard-details-chevron' }, { tag: 'span', text: 'Details' }], on: { 'aria-expanded': 'true' }, labelSelector: 'span' },
  { family: 'chip chip-filter', children: [{ tag: 'span', text: 'Swaps' }], on: { 'aria-pressed': 'true' }, labelSelector: 'span' },
  { family: 'tab', wrap: 'tabs', attrs: { role: 'tab', 'aria-selected': 'false' }, children: [{ tag: 'span', text: 'Basic' }], on: { 'aria-selected': 'true' }, labelSelector: 'span' },
  { family: 'layout opens', wrap: 'bar-end', attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, children: [{ tag: 'svg', icon: 'layout', cls: 'icon' }, { tag: 'span', text: 'Layout' }], on: { 'aria-expanded': 'true' }, labelSelector: 'span' },
  { family: 'composer-send', iconOnly: true, wrap: 'composer-field', attrs: { 'aria-label': 'Send' }, children: [{ tag: 'svg', icon: 'send', cls: 'icon composer-send-glyph' }, { tag: 'svg', icon: 'stop', cls: 'icon composer-stop-glyph' }], disables: true },
  { family: 'steps-fold', wide: true, wrap: 'steps-block', children: [{ tag: 'svg', glyph: 'chevron', cls: 'steps-chevron' }, { tag: 'span', cls: 'steps-fold-label', text: '3 steps' }, { tag: 'span', cls: 'steps-fold-names', text: 'wallet, proposals, show' }], on: { 'aria-expanded': 'true' }, labelSelector: '.steps-fold-label' },
  { family: 'checks-toggle', wide: true, wrap: 'checks', children: [{ tag: 'span', cls: 'checks-toggle-word', text: 'Checks' }, { tag: 'span', cls: 'checks-summary', text: '5 of 5 passed' }, { tag: 'svg', glyph: 'chevron', cls: 'checks-chevron' }], on: { 'aria-expanded': 'true' }, labelSelector: '.checks-toggle-word' },
  { family: 'dock-close', iconOnly: true, wrap: 'dock-head', attrs: { 'aria-label': 'Not now' }, children: [{ tag: 'svg', icon: 'close', cls: 'icon' }] },
  { family: 'choice', wrap: 'choices', children: [{ tag: 'span', cls: 'title-sm', text: 'Use Touch ID' }, { tag: 'span', cls: 'meta', text: 'The key lives in this Mac' }], on: { 'data-chosen': 'true' }, labelSelector: '.title-sm' },
  { family: 'lock-eye', iconOnly: true, wrap: 'lock-field', attrs: { 'aria-label': 'Show password', 'aria-pressed': 'false' }, children: [{ tag: 'svg', icon: 'show', cls: 'icon icon-20' }], on: { 'aria-pressed': 'true' } },
  { family: 'assetpick-tile', wide: true, wrap: 'assetpick-list', children: [{ tag: 'span', cls: 'logo', attrs: { style: '--logo: 24px', 'data-fallback': 'true' }, children: [{ tag: 'span', cls: 'logo-initial', text: 'U' }] }, { tag: 'div', cls: 'assetpick-words', children: [{ tag: 'p', cls: 'assetpick-ticker', text: 'USDC' }, { tag: 'p', cls: 'assetpick-note', text: 'the spot one' }] }, { tag: 'p', cls: 'assetpick-usd', text: '$1.00' }], labelSelector: '.assetpick-ticker' },
  { family: 'tcard-details-head', wide: true, wrap: 'tcard-details', attrs: { 'aria-expanded': 'false' }, children: [{ tag: 'svg', glyph: 'chevron', cls: 'tcard-details-chevron' }, { tag: 'span', cls: 'tcard-details-word', text: 'Details' }], on: { 'aria-expanded': 'true' }, labelSelector: '.tcard-details-word' },
  { family: 'net-tile', wide: true, wrap: 'netpick-grid', attrs: { 'data-network': 'arb', style: '--net: #2D374B; --net-accent: #12AAFF' }, children: [{ tag: 'span', cls: 'net-tile-mark', children: [{ tag: 'span', cls: 'logo', attrs: { style: '--logo: 28px', 'data-fallback': 'true' }, children: [{ tag: 'span', cls: 'logo-initial', text: 'A' }] }] }, { tag: 'span', cls: 'net-tile-name', text: 'Arbitrum' }], on: { 'aria-current': 'true' }, labelSelector: '.net-tile-name' },
  { family: 'netpick-link', wrap: 'netpick-netfoot', children: [{ tag: 'span', text: 'All networks' }], labelSelector: 'span' },
  { family: 'net-row', wide: true, wrap: 'net-list', attrs: { role: 'listitem', style: '--net: #2D374B' }, children: [{ tag: 'span', cls: 'logo', attrs: { style: '--logo: 24px', 'data-fallback': 'true' }, children: [{ tag: 'span', cls: 'logo-initial', text: 'B' }] }, { tag: 'div', cls: 'net-row-main', children: [{ tag: 'span', cls: 'net-row-name', text: 'Base' }, { tag: 'span', cls: 'net-row-words', text: 'Coinbase network' }] }], labelSelector: '.net-row-name' },
  { family: 'netpick-back', wrap: 'netpick-head', children: [{ tag: 'svg', icon: 'chevron-right', cls: 'icon netpick-back-icon' }, { tag: 'span', text: 'Change network' }], labelSelector: 'span' },
  { family: 'netsel', wrap: 'netsel-wrap', attrs: { 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': 'Which network' }, children: [{ tag: 'span', cls: 'netsel-mark' }, { tag: 'span', cls: 'netsel-name', text: 'Arbitrum' }, { tag: 'svg', icon: 'chevron-down', cls: 'icon chev-icon' }], on: { 'aria-expanded': 'true' }, labelSelector: '.netsel-name' },
  { family: 'receipt-close', iconOnly: true, wrap: 'receipt-head', attrs: { 'aria-label': 'Close' }, children: [{ tag: 'svg', icon: 'close', cls: 'icon' }] },
  { family: 'tx receipt-row', wide: true, sentence: true, wrap: 'receipt-rows', children: [{ tag: 'span', cls: 'tx-logos' }, { tag: 'span', cls: 'tx-title', text: 'Swapped 2 USDC to NEAR' }, { tag: 'span', cls: 'tx-when', text: '14:20' }, { tag: 'span', cls: 'tx-amount', text: '+0.94 NEAR', attrs: { 'data-dir': 'in' } }, { tag: 'span', cls: 'tx-sub', text: 'fee $0.01' }], labelSelector: '.tx-title' },
  { family: 'activity-link', children: [{ tag: 'span', text: 'Show all' }], labelSelector: 'span' },
  { family: 'sendcard-info', iconOnly: true, wrap: 'sendcard', attrs: { 'data-tip': 'The fee the venue charges', 'aria-label': 'The fee the venue charges' }, children: [{ tag: 'span', text: 'i' }] },
  { family: 'trade-tab', wrap: 'trade-tabs', attrs: { role: 'tab', 'aria-selected': 'false' }, children: [{ tag: 'span', cls: 'trade-tab-label', text: 'Positions' }, { tag: 'span', cls: 'trade-tab-count mono', text: '2' }], on: { 'aria-selected': 'true' }, labelSelector: '.trade-tab-label' },
  { family: 'layers opens', wrap: 'layers-wrap', attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, children: [{ tag: 'span', text: 'Layers' }, { tag: 'svg', icon: 'chevron-down', cls: 'icon chev-icon' }], on: { 'aria-expanded': 'true' }, labelSelector: 'span' },
  { family: 'trade-symbol opens', wrap: 'trade-symbol-wrap', attrs: { 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': 'Which market' }, children: [{ tag: 'span', cls: 'trade-symbol-logo' }, { tag: 'span', cls: 'trade-mark-coin', text: 'BTC' }, { tag: 'svg', icon: 'chevron-down', cls: 'icon chev-icon' }], on: { 'aria-expanded': 'true' }, disables: true, labelSelector: '.trade-mark-coin' },
  { family: 'check-row layers-row', wrapStyle: 'width: 196px', wrap: 'layers-rows', attrs: { role: 'menuitemcheckbox', 'aria-checked': 'false' }, children: [{ tag: 'i', cls: 'check layers-check' }, { tag: 'span', text: 'Chart' }], on: { 'aria-checked': 'true' }, labelSelector: 'span' },
  { family: 'pane-hide', iconOnly: true, wrap: 'trade-tabs', attrs: { 'aria-label': 'Hide the deck', 'data-pane': 'deck' }, children: [{ tag: 'svg', icon: 'hide', cls: 'icon' }] },
  { family: 'pane-show', iconOnly: true, wrap: 'trade-wrap', wrapStyle: 'height: auto', wrapAttrs: { 'data-pane-deck': 'hidden' }, attrs: { 'aria-label': 'Show the deck', 'data-pane': 'deck' }, children: [{ tag: 'svg', icon: 'show', cls: 'icon' }] },
];

// Turns a Policy into deterministic plain-English sentences. Pure, no IO.
// Lines that describe a real default-relevant limit (transaction cap, session
// cap, click threshold, per-chain gas minimums) always render, since those
// limits are meaningful even at their default value. Lines that describe an
// opt-in restriction (issuer caps, freezable cap, forbidden issuers, extra
// destinations) render only when set away from their unrestricted default,
// since "no issuer may exceed 100%" says nothing. Kill switch, when on,
// always renders last.

import type { ChainId, Policy } from '../types.ts';

const CHAIN_ORDER: readonly ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];

function formatUsd(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  const isInt = Number.isInteger(rounded);
  return (
    '$' +
    rounded.toLocaleString('en-US', isInt ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

function formatPct(share: number): string {
  return Math.round(share * 100) + '%';
}

export function renderSentences(p: Policy): string[] {
  const lines: string[] = [];

  lines.push(`Refuse any single transaction above ${formatUsd(p.outbound.maxPerTransactionUsd)}.`);
  lines.push(`Refuse more than ${formatUsd(p.outbound.maxPerSessionUsd)} total per session.`);
  lines.push(`Ask me before anything above ${formatUsd(p.outbound.humanClickAboveUsd)}.`);

  if (p.outbound.destinationAllowlist.length > 0) {
    lines.push(`Additional allowed destinations: ${p.outbound.destinationAllowlist.join(', ')}.`);
  }

  for (const chain of CHAIN_ORDER) {
    const usd = p.composition.minNativeGasUsd[chain];
    if (usd !== undefined && usd > 0) {
      lines.push(`Keep at least ${formatUsd(usd)} of gas on ${chain}.`);
    }
  }

  const defaultShare = p.composition.maxIssuerShare.default;
  if (defaultShare !== undefined && defaultShare < 1) {
    lines.push(`No issuer may exceed ${formatPct(defaultShare)} of holdings.`);
  }
  const namedIssuers = Object.keys(p.composition.maxIssuerShare)
    .filter((k) => k !== 'default')
    .sort();
  for (const issuer of namedIssuers) {
    lines.push(`${issuer} may not exceed ${formatPct(p.composition.maxIssuerShare[issuer])} of holdings.`);
  }

  if (p.composition.maxFreezableShare < 1) {
    lines.push(`No more than ${formatPct(p.composition.maxFreezableShare)} of holdings may be freezable.`);
  }

  if (p.composition.forbiddenIssuers.length > 0) {
    const sorted = [...p.composition.forbiddenIssuers].sort();
    lines.push(`Never move funds into: ${sorted.join(', ')}.`);
  }

  if (p.killSwitch) {
    lines.push('KILL SWITCH ON: all writes refused.');
  }

  return lines;
}

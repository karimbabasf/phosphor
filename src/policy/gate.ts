// The single place that decides whether a proposal needs a human click.
//
// Karim asked for testnet with no safeguards, which is reasonable for testing and
// fatal if it ever reaches mainnet: the product's central claim is that an agent
// cannot approve its own actions. So the bypass is not a flag that writes are read
// from directly anywhere. Every caller goes through gateRequired(), and mainnet
// ignores the flag entirely rather than trusting whoever edited config.json.
//
// What the bypass does NOT turn off, on any network:
//   - the policy engine: a 'refuse' verdict still refuses
//   - the kill switch
//   - the audit log, which records decidedBy 'gate_disabled' so the transcript
//     never claims a human clicked when no human did

import type { AppConfig } from '../types.ts';

export type GateConfig = Pick<AppConfig, 'network' | 'approvalGate'>;

export function gateRequired(cfg: GateConfig): boolean {
  if (cfg.network === 'mainnet') return true; // not configurable, deliberately
  return cfg.approvalGate;
}

// Rendered into the status bar whenever the gate is off, so the state is never a
// surprise. Returns null when the gate is on and there is nothing to warn about.
export function gateBanner(cfg: GateConfig): string | null {
  if (gateRequired(cfg)) return null;
  return 'GATE DISABLED - TESTNET - EVERY PROPOSAL AUTO-APPROVES';
}

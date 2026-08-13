// Agent connection tracking.
//
// This lives in its own module rather than inside main.ts so the one rule that
// matters can be tested: only a CHANGE of connection state is an audit event.
//
// The heartbeat used to be audited on every ping. mcp.ts sends one every 15s, so
// the append-only log gained ~5,760 entries a day saying nothing happened, and a
// real refusal or approval was buried between them by construction. The log is the
// record of what the agent did; a liveness ping is not something anyone did.

import type { Audit } from './audit.ts';

export const AGENT_TIMEOUT_MS = 45_000;

export type AgentTracker = {
  seen(client: string): void;
  connected(): number;
  // A drop is silence, so no request arrives carrying it. Nothing else can notice.
  sweep(): void;
};

export function createAgentTracker(audit: Audit, now: () => number = Date.now): AgentTracker {
  let lastHello = 0;
  let client = 'unknown client';
  let logged = false;

  function connected(): number {
    return now() - lastHello < AGENT_TIMEOUT_MS ? 1 : 0;
  }

  function seen(name: string): void {
    lastHello = now();
    client = name;
    if (logged) return;
    logged = true;
    audit.append('agent_connected', `agent connected: ${name}`);
  }

  function sweep(): void {
    if (!logged || connected() === 1) return;
    logged = false;
    audit.append('agent_connected', `agent dropped: ${client}`);
  }

  return { seen, connected, sweep };
}

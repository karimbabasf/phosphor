// Which vendor the in-app chat runs: the one the person picked, when the app can drive it under a
// lockdown it reads back, and otherwise nothing, with the sentence that says why. Never a quiet
// fallback to Claude Code: a chat that answered as Claude after Grok was picked is the bug this
// file exists to close (R3, 2026-09-23).

import { agentById } from '../agents-catalog.ts';
import type { AgentId } from '../agents-catalog.ts';
import { claude } from './claude.ts';
import { grok } from './grok.ts';
import type { Provider } from './types.ts';

export const PROVIDERS: readonly Provider[] = [claude, grok];

export type ChatVendor = {
  id: AgentId;
  name: string;
  // Whether this chat can run it. False means `reason` says where it runs instead.
  inApp: boolean;
  reason: string | null;
};

export function providerById(id: unknown): Provider | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

// The sentence for a pick the chat cannot run, in the words the window shows.
function elsewhere(id: AgentId, name: string): string {
  if (id === 'desktop') return 'Claude Desktop cannot drive Phosphor. Pick Claude Code or Grok to chat here.';
  if (id === 'mcp') return 'The agent you picked connects from outside this window. It shows up here when it does.';
  return `${name} runs in your terminal, not in this chat. Start it there and it joins this window.`;
}

// No pick is Claude Code, which is what a fresh install has always started.
export function vendorFor(picked: AgentId | null): ChatVendor {
  const id = picked ?? 'claude';
  const name = agentById(id)?.name ?? id;
  const inApp = providerById(id) !== null;
  return { id, name, inApp, reason: inApp ? null : elsewhere(id, name) };
}

/* The provider a chat holds for a pick it cannot run: every start fails with the pick's own
   sentence, and nothing is ever spawned. So the window says "Codex runs in your terminal" where it
   used to start Claude Code without a word. */
export function unavailable(vendor: ChatVendor): Provider {
  const refuse = (): never => {
    throw Object.assign(new Error(`driver: ${vendor.name} is not a vendor the in-app chat can run`), { reason: vendor.reason });
  };
  // Claude's shape for the parts that are never reached: nothing here ever spawns.
  return { ...claude, name: vendor.name, evidence: '', resolveBin: refuse, spawn: refuse };
}

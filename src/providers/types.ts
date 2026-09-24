// What the driver core needs from a vendor's CLI, and nothing about any vendor in particular.
//
// Ported from the feat/agent-providers branch and cut to the two vendors the in-app chat can
// drive under a lockdown it reads back: Claude Code and Grok. Both speak the same stream (Claude
// Code's stream-json, which Grok emits as streaming-messages-json), so the core keeps one parser
// and a provider answers only what differs: how the child is spawned, how a turn goes down, and
// which names on the stream are Phosphor's own.

export type ProviderId = 'claude' | 'grok';

// stdin: one long-lived process that takes turns on its stdin (Claude Code).
// turn: one process per turn, resumed by the session id the app chose (Grok, whose headless
// mode reads no stdin).
export type Transport = 'stdin' | 'turn';

export type SpawnInput = {
  repo: string;
  nodeBin: string;
  // App-owned, per vendor: <dataDir>/agents/<id>. Claude keeps its persona file here; Grok runs
  // with this as its HOME so nothing of the person's own setup loads.
  home: string;
  // The config override for the vendor's binary, validated by resolveBin.
  bin?: string;
  sessionId: string;
  model?: string;
  // The allowlisted environment childEnv built. A provider adds to it and never reads a key from it.
  env: NodeJS.ProcessEnv;
  // The persona. Empty means none.
  systemPrompt: string;
  // Claude's lockdown file.
  settings: string;
  // turn transport only: this turn's text, and whether the vendor already holds the session.
  prompt?: string;
  resume?: boolean;
};

export type SpawnSpec = { bin: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv };

// One tool call off the stream, as the lockdown and the window see it.
export type ToolCall =
  // A Phosphor tool, named mcp__phosphor__<tool> whatever the vendor called it.
  | { kind: 'phosphor'; name: string; input: unknown }
  // The vendor's own way of reaching MCP tools (Grok's search_tool): allowed, never drawn.
  | { kind: 'meta' }
  // The vendor's own web search or page reading, under one name for both vendors. Allowed on
  // Karim's decision of 2026-09-23 (research anything, not only crypto); never a card.
  | { kind: 'web'; name: 'web_search' | 'web_fetch' }
  // Anything else. The session ends on it.
  | { kind: 'builtin'; name: string };

export type Provider = {
  id: ProviderId;
  // The word the window and the audit log use.
  name: string;
  transport: Transport;
  // The command run and what it showed, dated. This is what earned the vendor its seat.
  evidence: string;
  // Throws a sentence a person can read when the binary is not there.
  resolveBin(override?: string): string;
  // Also where the provider writes what the child reads (Claude's persona file, Grok's config).
  spawn(input: SpawnInput): SpawnSpec;
  // The init event, read back: every name on it this app did not hand the child. Empty is clean.
  surface(init: Record<string, unknown>): string[];
  // `server` marks a tool the API ran for the model inside its reply (a server_tool_use block).
  tool(name: string, input: unknown, server?: boolean): ToolCall;
  // A tool result's content as the Phosphor tool wrote it, with any vendor wrapper taken off.
  // null when it is an error the vendor reported rather than an answer.
  result(content: unknown): unknown;
  // stdin transport only.
  encodeTurn?(text: string): string;
  encodeInterrupt?(): string;
  // Removes what spawn wrote for one session (a persona, a turn) once the child has read it, and
  // when the session ends.
  cleanup?(input: { home: string; sessionId: string }): void;
  // Removes what the vendor kept of a session that has ended (Grok's history of it).
  endSession?(input: { home: string; sessionId: string }): void;
};

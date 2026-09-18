// The propose door driven in process: handlePropose over a real duplicate guard and whatever
// proposal service the test hands in, with the HTTP response captured as JSON.

import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { Proposal, ProposalService } from '../../../src/types.ts';
import type { Ctx } from '../../../src/http/context.ts';
import type { JsonBody } from '../../../src/http/respond.ts';
import { handlePropose } from '../../../src/http/propose.ts';
import { createDuplicateGuard, stillInFlight } from '../../../src/duplicates.ts';
import { createAgents } from '../../../src/agents.ts';
import { createAudit } from '../../../src/audit.ts';
import type { Audit } from '../../../src/audit.ts';
import type { DuplicateGuard } from '../../../src/duplicates.ts';
import { stubView } from '../../fixtures/view.ts';

export type Reply = { status: number; json: Record<string, unknown> };

export type HttpHarness = {
  ctx: Ctx;
  duplicates: DuplicateGuard;
  post(kind: string, params: Record<string, unknown>, session?: string): Promise<Reply>;
};

function captured(): { res: http.ServerResponse; reply: () => Reply } {
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: unknown) {
      text = String(chunk ?? '');
    },
  } as unknown as http.ServerResponse;
  return { res, reply: () => ({ status, json: JSON.parse(text) as Record<string, unknown> }) };
}

// A service that answers every propose with `row` and settles to it. For tests about the door's
// reply shape, where the service's own behaviour is proven elsewhere.
export function serviceThatAnswers(row: Proposal, settledRow: Proposal = row): ProposalService {
  const answer = async () => row;
  return {
    proposePolicyChange: answer,
    proposeSwap: answer,
    proposeHlDeposit: answer,
    proposeHlWithdraw: answer,
    proposeSend: answer,
    proposeTrade: answer,
    proposeTradeChange: answer,
    approve: answer,
    refuse: answer,
    releaseQueued: async () => 0,
    get: (id) => (id === row.id ? settledRow : undefined),
    list: () => [settledRow],
    view: (p) => stubView(p),
    markStalled: () => 0,
    sessionSpentUsd: () => 0,
    reconcileOnBoot: () => [],
    reconcileOpen: async () => 0,
    reconcile: async () => settledRow,
    acknowledge: async () => settledRow,
    settled: async () => settledRow,
    settle: async () => true,
    dailyLimit: (capUsd) => ({ capUsd, spentUsd: 0, resetsAt: null }),
  };
}

export function makeHttp(over: { proposals: ProposalService; audit?: Audit; dataDir?: string; now?: () => number }): HttpHarness {
  // Wired off the service the way src/server.ts wires it off the store, through the same rule.
  const duplicates = createDuplicateGuard(over.now ?? Date.now, undefined, {
    inFlight: (id) => stillInFlight(over.proposals.get(id)),
  });
  const audit = over.audit ?? createAudit(over.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-http-')));
  const ctx = {
    proposals: over.proposals,
    duplicates,
    audit,
    agents: createAgents(),
    sse: { broadcastState: () => {} },
  } as unknown as Ctx;
  return {
    ctx,
    duplicates,
    post: async (kind, params, session = 'test-session') => {
      const { res, reply } = captured();
      const body: JsonBody = { op: 'propose', kind, params, session };
      await handlePropose(ctx, body, res);
      return reply();
    },
  };
}

// The proposal view, built without the settle seam, for the hand-built ProposalService stubs.
//
// Those stubs exist to answer one route and prove one reply shape; none of them holds a ledger,
// so none of them can re-judge a row against a balance. This builds the same object the real
// service builds and leaves the row exactly as it is, which is what a stub should do.

import type { Proposal } from '../../src/types.ts';
import { proposalView } from '../../src/proposals/view.ts';
import type { ProposalView } from '../../src/proposals/view.ts';

export function stubView(p: Proposal, now?: number): ProposalView {
  return proposalView({ settle: (row) => row }, p, now);
}

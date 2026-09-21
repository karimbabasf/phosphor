# Node H report: the latency proof (criterion 2)

Worktree /Users/karimbaba/Developer/Apps/phosphor-rfp-h-latency, branch rfp/h-latency off main at 8d665d1.
Nothing pushed, nothing tagged. Evidence under evidence-h/.

## 1. Commits

- 342e10b Latency proof for criterion 2: scripts/latency-proof.ts times reads, proposes and stage changes through the MCP door on a demo backend, tests/unit/latency-proof.test.ts holds its arithmetic
- (this report, the lessons lines and evidence-h/ follow in one commit on the same branch)

## 2. Counts

- `npm run typecheck`: exit 0.
- `npm test`: 3219 tests, 3219 pass, 0 fail (second run, machine quiet). Baseline on main is 3214; the five new tests are tests/unit/latency-proof.test.ts. A first run under peer load had 3216 pass, 3 fail: driver-memory, driver-prompt and driver-reason timed out at their 5 s caps; the three pass 14/14 alone and nothing in src changed on this branch (see follow-ups).
- `npm run eval`: not run. This node touches nothing the agent reads or says (no persona, role, skills, operator, tool descriptions or view.ts consumers); the diff is one script, one unit test and docs.
- `node scripts/latency-proof.ts`: three runs, exit 0 each (evidence-h/proof-run1.txt to proof-run3.txt).
- `npm run venue-latency`: exit 0 (evidence-h/venue-latency.txt).

## 3. Criteria

- 2.1 PASS. 20 warm calls each of wallet, proposals, policy_show and show through src/mcp.ts over stdio: p95 0.5 to 1.2 ms against 300 ms across three runs. The demo backend has no venue inside any read, so the 2 s venue budget is not exercised here; `npm run venue-latency` shows what a venue read costs from this Mac (p50 410 to 558 ms per REST call, below). Evidence: evidence-h/proof-run1.txt to proof-run3.txt.
- 2.2 PASS. Five propose_swap over the 100 USD threshold answered pending (a click) at p95 20.0 to 22.7 ms against 1500 ms; five under it answered executing at p95 34.1 to 42.7 ms against 3000 ms. The tool answer is what is timed; every one of the five under-threshold answers came 4.2 s before the row's settledAt, and the script fails the row when an answer lands after settlement. Evidence: the same three files, the line "answered before settlement".
- 2.3 PASS. Every stage every row entered (40 per run: 7 stages on each executing swap, 1 on each pending one), from the row's lastChangeAt to the /api/events frame carrying its id: p95 38 to 42 ms, max 75 to 84 ms, against 500 ms. Evidence: the same three files.
- 2.5 PASS on the two numbers this script can take. RSS 168.8 to 169.8 MB against 250 (`ps -o rss=,%cpu=` on the backend pid, 3 s after the run); 6 audit lines per proposal lifecycle against 12 (proposal_created, submitted x3, execution_unconfirmed, executed), on every one of the five executing swaps. CPU printed as 0.1 to 0.9 percent, not gated: it is ps's decaying minute average right after a run, and the hour-long idle read the criterion names is not something a 20 s script can take. Evidence: the same three files, the resources and audit lines.
- The audit log is read back against the calls made (95 of 95 audited, every run), so the sub-millisecond reads are the app answering, not the proxy.

`npm run venue-latency` (evidence-h/venue-latency.txt), read straight off mainnet, unsigned, zero address because the worktree has no config.local.json:

```
info meta                  p50   558 ms   min   480   max  1065   (10 samples, HTTP 200)
info clearinghouseState    p50   434 ms   min   421   max   512   (10 samples, HTTP 200)
info l2Book BTC            p50   410 ms   min   407   max   426   (10 samples, HTTP 200)
info extraAgents           p50   422 ms   min   420   max   834   (10 samples, HTTP 200)
exchange rejected cancel   p50   414 ms   min   410   max   420   (10 samples, HTTP 200, {"status":"err","response":"Unable to recover signer."})
ws activeAssetCtx BTC      p50  1020 ms   min   474   max  1225   (19 gaps in 20 s, first frame 430 ms after open)
ws candle 1m BTC           p50   951 ms   min   289   max  3080   (16 gaps in 20 s, first frame 2206 ms after open)
```

## 4. Decisions

- 2.1: one uncounted warm-up call per read route before the twenty timed ones, because the criterion says "warm caches" and the first call through the proxy pays the hello and the first socket.
- 2.1: the 300 ms budget is applied to all four reads on the demo backend and the 2 s venue budget is left to venue-latency, since no demo read reaches a venue. The script prints that on its own line rather than claiming the venue number.
- 2.2: "dry" is demo mode (the demo rail signs nothing and moves nothing); ten proposals with distinct amounts (10 to 14 USD under, 150 to 190 over), because the duplicate guard refuses a repeat of a swap still in flight from the same session.
- 2.2 and frozen rule 2: the floor asked for is 98 percent of what the wallet read prices the swap at, truncated toward zero to 6 significant figures, never rounded. A read, not a guess; the demo quote takes 10 bps, so the floor holds.
- 2.2: the answer is placed against the row's settledAt (the confirmed stamp where settledAt is missing); an answer after it fails the row on its own line.
- 2.3: every stageAt entry on every row of the run is one sample, matched to the first frame for that id at or after the stamp. stageAt is the successive values lastChangeAt took (src/proposals/lifecycle.ts, stamped), so this is the criterion's measure taken per stage rather than once.
- 2.5: RSS and the audit line count gate the verdict; CPU is printed with its meaning and does not, for the reason in section 3.
- The script picks a free port and a mkdtemp data dir under the OS temp dir (a data dir under the worktree's state/ is refused in demo mode, lessons file), drops every PHOSPHOR_* and ACC_* the shell had before setting its own PHOSPHOR_* (config.ts reads PHOSPHOR_PORT before ACC_PORT, so a leftover would have pointed the run at another worktree's app), and PHOSPHOR_DEMO_STAGE_SCALE defaults to 0.2 so a lifecycle takes about five seconds. The scale changes how long a stage lasts, not how fast a change reaches the screen.
- The script is importable without running (the pathToFileURL guard scripts/release-manifest.ts uses), which is what lets the unit test hold percentile, rowStats, renderTable, verdictLine and truncatedFloor.

## 5. Requests for the lead

package.json, in "scripts", beside "venue-latency":

```
    "latency-proof": "node scripts/latency-proof.ts",
```

No dependency added: the script uses @modelcontextprotocol/sdk, which the repo already carries for scripts/e2e.ts.

## 6. Follow-ups found, not fixed

- tests/unit/driver-memory.test.ts:62, driver-prompt.test.ts:79, driver-reason.test.ts:60: three driver tests fail on a loaded machine (5 s caps, a fixture child killed by SIGTERM instead of exiting 3) and pass alone. Timing-bound fixtures, not a product bug; worth a longer cap or a quieter runner if the full suite is ever run beside another suite on purpose.
- scripts/latency-proof.ts takes no hour-long soak, so 2.5's "after one hour with an agent connected" numbers still need a pasted ps line from a long-running app; the script prints the ps line for its own 20 s.

## 7. Lessons appended

- [H] A demo row wears needs_reconciliation while it is settling: the credit read that closes it comes one CREDIT_MS beat later. A wait loop that counted that status as an ending read all five swaps as stuck one second before they confirmed. Rule: wait on executed, failed or refused (or settledAt), never on needs_reconciliation.
- [H] Under a loaded machine (peer suites running) tests/unit/driver-memory, driver-prompt and driver-reason time out at their 5 s caps and fail 3 of 3219; alone they pass 14/14. Rerun those three by themselves before calling a full-suite count red.

## The tables, best and worst of three

Best run (evidence-h/proof-run1.txt): the tightest proposes.

```
route                                  n       p50       p95       max    budget  result
----------------------------------------------------------------------------------------
wallet                                20       0.6       1.0       1.1    300 ms  PASS
proposals                             20       0.5       0.7       1.9    300 ms  PASS
policy_show                           20       0.5       0.6       0.6    300 ms  PASS
show (proposal)                       20       0.4       0.5       0.5    300 ms  PASS
propose_swap over threshold (click)    5      17.4      22.7      22.7   1500 ms  PASS
propose_swap under threshold           5      33.9      34.1      34.1   3000 ms  PASS
stage change to SSE frame             40      19.0      41.0      84.0    500 ms  PASS

propose_swap under threshold: 5 of 5 answered before settlement, the closest by 4.2 s
reads: demo backend, no venue inside any read; the 2 s venue budget (2.1) is npm run venue-latency's line
tool calls audited by the app: 95 of 95 made PASS
resources: pid 37978, rss 168.9 MB (budget 250) PASS, cpu 0.9% (ps, a decaying minute average taken 3 s after the run, not the hour-long idle read)
audit lines per proposal lifecycle: max 6 (budget 12) PASS   4f030b7b-6484-40ac-92ae-2ab685452fa0: 6, 316a5a1f-8425-4cf1-ab76-7167316e0d71: 6, 9fa38f08-e1e8-4bcd-ae1e-542e67f868d9: 6, f5e6c43b-4707-4c4e-ac91-5ca17560ad76: 6, ee96c77c-afce-44a3-bbce-8a4928efc918: 6
LATENCY PROOF: PASS
```

Worst run (evidence-h/proof-run2.txt): the highest single p95, 42.7 ms on the under-threshold propose.

```
route                                  n       p50       p95       max    budget  result
----------------------------------------------------------------------------------------
wallet                                20       0.6       1.2       1.2    300 ms  PASS
proposals                             20       0.5       0.5       0.6    300 ms  PASS
policy_show                           20       0.4       0.7       0.8    300 ms  PASS
show (proposal)                       20       0.4       0.6       1.7    300 ms  PASS
propose_swap over threshold (click)    5      18.0      21.8      21.8   1500 ms  PASS
propose_swap under threshold           5      34.4      42.7      42.7   3000 ms  PASS
stage change to SSE frame             40      18.0      38.0      75.0    500 ms  PASS

propose_swap under threshold: 5 of 5 answered before settlement, the closest by 4.2 s
reads: demo backend, no venue inside any read; the 2 s venue budget (2.1) is npm run venue-latency's line
tool calls audited by the app: 95 of 95 made PASS
resources: pid 38109, rss 168.8 MB (budget 250) PASS, cpu 0.3% (ps, a decaying minute average taken 3 s after the run, not the hour-long idle read)
audit lines per proposal lifecycle: max 6 (budget 12) PASS   85a2b5f3-fe38-4aa6-af5d-d7879018a2f0: 6, bea0ee3c-e306-417c-abe6-2e03d448019a: 6, 2e887d02-51f2-48ff-b204-f715a173dfff: 6, 41189be0-2592-4125-a534-25414d123cdd: 6, c2367482-83ca-4323-ae52-7aac5db06e9d: 6
LATENCY PROOF: PASS
```

The third run (evidence-h/proof-run3.txt) sits between the two: reads p95 0.6 to 1.1 ms, proposes 20.0 and 36.9 ms, stage change p95 42 ms max 82 ms, rss 169.8 MB, 6 audit lines, PASS.

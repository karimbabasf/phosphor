// The contract every attack case answers to. A case sets up, runs the attack, names the refusal it
// expects, records what it observed, and decides pass or fail. `evidence` is the one line a reader
// checks: a command and the piece of its output that settles it, never prose.

export interface AttackCtx {
  // The ad-hoc bundle this repo builds (npm run bundle && tauri build). Null when it is not built.
  builtApp: string | null;
  // A Developer ID signed bundle, from --app <path>. Null without it. SIGNED-ONLY cases need it;
  // cases that only need a bundle take it when the ad-hoc one is absent.
  signedApp: string | null;
  // A fresh temp directory for this case, removed by the runner on a clean pass.
  scratch: string;
}

export interface AttackResult {
  expected: string;
  observed: string;
  pass: boolean;
  evidence: string;
  // Set to a reason when the case did not run (no signed build, no bundle). A skip is not a failure.
  skipped?: string;
}

export interface AttackCase {
  // Sorts the suite and names the row. Keep it stable: reports cite it.
  id: string;
  title: string;
  // Needs a Developer ID signed bundle. Skipped unless --app is given.
  signedOnly?: boolean;
  // Needs a built bundle (ad-hoc is fine). Skipped when neither the ad-hoc build nor --app exists.
  needsBuiltApp?: boolean;
  // Per-case wall clock. Default 120s.
  timeoutMs?: number;
  run(ctx: AttackCtx): Promise<AttackResult>;
}

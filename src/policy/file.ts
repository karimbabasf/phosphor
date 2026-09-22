// Loads and saves policy.json. Fail closed: any unreadable, unparseable, or
// schema-invalid file (including a missing one) makes loadPolicy return null.
// The caller (proposal service / server) treats null as "refuse every write"
// and the UI shows POLICY FILE UNREADABLE. Seeding a fresh default policy on
// first boot is the wiring layer's job (an explicit savePolicy call), not a
// side effect of loading.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Policy } from '../types.ts';
import { renderSentences } from './render.ts';
import { atomicWriteJson } from '../fsatomic.ts';

const policySchema = z.object({
  version: z.number(),
  killSwitch: z.boolean(),
  outbound: z.object({
    maxPerTransactionUsd: z.number(),
    maxPerSessionUsd: z.number(),
    humanClickAboveUsd: z.number(),
    autoApproveDailyUsd: z.number().optional(),
    destinationAllowlist: z.array(z.string()),
    simulateBeforeSign: z.literal(true),
  }),
  composition: z.object({
    maxIssuerShare: z.record(z.string(), z.number()),
    maxFreezableShare: z.number(),
    forbiddenIssuers: z.array(z.string()),
  }),
  sentences: z.array(z.string()),
});

function policyPath(dataDir: string): string {
  return path.join(dataDir, 'policy.json');
}

export function loadPolicy(dataDir: string): Policy | null {
  try {
    const raw = fs.readFileSync(policyPath(dataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const result = policySchema.safeParse(parsed);
    if (!result.success) return null;
    const policy = parsed as Policy;
    // A file predating the auto-approved ceiling loads with it filled in, at five times the
    // click threshold, so an existing install gets the wall without a hand edit. Not persisted
    // here: loadPolicy never writes, and the value lands on disk the next time any change saves.
    if (policy.outbound.autoApproveDailyUsd === undefined) {
      policy.outbound.autoApproveDailyUsd = 5 * policy.outbound.humanClickAboveUsd;
    }
    // A file from before the per-chain gas floors went still carries them and the "Keep at
    // least ... of gas" sentences they rendered. The key is dropped and the sentences re-rendered
    // from what is left, so the retired rule never shows again; the clean shape reaches disk at
    // the next save.
    const composition = policy.composition as Record<string, unknown>;
    if ('minNativeGasUsd' in composition) {
      delete composition.minNativeGasUsd;
      policy.sentences = renderSentences(policy);
    }
    return policy;
  } catch {
    return null;
  }
}

export function savePolicy(dataDir: string, p: Policy): void {
  fs.mkdirSync(dataDir, { recursive: true });
  atomicWriteJson(policyPath(dataDir), p);
}

/* The same write, behind the same schema the loader holds the file to. savePolicy trusts its
   caller because its callers are the seeding boot and a click on a verdict the engine already
   gave; this is the door for a write that comes straight from the window (the onboarding
   threshold), where the value was typed by a person and nothing has judged it yet. A policy
   that would not load is never written: the file on disk stays what it was and the caller
   hears false. */
export function savePolicyChecked(dataDir: string, p: Policy): boolean {
  if (!policySchema.safeParse(p).success) return false;
  savePolicy(dataDir, p);
  return true;
}

export function defaultPolicy(): Policy {
  const p: Policy = {
    version: 1,
    killSwitch: false,
    outbound: {
      maxPerTransactionUsd: 10000,
      maxPerSessionUsd: 25000,
      humanClickAboveUsd: 100,
      autoApproveDailyUsd: 500,
      destinationAllowlist: [],
      simulateBeforeSign: true,
    },
    composition: {
      maxIssuerShare: { default: 1 },
      maxFreezableShare: 1,
      forbiddenIssuers: [],
    },
    sentences: [],
  };
  p.sentences = renderSentences(p);
  return p;
}

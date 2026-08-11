// Loads and saves policy.json. Fail closed: any unreadable, unparseable, or
// schema-invalid file (including a missing one) makes loadPolicy return null.
// The caller (proposal service / server) treats null as "refuse every write"
// and the UI shows POLICY FILE UNREADABLE. Seeding a fresh default policy on
// first boot is the wiring layer's job (an explicit savePolicy call), not a
// side effect of loading.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Policy } from '../types.ts';
import { renderSentences } from './render.ts';

const policySchema = z.object({
  version: z.number(),
  killSwitch: z.boolean(),
  outbound: z.object({
    maxPerTransactionUsd: z.number(),
    maxPerSessionUsd: z.number(),
    humanClickAboveUsd: z.number(),
    destinationAllowlist: z.array(z.string()),
    simulateBeforeSign: z.literal(true),
  }),
  composition: z.object({
    maxIssuerShare: z.record(z.number()),
    maxFreezableShare: z.number(),
    minNativeGasUsd: z.record(z.number()),
    forbiddenIssuers: z.array(z.string()),
  }),
  sentences: z.array(z.string()),
});

function policyPath(dataDir: string): string {
  return path.join(dataDir, 'policy.json');
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

export function loadPolicy(dataDir: string): Policy | null {
  try {
    const raw = fs.readFileSync(policyPath(dataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const result = policySchema.safeParse(parsed);
    if (!result.success) return null;
    return parsed as Policy;
  } catch {
    return null;
  }
}

export function savePolicy(dataDir: string, p: Policy): void {
  fs.mkdirSync(dataDir, { recursive: true });
  atomicWriteJson(policyPath(dataDir), p);
}

export function defaultPolicy(): Policy {
  const p: Policy = {
    version: 1,
    killSwitch: false,
    outbound: {
      maxPerTransactionUsd: 10000,
      maxPerSessionUsd: 25000,
      humanClickAboveUsd: 100,
      destinationAllowlist: [],
      simulateBeforeSign: true,
    },
    composition: {
      maxIssuerShare: { default: 1 },
      maxFreezableShare: 1,
      minNativeGasUsd: { eth: 5, base: 1, arb: 1, sol: 2, near: 0.5 },
      forbiddenIssuers: [],
    },
    sentences: [],
  };
  p.sentences = renderSentences(p);
  return p;
}

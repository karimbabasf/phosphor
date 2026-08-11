// Loads config.json from the repo root into AppConfig. Env vars ACC_PORT,
// ACC_MODE, ACC_DATA_DIR override the matching file fields. dataDir is
// resolved relative to root (or used as-is if already absolute) and created
// if missing, so every other module can assume it exists.

import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, Mode } from './types.ts';

export function loadConfig(root?: string): AppConfig {
  const baseDir = root ?? process.cwd();
  const raw = fs.readFileSync(path.join(baseDir, 'config.json'), 'utf8');
  const parsed = JSON.parse(raw) as Partial<AppConfig>;

  const mode = (process.env.ACC_MODE as Mode | undefined) ?? parsed.mode ?? 'demo';
  const port = process.env.ACC_PORT ? Number(process.env.ACC_PORT) : (parsed.port ?? 4177);
  const dataDirInput = process.env.ACC_DATA_DIR ?? parsed.dataDir ?? 'state';
  const dataDir = path.resolve(baseDir, dataDirInput);

  const cfg: AppConfig = {
    mode,
    port,
    addresses: parsed.addresses ?? { evm: [], solana: [], near: [] },
    economicTransferUsd: parsed.economicTransferUsd ?? 0,
    candleProducts: parsed.candleProducts ?? [],
    dataDir,
  };

  fs.mkdirSync(dataDir, { recursive: true });

  return cfg;
}

// Installs the payload resolve guard (src/payload-guard.ts) before any other module of this app
// loads. main.ts imports this FIRST, so, in ESM evaluation order, the hook is registered before the
// rest of main.ts's imports are resolved and nothing can load from outside the payload (audit
// 2026-10-01, L14). The root is this file's own payload root: src/boot-guard.ts -> the payload.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installResolveGuard } from './payload-guard.ts';

installResolveGuard(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

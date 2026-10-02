// Not one of the 14 attacks: the attacker's own toolkit, proven to reach the app, so a later case
// that reports "refused" is reporting a refusal and not a broken harness. It boots a real backend on
// a throwaway data dir and HOME, reads the unauthenticated health probe, seats an OUTSIDE MCP proxy
// off agent.secret, and reads the audit tail with no credential. All of that is meant to work; the
// walls are in the cases that follow.

import assert from 'node:assert/strict';
import { bootBackend } from '../harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

export const attack: AttackCase = {
  id: '00-smoke',
  title: 'harness self-test: a hostile local process can reach the app it is attacking',
  async run(_ctx: AttackCtx): Promise<AttackResult> {
    const app = await bootBackend();
    try {
      const health = await app.health();
      assert.equal(typeof health?.locked, 'boolean', 'health has no locked flag');

      const { client, close } = await app.mcpOutside();
      let toolCount = 0;
      try {
        const tools = await client.listTools();
        toolCount = tools.tools.length;
        assert.ok(toolCount > 0, 'OUTSIDE seat saw no tools');
      } finally {
        await close();
      }

      const log = await app.auditLog(20);
      assert.ok(Array.isArray(log), '/api/log did not return an array');

      return {
        expected: 'boot comes up, health answers with no credential, OUTSIDE MCP seats, audit readable',
        observed: `locked=${health.locked}, OUTSIDE tools=${toolCount}, audit lines=${log.length}`,
        pass: true,
        evidence: `GET /api/health -> locked=${health.locked}; MCP listTools -> ${toolCount} tools`,
      };
    } finally {
      await app.stop();
    }
  },
};

export default attack;

// Many operations, one round trip.
//
// The agent's latency is round trips, not milliseconds: every MCP call is an LLM turn, so
// an analysis that takes nine calls takes most of a minute. This envelope collapses that
// into one call, and `$ref` is what makes it more than a convenience: drawing a line and
// then measuring against it stays a single turn because the second op can name the first
// op's result.
//
// Ops run sequentially, on purpose. `$ref` implies order, and a nine-op batch is bounded
// work already; running them concurrently would buy microseconds and cost the guarantee.
//
// One failing op does not abort the batch. A partial answer with a named failure is more
// useful to a model than a single error for the whole call, which tells it nothing about
// which of nine things went wrong.

export type Op = { op: string; args?: Record<string, unknown>; as?: string };

export type OpResult =
  | { op: string; as?: string; ok: true; value: unknown }
  | { op: string; as?: string; ok: false; error: string };

export type Handler = (
  args: Record<string, unknown>,
  refs: Record<string, unknown>,
) => Promise<unknown> | unknown;

const DEFAULT_MAX = 32;
const REF = /^\$ref:([A-Za-z0-9_]+)((?:\.[A-Za-z0-9_]+)*)$/;

function resolvePath(root: unknown, path: string): unknown {
  if (path === '') return root;
  let current: unknown = root;
  for (const key of path.slice(1).split('.')) {
    if (current === null || typeof current !== 'object') {
      throw new Error(`cannot read '${key}' of a non-object in reference`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// Only strings that are ENTIRELY a reference resolve. Substring interpolation was rejected:
// a price label reading "$ref:..." as part of prose would be silently rewritten, and a
// label is human-visible text on a money surface.
function resolveArgs(
  args: Record<string, unknown>,
  refs: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      const m = REF.exec(v);
      if (m) {
        const [, name, path] = m;
        if (!(name in refs)) throw new Error(`unknown reference '${name}' in argument '${k}'`);
        out[k] = resolvePath(refs[name], path);
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}

export async function runBatch(
  ops: Op[],
  handlers: Record<string, Handler>,
  opts?: { max?: number },
): Promise<OpResult[]> {
  const max = opts?.max ?? DEFAULT_MAX;
  if (ops.length > max) {
    return [
      { op: 'batch', ok: false, error: `a batch takes at most ${max} ops, got ${ops.length}` },
    ];
  }

  const results: OpResult[] = [];
  const refs: Record<string, unknown> = {};

  for (const entry of ops) {
    const handler = handlers[entry.op];
    if (!handler) {
      results.push({
        op: entry.op,
        as: entry.as,
        ok: false,
        error: `unknown op '${entry.op}'. known ops: ${Object.keys(handlers).sort().join(', ')}`,
      });
      continue;
    }
    try {
      const args = resolveArgs(entry.args ?? {}, refs);
      const value = await handler(args, refs);
      if (entry.as) refs[entry.as] = value;
      results.push({ op: entry.op, as: entry.as, ok: true, value });
    } catch (err) {
      results.push({
        op: entry.op,
        as: entry.as,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

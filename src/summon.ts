// Start a fresh agent in a terminal window, wired to this app.
//
// The window can already stop an agent (the kill switch, the seat, /api/refuse). It could not
// start one, and that asymmetry is felt: the whole product is "drive your crypto through your
// agent", and step one of that was leaving the app, finding a terminal and typing a command.
// This closes it. One button, a new terminal, a new agent, and the seat handed over.
//
// SECURITY, because this file spawns a process and that deserves a straight answer.
//
// It grants no privilege that was not already there. /api/summon is on the same token-gated,
// same-origin, loopback-only path as /api/kill and /api/approve, and the threat model in
// docs/security-model.md already assumes anything with a shell on this machine can read the
// per-boot token from /api/session. But anything with a shell on this machine can also open a
// terminal directly, so a route that opens a terminal hands it nothing new. What matters is
// that the command is FIXED. Nothing from the request reaches it: not the working directory,
// not the command, not one argument. The only variable is a path this process was configured
// with at boot, and even that is escaped and validated below rather than trusted, because a
// path is still a string and this is still the one place in the app where a string becomes a
// command.

import { execFile } from 'node:child_process';

export type SummonOutcome = { ok: true; how: string } | { ok: false; error: string };

/** Runs a command. Injected so the script can be asserted without opening a terminal. */
export type Runner = (file: string, args: readonly string[]) => Promise<void>;

// A path with a newline or a control character in it cannot be safely embedded in an
// AppleScript string literal and has no business being a project directory. Refused rather
// than escaped: there is no legitimate case, so accepting one would only be a way to be
// clever about input that should not exist.
const FORBIDDEN = new RegExp("[\\u0000-\\u001f\\u007f]");

/** POSIX single-quote quoting. Inside single quotes the shell treats everything literally,
 *  so the only character needing work is the quote itself: close, escape it, reopen. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** AppleScript string literal escaping. Backslash first, or it would double-escape the
 *  backslashes the quote escaping is about to add. */
export function appleQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// The first thing the summoned agent is told to do. A CONSTANT, never anything from the
// request: it is embedded in the command exactly like `claude` itself is, so it changes the
// "nothing from the request reaches the command line" property not at all. It exists because a
// bare `claude` starts and then SITS: the MCP handshake loads the "call start first" rule in
// front of the model, but the model takes no turn until a human types, so the greeting a user
// summoned to see never appears until they type something themselves. This is that first turn,
// pre-typed, so clicking summon shows the banner instead of an empty prompt.
const FIRST_PROMPT =
  'Connect to Phosphor and show me the greeting now: call the start tool and print its banner ' +
  'verbatim inside a code block, then wait for my instructions.';

/**
 * The AppleScript that opens the window. Pure, so a test can read the exact text that would
 * run without a terminal ever appearing.
 *
 * `claude` is invoked bare rather than by absolute path on purpose: on this machine it is a
 * shell function that adds `--effort max`, defined in the user's profile. `do script` runs a
 * login shell, so the function is in scope; an absolute path to the binary would silently
 * bypass it and start a weaker agent than the user configured. The fixed FIRST_PROMPT is
 * passed as claude's first argument so the agent acts the moment the window opens.
 */
export function summonScript(cwd: string): string {
  return [
    'tell application "Terminal"',
    '  activate',
    `  do script ${appleQuote(`cd ${shellQuote(cwd)} && claude ${shellQuote(FIRST_PROMPT)}`)}`,
    'end tell',
  ].join('\n');
}

const defaultRunner: Runner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 15_000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

export async function summonAgent(
  cwd: string,
  platform: string = process.platform,
  run: Runner = defaultRunner,
): Promise<SummonOutcome> {
  if (platform !== 'darwin') {
    // Said plainly rather than attempted. A half-working summon on a platform this was never
    // built for would be a worse answer than a clear no: the user still has a terminal.
    return {
      ok: false,
      error: `summon opens a Terminal.app window and only runs on macOS (this is ${platform}). ` +
        `Start the agent yourself: cd ${cwd} && claude`,
    };
  }
  if (FORBIDDEN.test(cwd)) {
    return { ok: false, error: 'the project path contains a control character and cannot be summoned into' };
  }
  try {
    await run('osascript', ['-e', summonScript(cwd)]);
    return { ok: true, how: 'Terminal.app' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

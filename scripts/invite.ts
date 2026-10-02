// Invite codes, the operator's side: make the treasury T, fund a batch of codes from it, reclaim
// codes nobody used, withdraw T, see where every code stands. Spec:
// docs/superpowers/specs/2026-10-01-invite-codes-design.md, "The money path". Docs: docs/money.md,
// "Issuing invite codes".
//
//   npm run invite -- treasury
//   npm run invite -- issue --count 10 --amount 5 --label "SF builders" [--simulate-only]
//   npm run invite -- issue --resume
//   npm run invite -- reclaim [--label <label>] [--address <code address>] [--simulate-only]
//   npm run invite -- withdraw --to <address> [--simulate-only]
//   npm run invite -- convert
//   npm run invite -- status
//   --file <path> (or PHOSPHOR_INVITES_FILE) for a file other than ~/.phosphor-invites/invites.enc.json
//
// RUN IT IN YOUR OWN TERMINAL, never through an agent: a session would put every live code into
// transcripts on disk and at the model provider. stdin must be a TTY, which stops a pipe or an
// agent from running it by accident. It is a speed bump, not a wall: a program that fakes a
// terminal (script(1)) gets past it, can type the passphrase for you and reads what goes to
// /dev/tty (audit L9). The wall is the passphrase: typed by a person at a no-echo prompt on every
// run, never on the command line, stored nowhere. The links go to /dev/tty once and never to stdout.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { decimalToBaseUnits } from '../src/intents.ts';
import { INVITE_ASSET_DECIMALS, INVITE_ASSET_ID, formatUsdc } from '../src/invite/payload.ts';
import { INTENTS_API_KEY_ENV, intentsApi } from '../src/rails/intents-native.ts';
import { relayClient } from '../src/relay/client.ts';
import { liveVerifier } from '../src/relay/verifier.ts';
import { newBook } from './invite/book.ts';
import { convertTreasury } from './invite/convert.ts';
import { heldList, otherUsdc } from './invite/usdc.ts';
import { MIN_PASSPHRASE_CHARS, createInviteFile, inviteFilePath, openInviteFile, passphraseChars, takeLock } from './invite/file.ts';
import type { FileLock, InviteFile } from './invite/file.ts';
import { fundingFor, issueBatch, liveSimulateAt, newTreasury, reclaimCodes, resumeBatch, statusLines, withdrawTreasury } from './invite/money.ts';
import type { Io, Ledger, MoneyNet } from './invite/money.ts';
import { liveTerminal } from './invite/tty.ts';
import type { Terminal } from './invite/tty.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const USAGE = [
  'Usage, in your own Terminal:',
  '  npm run invite -- treasury',
  '  npm run invite -- issue --count 10 --amount 5 --label "SF builders" [--simulate-only]',
  '  npm run invite -- issue --resume',
  '  npm run invite -- reclaim [--label <label>] [--address <code address>] [--simulate-only]',
  '  npm run invite -- withdraw --to <address> [--simulate-only]',
  '  npm run invite -- convert',
  '  npm run invite -- status',
  'Every command takes --file <path> (or PHOSPHOR_INVITES_FILE) for another invite file.',
].join('\n');

export const NOT_A_TERMINAL =
  'Run this in your own Terminal. It reads the invite file passphrase at a prompt and refuses piped input, so a script or an agent does not run it by accident. ' +
  'Never run it through an agent: the codes would land in its transcripts. Your passphrase is what keeps the file shut, so type it only in your own Terminal.';

const FLAGS: Record<string, readonly string[]> = {
  treasury: ['file'],
  issue: ['file', 'count', 'amount', 'label', 'simulate-only', 'resume'],
  reclaim: ['file', 'label', 'address', 'simulate-only'],
  withdraw: ['file', 'to', 'simulate-only'],
  convert: ['file'],
  status: ['file'],
};

export type CliDeps = {
  stdinIsTTY: boolean;
  terminal: Terminal;
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  home?: string;
  repoRoot?: string;
  net: () => MoneyNet;
};

function liveNet(): MoneyNet {
  return {
    verifier: liveVerifier(),
    relay: relayClient(),
    simulateAt: liveSimulateAt(),
    // The partner key when one is set, as the app does; 1Click's public fee tier without one.
    oneclick: intentsApi({ apiKey: process.env[INTENTS_API_KEY_ENV] ?? '' }),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: (n) => crypto.randomBytes(n),
  };
}

async function askPassphrase(terminal: Terminal, prompt: string): Promise<Buffer | null> {
  return terminal.ask(prompt, { secret: true });
}

function ioFor(deps: CliDeps): Io {
  return {
    say: deps.out,
    async confirm(question) {
      const answer = await deps.terminal.ask(`${question} Type yes to go on: `, { secret: false });
      const yes = answer !== null && answer.toString('utf8').trim().toLowerCase() === 'yes';
      answer?.fill(0);
      return yes;
    },
    async ask(question) {
      const answer = await deps.terminal.ask(question, { secret: false });
      if (answer === null) return null;
      const text = answer.toString('utf8');
      answer.fill(0);
      return text;
    },
    reveal: (text) => deps.terminal.write(`${text}\n`),
  };
}

/* The passphrase for a new file: asked twice, at least MIN_PASSPHRASE_CHARS characters. */
async function newPassphrase(deps: CliDeps): Promise<Buffer | null> {
  deps.out(`Choose a passphrase of at least ${MIN_PASSPHRASE_CHARS} characters. A long sentence you will remember works. It is typed on every run and stored nowhere.`);
  for (let tries = 0; tries < 3; tries += 1) {
    const first = await askPassphrase(deps.terminal, 'New passphrase: ');
    if (first === null) return null;
    if (passphraseChars(first) < MIN_PASSPHRASE_CHARS) {
      first.fill(0);
      deps.out(`That is shorter than ${MIN_PASSPHRASE_CHARS} characters. Try again.`);
      continue;
    }
    const second = await askPassphrase(deps.terminal, 'The same passphrase again: ');
    if (second === null) {
      first.fill(0);
      return null;
    }
    const same = first.length === second.length && crypto.timingSafeEqual(first, second);
    second.fill(0);
    if (same) return first;
    first.fill(0);
    deps.out('The two did not match. Try again.');
  }
  return null;
}

async function treasury(file: string, deps: CliDeps, net: MoneyNet): Promise<number> {
  let opened: InviteFile;
  let created = false;
  try {
    opened = await openExisting(file, deps);
  } catch (err) {
    if (!(err instanceof NoFile)) throw err;
    const passphrase = await newPassphrase(deps);
    if (passphrase === null) {
      deps.out('Stopped. No invite file was made.');
      return 1;
    }
    try {
      // T's key goes into the file first; its address is printed only once the file reads back.
      createInviteFile(file, passphrase, newBook(newTreasury(net))).close();
      opened = openInviteFile(file, passphrase);
    } finally {
      passphrase.fill(0);
    }
    created = true;
  }
  try {
    const address = opened.book.treasury.address;
    deps.out(created ? `Made the treasury T and wrote its key to ${file} (mode 0600). It is the only copy of that key.` : `The treasury T in ${file}:`);
    deps.out(`T: ${address}`);
    const held = await net.verifier.balance(address, INVITE_ASSET_ID).catch(() => null);
    deps.out(`It holds ${held === null ? 'an amount of NEAR USDC this run could not read' : `$${formatUsdc(held)} of NEAR USDC`}, the USDC a code holds.`);
    const other = (await otherUsdc(net, address)).held;
    if (other.length > 0) deps.out(`It also holds ${heldList(other)} inside NEAR Intents: \`npm run invite -- convert\` turns it into NEAR USDC.`);
    deps.out(`To fund a batch, send T count x amount / 0.9975 plus a cent with the app's Send: 10 codes of $5 is $${fundingFor(50_000_000n)}.`);
    deps.out(
      'Any USDC sent inside NEAR Intents works. The Send pays out of whichever USDC the wallet holds, so it may land as USDC on Base or ' +
        'another chain; `npm run invite -- convert` turns that into NEAR USDC first, through 1Click.',
    );
    return 0;
  } finally {
    opened.close();
  }
}

class NoFile extends Error {}

async function openExisting(file: string, deps: CliDeps): Promise<InviteFile> {
  if (!fs.existsSync(file)) throw new NoFile(file);
  const passphrase = await askPassphrase(deps.terminal, 'Invite file passphrase: ');
  if (passphrase === null) throw new Error('Stopped. Nothing was read.');
  try {
    return openInviteFile(file, passphrase);
  } finally {
    passphrase.fill(0);
  }
}

function amountBase(text: string | undefined): bigint | null {
  if (text === undefined || !/^\d{1,6}(\.\d{1,2})?$/.test(text.trim())) return null;
  return decimalToBaseUnits(text.trim(), INVITE_ASSET_DECIMALS);
}

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    deps.out(USAGE);
    return command === undefined ? 2 : 0;
  }
  const allowed = FLAGS[command];
  if (allowed === undefined) {
    deps.err(`There is no command "${command}".`);
    deps.out(USAGE);
    return 2;
  }
  if (!deps.stdinIsTTY) {
    deps.err(NOT_A_TERMINAL);
    return 1;
  }

  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: rest,
      options: {
        file: { type: 'string' },
        count: { type: 'string' },
        amount: { type: 'string' },
        label: { type: 'string' },
        address: { type: 'string' },
        to: { type: 'string' },
        'simulate-only': { type: 'boolean' },
        resume: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err));
    deps.out(USAGE);
    return 2;
  }
  const stray = Object.keys(values).filter((k) => !allowed.includes(k));
  if (stray.length > 0) {
    deps.err(`${command} does not take --${stray.join(', --')}.`);
    deps.out(USAGE);
    return 2;
  }

  let file: string;
  try {
    file = inviteFilePath(values['file'] as string | undefined, deps.env, deps.repoRoot ?? ROOT, deps.home);
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const net = deps.net();
  const simulate = values['simulate-only'] === true;
  // Every command that can write the file holds the lock for its whole run. status and a
  // simulate-only reclaim or withdraw read and never write, so they run beside one. A simulate-only
  // issue writes its codes, void, before it signs (scripts/invite/money.ts), so it takes the lock.
  const writes = command !== 'status' && !(simulate && command !== 'issue');

  let lock: FileLock | null = null;
  let opened: InviteFile | null = null;
  const onSignal = (): void => {
    opened?.close();
    lock?.release();
    process.exit(130);
  };
  try {
    if (writes) lock = takeLock(file);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.once('SIGHUP', onSignal);

    if (command === 'treasury') return await treasury(file, deps, net);

    try {
      opened = await openExisting(file, deps);
    } catch (err) {
      if (err instanceof NoFile) {
        deps.err(`There is no invite file at ${file}. Run \`npm run invite -- treasury\` to make one.`);
        return 1;
      }
      throw err;
    }
    const current = opened;
    const ledger: Ledger = {
      book: current.book,
      save: () => {
        if (!writes) throw new Error('this run only reads the invite file');
        current.save();
      },
    };
    const io = ioFor(deps);

    if (command === 'status') {
      for (const line of await statusLines(ledger.book, net)) deps.out(line);
      return 0;
    }
    if (command === 'issue') {
      if (values['resume'] === true) {
        if (values['count'] !== undefined || values['amount'] !== undefined || values['label'] !== undefined || simulate) {
          deps.err('issue --resume takes no other flag: it finishes the batch that is pending.');
          return 2;
        }
        return await resumeBatch(ledger, net, io);
      }
      const count = Number(values['count']);
      const amount = amountBase(values['amount'] as string | undefined);
      const label = values['label'];
      if (!/^\d{1,2}$/.test(String(values['count'] ?? '')) || amount === null || typeof label !== 'string') {
        deps.err('issue needs --count (1 to 10), --amount in dollars (like 5 or 0.10) and --label "<who they are for>".');
        return 2;
      }
      return await issueBatch(ledger, net, { count, amountBase: amount, label, simulateOnly: simulate }, io);
    }
    if (command === 'reclaim') {
      return await reclaimCodes(
        ledger,
        net,
        {
          simulateOnly: simulate,
          ...(typeof values['label'] === 'string' ? { label: values['label'] } : {}),
          ...(typeof values['address'] === 'string' ? { address: values['address'] } : {}),
        },
        io,
      );
    }
    if (command === 'withdraw') {
      if (typeof values['to'] !== 'string') {
        deps.err('withdraw needs --to <address>: copy it from Receive in the app.');
        return 2;
      }
      return await withdrawTreasury(ledger, net, { to: values['to'], simulateOnly: simulate }, io);
    }
    if (command === 'convert') return await convertTreasury(ledger, net, io);
    return 2;
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGHUP', onSignal);
    opened?.close();
    lock?.release();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), {
    stdinIsTTY: process.stdin.isTTY === true,
    terminal: liveTerminal(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    net: liveNet,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}

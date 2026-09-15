// The environment a child gets is a list of names this app chose, never the parent's minus a list.
//
// THE FAILURE. Both children (the Claude Code driver and the runner that signs trades) were spawned
// with a copy of process.env minus a denylist of twelve names. Everything else in the shell that
// launched the app rode along: PHOSPHOR_1CLICK_API_KEY, which the denylist never named, and any
// AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN or NPM_TOKEN a developer's shell carries. `ps eww <pid>` prints
// the environment of any process this user owns, and a child that reads its own environment
// (the driver, before the lockdown, or a dependency in either) reads every one of them.
//
// THE FIX. An allowlist: the handful of names a process needs to run at all, the PHOSPHOR_* names
// each child's own code reads, and for the driver the one name Claude Code needs to find its
// login. A name that is not on the list does not exist in the child, whatever the parent holds.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INHERITED_ENV, STRIPPED, childEnv, useSeatSecret } from '../../src/driver.ts';
import { runnerChildEnv } from '../../src/runner/host.ts';

// A parent shell with everything in it: the names a child needs, the names it must never see,
// and a few nobody thought to list.
function parent(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/someone',
    USER: 'someone',
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    TMPDIR: '/tmp/x',
    TERM: 'xterm',
    NODE_OPTIONS: '--require /tmp/evil.js',
    PHOSPHOR_1CLICK_API_KEY: 'oneclick-key',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    GITHUB_TOKEN: 'gh-token',
    NPM_TOKEN: 'npm-token',
    ANTHROPIC_API_KEY: 'sk-ant',
    ANTHROPIC_BASE_URL: 'https://elsewhere',
    OPENAI_API_KEY: 'sk-openai',
    PHOSPHOR_KEYS: '/Users/someone/.phosphor/keys.json',
    PHOSPHOR_WINDOW_TOKEN: 'a'.repeat(64),
    PHOSPHOR_DATA_DIR: '/data',
    PHOSPHOR_MODE: 'live',
    CLAUDE_CONFIG_DIR: '/Users/someone/.claude-work',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    SOME_RANDOM_THING: 'x',
  };
}

const SECRETS = ['PHOSPHOR_1CLICK_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'PHOSPHOR_KEYS', 'PHOSPHOR_WINDOW_TOKEN', 'NODE_OPTIONS', 'SOME_RANDOM_THING'];

test('the driver child gets the inherited names, its own PHOSPHOR names and the login directory, and nothing else', () => {
  useSeatSecret('s'.repeat(64));
  const env = childEnv('/repo', 4177, 'session-1', { role: 'analyst', label: 'worker', parent: 'lead' }, parent());

  for (const name of SECRETS) assert.equal(name in env, false, `${name} reached the driver child`);
  for (const name of INHERITED_ENV) assert.equal(env[name], parent()[name], `${name} is inherited`);

  assert.deepEqual(
    Object.keys(env).sort(),
    [
      ...INHERITED_ENV,
      'ACC_PORT',
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
      'CLAUDE_CONFIG_DIR',
      'PHOSPHOR_LABEL',
      'PHOSPHOR_PARENT',
      'PHOSPHOR_REPO',
      'PHOSPHOR_ROLE',
      'PHOSPHOR_SEAT',
      'PHOSPHOR_SESSION',
    ].sort(),
    'exactly the names the child needs, no more',
  );
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', 'set by this app, never inherited');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/Users/someone/.claude-work', 'where Claude Code keeps its login, when the parent moved it');
  assert.equal(env.PHOSPHOR_SEAT, 's'.repeat(64));
  assert.equal(env.ACC_PORT, '4177');
});

test('a name the parent lacks is absent rather than empty, and the config directory is passed only when set', () => {
  const env = childEnv('/repo', 4177, 'session-1', undefined, { PATH: '/bin' });
  assert.equal('CLAUDE_CONFIG_DIR' in env, false);
  assert.equal('HOME' in env, false);
  assert.equal('LC_ALL' in env, false);
  assert.equal(env.PATH, '/bin');
});

test('the denylist is still stated, and every name on it is one the allowlist never admits', () => {
  // STRIPPED is the second wall: a name added to INHERITED_ENV by mistake must not be one of these.
  for (const name of STRIPPED) assert.equal((INHERITED_ENV as readonly string[]).includes(name), false, name);
  assert.ok(STRIPPED.includes('PHOSPHOR_WINDOW_TOKEN'));
  assert.ok(STRIPPED.includes('PHOSPHOR_KEYS'));
});

test('the runner child gets the inherited names and the two venue names it reads, and nothing else', () => {
  const env = runnerChildEnv('https://api.hyperliquid.xyz', '0xabc', parent());
  for (const name of SECRETS) assert.equal(name in env, false, `${name} reached the runner child`);
  assert.deepEqual(Object.keys(env).sort(), [...INHERITED_ENV, 'PHOSPHOR_HL_URL', 'PHOSPHOR_HL_USER'].sort());
  assert.equal(env.PHOSPHOR_HL_URL, 'https://api.hyperliquid.xyz');
  assert.equal(env.PHOSPHOR_HL_USER, '0xabc');
  assert.equal('CLAUDE_CONFIG_DIR' in env, false, 'the runner is not Claude Code');
});

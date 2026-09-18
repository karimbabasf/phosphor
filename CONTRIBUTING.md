# Contributing

Phosphor moves real money, so the bar for a change is that it can be read and trusted, not that
it is clever. Small pull requests that do one thing land; a large one is split first.

## Before you write code

- Read [docs/security-model.md](docs/security-model.md). Nothing may let the connected agent
  reach approval, execution or policy directly. A change that moves that line is refused.
- Read [docs/architecture.md](docs/architecture.md) for where things live.
- For anything that is not a small fix, open an issue first and say what you intend. That saves
  both of us a week.

## Run it

Needs Node 24 or later and a Rust toolchain. `npm install`, then `npm run tauri dev` for the
window or `npm run app` for the backend alone. The README has the rest.

## Test it

    npm run typecheck
    npm test

Both must pass. A change to behaviour comes with a test that fails without it. Tests live under
`tests/unit/`, one file per module, and use `node:test`; match the file that covers the module
you touched.

## Docs

`docs/` describes the version in `package.json`, nothing older and nothing planned. A change
that a user can see updates the page it touches and adds a line under the current version in
`docs/changelog.md`, in the same commit. `tests/unit/docs.test.ts` fails the suite otherwise.

## Style

- Plain English in comments and docs. A comment says what the code cannot.
- No key, seed, secret, address or personal path in the tree, in a test fixture or in a commit
  message. `.gitignore` keeps `config.local.json` out; keep it that way.
- No new dependency without a reason in the pull request: what it does that the standard library
  and the current dependencies cannot. Every dependency runs with `ignore-scripts`.
- Commit messages say what changed and why, in a sentence.

## Security problems

Never in a public issue or pull request. Use [private reporting](https://github.com/karimbabasf/phosphor/security/advisories/new);
[SECURITY.md](SECURITY.md) says what a useful report carries.

## License

By contributing you agree that your contribution is licensed under the repository's license,
FSL-1.1-MIT, and becomes MIT with the rest of that version two years after its release.

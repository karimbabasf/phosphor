// Puts the DMG behind https://phosphor.money/download/mac. Run by the release workflow's site
// job, which installs this folder's lockfile and nothing else, and holds BLOB_READ_WRITE_TOKEN
// and no other secret:
//
//   npm ci --ignore-scripts --no-audit --no-fund     (in scripts/site-upload)
//   node scripts/site-upload/upload.mjs <dmg>
//
// Same fixed name every release, overwritten in place, cached for 60 seconds so the site hands
// out the new version within a minute. Through the Blob SDK, which needs the store token alone:
// the Vercel CLI (`vercel blob put`) refuses to start without an account login even when handed
// the token, which is where the v0.5.1 run died, and on a runner there is no account to log in.
import { put } from '@vercel/blob';
import { createReadStream } from 'node:fs';

const dmg = process.argv[2];
if (!dmg) throw new Error('usage: node scripts/site-upload/upload.mjs <dmg>');
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set, the site download still serves the previous version');

const out = await put('Phosphor-macOS-arm64.dmg', createReadStream(dmg), {
  access: 'public',
  addRandomSuffix: false,
  allowOverwrite: true,
  cacheControlMaxAge: 60,
  contentType: 'application/x-apple-diskimage',
  multipart: true,
  token,
});
console.log('site download now serves', out.url);

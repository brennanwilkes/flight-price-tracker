#!/usr/bin/env node
/* Stamp the PWA build into the site artifact. Run by deploy-pages.yml on the deployed copy only;
 * never commit a stamped file. Ported from spirit-tracker tools/stamp_pwa.js.
 *
 *   node scripts/stamp-pwa.mjs _site
 *
 * - sw.js:      BUILD = hash of the shell, FILES = every shell file to precache
 * - index.html: <meta name="fl-build"> = the same hash (app/pwa.js registers only when set)
 *
 * BUILD hashes file contents, not the commit, so a deploy that changes nothing raises no
 * "new version" bar. Data isn't in the site (it's read from the data branch).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.argv[2];
if (root === undefined) throw new Error('usage: node scripts/stamp-pwa.mjs <site-dir>');

const SHELL_EXT = new Set(['.html', '.js', '.css', '.png', '.svg', '.webmanifest']);

function walk(rel) {
  const out = [];
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel === '' ? ent.name : `${rel}/${ent.name}`;
    if (ent.isDirectory()) out.push(...walk(p));
    else if (SHELL_EXT.has(path.extname(ent.name)) && p !== 'sw.js') out.push(p);
  }
  return out;
}

const files = walk('').sort();
for (const f of ['index.html', 'manifest.webmanifest', 'app/main.js', 'app/pwa.js']) {
  if (!files.includes(f)) throw new Error(`shell is missing ${f}; wrong site dir?`);
}

const swPath = path.join(root, 'sw.js');
const indexPath = path.join(root, 'index.html');
const swSrc = fs.readFileSync(swPath, 'utf8');
const indexSrc = fs.readFileSync(indexPath, 'utf8');

const hash = crypto.createHash('sha256');
for (const f of files) {
  hash.update(f);
  hash.update(fs.readFileSync(path.join(root, f)));
}
hash.update(swSrc);
const build = hash.digest('hex').slice(0, 12);

function replaceOnce(src, needle, value, file) {
  const n = src.split(needle).length - 1;
  if (n !== 1) throw new Error(`${file}: expected exactly one ${needle}, found ${n}`);
  return src.replace(needle, () => value);
}

const precache = ['./', ...files.map((f) => `./${f}`)];
let sw = replaceOnce(swSrc, "'__BUILD__'", `'${build}'`, 'sw.js');
sw = replaceOnce(sw, '[/*__FILES__*/]', JSON.stringify(precache, null, 2), 'sw.js');
fs.writeFileSync(swPath, sw);
fs.writeFileSync(indexPath, replaceOnce(indexSrc, 'content="__BUILD__"', `content="${build}"`, 'index.html'));

const bytes = files.reduce((n, f) => n + fs.statSync(path.join(root, f)).size, 0);
console.log(`stamped PWA build ${build}: ${precache.length} shell files, ${(bytes / 1024).toFixed(0)} KB`);

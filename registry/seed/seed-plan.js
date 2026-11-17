#!/usr/bin/env node
'use strict';
// Helper for seed-registry.sh.
//
//   node seed-plan.js kind    <file.json>          -> prints "lock" or "package"
//   node seed-plan.js plan    <package-lock.json>  -> TSV: STATUS  name@version  tag/detail
//        STATUS = PRESENT | MISSING | BLOCKED | UNSUPPORTED | SKIPPED (other OS/CPU)
//   node seed-plan.js verify  <package-lock.json>  -> TSV: STATUS  name@version  detail
//        STATUS = OK | MISSING | MISMATCH
//   node seed-plan.js publish <file.tgz> <tag>     -> uploads the tarball unchanged to REGISTRY_URL
//
// Environment: REGISTRY_URL, SEMVER_PATH, INTERNAL_SCOPES (comma list), BLOCKLIST (file),
//              SEED_OS / SEED_CPU (e.g. linux / x64; empty = every platform), AUTH_NPMRC (publish)

const fs = require('fs');

const [mode, file, publishTag] = process.argv.slice(2);
if (!['kind', 'plan', 'verify', 'publish'].includes(mode) || !file) {
  console.error('usage: seed-plan.js kind|plan|verify <file.json>  |  publish <file.tgz> <tag>');
  process.exit(64);
}

// Publish without "npm publish": a package's own publishConfig.registry would override
// --registry and send it to the public registry. Same request body as npm (libnpmpublish),
// built from the original tarball bytes, so integrity hashes stay identical to the lockfile.
if (mode === 'publish') {
  publish(file, publishTag || 'latest').catch(e => { console.error('publish: ' + e.message); process.exit(1); });
  return;
}

function packageJsonFromTgz(buf) {
  const tar = require('zlib').gunzipSync(buf);
  for (let off = 0; off + 512 <= tar.length;) {
    const field = (a, b) => tar.toString('utf8', off + a, off + b).replace(/\0.*$/s, '');
    const name = field(0, 100);
    if (!name) break;
    const size = parseInt(field(124, 136).trim() || '0', 8);
    const full = (field(345, 500) ? field(345, 500) + '/' : '') + name;
    if (/^[^/]+\/package\.json$/.test(full)) return JSON.parse(tar.toString('utf8', off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('package.json not found in tarball');
}

function registryToken() {
  const key = String(process.env.REGISTRY_URL).replace(/^https?:/, '').replace(/\/*$/, '/') + ':_authToken=';
  const line = fs.readFileSync(process.env.AUTH_NPMRC, 'utf8').split('\n').map(l => l.trim()).find(l => l.startsWith(key));
  if (!line) throw new Error(`no "${key}" line in ${process.env.AUTH_NPMRC}`);
  return line.slice(key.length);
}

async function publish(tgzPath, tag) {
  const crypto = require('crypto');
  const reg = String(process.env.REGISTRY_URL).replace(/\/*$/, '/');
  const data = fs.readFileSync(tgzPath);
  const manifest = packageJsonFromTgz(data);
  const tarballName = `${manifest.name}-${manifest.version}.tgz`;
  manifest._id = `${manifest.name}@${manifest.version}`;
  manifest.dist = {
    integrity: 'sha512-' + crypto.createHash('sha512').update(data).digest('base64'),
    shasum: crypto.createHash('sha1').update(data).digest('hex'),
    tarball: new URL(`${manifest.name}/-/${tarballName}`, reg).href.replace(/^https:\/\//, 'http://'),
  };
  const body = {
    _id: manifest.name, name: manifest.name, description: manifest.description,
    'dist-tags': { [tag]: manifest.version }, versions: { [manifest.version]: manifest }, access: null,
    _attachments: { [tarballName]: { content_type: 'application/octet-stream', data: data.toString('base64'), length: data.length } },
  };
  const r = await fetch(reg + manifest.name.replace('/', '%2f'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registryToken() },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${manifest._id}: HTTP ${r.status} ${text.slice(0, 200)}`);
  console.log(`published ${manifest._id} (${tag})`);
}

const json = JSON.parse(fs.readFileSync(file, 'utf8'));

if (mode === 'kind') {
  console.log(json.lockfileVersion ? 'lock' : 'package');
  process.exit(0);
}

const semver = require(process.env.SEMVER_PATH);
const registry = String(process.env.REGISTRY_URL || '').replace(/\/*$/, '/');
const internal = (process.env.INTERNAL_SCOPES || '').split(',').map(s => s.trim()).filter(Boolean);
const seedOs = process.env.SEED_OS || '';
const seedCpu = process.env.SEED_CPU || '';

// npm "os"/"cpu" field check: ["linux"], ["!win32"], ... Empty target or field = allowed.
function platformOk(list, target) {
  if (!target || !Array.isArray(list) || list.length === 0) return true;
  if (list.includes('!' + target)) return false;
  const positive = list.filter(x => !x.startsWith('!'));
  return positive.length === 0 || positive.includes(target);
}

// Every package in the lockfile, once per name@version.
function specsFromLock(lock) {
  if (!lock.packages) throw new Error('need lockfileVersion 2 or 3 (npm 7 or newer)');
  const out = new Map();
  for (const [path, e] of Object.entries(lock.packages)) {
    if (!path || !path.includes('node_modules/') || e.link || e.inBundle) continue;
    const name = e.name || path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (internal.some(scope => name.startsWith(scope + '/'))) continue; // published separately
    const fromRegistry = Boolean(semver.valid(e.version)) && (!e.resolved || /^https?:\/\//.test(e.resolved));
    const otherPlatform = !platformOk(e.os, seedOs) || !platformOk(e.cpu, seedCpu);
    out.set(`${name}@${e.version}`, { name, version: e.version, integrity: e.integrity || '', fromRegistry, otherPlatform });
  }
  return [...out.values()];
}

// Blocklist lines: "<name> <semver range>"; no range = every version. "#" starts a comment.
function loadBlocklist() {
  const f = process.env.BLOCKLIST;
  if (!f || !fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n')
    .map(l => l.replace(/#.*/, '').trim()).filter(Boolean)
    .map(l => {
      const i = l.search(/\s/);
      return i < 0 ? { name: l, range: '*' } : { name: l.slice(0, i), range: l.slice(i + 1).trim() };
    });
}

async function fetchMeta(name) {
  const r = await fetch(registry + name.replace('/', '%2f'), { headers: { accept: 'application/json' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${name}: registry answered HTTP ${r.status}`);
  return r.json();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

function sameIntegrity(lockIntegrity, dist) {
  if (!lockIntegrity) return true;
  for (const part of lockIntegrity.split(/\s+/)) {
    const dash = part.indexOf('-');
    const alg = part.slice(0, dash);
    if (alg === 'sha512' && dist.integrity) return dist.integrity.split(/\s+/).includes(part);
    if (alg === 'sha1' && dist.shasum) return Buffer.from(part.slice(dash + 1), 'base64').toString('hex') === dist.shasum;
  }
  return true;
}

(async () => {
  const specs = specsFromLock(json);
  const names = [...new Set(specs.map(s => s.name))];
  const metaList = await mapLimit(names, 8, fetchMeta);
  const meta = new Map(names.map((n, i) => [n, metaList[i]]));
  const rows = [];

  if (mode === 'plan') {
    const block = loadBlocklist();
    for (const name of names) {
      const m = meta.get(name);
      const have = new Set(Object.keys((m && m.versions) || {}));
      const mine = specs.filter(s => s.name === name);
      const missing = mine.filter(s => s.fromRegistry && !s.otherPlatform && !have.has(s.version));
      const all = [...have, ...missing.map(s => s.version)].filter(v => semver.valid(v));
      const best = semver.rsort(all.filter(v => !semver.prerelease(v)))[0] || semver.rsort([...all])[0];
      const current = m && m['dist-tags'] && m['dist-tags'].latest;
      for (const s of mine) {
        const spec = `${s.name}@${s.version}`;
        if (s.otherPlatform) {
          rows.push(['SKIPPED', spec, `not for ${seedOs || '*'}/${seedCpu || '*'}`]);
        } else if (!s.fromRegistry) {
          rows.push(['UNSUPPORTED', spec, 'not a registry package (git, file or URL)']);
        } else if (block.some(b => b.name === s.name && semver.satisfies(s.version, b.range, { includePrerelease: true }))) {
          rows.push(['BLOCKED', spec, 'in blocklist']);
        } else if (have.has(s.version)) {
          rows.push(['PRESENT', spec, '']);
        } else {
          // Only the highest version may move "latest"; older or prerelease versions get their own tag.
          const tag = s.version === best && (!current || semver.gt(best, current)) ? 'latest'
            : semver.prerelease(s.version) ? 'seed-pre' : 'seed-old';
          rows.push(['MISSING', spec, tag]);
        }
      }
    }
  } else {
    for (const s of specs) {
      if (!s.fromRegistry || s.otherPlatform) continue;
      const spec = `${s.name}@${s.version}`;
      const m = meta.get(s.name);
      const v = m && m.versions && m.versions[s.version];
      if (!v) rows.push(['MISSING', spec, '']);
      else if (!sameIntegrity(s.integrity, v.dist || {})) rows.push(['MISMATCH', spec, 'integrity differs from the lockfile']);
      else rows.push(['OK', spec, '']);
    }
  }
  for (const r of rows) console.log(r.join('\t'));
})().catch(e => { console.error('seed-plan: ' + e.message); process.exit(1); });

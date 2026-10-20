// Publish DiffStudio to a GitHub Release (Node version of publish-release.ps1).
//
// Usage from the repo root:
//   $env:GITHUB_TOKEN = "<PAT>"; node build/publish-release.mjs
// or without the variable to be prompted (input hidden).
//
// The token is only read into memory; it is never written to disk or git config.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const OWNER = process.env.DIFFSTUDIO_OWNER || 'xun78243-sudo';
const REPO = process.env.DIFFSTUDIO_REPO || 'diffstudio';
const TAG = process.env.DIFFSTUDIO_TAG || 'v0.1.1';
const INSTALLER = path.join(repoRoot, 'dist', `DiffStudio-Setup-${TAG.replace(/^v/, '')}.exe`);
const BODY = path.join(here, 'release-body.md');

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function readToken() {
  const fromEnv = process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv.trim();
  const { promptHidden } = await import('./prompt-hidden.mjs');
  return promptHidden('GitHub PAT (input hidden, Ctrl+C to abort): ');
}

async function api(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'diffstudio-release',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) fail(`GitHub API ${res.status} ${res.statusText}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function sha256(file) {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex').toUpperCase();
}

const info = await stat(INSTALLER).catch(() => null);
if (!info) fail(`Installer not found: ${INSTALLER} (run 'npm run dist' first)`);

const token = await readToken();
if (!token) fail('No token given.');

const digest = await sha256(INSTALLER);
console.log(`Installer ${path.basename(INSTALLER)} (${(info.size / 1048576).toFixed(1)} MB)`);
console.log(`SHA256 ${digest}`);
const body = await readFile(BODY, 'utf8');
if (!body.includes(digest)) fail('release-body.md does not contain this installer SHA256; fix it before publishing.');

const base = `https://api.github.com/repos/${OWNER}/${REPO}`;
const existing = await api(token, `${base}/releases/tags/${encodeURIComponent(TAG)}`).catch(() => null);

let release = existing;
if (!existing) {
  console.log(`Creating release ${TAG} ...`);
  release = await api(token, `${base}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      tag_name: TAG,
      name: `DiffStudio ${TAG.replace(/^v/, '')}`,
      body,
      draft: false,
      prerelease: false,
    }),
  });
  console.log(`Release created: ${release.html_url}`);
} else {
  console.log(`Release ${TAG} already exists: ${release.html_url} (reusing it)`);
}

const name = path.basename(INSTALLER);
const already = (release.assets || []).find((a) => a.name === name);
if (already) {
  console.log(`Asset already present: ${already.browser_download_url} (${already.size} bytes)`);
} else {
  console.log(`Uploading ${name} ...`);
  const asset = await api(
    token,
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await readFile(INSTALLER),
    }
  );
  console.log(`Asset uploaded: ${asset.browser_download_url}`);
}

console.log(`Done: ${release.html_url}`);

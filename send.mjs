// EOL check: send script for the ワークフロー方式 (docs/design-workflow-mode.md 6.1).
// This single file is the source of truth for both distribution forms (the inline workflow and the action).
// Plain Node ESM, no dependencies. It sends dependency files and README-like files only, never source code.
// The selection rules mirror selectWorkflowUpload() in src/core/workflow.ts (checked by tests).
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------------------------------------------
// Glob matching (port of src/core/glob.ts)
// ---------------------------------------------------------------------------------------------------------------
const globCache = new Map();

/** Supported syntax: `**`, `*`, `?`, `{a,b}`. Anchored to the whole path. */
export function globToRegExp(glob) {
  const hit = globCache.get(glob);
  if (hit) return hit;
  let re = '';
  let i = 0;
  let braceDepth = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atSegStart = i === 0 || glob[i - 1] === '/';
        if (glob[i + 2] === '/' && atSegStart) {
          re += '(?:.*/)?';
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      braceDepth++;
      re += '(?:';
    } else if (c === '}' && braceDepth > 0) {
      braceDepth--;
      re += ')';
    } else if (c === ',' && braceDepth > 0) {
      re += '|';
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
    i++;
  }
  const out = new RegExp(`^${re}$`);
  globCache.set(glob, out);
  return out;
}

export function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}

export function depth(path) {
  let n = 0;
  for (const ch of path) if (ch === '/') n++;
  return n;
}

/** Shallow paths first, then shorter, then alphabetical. */
export function byRelevance(a, b) {
  return depth(a) - depth(b) || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Selection (port of selectWorkflowUpload)
// ---------------------------------------------------------------------------------------------------------------

/** Client-side caps on presence paths (the server accepts at most 200). Today's catalog has maxPaths <= 10. */
export const PRESENCE_MAX_PER_NEED = 10;
export const PRESENCE_MAX_TOTAL = 100;
/** Room for presence / skipped / metadata on top of the file contents when counting the body against maxTotalBytes. */
export const BODY_MARGIN_BYTES = 64 * 1024;

/** True when a directory segment of the path is in the catalog's skip lists (the file name itself is not checked). */
export function isCatalogSkipped(skip, path) {
  const exact = new Set(skip.dirs);
  const lower = new Set(skip.dirsIgnoreCase.map((d) => d.toLowerCase()));
  const segs = path.split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    if (exact.has(segs[i]) || lower.has(segs[i].toLowerCase())) return true;
  }
  return false;
}

/**
 * Decide what to send. `catalog` is the parsed /files.json, `entries` is [{path, size}] (size = bytes of the
 * checked-out file, or null when the file is not on disk), `limits` is catalog.limits.
 * Returns { files: string[], presence: string[], skipped: [{path, reason}] } (paths only).
 */
/** At most this many skipped entries are sent (the server only logs them); the log shows the full count. */
const MAX_SKIPPED_SENT = 100;

/** Same rule as the server's validPath (src/app/workflow-upload.ts): one bad path would make it refuse the whole upload. */
export function isSendablePath(p) {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    p.length <= 300 &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    !p.split('/').some((s) => s === '' || s === '.' || s === '..') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(p)
  );
}

export function selectFiles(catalog, entries, limits) {
  const size = new Map(entries.map((e) => [e.path, e.size]));
  const paths = entries.map((e) => e.path).filter((p) => !isCatalogSkipped(catalog.skip, p));
  const skipped = [];

  const lockfileRe = new RegExp(catalog.lockfilePattern);
  const manifests = [];
  for (const p of paths.filter((x) => matchesAny(x, catalog.manifests)).sort(byRelevance)) {
    const s = size.get(p);
    if (s === null || s === undefined) continue; // not checked out: skip silently
    const cap = lockfileRe.test(p) ? limits.maxLockfileBytes : limits.maxFileBytes;
    if (s > cap) skipped.push({ path: p, reason: 'too_large' });
    else manifests.push(p);
  }

  const rootRe = new RegExp(catalog.readme.rootPattern, 'i');
  const docsRe = new RegExp(catalog.readme.docsPattern, 'i');
  const readme = paths
    .filter((p) => {
      if (!(rootRe.test(p) || docsRe.test(p))) return false;
      const s = size.get(p);
      return s !== null && s !== undefined && s <= catalog.readme.maxBytes;
    })
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .slice(0, catalog.readme.maxFiles);

  const files = [];
  for (const p of [...manifests, ...readme]) {
    if (files.includes(p)) continue;
    if (files.length >= limits.maxFiles) skipped.push({ path: p, reason: 'too_many' });
    else files.push(p);
  }

  // Presence: paths only, never read. Client-side caps apply whatever the catalog says (a broken or hostile catalog
  // must not make the script list the whole tree): at most PRESENCE_MAX_PER_NEED per need, PRESENCE_MAX_TOTAL in all.
  const presence = new Set();
  for (const need of catalog.presence) {
    const cap = Number.isInteger(need.maxPaths) && need.maxPaths > 0 ? Math.min(need.maxPaths, PRESENCE_MAX_PER_NEED) : 0;
    paths
      .filter((p) => matchesAny(p, need.globs))
      .sort(byRelevance)
      .slice(0, cap)
      .forEach((p) => presence.add(p));
  }
  return { files, presence: [...presence].filter((p) => !files.includes(p)).slice(0, PRESENCE_MAX_TOTAL), skipped };
}

// ---------------------------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------------------------

/** Size of a regular file on disk (symlinks are not followed), or null when it is not there. */
function fileSize(path) {
  try {
    const st = lstatSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

function listPaths() {
  // NEVER add -l / --long here. In a blob-less clone (filter: blob:none) `ls-tree -l` downloads every blob just to
  // report sizes, which would pull all source code onto the runner. Sizes come from the checked-out files instead.
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function validAppUrl(u) {
  return /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u);
}

export async function main(env = process.env) {
  const appUrl = (env.APP_URL ?? '').replace(/\/+$/, '');
  const client = env.CLIENT === 'action' ? 'action' : 'inline';
  const templateVersion = Number.parseInt(env.TEMPLATE_VERSION ?? '', 10);
  if (!validAppUrl(appUrl)) return fail('APP_URL が正しくありません（https:// で始まる URL を指定してください）。');
  if (!Number.isSafeInteger(templateVersion) || templateVersion <= 0) return fail('TEMPLATE_VERSION が正しくありません。');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return fail('OIDC トークンを取得できません。ワークフローの permissions に「id-token: write」が必要です。');
  }

  // Action form (CATALOG_FILE): the catalog is a snapshot pinned inside the action (selection never depends on the live
  // service; its version is what the user runs). Inline form: the live /files.json (the sparse patterns are fixed in the
  // user's YAML, and a file is only sent if it is on disk AND matches these rules).
  let catalog;
  if (env.CATALOG_FILE) {
    try {
      catalog = JSON.parse(readFileSync(env.CATALOG_FILE, 'utf8'));
    } catch (e) {
      return fail(`同梱の catalog.json を読めませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    try {
      const res = await fetch(`${appUrl}/files.json`);
      if (!res.ok) return fail(`/files.json を取得できませんでした（HTTP ${res.status}）。`);
      catalog = await res.json();
    } catch (e) {
      return fail(`/files.json を取得できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!catalog || catalog.schema !== 1) return fail('catalog の形式（schema）がこのスクリプトに対応していません。ひな形（またはアクション）を新しいものに替えてください。');

  // Paths the server would refuse (it rejects the whole upload for one bad path) are left out here.
  const entries = listPaths()
    .filter(isSendablePath)
    .map((path) => ({ path, size: fileSize(path) }));
  const sel = selectFiles(catalog, entries, catalog.limits);

  // Read the contents; stop at the total body cap.
  const files = [];
  const skipped = [...sel.skipped];
  // Budget = the JSON as sent (escaping included, so a content full of quotes counts for what it really weighs) plus a margin.
  let total = BODY_MARGIN_BYTES;
  for (const path of sel.files) {
    let content;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const bytes = Buffer.byteLength(JSON.stringify({ path, content }), 'utf8');
    if (total + bytes > catalog.limits.maxTotalBytes) {
      skipped.push({ path, reason: 'too_many' });
      continue;
    }
    total += bytes;
    files.push({ path, content });
  }

  // OIDC token (audience = this service).
  let token;
  try {
    const tr = await fetch(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(appUrl)}`, {
      headers: { Authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    });
    if (!tr.ok) return fail(`OIDC トークンを取得できませんでした（HTTP ${tr.status}）。permissions に「id-token: write」が必要です。`);
    token = (await tr.json()).value;
  } catch (e) {
    return fail(`OIDC トークンを取得できませんでした: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof token !== 'string' || !token) return fail('OIDC トークンが空でした。');

  const body = gzipSync(
    Buffer.from(
      JSON.stringify({ templateVersion, client, catalogVersion: catalog.version, files, presence: sel.presence, skipped: skipped.slice(0, MAX_SKIPPED_SENT) }),
      'utf8',
    ),
  );

  // Audit log: names only, never contents or the token.
  console.log(`送るファイル（中身あり）: ${files.length} 件`);
  for (const f of files) console.log(`  ${f.path}`);
  console.log(`有無だけ送るパス（中身なし）: ${sel.presence.length} 件`);
  for (const p of sel.presence) console.log(`  ${p}`);
  if (skipped.length > 0) console.log(`送らなかったファイル: ${skipped.length} 件（${skipped.map((s) => `${s.path}:${s.reason}`).join(', ')}）`);

  let res;
  try {
    res = await fetch(`${appUrl}/api/workflow/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', authorization: `Bearer ${token}` },
      body,
    });
  } catch (e) {
    return fail(`送信できませんでした（ネットワークエラー）: ${e instanceof Error ? e.message : String(e)}`);
  }
  let reply = null;
  try {
    reply = await res.json();
  } catch {
    // not JSON
  }
  const message = reply && typeof reply.message === 'string' ? reply.message : '';
  console.log(`応答: HTTP ${res.status}${reply && reply.status ? ` / ${reply.status}` : ''}${message ? ` / ${message}` : ''}`);
  if (reply && typeof reply.result === 'string') console.log(`結果: ${reply.result}`);
  // Only these are failures (design 6.1: everything else succeeds, e.g. skipped / unchanged / deferred / 404).
  if (res.status === 413 || res.status === 429 || res.status === 401 || res.status >= 500) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`予期しないエラー: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}

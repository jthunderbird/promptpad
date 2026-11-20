// Minimal GitHub REST client: just what promptpad sync needs (no git executable, no local clone).
// The API and web base URLs can be overridden (tests point them at a fake server; GitHub Enterprise later).
import type { Link } from './model';
import * as P from './platform';

const LS = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };

export const cfg = {
  get api() { return (LS('promptpad.ghApi') || 'https://api.github.com').replace(/\/$/, ''); },
  get web() { return (LS('promptpad.ghWeb') || 'https://github.com').replace(/\/$/, ''); },
  /** Client id of the promptpad OAuth App (public value); a stored override wins (used by tests). */
  get clientId() { return LS('promptpad.ghClientId') || DEFAULT_CLIENT_ID; },
  /** Permission asked for at sign-in: repository contents (an OAuth App has no narrower scope for private repos). */
  scope: 'repo',
};

/** Public client id of promptpad's GitHub OAuth App (device flow enabled). Not a secret. */
export const DEFAULT_CLIENT_ID = 'Ov23lijDhZWpORmuzEjk';

export type ErrKind = 'auth' | 'conflict' | 'notfound' | 'network' | 'http';
export class GhError extends Error {
  constructor(public kind: ErrKind, public status: number, message: string) { super(message); }
}

// ---- utf-8 <-> base64 ----
export function b64enc(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function b64dec(s: string): string {
  const bin = atob(s.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const seg = (p: string) => p.split('/').map(encodeURIComponent).join('/');

async function call(token: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  let res: Response;
  try {
    res = await fetch(cfg.api + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...extra,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch (e) {
    throw new GhError('network', 0, 'Cannot reach GitHub: ' + String((e as Error).message ?? e));
  }
  return res;
}

async function fail(res: Response): Promise<never> {
  let msg = res.statusText;
  try { msg = (await res.json()).message || msg; } catch { /* keep */ }
  const kind: ErrKind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 404 ? 'notfound' : res.status === 409 || res.status === 422 ? 'conflict' : 'http';
  throw new GhError(kind, res.status, `GitHub ${res.status}: ${msg}`);
}

export interface Repo { full_name: string; private: boolean }

export async function getUser(token: string): Promise<{ login: string }> {
  const r = await call(token, 'GET', '/user');
  if (!r.ok) return fail(r);
  return r.json();
}

export async function listRepos(token: string): Promise<Repo[]> {
  const r = await call(token, 'GET', '/user/repos?per_page=100&sort=pushed');
  if (!r.ok) return fail(r);
  return (await r.json()).map((x: any) => ({ full_name: x.full_name, private: !!x.private }));
}

export async function getRepo(token: string, repo: string): Promise<Repo> {
  const r = await call(token, 'GET', `/repos/${repo}`);
  if (!r.ok) return fail(r);
  const x = await r.json();
  return { full_name: x.full_name, private: !!x.private };
}

export async function branchExists(token: string, repo: string, branch: string): Promise<boolean> {
  const r = await call(token, 'GET', `/repos/${repo}/branches/${encodeURIComponent(branch)}`);
  if (r.status === 404) return false;
  if (!r.ok) return fail(r);
  return true;
}

/** The .ppad files on a branch. */
export async function listPpad(token: string, repo: string, branch: string): Promise<string[]> {
  const r = await call(token, 'GET', `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (!r.ok) return fail(r);
  const j = await r.json();
  return (j.tree as any[]).filter((e) => e.type === 'blob' && /\.ppad$/i.test(e.path)).map((e) => e.path as string);
}

export type FileResult =
  | { kind: 'notmod' }
  | { kind: 'missing' }
  | { kind: 'ok'; sha: string; text: string; etag?: string };

/** Read a file. Pass the etag of the last read to get a cheap 'notmod' when nothing changed. */
export async function getFile(token: string, link: Link, etag?: string): Promise<FileResult> {
  const r = await call(token, 'GET', `/repos/${link.repo}/contents/${seg(link.path)}?ref=${encodeURIComponent(link.branch)}`, undefined, etag ? { 'If-None-Match': etag } : {});
  if (r.status === 304) return { kind: 'notmod' };
  if (r.status === 404) return { kind: 'missing' };
  if (!r.ok) return fail(r);
  const j = await r.json();
  return { kind: 'ok', sha: j.sha, text: b64dec(j.content ?? ''), etag: r.headers.get('ETag') ?? undefined };
}

/** Create (sha = null) or update a file. Throws a 'conflict' GhError when the file changed meanwhile. */
export async function putFile(token: string, link: Link, text: string, sha: string | null, message: string): Promise<{ sha: string }> {
  const r = await call(token, 'PUT', `/repos/${link.repo}/contents/${seg(link.path)}`, {
    message,
    content: b64enc(text),
    branch: link.branch,
    ...(sha ? { sha } : {}),
  });
  if (!r.ok) return fail(r);
  return { sha: (await r.json()).content.sha };
}

/** Create `branch` as an orphan branch (no parent commits) holding just this one file. */
export async function createOrphanBranch(token: string, link: Link, text: string, message: string): Promise<{ sha: string }> {
  const post = async (p: string, body: unknown) => {
    const r = await call(token, 'POST', `/repos/${link.repo}${p}`, body);
    if (!r.ok) return fail(r);
    return r.json();
  };
  const blob = await post('/git/blobs', { content: b64enc(text), encoding: 'base64' });
  const tree = await post('/git/trees', { tree: [{ path: link.path, mode: '100644', type: 'blob', sha: blob.sha }] });
  const commit = await post('/git/commits', { message, tree: tree.sha, parents: [] });
  await post('/git/refs', { ref: `refs/heads/${link.branch}`, sha: commit.sha });
  return { sha: blob.sha };
}

// ---- sign-in: OAuth device flow (browser) ----

export interface DeviceCode { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number }

async function postJson(url: string, body: unknown): Promise<any> {
  const text = await P.httpPostJson(url, JSON.stringify(body));
  try { return JSON.parse(text); } catch { throw new GhError('http', 0, 'Unexpected answer from GitHub sign-in'); }
}

export async function deviceStart(clientId: string): Promise<DeviceCode> {
  const j = await postJson(`${cfg.web}/login/device/code`, { client_id: clientId, scope: cfg.scope });
  if (!j.device_code) throw new GhError('http', 0, j.error_description || j.error || 'Sign-in could not start');
  return j;
}

/** One poll. Returns the token, or a reason to keep waiting ('pending', 'slow') or an error string. */
export async function devicePoll(clientId: string, device: string): Promise<{ token?: string; wait?: 'pending' | 'slow'; error?: string }> {
  const j = await postJson(`${cfg.web}/login/oauth/access_token`, {
    client_id: clientId,
    device_code: device,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (j.access_token) return { token: j.access_token };
  if (j.error === 'authorization_pending') return { wait: 'pending' };
  if (j.error === 'slow_down') return { wait: 'slow' };
  return { error: j.error_description || j.error || 'Sign-in failed' };
}

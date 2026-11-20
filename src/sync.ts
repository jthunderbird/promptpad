// GitHub sync engine. A workspace whose header carries a `remote` link (repo, branch, file) is kept in step
// with that file on GitHub through the REST API: no git executable and no local clone.
//
// Same idea as the multi-instance sync on a shared file, with the remote file's blob sha as its signature:
//   - after a pause in typing (idle, default 10 s; at most 60 s of continuous typing) push the workspace;
//   - every 15 s and on window focus fetch (conditional request) and three-way merge what others pushed;
//   - a push rejected because the file moved (sha mismatch) means: fetch, merge, push again.
// The merge base (what we last synced) is persisted per link so edits made offline still merge three-way.
import * as gh from './gh';
import * as P from './platform';
import { type Link, type Workspace, parseWorkspace, serializeWorkspace } from './model';
import { type BlameInfo, mapBlame } from './blame';
import { type MergeResult, type Snap, fileSnap, mergeSnaps, snapOf, snapString } from './merge';

export type SyncState = 'off' | 'signedout' | 'pending' | 'syncing' | 'synced' | 'offline' | 'auth' | 'error';

export interface SyncDeps {
  ws(): Workspace;
  /** Run inside the app's serial chain (shared with local file saves and file-change merges). */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Commit any in-progress edit into the model (no DOM change). */
  flush(): void;
  /** Put a merge result into the live workspace. Returns whether anything changed. */
  apply(res: MergeResult): boolean;
  /** The workspace changed because of a remote merge: save the local file too. */
  touchLocal(): void;
  toast(msg: string, ms?: number): void;
  changed(): void;
}

interface Base { sha: string | null; snap: Snap; etag?: string }

const EMPTY: Snap = { tabs: [], copyFormat: 'markdown', toggles: {} };
export const linkKey = (l: Link) => `${l.repo}@${l.branch}:${l.path}`;
const BASE_KEY = (l: Link) => 'promptpad.gh.base:' + linkKey(l);

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } };

export class Sync {
  state: SyncState = 'off';
  detail = '';
  conflicts = 0;
  lastSync = 0;
  isPublic = false;
  user = lsGet('promptpad.ghuser') ?? '';
  idleMs = 10_000;
  maxMs = 60_000;
  pollMs = 15_000;

  /** Who last changed each block (GitHub blame of the synced file), keyed by tab uid and block key. */
  blame = new Map<string, BlameInfo[]>();
  private blameSha = '';
  private baseText = '';
  private token: string | null = null;
  private base: Base | null = null;
  private idleT = 0;
  private maxT = 0;
  private pollT = 0;

  constructor(private d: SyncDeps) {}

  get link(): Link | null { return this.d.ws().remote ?? null; }
  get signedIn() { return !!this.token; }

  async init() {
    this.token = await P.getToken();
    this.startPolling();
    this.attach();
  }

  private startPolling() {
    clearInterval(this.pollT);
    this.pollT = window.setInterval(() => this.poll(), this.pollMs);
  }

  setTiming(idleMs: number, maxMs: number, pollMs: number) {
    this.idleMs = idleMs; this.maxMs = maxMs; this.pollMs = pollMs;
    this.startPolling();
  }

  private poll() {
    if (!this.link || !this.token || document.hidden || this.idleT || this.state === 'auth') return;
    void this.syncNow();
  }

  /** Call when the open workspace changed (opened, new, linked or unlinked). */
  attach() {
    clearTimeout(this.idleT); clearTimeout(this.maxT);
    this.idleT = this.maxT = 0;
    this.conflicts = 0;
    this.isPublic = false;
    this.base = null;
    this.blame = new Map(); this.blameSha = ''; this.baseText = '';
    const l = this.link;
    if (!l) return this.set('off');
    const raw = lsGet(BASE_KEY(l));
    if (raw) {
      try {
        const j = JSON.parse(raw);
        this.base = { sha: j.sha ?? null, snap: fileSnap(parseWorkspace(j.text)), etag: j.etag };
        this.baseText = j.text;
      } catch { /* start without a base */ }
    }
    if (!this.token) return this.set('signedout');
    this.set('pending');
    void this.loadRepoInfo(l);
    void this.syncNow();
  }

  private async loadRepoInfo(l: Link) {
    try {
      const r = await gh.getRepo(this.token!, l.repo);
      if (this.link && linkKey(this.link) === linkKey(l)) { this.isPublic = !r.private; this.d.changed(); }
    } catch { /* not important */ }
  }

  private set(state: SyncState, detail = '') {
    this.state = state;
    this.detail = detail;
    this.d.changed();
  }

  /** Called after every edit. Cheap; the real work happens after the idle delay. */
  noteChange() {
    if (!this.link || !this.token) return;
    if (this.state !== 'pending') this.set('pending');
    clearTimeout(this.idleT);
    this.idleT = window.setTimeout(() => void this.syncNow(), this.idleMs);
    if (!this.maxT) this.maxT = window.setTimeout(() => void this.syncNow(), this.maxMs);
  }

  /** Fetch who changed what (one GraphQL call) when the remote file has a new version. Failures are ignored. */
  async refreshBlame(force = false) {
    const l = this.link, token = this.token, sha = this.base?.sha;
    if (!l || !token || !sha || !this.baseText) return;
    if (!force && sha === this.blameSha) return;
    const text = this.baseText;
    try {
      const ranges = await gh.getBlame(token, l);
      if (this.base?.sha !== sha) return;
      this.blame = mapBlame(text, ranges);
      this.blameSha = sha;
      this.d.changed();
    } catch { /* blame is a nicety; keep what we have */ }
  }

  blameFor(tab: string, key: string, occurrence: number): BlameInfo | null {
    return this.blame.get(tab + '|' + key)?.[occurrence] ?? null;
  }

  dismissConflicts() { this.conflicts = 0; this.d.changed(); }

  // ---- sign in / out ----

  /** Verify and store a token (pasted, or obtained by the browser flow). */
  async signIn(token: string): Promise<string> {
    const u = await gh.getUser(token);
    await P.setToken(token);
    this.token = token;
    this.user = u.login;
    lsSet('promptpad.ghuser', u.login);
    this.attach();
    return u.login;
  }

  async signOut() {
    await P.setToken(null);
    this.token = null;
    this.user = '';
    lsSet('promptpad.ghuser', null);
    this.attach();
  }

  requireToken(): string {
    if (!this.token) throw new gh.GhError('auth', 401, 'Sign in to GitHub first');
    return this.token;
  }

  // ---- link management ----

  private persist(l: Link, text: string | null, sha: string | null, etag?: string) {
    if (text === null) lsSet(BASE_KEY(l), null);
    else lsSet(BASE_KEY(l), JSON.stringify({ sha, text, etag }));
  }

  /** Remember `text` (as just read from or written to GitHub) as the merge base for `l`. */
  seed(l: Link, sha: string, text: string, etag?: string) {
    this.persist(l, text, sha, etag);
  }

  /** Create the file on GitHub (and the orphan branch if it does not exist yet) and link the open workspace to it. */
  async publish(l: Link): Promise<void> {
    const token = this.requireToken();
    const ws = this.d.ws();
    this.d.flush();
    const prev = ws.remote;
    ws.remote = l;
    const text = serializeWorkspace(ws);
    try {
      let sha: string;
      if (!(await gh.branchExists(token, l.repo, l.branch))) sha = (await gh.createOrphanBranch(token, l, text, 'promptpad: create ' + l.path)).sha;
      else {
        if ((await gh.getFile(token, l)).kind !== 'missing') throw new Error(`${l.path} already exists on ${l.branch}. Open it, or pick another file name.`);
        sha = (await gh.putFile(token, l, text, null, 'promptpad: create ' + l.path)).sha;
      }
      this.persist(l, text, sha);
    } catch (e) {
      ws.remote = prev;
      throw e;
    }
    this.attach();
  }

  unlink() {
    const ws = this.d.ws();
    if (ws.remote) this.persist(ws.remote, null, null);
    ws.remote = null;
    this.attach();
  }

  // ---- the sync cycle ----

  syncNow(): Promise<void> {
    return this.d.run(() => this.cycle());
  }

  private async cycle() {
    clearTimeout(this.idleT); clearTimeout(this.maxT);
    this.idleT = this.maxT = 0;
    const l = this.link;
    const token = this.token;
    if (!l || !token) return;
    const ws = this.d.ws();
    if (this.state === 'pending') this.set('syncing');
    try {
      this.d.flush();
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = await gh.getFile(token, l, this.base?.etag);
        const missing = r.kind === 'missing';
        if (r.kind === 'ok') {
          if (this.base && r.sha === this.base.sha) {
            this.base.etag = r.etag;
          } else {
            const remoteSnap = fileSnap(parseWorkspace(r.text));
            const res = mergeSnaps(this.base?.snap ?? EMPTY, snapOf(ws), remoteSnap);
            const changed = this.d.apply(res);
            this.base = { sha: r.sha, snap: remoteSnap, etag: r.etag };
            this.baseText = r.text;
            this.persist(l, r.text, r.sha, r.etag);
            if (res.conflicts) this.conflicts += res.conflicts;
            if (changed) {
              this.d.touchLocal();
              this.d.toast(res.conflicts ? `Updated from GitHub. ${res.conflicts} block${res.conflicts === 1 ? '' : 's'} changed on both sides: both versions kept.` : 'Updated from GitHub');
            }
          }
        }
        if (!missing && this.base && snapString(fileSnap(ws)) === snapString(this.base.snap)) break; // nothing to push
        const text = serializeWorkspace(ws);
        try {
          const put = await gh.putFile(token, l, text, missing ? null : this.base?.sha ?? null, 'promptpad: update ' + l.path);
          this.base = { sha: put.sha, snap: fileSnap(parseWorkspace(text)) };
          this.baseText = text;
          this.persist(l, text, put.sha);
          break;
        } catch (e) {
          if (e instanceof gh.GhError && e.kind === 'conflict' && attempt < 3) { if (this.base) this.base.etag = undefined; continue; }
          throw e;
        }
      }
      this.lastSync = Date.now();
      this.set('synced');
      void this.refreshBlame();
    } catch (e) {
      if (e instanceof gh.GhError) {
        if (e.kind === 'network') this.set('offline', e.message);
        else if (e.kind === 'auth') this.set('auth', e.message);
        else this.set('error', e.message);
      } else this.set('error', String((e as Error).message ?? e));
    }
  }
}

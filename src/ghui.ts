// GitHub sync UI: the sync bar in the menu bar, the sign-in dialog and the open / save-to-GitHub dialogs.
import * as gh from './gh';
import { DEFAULT_CLIENT_ID } from './gh';
import * as P from './platform';
import type { Link } from './model';
import type { Sync } from './sync';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as any;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...kids);
  return e;
};

// ---------- modal ----------
function modal(title: string, build: (box: HTMLElement, close: () => void) => void, onClose?: () => void): () => void {
  const over = el('div', { class: 'modal' });
  const box = el('div', { class: 'box' }, el('h3', {}, title));
  over.appendChild(box);
  const close = () => { if (!over.isConnected) return; over.remove(); document.removeEventListener('keydown', onKey, true); onClose?.(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  over.addEventListener('mousedown', (e) => { if (e.target === over) close(); });
  build(box, close);
  document.body.appendChild(over);
  (box.querySelector('input,button') as HTMLElement | null)?.focus();
  return close;
}

const field = (label: string, input: HTMLElement) => el('label', { class: 'fld' }, el('span', {}, label), input);
const errBox = () => el('div', { class: 'err', hidden: true });
const showErr = (b: HTMLElement, msg: string) => { b.textContent = msg; b.hidden = !msg; };

// ---------- sync bar ----------
export function renderBar(bar: HTMLElement, sync: Sync, actions: { signIn(): void }) {
  bar.textContent = '';
  const link = sync.link;
  if (!link) { bar.hidden = true; return; }
  bar.hidden = false;
  const map: Record<string, [string, string]> = {
    signedout: ['GitHub sync: sign in', 'warn'],
    pending: ['↑ Changes pending', 'pend'],
    syncing: ['⟳ Syncing…', 'pend'],
    synced: ['✓ GitHub synced', 'ok'],
    offline: ['⚠ Offline, will retry', 'warn'],
    auth: ['⚠ Sign in again', 'warn'],
    error: ['⚠ Sync error', 'warn'],
    off: ['', ''],
  };
  const [text, cls] = map[sync.state] ?? ['', ''];
  const main = el('button', { class: 'sb ' + cls, type: 'button' }, text);
  const when = sync.lastSync ? ` · last synced ${new Date(sync.lastSync).toLocaleTimeString()}` : '';
  main.title = `${link.repo} · ${link.branch} · ${link.path}${when}${sync.user ? ` · signed in as ${sync.user}` : ''}${sync.detail ? '\n' + sync.detail : ''}`;
  main.onclick = () => {
    if (sync.state === 'signedout' || sync.state === 'auth') actions.signIn();
    else void sync.syncNow();
  };
  bar.appendChild(main);
  if (sync.isPublic) {
    const pub = el('span', { class: 'sb chip bad' }, 'PUBLIC repo');
    pub.title = 'This repository is public: everything in this workspace is visible to anyone. Do not keep secrets in prompts.';
    bar.appendChild(pub);
  }
  if (sync.conflicts) {
    const c = el('button', { class: 'sb chip warn', type: 'button' }, `⚠ ${sync.conflicts} conflict${sync.conflicts === 1 ? '' : 's'}: both versions kept`);
    c.title = 'Another device changed the same block(s) as you. Both versions are in the tab, one after the other. Click to dismiss.';
    c.onclick = () => sync.dismissConflicts();
    bar.appendChild(c);
  }
}

// ---------- sign in ----------
export function showSignIn(sync: Sync, done: (ok: boolean) => void) {
  let finished = false;
  let cancelled = false;
  const finish = (ok: boolean, close: () => void) => { if (finished) return; finished = true; cancelled = true; close(); done(ok); };
  modal('Sign in to GitHub', (box, close) => {
    const err = errBox();

    // browser (device flow)
    const status = el('div', { class: 'muted small' });
    const codeBox = el('div', { class: 'code', hidden: true });
    const idIn = el('input', { type: 'text', placeholder: 'OAuth App client id', value: gh.cfg.clientId, spellcheck: false });
    const go = el('button', { class: 'primary', type: 'button' }, 'Sign in with browser');
    go.onclick = async () => {
      showErr(err, '');
      const id = idIn.value.trim();
      if (!id) { showErr(err, 'Browser sign-in needs the client id of promptpad\'s GitHub OAuth App (see the README). You can paste a token below instead.'); return; }
      try { localStorage.setItem('promptpad.ghClientId', id); } catch { /* ignore */ }
      go.disabled = true;
      try {
        const dc = await gh.deviceStart(id);
        // Show the code first and let the user open GitHub when ready (on a phone GitHub replaces this screen).
        codeBox.hidden = false;
        codeBox.textContent = dc.user_code;
        const copy = el('button', { type: 'button' }, 'Copy code');
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(dc.user_code); }
          catch { const r = document.createRange(); r.selectNodeContents(codeBox); const sl = getSelection(); sl?.removeAllRanges(); sl?.addRange(r); document.execCommand('copy'); }
          copy.textContent = 'Copied';
        };
        const cont = el('button', { class: 'primary', type: 'button' }, 'Continue to GitHub');
        cont.onclick = () => { void P.openUrl(dc.verification_uri).catch(() => { status.textContent = `Open ${dc.verification_uri} and enter the code. Waiting…`; }); };
        go.replaceWith(el('div', { class: 'row' }, copy, cont));
        status.textContent = 'Copy the code, then continue to GitHub and enter it there. Waiting for approval…';
        let wait = Math.max(1, dc.interval || 5) * 1000;
        let netFails = 0;
        const deadline = Date.now() + dc.expires_in * 1000;
        while (!cancelled && Date.now() < deadline) {
          // also check right away when the user comes back from GitHub
          await new Promise<void>((r) => { const t = setTimeout(done2, wait); const v = () => { if (!document.hidden) setTimeout(done2, 1500); }; function done2() { clearTimeout(t); document.removeEventListener('visibilitychange', v); r(); } document.addEventListener('visibilitychange', v); });
          if (cancelled) return;
          // A failed request (for example no network while the phone switches apps) is not fatal: GitHub keeps the code valid, so just try again.
          let p: Awaited<ReturnType<typeof gh.devicePoll>>;
          try { p = await gh.devicePoll(id, dc.device_code); netFails = 0; }
          catch (e) {
            if (++netFails >= 40) throw e;
            status.textContent = 'Waiting for approval… (connection problem, retrying)';
            continue;
          }
          if (p.token) {
            await sync.signIn(p.token);
            return finish(true, close);
          }
          if (p.wait === 'slow') wait += 5000;
          else if (!p.wait) throw new Error(p.error ?? 'Sign-in failed');
        }
        if (!cancelled) throw new Error('The code expired. Try again.');
      } catch (e) {
        showErr(err, String((e as Error).message ?? e));
        codeBox.hidden = true;
        status.textContent = '';
        go.disabled = false;
      }
    };
    box.append(
      el('div', { class: 'sec' }, 'Browser'),
      el('p', { class: 'small' }, 'Opens GitHub, where you approve promptpad (access to your repositories, so it can read and write the workspace file). No password or token is typed here.'),
      ...(DEFAULT_CLIENT_ID ? [] : [field('Client id', idIn)]),
      go, codeBox, status,
    );

    // token
    const tok = el('input', { type: 'password', placeholder: 'ghp_… or github_pat_…', spellcheck: false });
    const use = el('button', { type: 'button' }, 'Sign in with token');
    use.onclick = async () => {
      showErr(err, '');
      const t = tok.value.trim();
      if (!t) return;
      use.disabled = true;
      try {
        await sync.signIn(t);
        finish(true, close);
      } catch (e) {
        showErr(err, String((e as Error).message ?? e));
        use.disabled = false;
      }
    };
    const mk = el('button', { type: 'button', class: 'link' }, 'Create a token on GitHub');
    mk.onclick = () => void P.openUrl(`${gh.cfg.web}/settings/personal-access-tokens/new`);
    box.append(
      el('div', { class: 'sec' }, 'Or paste a personal access token'),
      el('p', { class: 'small' }, 'A fine-grained token limited to your repo with "Contents: Read and write" is enough, or a classic token with the repo scope. It is stored in the Windows credential store.'),
      field('Token', tok), el('div', { class: 'row' }, use, mk),
      err,
    );
    const cancel = el('button', { type: 'button', class: 'cancel' }, 'Cancel');
    cancel.onclick = () => finish(false, close);
    box.appendChild(el('div', { class: 'row end' }, cancel));
  }, () => { cancelled = true; if (!finished) { finished = true; done(false); } });
}

// ---------- repo / branch pickers ----------
const SECRET_NOTE = 'Everything in this workspace is committed to this branch and visible to anyone with access to the repository. Do not keep secrets in prompts.';

function repoFields(sync: Sync, preset?: Link) {
  const list = el('datalist', { id: 'gh-repos' });
  const repo = el('input', { type: 'text', placeholder: 'owner/name', value: preset?.repo ?? '', spellcheck: false });
  repo.setAttribute('list', 'gh-repos');
  const branch = el('input', { type: 'text', value: preset?.branch ?? 'promptpad', spellcheck: false });
  const pub = el('div', { class: 'warnline', hidden: true }, 'This repository is public.');
  const priv = new Map<string, boolean>();
  void gh.listRepos(sync.requireToken()).then((rs) => {
    for (const r of rs) {
      priv.set(r.full_name, r.private);
      list.appendChild(el('option', { value: r.full_name, label: r.private ? 'private' : 'PUBLIC' }));
    }
  }).catch(() => { /* typing the name works too */ });
  const check = async () => {
    pub.hidden = true;
    const name = repo.value.trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(name)) return;
    try {
      const r = await gh.getRepo(sync.requireToken(), name);
      if (repo.value.trim() === name) pub.hidden = r.private;
    } catch { /* ignore */ }
  };
  repo.onchange = () => void check();
  return { list, repo, branch, pub, nodes: [list, field('Repository', repo), field('Branch', branch), pub] };
}

/** Pick a repo and branch, list the .ppad files on it, and open one. `open` throws to show an error. */
export function showOpen(sync: Sync, open: (l: Link) => Promise<void>) {
  modal('Open from GitHub', (box, close) => {
    const f = repoFields(sync);
    const err = errBox();
    const files = el('div', { class: 'files' });
    const load = el('button', { class: 'primary', type: 'button' }, 'List files');
    load.onclick = async () => {
      showErr(err, '');
      files.textContent = '';
      const repo = f.repo.value.trim();
      const branch = f.branch.value.trim();
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo) || !branch) { showErr(err, 'Enter the repository as owner/name and a branch.'); return; }
      load.disabled = true;
      try {
        const list = await gh.listPpad(sync.requireToken(), repo, branch);
        if (!list.length) files.appendChild(el('div', { class: 'muted small' }, 'No .ppad files on that branch.'));
        for (const path of list) {
          const b = el('button', { type: 'button', class: 'file' }, path);
          b.onclick = async () => {
            showErr(err, '');
            try { await open({ repo, branch, path }); close(); } catch (e) { showErr(err, String((e as Error).message ?? e)); }
          };
          files.appendChild(b);
        }
      } catch (e) {
        const g = e as gh.GhError;
        showErr(err, g.kind === 'notfound' ? 'Repository or branch not found.' : String(g.message ?? e));
      } finally { load.disabled = false; }
    };
    const cancel = el('button', { type: 'button', class: 'cancel' }, 'Close');
    cancel.onclick = close;
    box.append(...f.nodes, load, files, err, el('div', { class: 'row end' }, cancel));
  });
}

/** Choose where to create the workspace on GitHub. `save` throws to show an error. */
export function showSave(sync: Sync, defaultName: string, save: (l: Link) => Promise<void>) {
  modal('Save to GitHub', (box, close) => {
    const f = repoFields(sync);
    const name = el('input', { type: 'text', value: defaultName, spellcheck: false });
    const err = errBox();
    const go = el('button', { class: 'primary', type: 'button' }, 'Save to GitHub');
    go.onclick = async () => {
      showErr(err, '');
      const repo = f.repo.value.trim();
      const branch = f.branch.value.trim();
      let path = name.value.trim().replace(/^\/+/, '');
      if (path && !/\.ppad$/i.test(path)) path += '.ppad';
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo) || !branch || !path) { showErr(err, 'Enter the repository as owner/name, a branch and a file name.'); return; }
      go.disabled = true;
      try { await save({ repo, branch, path }); close(); } catch (e) { showErr(err, String((e as Error).message ?? e)); go.disabled = false; }
    };
    const cancel = el('button', { type: 'button', class: 'cancel' }, 'Cancel');
    cancel.onclick = close;
    box.append(
      ...f.nodes, field('File name', name),
      el('p', { class: 'small hint' }, 'A branch that does not exist yet is created empty of history (an orphan branch), so it never touches your real branches. ' + SECRET_NOTE),
      err, el('div', { class: 'row end' }, go, cancel),
    );
  });
}

import './style.css';
import pkg from '../package.json';
import { Editor } from './editor';
import { type ToggleKey, TOGGLE_KEYS, ALL_KEYS } from './md';
import {
  type Tab, type Workspace, headingLevel, joinBlocks, newBlock, newTab, newWorkspace, parseWorkspace, serializeWorkspace,
} from './model';
import * as P from './platform';
import { type MergeResult, type Snap, decodeKey, fileSnap, mergeSnaps, snapOf, snapString } from './merge';

// ---------- app settings (per machine, not in the workspace) ----------
interface Settings { theme: 'light' | 'dark' | 'system'; sidebar: boolean; last: string | null }
const SKEY = 'promptpad.settings';
function loadSettings(): Settings {
  const d: Settings = { theme: 'system', sidebar: false, last: null };
  try { return { ...d, ...JSON.parse(localStorage.getItem(SKEY) ?? '{}') }; } catch { return d; }
}
const settings = loadSettings();
const saveSettings = () => { try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch { /* ignore */ } };

const SAMPLE = `# Refactor the billing module

Add retry handling to the invoice sender. Requirements:
- retry up to 3 times with exponential backoff
- never retry on 4xx errors
- log every attempt with the invoice id

## Constraints

Keep the public API unchanged and do not touch the database schema.

| File | Change |
| --- | --- |
| sender.go | add retry loop |
| sender_test.go | cover 5xx and 4xx |

## Flow

\`\`\`mermaid
graph TD
  A[send] --> B{status}
  B -->|5xx| C[backoff]
  C --> A
  B -->|ok| D[done]
\`\`\`
`;

// ---------- state ----------
let ws: Workspace = newWorkspace();
let editor: Editor;
let autosaveTimer = 0;

const app = document.getElementById('app')!;
app.innerHTML = `
  <div id="menubar"></div>
  <div id="tabbar"><div id="tabs"></div><button id="newtab" title="New tab (Ctrl+T)">+</button>
    <div id="topsearch"><input id="topfind" placeholder="Search all tabs  (Ctrl+F)" spellcheck="false" /><div id="topres" hidden></div></div></div>
  <div id="main">
    <aside id="sidebar" hidden>
      <div class="side-tabs"><button data-pane="outline" class="on">Outline</button><button data-pane="find">Find</button></div>
      <div id="pane-outline" class="pane"></div>
      <div id="pane-find" class="pane" hidden>
        <input id="findq" placeholder="Search all tabs…" />
        <div id="findres"></div>
      </div>
    </aside>
    <div id="scroller"><div id="doc"></div></div>
  </div>
  <div id="status"><span id="st-left"></span><span id="st-right"></span></div>
  <div id="toast" hidden></div>
`;
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;

// ---------- helpers ----------
function toast(msg: string, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout((toast as any)._t);
  (toast as any)._t = setTimeout(() => (t.hidden = true), ms);
}

function applyTheme() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (editor) {
    const was = editor.dark;
    editor.dark = dark;
    if (was !== dark) editor.renderTab();
  }
}

function wsName(): string {
  return ws.path ? P.fileName(ws.path).replace(/^web:/, '') : 'Untitled workspace';
}

function updateTitle() {
  const t = `${ws.dirty ? '• ' : ''}${wsName()} — promptpad`;
  void P.setWindowTitle(t);
  $('#st-left').textContent = `${wsName()}${ws.dirty ? (ws.path ? ' (saving…)' : ' (unsaved)') : ''}`;
  const tab = editor?.tab;
  if (tab) {
    const words = tab.blocks.reduce((n, b) => n + (b.text.match(/\S+/g)?.length ?? 0), 0);
    $('#st-right').textContent = `${tab.blocks.length} blocks · ${words} words · ${ws.path ? 'autosaved · live-synced' : 'not saved to a file yet'} · copy as ${ws.copyFormat === 'plain' ? 'plain text' : 'markdown'}`;
  }
}

let editVersion = 0;
let statusTimer = 0;
let recoveryTimer = 0;
let autosaveMax = 0;
let writer: (path: string, text: string) => Promise<string | null> = P.writeKnown;

/** Cheap, non-visual bookkeeping after any edit. Never touches the editor DOM. */
function markDirty() {
  editVersion++;
  if (!ws.dirty) {
    ws.dirty = true;
    updateTitle();
  } else {
    clearTimeout(statusTimer);
    statusTimer = window.setTimeout(updateTitle, 400);
  }
  if (ws.path && !ws.path.startsWith('download:')) scheduleAutosave();
  if (!ws.path) {
    clearTimeout(recoveryTimer);
    recoveryTimer = window.setTimeout(stashRecovery, 1500);
  }
}

function scheduleAutosave() {
  // save after a pause in typing, but at least every 10 s of continuous typing
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(runAutosave, 1500);
  if (!autosaveMax) autosaveMax = window.setTimeout(runAutosave, 10000);
}

function runAutosave() {
  clearTimeout(autosaveTimer);
  clearTimeout(autosaveMax);
  autosaveMax = 0;
  void saveWorkspace(false);
}

function stashRecovery() {
  // crash-recovery copy for workspaces never saved to disk
  if (ws.path) return;
  try { localStorage.setItem('promptpad.recovery', serializeWorkspace(ws)); } catch { /* ignore */ }
}

// ---------- tabs ----------
function renderTabs() {
  const box = $('#tabs');
  box.textContent = '';
  ws.tabs.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'tab' + (i === ws.active ? ' on' : '');
    el.draggable = true;
    el.dataset.i = String(i);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = t.name;
    const x = document.createElement('button');
    x.className = 'close';
    x.textContent = '×';
    x.title = 'Close tab (Ctrl+W)';
    x.onclick = (e) => { e.stopPropagation(); closeTab(i); };
    el.append(label, x);
    el.onclick = () => switchTab(i);
    el.onauxclick = (e) => { if (e.button === 1) closeTab(i); };
    el.ondblclick = () => renameTab(i, label);
    el.ondragstart = (e) => e.dataTransfer?.setData('text/plain', String(i));
    el.ondragover = (e) => e.preventDefault();
    el.ondrop = (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer?.getData('text/plain'));
      if (Number.isNaN(from) || from === i) return;
      const active = ws.tabs[ws.active];
      const [m] = ws.tabs.splice(from, 1);
      ws.tabs.splice(i, 0, m);
      ws.active = ws.tabs.indexOf(active);
      renderTabs();
      markDirty();
    };
    box.appendChild(el);
  });
  box.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renameTab(i: number, label: HTMLElement) {
  const inp = document.createElement('input');
  inp.className = 'rename';
  inp.value = ws.tabs[i].name;
  label.replaceWith(inp);
  inp.focus();
  inp.select();
  const done = (ok: boolean) => {
    if (ok && inp.value.trim()) { ws.tabs[i].name = inp.value.trim(); markDirty(); }
    renderTabs();
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); };
  inp.onblur = () => done(true);
}

function switchTab(i: number) {
  if (i === ws.active) return;
  editor.flushEdit();
  editor.commitAll();
  ws.active = i;
  renderTabs();
  editor.renderTab();
  refreshSide();
  updateTitle();
  markDirty();
}

function addTab(name?: string, text = '') {
  editor.flushEdit();
  editor.commitAll();
  const n = ws.tabs.length + 1;
  ws.tabs.push(newTab(name ?? `Prompt ${n}`, text));
  ws.active = ws.tabs.length - 1;
  renderTabs();
  editor.renderTab();
  editor.focusBlock(0, false);
  refreshSide();
  markDirty();
}

async function closeTab(i: number) {
  const t = ws.tabs[i];
  const hasText = t.blocks.some((b) => b.text.trim());
  if (hasText && !(await P.confirmDialog(`Close "${t.name}"? Its content is removed from this workspace.`, 'Close tab', 'Cancel'))) return;
  ws.tabs.splice(i, 1);
  if (!ws.tabs.length) ws.tabs.push(newTab('Prompt 1'));
  ws.active = Math.min(ws.active > i ? ws.active - 1 : ws.active, ws.tabs.length - 1);
  renderTabs();
  editor.renderTab();
  refreshSide();
  markDirty();
}

// ---------- workspace files ----------
// Several promptpad windows (or devices over a network share) can open the same file. Every save first
// folds in what other instances saved since we last looked (three-way merge against `baseSnap`), and a
// 2 s poll picks up their changes while we are idle.
let baseSnap: Snap | null = null; // file contents as of our last read or write
let lastSig: string | null = null; // file signature (mtime:size) as of our last read or write
let syncChain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const p = syncChain.then(fn, fn);
  syncChain = p.catch(() => {});
  return p;
};

const eqKeys = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
const blocksFromKeys = (keys: string[]) => {
  const bl = keys.map((k) => { const d = decodeKey(k); return newBlock(d.text, { copied: d.copied, folded: d.folded }); });
  return bl.length ? bl : [newBlock()];
};

/** Put a merge result into the live workspace with the least visible change. */
function applyMerged(res: MergeResult): boolean {
  const activeTab = ws.tabs[ws.active];
  const byUid = new Map(ws.tabs.map((t) => [t.uid, t]));
  const cur = new Map(snapOf(ws).tabs.map((t) => [t.uid, t.keys]));
  const next: Tab[] = [];
  let changed = false;
  let namesChanged = false;
  for (const st of res.tabs) {
    let t = byUid.get(st.uid);
    if (!t) {
      t = newTab(st.name, '', st.uid);
      t.blocks = blocksFromKeys(st.keys);
      changed = namesChanged = true;
    } else {
      if (t.name !== st.name) { t.name = st.name; changed = namesChanged = true; }
      if (!eqKeys(cur.get(st.uid), st.keys)) {
        changed = true;
        t.undo = [];
        t.redo = [];
        if (t === activeTab) editor.applyKeys(st.keys);
        else t.blocks = blocksFromKeys(st.keys);
      }
    }
    next.push(t);
  }
  if (!next.length) next.push(newTab('Prompt 1'));
  let fullRender = false;
  if (next.length !== ws.tabs.length || next.some((t, i) => t !== ws.tabs[i])) { changed = namesChanged = true; }
  ws.tabs = next;
  let ai = next.indexOf(activeTab);
  if (ai < 0) { ai = Math.min(ws.active, next.length - 1); fullRender = true; }
  ws.active = ai;
  if (ws.copyFormat !== res.copyFormat) { ws.copyFormat = res.copyFormat as 'markdown' | 'plain'; changed = true; }
  for (const k of ALL_KEYS) {
    if (typeof res.toggles[k] === 'boolean' && ws.toggles[k] !== res.toggles[k]) { ws.toggles[k] = res.toggles[k]; fullRender = changed = true; }
  }
  if (namesChanged) renderTabs();
  if (fullRender) editor.renderTab();
  if (changed) { syncMenus(); refreshSide(); }
  return changed;
}

/** If the file changed since we last looked, merge it into the open workspace. Call inside `serial`. */
async function pullIfChanged(): Promise<boolean> {
  const path = ws.path;
  if (!path || path.startsWith('download:')) return false;
  const sig = await P.fileSig(path);
  if (sig === null || sig === lastSig) return false;
  let remote: Workspace;
  try { remote = parseWorkspace(await P.readText(path)); } catch { return false; } // maybe mid-write: retry next tick
  if (ws.path !== path) return false;
  lastSig = sig;
  const remoteSnap = fileSnap(remote);
  const base = baseSnap ?? remoteSnap;
  if (snapString(remoteSnap) === snapString(base)) return false; // our own write, or nothing of substance
  editor.flushEdit();
  const res = mergeSnaps(base, snapOf(ws), remoteSnap);
  const changed = applyMerged(res);
  baseSnap = remoteSnap;
  // anything still different from the file must be written back (our edits made while the other side changed)
  if (snapString(fileSnap(ws)) !== snapString(remoteSnap)) {
    ws.dirty = true;
    scheduleAutosave();
  } else ws.dirty = false;
  updateTitle();
  if (changed) toast(res.conflicts ? `Updated from another instance. ${res.conflicts} block${res.conflicts === 1 ? '' : 's'} changed on both sides: both versions kept.` : 'Updated from another instance');
  return changed;
}

setInterval(() => { if (ws.path && !document.hidden) void serial(pullIfChanged); }, 2000);
window.addEventListener('focus', () => { if (ws.path) void serial(pullIfChanged); });

async function rememberSynced(path: string | null, snap: Snap | null) {
  baseSnap = snap;
  lastSig = path && !path.startsWith('download:') ? await P.fileSig(path) : null;
}

function useWorkspace(next: Workspace, path: string | null) {
  ws = next;
  ws.path = path;
  ws.dirty = false;
  editor.ws = ws;
  baseSnap = null;
  lastSig = null;
  if (path && !path.startsWith('download:')) settings.last = path;
  else settings.last = null;
  saveSettings();
  renderTabs();
  editor.renderTab();
  syncMenus();
  refreshSide();
  updateTitle();
}

async function confirmDiscard(): Promise<boolean> {
  if (!ws.dirty) return true;
  if (ws.path) { await saveWorkspace(false); return true; }
  return P.confirmDialog('This workspace has unsaved changes. Discard them?', 'Discard', 'Cancel');
}

async function newWorkspaceCmd() {
  if (!(await confirmDiscard())) return;
  useWorkspace(newWorkspace(), null);
}

async function openWorkspaceCmd(known?: string) {
  if (!(await confirmDiscard())) return;
  let path: string | null;
  let text: string;
  if (known) {
    path = known;
    text = await P.readText(known);
  } else {
    const r = await P.openFile('workspace');
    if (!r) return;
    path = r.path;
    text = r.text;
  }
  await loadText(text, path);
}

async function loadText(text: string, path: string | null) {
  let next: Workspace;
  try { next = parseWorkspace(text); } catch (e) { toast(String((e as Error).message)); return; }
  const snap = fileSnap(next);
  useWorkspace(next, path);
  await rememberSynced(path, snap);
}

/** Save to the current path. First folds in anything other instances saved meanwhile, then writes the merged
 *  workspace. Pure serialization of the model: no editor DOM or focus changes, so it is safe in the background. */
async function saveWorkspace(interactive = true): Promise<boolean> {
  if (!ws.path || ws.path.startsWith('download:')) return interactive ? saveWorkspaceAs() : false;
  return serial(async () => {
    const path = ws.path;
    if (!path) return false;
    try {
      await pullIfChanged();
      const v = editVersion;
      if (baseSnap && snapString(fileSnap(ws)) === snapString(baseSnap)) {
        if (v === editVersion) { ws.dirty = false; updateTitle(); }
        if (interactive) toast('Saved');
        return true;
      }
      const text = serializeWorkspace(ws);
      const sig = await writer(path, text);
      if (sig === null) return interactive ? saveWorkspaceAs() : false;
      lastSig = sig;
      baseSnap = fileSnap(parseWorkspace(text));
      if (v === editVersion && ws.path === path) { ws.dirty = false; updateTitle(); }
      if (interactive) toast('Saved');
      return true;
    } catch (e) { toast('Save failed: ' + String(e)); return false; }
  });
}

async function saveWorkspaceAs(): Promise<boolean> {
  const text = serializeWorkspace(ws);
  try {
    const p = await P.saveAs(`${wsName().replace(/\.ppad$/, '')}.${P.WS_EXT}`.replace('Untitled workspace', 'workspace'), text, 'workspace');
    if (!p) return false;
    ws.path = p;
    ws.dirty = false;
    if (!p.startsWith('download:')) settings.last = p; else settings.last = null;
    await rememberSynced(p, fileSnap(parseWorkspace(text)));
    saveSettings();
    try { localStorage.removeItem('promptpad.recovery'); } catch { /* ignore */ }
    updateTitle();
    toast('Saved');
    return true;
  } catch (e) { toast('Save failed: ' + String(e)); return false; }
}

async function importMd() {
  const r = await P.openFile('markdown');
  if (!r) return;
  addTab(r.name.replace(/\.(md|markdown|txt)$/i, ''), r.text);
}

async function exportMd() {
  editor.commitAll();
  const t = editor.tab;
  await P.saveAs(`${t.name}.md`, joinBlocks(t.blocks, false) + '\n', 'markdown');
}

// ---------- menus ----------
type Item =
  | { sep: true }
  | { label: string; key?: string; run?: () => void; check?: () => boolean; radio?: () => boolean; keepOpen?: boolean; sub?: Item[]; disabled?: () => boolean; hidden?: () => boolean; text?: () => string };

const toggleItem = (label: string, keys: ToggleKey[]): Item => ({
  label,
  check: () => keys.every((k) => ws.toggles[k]),
  keepOpen: true,
  run: () => setToggles(keys, !keys.every((k) => ws.toggles[k])),
});

function setToggles(keys: ToggleKey[], on: boolean) {
  editor.commitAll();
  keys.forEach((k) => (ws.toggles[k] = on));
  editor.renderTab();
  markDirty();
  syncMenus();
}

/** Turn a force override on, or off if already on; the other one always goes off. Per-type checks stay untouched. */
function setForce(k: 'forceRender' | 'forceRaw') {
  editor.commitAll();
  const on = !ws.toggles[k];
  ws.toggles.forceRender = ws.toggles.forceRaw = false;
  ws.toggles[k] = on;
  editor.renderTab();
  markDirty();
  syncMenus();
}

const H_KEYS: ToggleKey[] = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

const MENUS: { name: string; items: Item[] }[] = [
  {
    name: 'File',
    items: [
      { label: 'New tab', key: 'Ctrl+T', run: () => addTab() },
      { label: 'Close tab', key: 'Ctrl+W', run: () => void closeTab(ws.active) },
      { sep: true },
      { label: 'New workspace', run: () => void newWorkspaceCmd() },
      { label: 'Open workspace…', key: 'Ctrl+O', run: () => void openWorkspaceCmd() },
      { label: 'Save workspace', key: 'Ctrl+S', run: () => void saveWorkspace() },
      { label: 'Save workspace as…', key: 'Ctrl+Shift+S', run: () => void saveWorkspaceAs() },
      { sep: true },
      { label: 'Import .md as new tab…', run: () => void importMd() },
      { label: 'Export tab as .md…', run: () => void exportMd() },
      { sep: true },
      { label: 'Exit', run: () => void P.exitApp() },
    ],
  },
  {
    name: 'Edit',
    items: [
      { label: 'Undo', key: 'Ctrl+Z', run: () => editor.undo() },
      { label: 'Redo', key: 'Ctrl+Y', run: () => editor.redo() },
      { sep: true },
      { label: 'Search all tabs', key: 'Ctrl+F', run: () => focusTopSearch() },
      { label: 'Find panel in sidebar', key: 'Ctrl+Shift+F', run: () => openFind() },
      { sep: true },
      { label: 'Copy button copies markdown', radio: () => ws.copyFormat === 'markdown', keepOpen: true, run: () => { ws.copyFormat = 'markdown'; markDirty(); syncMenus(); } },
      { label: 'Copy button copies plain text', radio: () => ws.copyFormat === 'plain', keepOpen: true, run: () => { ws.copyFormat = 'plain'; markDirty(); syncMenus(); } },
    ],
  },
  {
    name: 'View',
    items: [
      { label: 'Light theme', radio: () => settings.theme === 'light', keepOpen: true, run: () => { settings.theme = 'light'; saveSettings(); applyTheme(); syncMenus(); } },
      { label: 'Dark theme', radio: () => settings.theme === 'dark', keepOpen: true, run: () => { settings.theme = 'dark'; saveSettings(); applyTheme(); syncMenus(); } },
      { label: 'Match system theme', radio: () => settings.theme === 'system', keepOpen: true, run: () => { settings.theme = 'system'; saveSettings(); applyTheme(); syncMenus(); } },
      {
        label: 'Rendering',
        sub: [
          { label: 'Render all (ignore checks below)', check: () => ws.toggles.forceRender, keepOpen: true, run: () => setForce('forceRender') },
          { label: 'Unrender all (ignore checks below)', key: 'Ctrl+Shift+R', check: () => ws.toggles.forceRaw, keepOpen: true, run: () => setForce('forceRaw') },
          { sep: true },
          toggleItem('All headers', H_KEYS),
          ...H_KEYS.map((k, i) => toggleItem(`Header ${i + 1}`, [k])),
          { sep: true },
          toggleItem('Paragraphs', ['paragraphs']),
          toggleItem('Bold / italic / inline code', ['inline']),
          toggleItem('Links', ['links']),
          toggleItem('Images', ['images']),
          toggleItem('Lists', ['lists']),
          toggleItem('Tables', ['tables']),
          toggleItem('Code blocks', ['code']),
          toggleItem('Mermaid diagrams', ['mermaid']),
          toggleItem('Quotes', ['quotes']),
          toggleItem('Horizontal rules', ['rules']),
        ],
      },
      { sep: true },
      { label: 'Sidebar (outline / find)', key: 'Ctrl+\\', check: () => !$('#sidebar').hidden, keepOpen: true, run: () => toggleSidebar() },
      { label: 'Collapse all headers', run: () => editor.setAllFolds(true) },
      { label: 'Expand all headers', run: () => editor.setAllFolds(false) },
    ],
  },
  {
    name: 'Help',
    items: [
      { label: 'Check for updates…', run: () => void manualUpdateCheck() },
      { label: 'Update now', text: () => `Update to ${update?.version ?? ''} now`, hidden: () => !update, run: () => void installUpdate() },
      { sep: true },
      { label: 'About promptpad', run: () => toast(`promptpad ${pkg.version} · MIT · markdown editor for agentic prompts`) },
    ],
  },
];

let helpBtn: HTMLButtonElement | null = null;

function setHelpLabel() {
  if (!helpBtn) return;
  helpBtn.textContent = 'Help';
  if (update) {
    const span = document.createElement('span');
    span.className = 'upd';
    span.textContent = ' (Update available)';
    helpBtn.appendChild(span);
  }
}

function buildMenus() {
  const bar = $('#menubar');
  bar.textContent = '';
  let openMenu: HTMLElement | null = null;
  const closeAll = () => { openMenu?.classList.remove('open'); openMenu = null; };

  const build = (items: Item[]): HTMLElement => {
    const ul = document.createElement('ul');
    ul.className = 'dd';
    for (const it of items) {
      const li = document.createElement('li');
      if ('sep' in it) { li.className = 'sep'; ul.appendChild(li); continue; }
      li.dataset.label = it.label;
      const mark = document.createElement('span');
      mark.className = 'mark';
      const lab = document.createElement('span');
      lab.className = 'lab';
      lab.textContent = it.label;
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = it.sub ? '▸' : it.key ?? '';
      li.append(mark, lab, key);
      if (it.sub) {
        li.classList.add('has-sub');
        li.appendChild(build(it.sub));
      } else {
        li.onclick = (e) => {
          e.stopPropagation();
          it.run?.();
          if (it.keepOpen) syncMenus();
          else closeAll();
        };
      }
      (li as any)._item = it;
      ul.appendChild(li);
    }
    return ul;
  };

  for (const m of MENUS) {
    const wrap = document.createElement('div');
    wrap.className = 'menu';
    const btn = document.createElement('button');
    btn.textContent = m.name;
    if (m.name === 'Help') helpBtn = btn;
    wrap.appendChild(btn);
    wrap.appendChild(build(m.items));
    btn.onclick = (e) => {
      e.stopPropagation();
      if (openMenu === wrap) return closeAll();
      closeAll();
      wrap.classList.add('open');
      openMenu = wrap;
      syncMenus();
    };
    btn.onmouseenter = () => {
      if (openMenu && openMenu !== wrap) { closeAll(); wrap.classList.add('open'); openMenu = wrap; syncMenus(); }
    };
    bar.appendChild(wrap);
  }
  document.addEventListener('click', closeAll);
  window.addEventListener('blur', closeAll);
}

function syncMenus() {
  document.querySelectorAll<HTMLElement>('#menubar li').forEach((li) => {
    const it = (li as any)._item as Item | undefined;
    if (!it || 'sep' in it) return;
    const mark = li.querySelector('.mark')!;
    if (it.hidden) li.style.display = it.hidden() ? 'none' : '';
    if (it.text) li.querySelector('.lab')!.textContent = it.text();
    if (it.check) mark.textContent = it.check() ? '✓' : '';
    else if (it.radio) mark.textContent = it.radio() ? '●' : '';
  });
}

// ---------- sidebar: outline + find ----------
function toggleSidebar(force?: boolean) {
  const sb = $('#sidebar');
  sb.hidden = force === undefined ? !sb.hidden : !force;
  settings.sidebar = !sb.hidden;
  saveSettings();
  syncMenus();
  refreshSide();
}

function showPane(name: 'outline' | 'find') {
  document.querySelectorAll<HTMLElement>('.side-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.pane === name));
  $('#pane-outline').hidden = name !== 'outline';
  $('#pane-find').hidden = name !== 'find';
}

function openFind() {
  toggleSidebar(true);
  showPane('find');
  const q = $<HTMLInputElement>('#findq');
  const sel = window.getSelection()?.toString();
  if (sel && sel.length < 80 && !sel.includes('\n')) q.value = sel;
  q.focus();
  q.select();
  runFind();
}

function refreshSide() {
  if ($('#sidebar').hidden) return;
  const box = $('#pane-outline');
  box.textContent = '';
  editor.tab.blocks.forEach((b, i) => {
    const lvl = headingLevel(b.text);
    if (!lvl) return;
    const a = document.createElement('div');
    a.className = 'ol';
    a.style.paddingLeft = 8 + (lvl - 1) * 14 + 'px';
    a.textContent = b.text.replace(/^\s*#{1,6}\s*/, '').replace(/[*_`]/g, '') || '(empty)';
    a.onclick = () => editor.reveal(i);
    box.appendChild(a);
  });
  if (!box.children.length) box.innerHTML = '<div class="muted">No headers in this tab.</div>';
}

interface Hit { ti: number; bi: number }

/** Search every tab's blocks. Renders result rows into `out`; returns the hits in order. */
function searchAll(q: string, out: HTMLElement, onPick?: () => void): Hit[] {
  out.textContent = '';
  const hits: Hit[] = [];
  const needle = q.trim().toLowerCase();
  if (!needle) return hits;
  editor.commitAll();
  ws.tabs.forEach((t, ti) => {
    t.blocks.forEach((b, bi) => {
      const at = b.text.toLowerCase().indexOf(needle);
      if (at < 0 || hits.length >= 300) return;
      hits.push({ ti, bi });
      const r = document.createElement('div');
      r.className = 'hit';
      const from = Math.max(0, at - 30);
      const snip = (from ? '…' : '') + b.text.slice(from, at + needle.length + 60).replace(/\s+/g, ' ');
      r.innerHTML = '<span class="tabname"></span><span class="snip"></span>';
      r.querySelector('.tabname')!.textContent = t.name;
      r.querySelector('.snip')!.textContent = snip;
      r.onmousedown = (e) => e.preventDefault();
      r.onclick = () => { goTo(ti, bi); onPick?.(); };
      out.appendChild(r);
    });
  });
  if (!hits.length) out.innerHTML = '<div class="muted">No matches.</div>';
  return hits;
}

function goTo(ti: number, bi: number) {
  if (ti !== ws.active) switchTab(ti);
  editor.reveal(bi);
}

function runFind() {
  searchAll($<HTMLInputElement>('#findq').value, $('#findres'));
}

// ---- search box in the tab bar ----
let topHits: Hit[] = [];
let topIdx = -1;
const topInput = () => $<HTMLInputElement>('#topfind');

function runTopSearch() {
  const res = $('#topres');
  const q = topInput().value;
  topIdx = -1;
  if (!q.trim()) { res.hidden = true; topHits = []; return; }
  topHits = searchAll(q, res, closeTop);
  res.hidden = false;
}

function closeTop() {
  $('#topres').hidden = true;
}

function focusTopSearch() {
  const inp = topInput();
  const sel = window.getSelection()?.toString();
  if (sel && sel.length < 80 && !sel.includes('\n')) inp.value = sel;
  inp.focus();
  inp.select();
  runTopSearch();
}

// ---------- updates ----------
// The exe checks GitHub for a newer release at start. "Update now" downloads the new exe, swaps it in
// for the running one (Windows allows renaming a running exe) and restarts; the workspace is saved first.
const LATEST_API = 'https://api.github.com/repos/jthunderbird/promptpad/releases/latest';
const RELEASES_PAGE = 'https://github.com/jthunderbird/promptpad/releases/latest';
let update: { version: string; url: string } | null = null;
let fetchLatest: () => Promise<any> = async () => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(LATEST_API, { headers: { Accept: 'application/vnd.github+json' }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
};

const versionParts = (v: string): number[] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const isNewer = (a: number[], b: number[]) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

/** Ask GitHub for the latest release. 'newer' also sets `update` and the Help label. */
async function checkUpdate(auto: boolean, force = false): Promise<'newer' | 'current' | 'error'> {
  if (auto && !P.isTauri && !force) return 'current'; // the browser build does not self-check
  try {
    const rel = await fetchLatest();
    const tag = String(rel.tag_name ?? '');
    const asset = (rel.assets ?? []).find((a: any) => /^promptpad-.*\.exe$/.test(a.name));
    const next = versionParts(tag);
    const cur = versionParts(pkg.version);
    if (next && cur && asset && isNewer(next, cur)) {
      update = { version: tag.replace(/^v/, ''), url: String(asset.browser_download_url) };
      setHelpLabel();
      syncMenus();
      return 'newer';
    }
    update = null;
    setHelpLabel();
    syncMenus();
    return 'current';
  } catch { return 'error'; }
}

async function manualUpdateCheck() {
  toast('Checking for updates…');
  const r = await checkUpdate(false);
  if (r === 'newer') void installUpdate();
  else if (r === 'current') toast(`You are on the latest version (${pkg.version})`);
  else toast("Couldn't reach GitHub to check for updates", 3000);
}

async function installUpdate() {
  if (!update) return;
  if (!P.isTauri) { window.open(RELEASES_PAGE, '_blank', 'noopener'); return; }
  if (ws.dirty && !ws.path) { toast('Save your workspace first (File > Save workspace as…), then update', 4000); return; }
  const ok = await P.confirmDialog(
    `Update promptpad ${pkg.version} to ${update.version}?\n\nIt downloads the new exe, replaces this one and restarts. Your workspace is saved first and reopens afterwards.`,
    'Update', 'Cancel');
  if (!ok) return;
  if (ws.path) await saveWorkspace(false);
  toast('Downloading update…', 60000);
  try { await P.applyUpdate(update.url); } catch (e) { toast('Update failed: ' + String(e), 6000); }
}

// ---------- wiring ----------
editor = new Editor($('#doc'), ws, {
  onChange: () => { markDirty(); if (!$('#sidebar').hidden) refreshSideDebounced(); },
  toast,
  confirm: (m, ok) => P.confirmDialog(m, ok, 'Cancel'),
  resolveSrc: (href) => {
    if (/^(https?:|data:|blob:|asset:|http:\/\/asset\.localhost)/i.test(href)) return href;
    if (!P.isTauri || !ws.path || ws.path.startsWith('web:')) return href;
    const dir = ws.path.replace(/[\\/][^\\/]*$/, '');
    const abs = /^([a-z]:)?[\\/]/i.test(href) ? href : dir + '/' + href;
    try { return (window as any).__TAURI_INTERNALS__.convertFileSrc(abs); } catch { return href; }
  },
});
let sideTimer = 0;
const refreshSideDebounced = () => { clearTimeout(sideTimer); sideTimer = window.setTimeout(refreshSide, 300); };

buildMenus();
$('#newtab').onclick = () => addTab();
$('#findq').addEventListener('input', runFind);
topInput().addEventListener('input', runTopSearch);
topInput().addEventListener('focus', () => { if (topInput().value.trim()) runTopSearch(); });
topInput().addEventListener('blur', () => setTimeout(closeTop, 150));
topInput().addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { topInput().value = ''; closeTop(); topInput().blur(); }
  else if (e.key === 'Enter' && topHits.length) {
    e.preventDefault();
    topIdx = (topIdx + (e.shiftKey ? topHits.length - 1 : 1)) % topHits.length;
    const h = topHits[topIdx];
    goTo(h.ti, h.bi);
    $('#topres').querySelectorAll('.hit').forEach((x, i) => x.classList.toggle('cur', i === topIdx));
    $('#topres').querySelectorAll('.hit')[topIdx]?.scrollIntoView({ block: 'nearest' });
  }
});
document.querySelectorAll<HTMLElement>('.side-tabs button').forEach((b) => (b.onclick = () => { showPane(b.dataset.pane as any); refreshSide(); }));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  const act = (fn: () => void) => { e.preventDefault(); fn(); };
  if (k === 's') act(() => void (e.shiftKey ? saveWorkspaceAs() : saveWorkspace()));
  else if (k === 'o') act(() => void openWorkspaceCmd());
  else if (k === 't') act(() => addTab());
  else if (k === 'w') act(() => void closeTab(ws.active));
  else if (e.key === '\\') act(() => toggleSidebar());
  else if (k === 'z' && !e.shiftKey) act(() => editor.undo());
  else if (k === 'y' || (k === 'z' && e.shiftKey)) act(() => editor.redo());
  else if (k === 'r' && e.shiftKey) act(() => setForce('forceRaw'));
  else if (k === 'f' && e.shiftKey) act(openFind);
  else if (k === 'f') act(focusTopSearch);
  else if (e.key === 'Tab') act(() => switchTab((ws.active + (e.shiftKey ? ws.tabs.length - 1 : 1)) % ws.tabs.length));
});

void P.onCloseRequested(async () => {
  if (!ws.dirty) return true;
  if (ws.path) { await saveWorkspace(false); return true; }
  return P.confirmDialog('This workspace has unsaved changes. Quit without saving?', 'Quit', 'Cancel');
}, () => ws.dirty);

setTimeout(() => void checkUpdate(true), 3000);

(async function start() {
  editor.dark = false;
  applyTheme();
  syncMenus();
  if (settings.sidebar) toggleSidebar(true);
  const arg = await P.startupPath();
  const path = arg ?? settings.last;
  try {
    if (path && (await P.pathExists(path))) {
      await loadText(await P.readText(path), path);
      return;
    }
  } catch (e) { toast('Could not reopen last workspace: ' + String(e)); }
  // recover an unsaved workspace
  try {
    const rec = localStorage.getItem('promptpad.recovery');
    if (rec) {
      const w = parseWorkspace(rec);
      if (w.tabs.some((t) => t.blocks.some((b) => b.text.trim()))) {
        useWorkspace(w, null);
        ws.dirty = true;
        updateTitle();
        toast('Recovered your unsaved workspace');
        return;
      }
    }
  } catch { /* ignore */ }
  useWorkspace(ws, null);
  // first-run sample so the features are discoverable
  if (!editor.tab.blocks.some((b) => b.text.trim())) {
    editor.tab.blocks = newTab('x', SAMPLE).blocks;
    editor.renderTab();
  }
})();


(window as any).__pp = { get ws() { return ws; }, editor, setWriter: (w: typeof writer) => { writer = w; }, saveWorkspace, pullNow: () => serial(pullIfChanged), snapStr: () => snapString(fileSnap(ws)), setPath: (p: string) => { ws.path = p; }, serializeWorkspace, parseWorkspace, joinBlocks, checkUpdate, isNewer, versionParts, setFetchLatest: (f: typeof fetchLatest) => { fetchLatest = f; } };

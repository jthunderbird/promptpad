// Document model: a tab is a list of blocks (text between blank lines; a heading
// line is always its own block). The workspace file is one readable text file.
import { type Toggles, defaultToggles, ALL_KEYS } from './md';

export interface Link { repo: string; branch: string; path: string }

export interface Block {
  id: number;
  text: string;
  copied: boolean;
  folded: boolean;
}

export interface Tab {
  id: number;
  uid: string; // stable across devices (stored in the workspace file)
  name: string;
  blocks: Block[];
  undo: string[]; // serialized block snapshots
  redo: string[];
}

export interface Workspace {
  tabs: Tab[];
  active: number; // index
  toggles: Toggles;
  /** GitHub sync target (repo, branch, file); stored in the file header so any machine that opens it knows. */
  remote?: Link | null;
  copyFormat: 'markdown' | 'plain';
  path: string | null;
  dirty: boolean;
}

let nextId = 1;
export const newId = () => nextId++;

export const MARK_COPIED = '<!--pp:copied-->';
export const MARK_FOLDED = '<!--pp:folded-->';
const HEADING_RE = /^ {0,3}(#{1,6})(?:\s|$)/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

export function headingLevel(text: string): number {
  const m = HEADING_RE.exec(text.split('\n', 1)[0]);
  return m ? m[1].length : 0;
}

export function newBlock(text = '', flags: Partial<Block> = {}): Block {
  return { id: newId(), text, copied: false, folded: false, ...flags };
}

/** Split markdown into blocks. Markers (<!--pp:copied-->, <!--pp:folded-->) become flags. */
export function splitBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  let cur: string[] = [];
  let copied = false;
  let folded = false;
  let fence: string | null = null;

  const flush = () => {
    if (cur.length) {
      blocks.push(newBlock(cur.join('\n'), { copied, folded }));
      copied = false;
      folded = false;
      cur = [];
    }
  };

  for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      cur.push(line);
      const m = FENCE_RE.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
      continue;
    }
    if (cur.length === 0 && line.trim() === MARK_COPIED) { copied = true; continue; }
    if (cur.length === 0 && line.trim() === MARK_FOLDED) { folded = true; continue; }
    if (line.trim() === '') { flush(); continue; }
    if (HEADING_RE.test(line)) {
      flush();
      cur.push(line);
      flush();
      continue;
    }
    const f = FENCE_RE.exec(line);
    if (f) fence = f[1];
    cur.push(line);
  }
  flush();
  return blocks;
}

/** Serialize blocks. withMarkers=false yields clean markdown (export, copy). */
export function joinBlocks(blocks: Block[], withMarkers = true): string {
  return blocks
    .filter((b) => b.text.trim() !== '')
    .map((b) => {
      const pre = withMarkers ? (b.copied ? MARK_COPIED + '\n' : '') : '';
      return pre + b.text;
    })
    .join('\n\n');
}

export function snapshot(tab: Tab): string {
  return JSON.stringify(tab.blocks.map((b) => [b.text, b.copied ? 1 : 0, b.folded ? 1 : 0]));
}

export function restoreSnapshot(tab: Tab, snap: string) {
  const rows = JSON.parse(snap) as [string, number, number][];
  tab.blocks = rows.map(([t, c, f]) => newBlock(t, { copied: !!c, folded: !!f }));
  if (!tab.blocks.length) tab.blocks = [newBlock()];
}

export const newUid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);

export function newTab(name: string, text = '', uid: string = newUid()): Tab {
  const blocks = splitBlocks(text);
  return { id: newId(), uid, name, blocks: blocks.length ? blocks : [newBlock()], undo: [], redo: [] };
}

export function newWorkspace(): Workspace {
  return {
    tabs: [newTab('Prompt 1')],
    active: 0,
    toggles: defaultToggles(),
    copyFormat: 'markdown',
    path: null,
    dirty: false,
  };
}

// ---------- workspace file ----------
//
//   <!--promptpad:workspace TOKEN v1-->
//   { json header }
//   <!--promptpad:tab TOKEN {"name":"Prompt 1"}-->
//   ...markdown of the tab...
//   <!--promptpad:tab TOKEN {"name":"Other"}-->
//   ...
//
// TOKEN is stable (so saves do not rewrite the delimiter lines and diffs stay small); it only changes if it
// happens to occur in a tab's text. View state (active tab, folded headings) is per device and not in the file.

export function serializeWorkspace(ws: Workspace): string {
  const texts = ws.tabs.map((t) => joinBlocks(t.blocks, true));
  let token = 'pp9f3a1c';
  for (let n = 1; texts.some((x) => x.includes(token)); n++) token = `pp9f3a1c${n}`;
  const head: Record<string, unknown> = { version: 1, copyFormat: ws.copyFormat, toggles: ws.toggles };
  if (ws.remote) head.remote = ws.remote;
  const header = JSON.stringify(head, null, 1);
  let out = `<!--promptpad:workspace ${token} v1-->\n${header}\n`;
  ws.tabs.forEach((t, i) => {
    out += `<!--promptpad:tab ${token} ${JSON.stringify({ name: t.name, id: t.uid })}-->\n${texts[i]}\n`;
  });
  return out;
}

function parseLink(x: any): Link | null {
  return x && typeof x.repo === 'string' && typeof x.branch === 'string' && typeof x.path === 'string' && x.repo && x.branch && x.path
    ? { repo: x.repo, branch: x.branch, path: x.path }
    : null;
}

export function parseWorkspace(src: string): Workspace {
  const text = src.replace(/\r\n?/g, '\n');
  const first = text.split('\n', 1)[0];
  const m = /^<!--promptpad:workspace (\S+) v(\d+)-->$/.exec(first);
  if (!m) throw new Error('Not a promptpad workspace file');
  const token = m[1];
  const delim = new RegExp(`^<!--promptpad:tab ${token} (\\{.*\\})-->$`);
  const lines = text.split('\n');
  const headerLines: string[] = [];
  const tabs: Tab[] = [];
  let cur: { name: string; uid: string; lines: string[] } | null = null;
  const closeTab = () => {
    if (!cur) return;
    // each tab body ends with exactly one newline added by the writer
    const body = cur.lines.join('\n');
    tabs.push(newTab(cur.name, body, cur.uid));
    cur = null;
  };
  for (let i = 1; i < lines.length; i++) {
    const dm = delim.exec(lines[i]);
    if (dm) {
      closeTab();
      let name = 'Tab';
      let uid = `legacy-${tabs.length}`;
      try {
        const j = JSON.parse(dm[1]);
        name = String(j.name ?? 'Tab');
        if (typeof j.id === 'string' && j.id) uid = j.id;
      } catch { /* keep defaults */ }
      cur = { name, uid, lines: [] };
    } else if (cur) cur.lines.push(lines[i]);
    else headerLines.push(lines[i]);
  }
  closeTab();
  let header: any = {};
  try { header = JSON.parse(headerLines.join('\n')); } catch { /* defaults */ }
  const toggles = defaultToggles();
  for (const k of ALL_KEYS) if (typeof header.toggles?.[k] === 'boolean') toggles[k] = header.toggles[k];
  if (!tabs.length) tabs.push(newTab('Prompt 1'));
  return {
    tabs,
    active: 0,
    toggles,
    copyFormat: header.copyFormat === 'plain' ? 'plain' : 'markdown',
    remote: parseLink(header.remote),
    path: null,
    dirty: false,
  };
}

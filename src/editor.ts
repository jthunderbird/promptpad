// The editing surface. Each block is a card; each markdown token in a block is an
// editable "host": rendered (contenteditable) when its type toggle is on, raw
// markdown text (plaintext-only) when off. Edits serialize back token by token.
import {
  type Tok, type Toggles, hostToMarkdown, inlineHtml, lexBlock, toggleFor, tokenHtml, toPlainText,
} from './md';
import { decodeKey, keyOf } from './merge';
import {
  type Block, type Tab, type Workspace, headingLevel, newBlock, restoreSnapshot, snapshot, splitBlocks,
} from './model';

export interface EditorHooks {
  onChange(): void; // model changed (dirty, outline, autosave)
  resolveSrc(href: string): string; // image path -> loadable URL
  toast(msg: string): void;
  confirm(message: string, okLabel: string): Promise<boolean>;
}

const MAX_HISTORY = 300;
const TRASH_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 7v4M9.5 7v4"/></svg>';
const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5"/></svg>';

/** Text of a plaintext-only host. Chromium turns Enter into <div> lines, so walk the DOM. */
export function rawText(root: HTMLElement): string {
  let out = '';
  const walk = (n: Node) => {
    n.childNodes.forEach((c, i) => {
      if (c.nodeType === 3) out += c.nodeValue ?? '';
      else if (c.nodeName === 'BR') {
        const trailing = i === n.childNodes.length - 1 && (n === root || n.nodeName === 'DIV' || n.nodeName === 'P');
        if (!trailing) out += '\n';
      } else if (c.nodeName === 'DIV' || c.nodeName === 'P') {
        if (out !== '' || i > 0) out += '\n';
        walk(c);
      } else walk(c);
    });
  };
  walk(root);
  return out;
}

function selClosest(sel: string): Element | null {
  const n = window.getSelection()?.anchorNode;
  if (!n) return null;
  const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
  return el?.closest(sel) ?? null;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/;

function caretOffset(h: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return rawText(h).length;
  const r = document.createRange();
  r.selectNodeContents(h);
  r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  const tmp = document.createElement('div');
  tmp.appendChild(r.cloneContents());
  return rawText(tmp).length;
}

/** Replace a raw host's text (as one text node) and put the caret at off. */
function setRawText(h: HTMLElement, text: string, off: number) {
  h.textContent = text;
  const node = h.firstChild;
  const r = document.createRange();
  if (node) r.setStart(node, Math.min(off, text.length));
  else r.setStart(h, 0);
  r.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
  h.dispatchEvent(new Event('input'));
}

export class Editor {
  root: HTMLElement;
  ws: Workspace;
  hooks: EditorHooks;
  expanded = new Set<number>(); // copied blocks shown expanded (view state)
  rawOverride = new Set<string>(); // `${blockId}:${tokenIndex}` shown raw although its type is on
  private els = new Map<number, HTMLElement>();
  private toks = new Map<number, Tok[]>();
  private dirty = new Set<number>();
  private editPending: string | null = null;
  private editTimer = 0;
  dark = false;

  constructor(root: HTMLElement, ws: Workspace, hooks: EditorHooks) {
    this.root = root;
    this.ws = ws;
    this.hooks = hooks;
    root.addEventListener('keydown', (e) => this.onKeyDown(e));
    root.addEventListener('paste', (e) => this.onPaste(e));
    root.addEventListener('click', (e) => this.onClick(e));
  }

  get tab(): Tab { return this.ws.tabs[this.ws.active]; }

  // ---------- rendering ----------

  renderTab() {
    this.flushEdit();
    this.root.textContent = '';
    this.els.clear();
    this.toks.clear();
    this.dirty.clear();
    this.rawOverride.clear();
    for (const b of this.tab.blocks) this.root.appendChild(this.renderBlock(b));
    const tail = document.createElement('div');
    tail.className = 'tail';
    tail.title = 'Click to add a block';
    this.root.appendChild(tail);
    this.applyFolds();
  }

  private blockEl(b: Block): HTMLElement { return this.els.get(b.id)!; }

  renderBlock(b: Block): HTMLElement {
    const el = document.createElement('div');
    el.className = 'block';
    el.dataset.id = String(b.id);
    this.els.set(b.id, el);
    const level = headingLevel(b.text);
    if (level) el.classList.add('is-heading', 'h' + level);

    const collapsed = b.copied && !this.expanded.has(b.id);
    if (collapsed) {
      el.classList.add('copied-collapsed');
      const line = document.createElement('div');
      line.className = 'copied-line';
      line.title = 'Click to expand';
      line.innerHTML = '<span class="check">✓</span><span class="summary"></span><button class="x" title="Remove block">✕</button>';
      line.querySelector('.summary')!.textContent = b.text.split('\n').find((l) => l.trim()) ?? '';
      el.appendChild(line);
      return el;
    }

    const gutter = document.createElement('div');
    gutter.className = 'gutter';
    if (level) {
      const chev = document.createElement('button');
      chev.className = 'chev';
      chev.title = 'Collapse / expand section';
      chev.textContent = '▾';
      gutter.appendChild(chev);
    }
    el.appendChild(gutter);

    const body = document.createElement('div');
    body.className = 'body';
    const toks = lexBlock(b.text);
    this.toks.set(b.id, toks);
    if (!toks.length) {
      body.appendChild(this.emptyHost(b));
    } else {
      toks.forEach((tok, i) => body.appendChild(this.makeHost(b, tok, i)));
    }
    el.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const lvlCtl = level
      ? `<span class="lvl"><button class="act lvl-up" title="Bigger header (Alt+Shift+Up)">▲</button><span class="lvl-n">H${level}</span><button class="act lvl-dn" title="Smaller header (Alt+Shift+Down)">▼</button></span>`
      : '';
    actions.innerHTML = lvlCtl + (level ? `<button class="act del-sec" title="Delete header and all its content (Ctrl+Shift+Delete)">${TRASH_ICON}</button>` : '') + (b.copied
      ? `<span class="badge">✓ copied</span><button class="act collapse" title="Collapse">▴</button><button class="act copy" title="Copy again">${COPY_ICON}</button><button class="act x" title="Remove block">✕</button>`
      : `<button class="act copy" title="${level ? 'Copy section' : 'Copy block'}">${COPY_ICON}</button>`);
    el.appendChild(actions);
    return el;
  }

  private emptyHost(b: Block): HTMLElement {
    const h = document.createElement('div');
    h.className = 'host raw';
    h.setAttribute('contenteditable', 'plaintext-only');
    h.spellcheck = false;
    h.dataset.ph = this.tab.blocks.length === 1 ? 'Type or paste markdown…' : 'Type markdown…';
    h.addEventListener('input', () => this.onHostInput(b, null, 0, h));
    this.wireHost(b, h);
    return h;
  }

  private makeHost(b: Block, tok: Tok, idx: number): HTMLElement {
    const key = toggleFor(tok);
    const rendered = !!key && this.ws.toggles.master && this.ws.toggles[key] && !this.rawOverride.has(`${b.id}:${idx}`);
    const h = document.createElement('div');
    h.className = 'host';
    h.dataset.idx = String(idx);
    h.dataset.type = tok.type;
    if (!rendered) {
      h.classList.add('raw');
      h.setAttribute('contenteditable', 'plaintext-only');
      h.spellcheck = false;
      h.textContent = tok.raw;
    } else if (key === 'mermaid' || key === 'rules') {
      h.classList.add('static', key);
      h.title = 'Click to edit source';
      if (key === 'rules') h.innerHTML = '<hr>';
      else this.renderMermaid(h, (tok.token as any).text as string);
    } else if (key === 'code') {
      h.classList.add('codeblock');
      h.setAttribute('contenteditable', 'plaintext-only');
      h.spellcheck = false;
      h.dataset.lang = (tok.token as any).lang ?? '';
      if (h.dataset.lang) h.dataset.langLabel = h.dataset.lang;
      h.textContent = (tok.token as any).text as string;
    } else {
      h.classList.add('rendered', 'k-' + tok.type);
      h.setAttribute('contenteditable', 'true');
      h.innerHTML = tokenHtml(tok, this.ws.toggles);
      // marked wraps paragraphs in <p>; unwrap so the host is the line container
      if (tok.type === 'paragraph' || tok.type === 'heading') {
        const only = h.firstElementChild;
        if (only && (only.tagName === 'P' || /^H[1-6]$/.test(only.tagName)) && h.children.length === 1) {
          h.innerHTML = only.innerHTML;
        }
      }
      h.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src') ?? '';
        img.setAttribute('data-src', src);
        img.setAttribute('src', this.hooks.resolveSrc(src));
      });
      h.spellcheck = true;
    }
    h.addEventListener('input', () => this.onHostInput(b, tok, idx, h));
    this.wireHost(b, h);
    return h;
  }

  private wireHost(b: Block, h: HTMLElement) {
    h.addEventListener('focusout', (e) => {
      const next = (e as FocusEvent).relatedTarget as Node | null;
      const el = this.blockEl(b);
      if (next && el.contains(next)) return;
      setTimeout(() => {
        if (!el.isConnected) return;
        if (el.contains(document.activeElement)) return;
        if (!document.hasFocus() && document.activeElement && el.contains(document.activeElement)) return;
        this.commit(b);
      }, 0);
    });
  }

  private async renderMermaid(h: HTMLElement, code: string) {
    h.textContent = 'rendering diagram…';
    try {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({ startOnLoad: false, theme: this.dark ? 'dark' : 'default', securityLevel: 'strict' });
      const { svg } = await mermaid.render('m' + Math.random().toString(36).slice(2), code);
      h.innerHTML = svg;
    } catch (err) {
      h.classList.add('error');
      h.textContent = 'Mermaid error: ' + String((err as Error).message ?? err).split('\n')[0] + '\n\n' + code;
      h.style.whiteSpace = 'pre-wrap';
    }
  }

  // ---------- edits ----------

  private onHostInput(b: Block, tok: Tok | null, idx: number, h: HTMLElement) {
    if (this.editPending === null) this.editPending = snapshot(this.tab);
    clearTimeout(this.editTimer);
    this.editTimer = window.setTimeout(() => this.flushEdit(), 700);

    const raw = h.classList.contains('raw') ? rawText(h) : hostToMarkdown(h, tok!);
    if (tok) {
      tok.raw = raw;
      b.text = this.toks.get(b.id)!.map((t) => t.raw).join('\n');
    } else {
      b.text = raw;
    }
    if (b.copied) {
      b.copied = false;
      this.blockEl(b).classList.remove('copied-collapsed');
    }
    this.dirty.add(b.id);
    this.hooks.onChange();
  }

  /** Re-render / re-split a block after its editing finished. */
  commit(b: Block) {
    if (!this.dirty.has(b.id) && ![...this.rawOverride].some((k) => k.startsWith(b.id + ':'))) return;
    this.dirty.delete(b.id);
    for (const k of [...this.rawOverride]) if (k.startsWith(b.id + ':')) this.rawOverride.delete(k);
    const tab = this.tab;
    const at = tab.blocks.indexOf(b);
    if (at < 0) return;
    const parts = splitBlocks(b.text);
    const old = this.blockEl(b);
    if (parts.length === 1 && parts[0].text === b.text) {
      old.replaceWith(this.renderBlock(b));
    } else if (parts.length === 0) {
      b.text = '';
      old.replaceWith(this.renderBlock(b));
    } else {
      tab.blocks.splice(at, 1, ...parts);
      this.els.delete(b.id);
      this.toks.delete(b.id);
      const frag = document.createDocumentFragment();
      for (const p of parts) frag.appendChild(this.renderBlock(p));
      old.replaceWith(frag);
    }
    this.applyFolds();
    this.hooks.onChange();
  }

  commitAll() {
    for (const b of [...this.tab.blocks]) this.commit(b);
  }

  /** Replace the active tab's blocks with the given block keys (merge result), touching only what changed:
   *  unchanged blocks keep their DOM, so typing, caret and focus are not disturbed. */
  applyKeys(keys: string[]) {
    const tab = this.tab;
    const pool = new Map<string, Block[]>();
    for (const b of tab.blocks) {
      const k = keyOf(b.text, b.copied, b.folded);
      const q = pool.get(k);
      if (q) q.push(b);
      else pool.set(k, [b]);
    }
    const next: Block[] = [];
    const reused = new Set<Block>();
    for (const k of keys) {
      const ex = pool.get(k)?.shift();
      if (ex) {
        next.push(ex);
        reused.add(ex);
      } else {
        const d = decodeKey(k);
        next.push(newBlock(d.text, { copied: d.copied, folded: d.folded }));
      }
    }
    for (const b of tab.blocks) {
      if (reused.has(b)) continue;
      this.els.get(b.id)?.remove();
      this.els.delete(b.id);
      this.toks.delete(b.id);
      this.dirty.delete(b.id);
      this.expanded.delete(b.id);
    }
    if (!next.length) next.push(newBlock());
    tab.blocks = next;
    let cursor: Element | null = this.root.firstElementChild;
    for (const b of next) {
      let el = this.els.get(b.id);
      if (!el) el = this.renderBlock(b);
      if (el === cursor) cursor = cursor.nextElementSibling;
      else this.root.insertBefore(el, cursor);
    }
    this.applyFolds();
  }

  // ---------- history ----------

  flushEdit() {
    clearTimeout(this.editTimer);
    if (this.editPending !== null) {
      this.pushUndo(this.editPending);
      this.editPending = null;
    }
  }

  private pushUndo(snap: string) {
    const t = this.tab;
    if (t.undo[t.undo.length - 1] === snap) return;
    t.undo.push(snap);
    if (t.undo.length > MAX_HISTORY) t.undo.shift();
    t.redo = [];
  }

  /** Call before a structural mutation (remove, copy mark, new block, fold). */
  checkpoint() {
    this.flushEdit();
    this.commitAll();
    this.pushUndo(snapshot(this.tab));
  }

  undo() {
    this.flushEdit();
    this.commitAll();
    const t = this.tab;
    const prev = t.undo.pop();
    if (prev === undefined) return;
    t.redo.push(snapshot(t));
    this.restore(prev);
  }

  redo() {
    this.flushEdit();
    const t = this.tab;
    const next = t.redo.pop();
    if (next === undefined) return;
    t.undo.push(snapshot(t));
    this.restore(next);
  }

  private restore(snap: string) {
    const focusIdx = this.focusedBlockIndex();
    restoreSnapshot(this.tab, snap);
    this.renderTab();
    this.hooks.onChange();
    this.focusBlock(Math.min(Math.max(focusIdx, 0), this.tab.blocks.length - 1), false);
  }

  // ---------- block operations ----------

  focusedBlockIndex(): number {
    const a = document.activeElement as HTMLElement | null;
    const bl = a?.closest<HTMLElement>('.block');
    if (!bl) return -1;
    return this.tab.blocks.findIndex((x) => String(x.id) === bl.dataset.id);
  }

  focusBlock(i: number, atEnd: boolean) {
    const b = this.tab.blocks[i];
    if (!b) return;
    const el = this.els.get(b.id);
    const hosts = [...(el?.querySelectorAll<HTMLElement>('.host') ?? [])].filter((x) => x.isContentEditable);
    const h = atEnd ? hosts[hosts.length - 1] : hosts[0];
    if (h) this.focusHost(h, atEnd);
  }

  focusHost(h: HTMLElement, atEnd: boolean) {
    h.focus();
    const r = document.createRange();
    r.selectNodeContents(h);
    r.collapse(!atEnd);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
    h.scrollIntoView({ block: 'nearest' });
  }

  insertBlockAfter(b: Block, text = ''): Block {
    const tab = this.tab;
    const at = tab.blocks.indexOf(b);
    const nb = newBlock(text);
    tab.blocks.splice(at + 1, 0, nb);
    this.blockEl(b).after(this.renderBlock(nb));
    this.applyFolds();
    return nb;
  }

  appendBlock() {
    this.checkpoint();
    const last = this.tab.blocks[this.tab.blocks.length - 1];
    if (last && last.text.trim() === '') {
      this.focusBlock(this.tab.blocks.length - 1, true);
      return;
    }
    const nb = newBlock();
    this.tab.blocks.push(nb);
    this.root.insertBefore(this.renderBlock(nb), this.root.querySelector('.tail'));
    this.focusBlock(this.tab.blocks.length - 1, false);
    this.hooks.onChange();
  }

  removeBlock(b: Block) {
    this.checkpoint();
    const tab = this.tab;
    const at = tab.blocks.indexOf(b);
    if (at < 0) return;
    tab.blocks.splice(at, 1);
    this.blockEl(b).remove();
    this.els.delete(b.id);
    this.toks.delete(b.id);
    if (!tab.blocks.length) {
      const nb = newBlock();
      tab.blocks.push(nb);
      this.root.insertBefore(this.renderBlock(nb), this.root.querySelector('.tail'));
    }
    this.applyFolds();
    this.hooks.onChange();
  }

  private sectionRange(b: Block): [number, number] {
    const blocks = this.tab.blocks;
    const start = blocks.indexOf(b);
    const lvl = headingLevel(b.text);
    let end = start + 1;
    while (end < blocks.length) {
      const l = headingLevel(blocks[end].text);
      if (l && l <= lvl) break;
      end++;
    }
    return [start, end];
  }

  async copyBlock(b: Block) {
    this.commitAll();
    const lvl = headingLevel(b.text);
    let text: string;
    if (lvl) {
      const [s, e] = this.sectionRange(b);
      text = this.tab.blocks.slice(s, e).map((x) => x.text).filter((t) => t.trim()).join('\n\n');
    } else text = b.text;
    if (this.ws.copyFormat === 'plain') text = toPlainText(text);
    if (!(await writeClipboard(text))) {
      this.hooks.toast('Copy failed: clipboard not available');
      return;
    }
    this.checkpoint();
    if (lvl) {
      b.folded = true;
      this.applyFolds();
      this.hooks.toast('Section copied');
    } else {
      b.copied = true;
      this.expanded.delete(b.id);
      this.blockEl(b).replaceWith(this.renderBlock(b));
    }
    this.hooks.onChange();
  }

  /** Delete a heading and everything under it (up to the next header of equal or higher level), after confirming. */
  async deleteSection(b: Block) {
    if (!headingLevel(b.text)) return;
    const [start, end] = this.sectionRange(b);
    const n = end - start - 1;
    const title = b.text.replace(/^\s*#{1,6}\s*/, '').replace(/[*_`]/g, '').trim() || '(untitled)';
    const what = n > 0 ? `"${title}" and its ${n} block${n === 1 ? '' : 's'} of content` : `"${title}" (it has no content)`;
    if (!(await this.hooks.confirm(`Are you sure you want to delete ${what}? You can undo with Ctrl+Z.`, 'Delete'))) return;
    this.checkpoint();
    const tab = this.tab;
    const [s2, e2] = this.sectionRange(b);
    for (const x of tab.blocks.splice(s2, e2 - s2)) {
      this.els.get(x.id)?.remove();
      this.els.delete(x.id);
      this.toks.delete(x.id);
      this.expanded.delete(x.id);
    }
    if (!tab.blocks.length) {
      const nb = newBlock();
      tab.blocks.push(nb);
      this.root.insertBefore(this.renderBlock(nb), this.root.querySelector('.tail'));
    }
    this.applyFolds();
    this.hooks.onChange();
    this.hooks.toast(`Deleted ${n + 1} block${n ? 's' : ''} (Ctrl+Z to undo)`);
  }

  /** Change a heading's level by delta (-1 = bigger header, +1 = smaller). */
  changeLevel(b: Block, delta: number) {
    const cur = headingLevel(b.text);
    if (!cur) return;
    const next = Math.min(6, Math.max(1, cur + delta));
    if (next === cur) return;
    this.checkpoint();
    b.text = b.text.replace(/^(\s{0,3})#{1,6}/, (_m, sp) => sp + '#'.repeat(next));
    b.copied = false;
    this.dirty.delete(b.id);
    const old = this.blockEl(b);
    const had = old.contains(document.activeElement);
    old.replaceWith(this.renderBlock(b));
    this.applyFolds();
    this.hooks.onChange();
    if (had) this.focusBlock(this.tab.blocks.indexOf(b), true);
  }

  toggleFold(b: Block) {
    this.checkpoint();
    b.folded = !b.folded;
    this.applyFolds();
    this.hooks.onChange();
  }

  setAllFolds(folded: boolean) {
    this.checkpoint();
    for (const b of this.tab.blocks) if (headingLevel(b.text)) b.folded = folded;
    this.applyFolds();
    this.hooks.onChange();
  }

  /** Hide blocks under folded headings, up to the next heading of equal or higher strength. */
  applyFolds() {
    let foldLevel = 0;
    let hiddenCount = 0;
    let foldHead: HTMLElement | null = null;
    const closeHead = () => {
      if (foldHead) foldHead.querySelector<HTMLElement>('.body')?.setAttribute('data-hidden-label', `${hiddenCount} block${hiddenCount === 1 ? '' : 's'} hidden`);
    };
    for (const b of this.tab.blocks) {
      const el = this.els.get(b.id);
      if (!el) continue;
      const lvl = headingLevel(b.text);
      if (foldLevel && lvl && lvl <= foldLevel) {
        closeHead();
        foldLevel = 0;
        foldHead = null;
      }
      el.classList.toggle('is-hidden', foldLevel > 0);
      if (foldLevel > 0) hiddenCount++;
      el.classList.toggle('folded', !!lvl && b.folded);
      if (!foldLevel && lvl && b.folded) {
        foldLevel = lvl;
        hiddenCount = 0;
        foldHead = el;
      }
    }
    closeHead();
  }

  /** Unfold ancestors of block i and scroll to it. */
  reveal(i: number) {
    const blocks = this.tab.blocks;
    let min = headingLevel(blocks[i].text) || 7;
    for (let j = i - 1; j >= 0; j--) {
      const l = headingLevel(blocks[j].text);
      if (l && l < min) {
        blocks[j].folded = false;
        min = l;
      }
    }
    this.applyFolds();
    const el = this.els.get(blocks[i].id);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.classList.add('flash');
    setTimeout(() => el?.classList.remove('flash'), 1200);
  }

  // ---------- events ----------

  private blockOf(t: EventTarget | null): Block | null {
    const el = (t as HTMLElement | null)?.closest?.<HTMLElement>('.block');
    if (!el) return null;
    return this.tab.blocks.find((x) => String(x.id) === el.dataset.id) ?? null;
  }

  private onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (t.classList.contains('tail') || t === this.root) {
      this.appendBlock();
      return;
    }
    const b = this.blockOf(t);
    if (!b) return;
    if (t.closest('.copied-line')) {
      if (t.closest('.x')) this.removeBlock(b);
      else {
        this.expanded.add(b.id);
        this.blockEl(b).replaceWith(this.renderBlock(b));
      }
      return;
    }
    if (t.closest('.chev')) return this.toggleFold(b);
    if (t.closest('.actions .del-sec')) { void this.deleteSection(b); return; }
    if (t.closest('.actions .lvl-up')) return this.changeLevel(b, -1);
    if (t.closest('.actions .lvl-dn')) return this.changeLevel(b, 1);
    if (t.closest('.actions .copy')) { void this.copyBlock(b); return; }
    if (t.closest('.actions .collapse')) {
      this.expanded.delete(b.id);
      this.blockEl(b).replaceWith(this.renderBlock(b));
      return;
    }
    if (t.closest('.actions .x')) return this.removeBlock(b);
    const host = t.closest<HTMLElement>('.host.static');
    if (host) {
      this.rawOverride.add(`${b.id}:${host.dataset.idx}`);
      this.dirty.add(b.id);
      const el = this.blockEl(b);
      const nel = this.renderBlock(b);
      el.replaceWith(nel);
      const raw = nel.querySelector<HTMLElement>(`.host[data-idx="${host.dataset.idx}"]`);
      if (raw) this.focusHost(raw, true);
      return;
    }
    const a = t.closest('a');
    if (a && (e.ctrlKey || e.metaKey)) {
      window.open(a.getAttribute('href') ?? '', '_blank', 'noopener');
    }
  }

  private visibleHosts(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>('.block:not(.is-hidden):not(.copied-collapsed) .host')].filter(
      (h) => h.isContentEditable,
    );
  }

  /** Is the caret on the first / last visual line of the host? */
  private caretEdges(h: HTMLElement): { top: boolean; bottom: boolean } {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return { top: false, bottom: false };
    const r = sel.getRangeAt(0).cloneRange();
    let rect = r.getClientRects()[0];
    if (!rect || (rect.height === 0 && rect.width === 0)) {
      const rr = r.getBoundingClientRect();
      rect = rr.height ? rr : (h.getBoundingClientRect() as DOMRect);
      if (!rr.height) return { top: !(h.textContent ?? '').length, bottom: !(h.textContent ?? '').length };
    }
    const hr = h.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(h).lineHeight) || 22;
    return { top: rect.top - hr.top < lh * 0.9, bottom: hr.bottom - rect.bottom < lh * 0.9 };
  }

  private caretAtEnd(h: HTMLElement): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const r = document.createRange();
    r.selectNodeContents(h);
    r.setStart(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
    return r.toString() === '' && !r.cloneContents().querySelector('img');
  }

  private caretAtStart(h: HTMLElement): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const r = document.createRange();
    r.selectNodeContents(h);
    r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
    return r.toString() === '' && !r.cloneContents().querySelector('img');
  }

  /** Enter at the very start of a non-empty block: push it down by inserting an empty block above, caret stays. */
  private newBlockAbove(b: Block) {
    this.checkpoint();
    const tab = this.tab;
    const at = tab.blocks.indexOf(b);
    const nb = newBlock('');
    tab.blocks.splice(at, 0, nb);
    this.blockEl(b).before(this.renderBlock(nb));
    this.applyFolds();
    this.hooks.onChange();
    this.focusBlock(at, false);
    // caret goes to the new empty block above so you can type there; the old block moved down
  }

  private newBlockBelow(b: Block, h: HTMLElement) {
    this.checkpoint();
    // trim the trailing blank line the Enter-Enter left behind
    if (h.classList.contains('raw')) h.textContent = rawText(h).replace(/\n+$/, '');
    else {
      while (h.lastChild && (h.lastChild.nodeName === 'BR' || (h.lastChild.nodeType === 3 && !h.lastChild.textContent?.trim()))) {
        h.removeChild(h.lastChild);
      }
    }
    h.dispatchEvent(new Event('input'));
    this.commit(b);
    const cur = this.tab.blocks.indexOf(b) >= 0 ? b : this.tab.blocks[Math.max(0, this.focusedBlockIndex())];
    // after commit b may have been replaced; find the last block that came from it
    const idx = this.tab.blocks.indexOf(cur);
    const anchor = this.tab.blocks[idx >= 0 ? idx : this.tab.blocks.length - 1];
    const nb = this.insertBlockAfter(anchor);
    this.hooks.onChange();
    this.focusBlock(this.tab.blocks.indexOf(nb), false);
  }

  private onKeyDown(e: KeyboardEvent) {
    const h = (e.target as HTMLElement).closest?.<HTMLElement>('.host');
    if (!h) return;
    const b = this.blockOf(h);
    if (!b) return;
    const type = h.dataset.type ?? 'empty';
    const raw = h.classList.contains('raw');
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.shiftKey && e.key === 'Delete' && headingLevel(b.text)) {
      e.preventDefault();
      void this.deleteSection(b);
      return;
    }

    if (e.altKey && e.shiftKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && headingLevel(b.text)) {
      e.preventDefault();
      this.changeLevel(b, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (e.shiftKey || e.altKey || mod) return;
      const edge = this.caretEdges(h);
      const hosts = this.visibleHosts();
      const i = hosts.indexOf(h);
      if (e.key === 'ArrowDown' && edge.bottom && i >= 0 && i < hosts.length - 1) {
        e.preventDefault();
        this.focusHost(hosts[i + 1], false);
      } else if (e.key === 'ArrowUp' && edge.top && i > 0) {
        e.preventDefault();
        this.focusHost(hosts[i - 1], true);
      }
      return;
    }

    if (e.key === 'Backspace' && !mod && (h.textContent ?? '') === '' && this.caretAtStart(h)) {
      const hosts = this.visibleHosts();
      const i = hosts.indexOf(h);
      const body = h.parentElement!;
      if (body.children.length === 1 && this.tab.blocks.length > 1) {
        e.preventDefault();
        this.removeBlock(b);
        const hs = this.visibleHosts();
        const prev = hs[Math.max(0, Math.min(i - 1, hs.length - 1))];
        if (prev) this.focusHost(prev, true);
      }
      return;
    }

    if (e.key === 'Tab' && !mod) {
      if (h.querySelector('table')) {
        e.preventDefault();
        this.tableTab(h, e.shiftKey);
      } else if (h.dataset.type === 'list' && !raw) {
        e.preventDefault();
        document.execCommand(e.shiftKey ? 'outdent' : 'indent');
      } else if (raw && type !== 'code' && this.rawListIndent(h, e.shiftKey)) {
        e.preventDefault();
      } else if (raw || h.classList.contains('codeblock')) {
        e.preventDefault();
        if (!e.shiftKey) document.execCommand('insertText', false, '  ');
      }
      return;
    }

    if (e.key !== 'Enter' || mod || e.shiftKey) return;

    // table cells: Enter moves down a row
    const cell = selClosest('td,th');
    if (cell && h.contains(cell)) {
      e.preventDefault();
      this.tableTab(h, false, true);
      return;
    }

    const rt = raw ? rawText(h) : (h.textContent ?? '');
    if (type !== 'code' && rt.trim() && this.caretAtStart(h)) {
      e.preventDefault();
      this.newBlockAbove(b);
      return;
    }
    if (type === 'heading' || (raw && /^ {0,3}#{1,6}(\s|$)/.test(rt) && h.parentElement?.children.length === 1 && !rt.includes('\n'))) {
      e.preventDefault();
      if (this.caretAtEnd(h) || !rt.trim()) this.newBlockBelow(b, h);
      return;
    }

    if (type === 'code') return; // newline inside code

    if (type === 'list' && !raw) {
      const li = selClosest('li');
      if (li && !li.textContent?.trim()) {
        e.preventDefault();
        li.remove();
        if (!h.textContent?.trim()) {
          this.newBlockBelow(b, h);
          return;
        }
        h.dispatchEvent(new Event('input'));
        this.newBlockBelow(b, h);
      }
      return;
    }

    if (raw && type !== 'code' && this.rawListEnter(b, h)) {
      e.preventDefault();
      return;
    }

    if (raw) {
      // Enter on an empty last line ends the block
      if (rt !== '' && rt.endsWith('\n') && this.caretAtEnd(h)) {
        e.preventDefault();
        this.newBlockBelow(b, h);
      }
      return;
    }

    if (type === 'paragraph') {
      e.preventDefault();
      if (this.caretAtEnd(h) && /(<br>\s*){2}$/.test(h.innerHTML)) {
        this.newBlockBelow(b, h);
        return;
      }
      document.execCommand('insertLineBreak');
    }
  }

  /** Enter on a markdown list line in a raw host: continue the list (or leave it when the item is empty). */
  private rawListEnter(b: Block, h: HTMLElement): boolean {
    const text = rawText(h);
    const off = caretOffset(h);
    const lines = text.split('\n');
    let start = 0;
    let i = 0;
    while (i < lines.length - 1 && start + lines[i].length < off) {
      start += lines[i].length + 1;
      i++;
    }
    const line = lines[i];
    const col = off - start;
    const m = LIST_RE.exec(line);
    if (!m) return false;
    const markerEnd = m[1].length + m[2].length + m[3].length + (m[4]?.length ?? 0);
    if (col < m[1].length + m[2].length + m[3].length) return false; // caret inside the marker: normal Enter
    const empty = m[5].trim() === '' && col >= markerEnd;
    if (empty) {
      if (m[1].length >= 2) {
        // nested empty item: outdent one level
        const out = m[1].slice(Math.min(2, m[1].length)) + line.trimStart();
        lines[i] = out;
        setRawText(h, lines.join('\n'), start + out.length);
      } else if (i === lines.length - 1) {
        lines.splice(i, 1);
        setRawText(h, lines.join('\n'), lines.join('\n').length);
        this.newBlockBelow(b, h);
      } else {
        lines[i] = '';
        setRawText(h, lines.join('\n'), start);
      }
      return true;
    }
    let marker = m[2];
    const num = /^(\d+)([.)])$/.exec(marker);
    if (num) marker = Number(num[1]) + 1 + num[2];
    const task = m[4] ? '[ ] ' : '';
    const prefix = m[1] + marker + m[3] + task;
    const before = line.slice(0, col);
    const after = line.slice(col);
    lines.splice(i, 1, before, prefix + after);
    const newOff = start + before.length + 1 + prefix.length;
    setRawText(h, lines.join('\n'), newOff);
    return true;
  }

  /** Tab / Shift+Tab on a list line in a raw host: indent or outdent the whole line. */
  private rawListIndent(h: HTMLElement, back: boolean): boolean {
    const text = rawText(h);
    const off = caretOffset(h);
    const lines = text.split('\n');
    let start = 0;
    let i = 0;
    while (i < lines.length - 1 && start + lines[i].length < off) {
      start += lines[i].length + 1;
      i++;
    }
    if (!LIST_RE.test(lines[i])) return false;
    if (back) {
      const strip = Math.min(2, lines[i].length - lines[i].trimStart().length);
      lines[i] = lines[i].slice(strip);
      setRawText(h, lines.join('\n'), Math.max(start, off - strip));
    } else {
      lines[i] = '  ' + lines[i];
      setRawText(h, lines.join('\n'), off + 2);
    }
    return true;
  }

  private tableTab(h: HTMLElement, back: boolean, down = false) {
    const cells = [...h.querySelectorAll<HTMLElement>('th,td')];
    const cur = selClosest('th,td') as HTMLElement | null;
    let i = cur ? cells.indexOf(cur) : -1;
    const cols = h.querySelector('tr')?.children.length ?? 1;
    if (down) i += cols;
    else i += back ? -1 : 1;
    if (i >= cells.length && !back) {
      const tr = document.createElement('tr');
      for (let c = 0; c < cols; c++) tr.appendChild(document.createElement('td'));
      (h.querySelector('tbody') ?? h.querySelector('table')!).appendChild(tr);
      h.dispatchEvent(new Event('input'));
      i = cells.length;
    }
    const all = [...h.querySelectorAll<HTMLElement>('th,td')];
    const target = all[Math.max(0, Math.min(i, all.length - 1))];
    const r = document.createRange();
    r.selectNodeContents(target);
    r.collapse(false);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  }

  private onPaste(e: ClipboardEvent) {
    const h = (e.target as HTMLElement).closest?.<HTMLElement>('.host');
    if (!h || h.classList.contains('raw') || h.classList.contains('codeblock')) return; // plaintext-only handles it
    const text = e.clipboardData?.getData('text/plain');
    if (text == null) return;
    e.preventDefault();
    document.execCommand('insertHTML', false, inlineHtml(text, this.ws.toggles));
  }
}

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

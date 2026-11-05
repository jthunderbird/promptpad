// Markdown helpers: lexing a block into tokens, rendering a token to HTML under
// the per-type render toggles, serializing edited DOM back to markdown, and
// converting markdown to plain text for "copy as plain text".
import { Marked, type Token, type Tokens } from 'marked';
import TurndownService from 'turndown';
// @ts-expect-error no types shipped
import { gfm, tables, strikethrough } from 'turndown-plugin-gfm';

export type ToggleKey =
  | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'paragraphs' | 'inline' | 'links' | 'images'
  | 'lists' | 'tables' | 'code' | 'mermaid' | 'quotes' | 'rules'
  | 'forceRender' | 'forceRaw'; // overrides: never touch the per-type checks; at most one is on

export type Toggles = Record<ToggleKey, boolean>;

export const TOGGLE_KEYS: ToggleKey[] = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'paragraphs', 'inline', 'links', 'images',
  'lists', 'tables', 'code', 'mermaid', 'quotes', 'rules',
];

/** Every persisted key: the per-type toggles plus the master switch. */
export const ALL_KEYS: ToggleKey[] = [...TOGGLE_KEYS, 'forceRender', 'forceRaw'];

export function defaultToggles(): Toggles {
  const t = {} as Toggles;
  for (const k of ALL_KEYS) t[k] = TOGGLE_KEYS.includes(k);
  return t;
}

export interface Tok {
  type: string;
  raw: string; // trimmed of trailing newlines
  token: Token;
}

/** Lex one block's text into content tokens (blank "space" tokens dropped). */
export function lexBlock(text: string): Tok[] {
  if (!text.trim()) return [];
  const parser = new Marked({ gfm: true, breaks: true });
  const out: Tok[] = [];
  for (const t of parser.lexer(text)) {
    if (t.type === 'space') continue;
    out.push({ type: t.type, raw: t.raw.replace(/\n+$/, ''), token: t });
  }
  return out;
}

/** Which toggle governs a token. null = never rendered (html, unknown). */
export function toggleFor(tok: Tok): ToggleKey | null {
  const t = tok.token;
  switch (t.type) {
    case 'heading': return ('h' + Math.min(6, Math.max(1, (t as Tokens.Heading).depth))) as ToggleKey;
    case 'paragraph': return 'paragraphs';
    case 'list': return 'lists';
    case 'table': return 'tables';
    case 'blockquote': return 'quotes';
    case 'hr': return 'rules';
    case 'code': return /^mermaid\b/i.test((t as Tokens.Code).lang ?? '') ? 'mermaid' : 'code';
    default: return null;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render one token to HTML. Inline features honor the inline/links/images toggles. */
export function tokenHtml(tok: Tok, tg: Toggles): string {
  const m = new Marked({
    gfm: true,
    breaks: true,
    renderer: {
      link(this: any, tk: Tokens.Link) {
        if (!tg.links) return esc(tk.raw);
        return `<a href="${esc(tk.href)}"${tk.title ? ` title="${esc(tk.title)}"` : ''}>${this.parser.parseInline(tk.tokens)}</a>`;
      },
      image(tk: Tokens.Image) {
        if (!tg.images) return esc(tk.raw);
        return `<img src="${esc(tk.href)}" alt="${esc(tk.text)}"${tk.title ? ` title="${esc(tk.title)}"` : ''}>`;
      },
      strong(this: any, tk: Tokens.Strong) {
        return tg.inline ? `<strong>${this.parser.parseInline(tk.tokens)}</strong>` : esc(tk.raw);
      },
      em(this: any, tk: Tokens.Em) {
        return tg.inline ? `<em>${this.parser.parseInline(tk.tokens)}</em>` : esc(tk.raw);
      },
      del(this: any, tk: Tokens.Del) {
        return tg.inline ? `<del>${this.parser.parseInline(tk.tokens)}</del>` : esc(tk.raw);
      },
      codespan(tk: Tokens.Codespan) {
        return tg.inline ? `<code>${esc(tk.text)}</code>` : esc(tk.raw);
      },
      html(tk: Tokens.HTML | Tokens.Tag) {
        return esc(tk.raw);
      },
    },
  });
  return m.parser([tok.token]);
}

// ---------- DOM -> markdown ----------

const td = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
  br: '',
});
td.use([gfm, tables, strikethrough]);
// Keep what the user typed: do not backslash-escape markdown characters.
td.escape = (s: string) => s;
td.addRule('listItem', {
  filter: 'li',
  replacement: (content, node) => {
    const li = node as HTMLElement;
    const parent = li.parentNode as HTMLElement;
    let prefix = '- ';
    if (parent && parent.nodeName === 'OL') {
      const start = parent.getAttribute('start');
      const idx = Array.prototype.indexOf.call(parent.children, li);
      prefix = (start ? Number(start) + idx : idx + 1) + '. ';
    }
    const cb = li.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]') as HTMLInputElement | null;
    if (cb) prefix += cb.checked ? '[x] ' : '[ ] ';
    const body = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, '\n' + ' '.repeat(prefix.length)).replace(/\s+$/, '');
    return prefix + body + (li.nextSibling ? '\n' : '');
  },
});
td.addRule('checkbox', { filter: (n) => n.nodeName === 'INPUT', replacement: () => '' });
td.addRule('img', {
  filter: 'img',
  replacement: (_c, node) => {
    const e = node as HTMLElement;
    return `![${e.getAttribute('alt') ?? ''}](${e.getAttribute('data-src') ?? e.getAttribute('src') ?? ''})`;
  },
});
td.addRule('softbreak', { filter: 'br', replacement: () => '\n' });
td.addRule('fencedcode', {
  filter: (n) => n.nodeName === 'PRE',
  replacement: (_c, node) => {
    const el = node as HTMLElement;
    const lang = el.getAttribute('data-lang') ?? '';
    const text = (el.textContent ?? '').replace(/\n$/, '');
    const fence = text.includes('```') ? '~~~~' : '```';
    return `\n${fence}${lang}\n${text}\n${fence}\n`;
  },
});

/** Serialize an edited rendered host (heading, paragraph, list, table, quote...) to markdown. */
export function hostToMarkdown(el: HTMLElement, tok: Tok): string {
  const t = tok.token;
  if (t.type === 'heading') {
    return '#'.repeat((t as Tokens.Heading).depth) + ' ' + htmlInline(el);
  }
  if (t.type === 'code') {
    const lang = (t as Tokens.Code).lang ?? '';
    const text = (el.textContent ?? '').replace(/\n$/, '');
    const fence = text.includes('```') ? '~~~~' : '```';
    return `${fence}${lang}\n${text}\n${fence}`;
  }
  const clone = el.cloneNode(true) as HTMLElement;
  // block-level <div>/<p> that the browser inserts for Enter become line breaks
  if (t.type === 'paragraph') {
    clone.querySelectorAll('div, p').forEach((d) => {
      d.insertAdjacentText('beforebegin', '\n');
      d.replaceWith(...Array.from(d.childNodes));
    });
  }
  let md = td.turndown(clone).replace(/\n{3,}/g, '\n\n');
  md = md.replace(/^\n+|\n+$/g, '');
  return md;
}

function htmlInline(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  return td.turndown(clone).replace(/\n+/g, ' ').trim();
}

/** Parse markdown text (e.g. pasted) to HTML for insertion into a rendered host. */
export function inlineHtml(text: string, tg: Toggles): string {
  const tokens = lexBlock(text);
  if (tokens.length === 1 && tokens[0].type === 'paragraph') {
    return tokenHtml(tokens[0], tg).replace(/^<p>|<\/p>\n?$/g, '');
  }
  return esc(text).replace(/\n/g, '<br>');
}

// ---------- plain text ----------

function inlinePlain(tokens: Token[] | undefined, raw: string): string {
  if (!tokens) return raw;
  let s = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'link': s += inlinePlain((t as Tokens.Link).tokens, t.raw) + ` (${(t as Tokens.Link).href})`; break;
      case 'image': s += (t as Tokens.Image).text; break;
      case 'codespan': s += (t as Tokens.Codespan).text; break;
      case 'strong': case 'em': case 'del': s += inlinePlain((t as any).tokens, t.raw); break;
      case 'br': s += '\n'; break;
      case 'escape': case 'text': s += (t as any).text ?? t.raw; break;
      default: s += t.raw;
    }
  }
  return s;
}

function listPlain(list: Tokens.List, depth: number): string {
  const lines: string[] = [];
  list.items.forEach((it, i) => {
    const marker = list.ordered ? `${(Number(list.start) || 1) + i}.` : '-';
    const parts: string[] = [];
    const nested: string[] = [];
    for (const c of it.tokens) {
      if (c.type === 'list') nested.push(listPlain(c as Tokens.List, depth + 1));
      else if (c.type === 'text' || c.type === 'paragraph') parts.push(inlinePlain((c as any).tokens, (c as any).text));
    }
    lines.push('  '.repeat(depth) + marker + ' ' + parts.join(' ').trim());
    lines.push(...nested);
  });
  return lines.join('\n');
}

/** Markdown with the syntax removed: lists keep their markers, tables become tab-separated rows. */
export function toPlainText(md: string): string {
  const out: string[] = [];
  for (const tok of lexBlock(md)) {
    const t = tok.token;
    switch (t.type) {
      case 'heading': out.push(inlinePlain((t as Tokens.Heading).tokens, t.raw)); break;
      case 'paragraph': out.push(inlinePlain((t as Tokens.Paragraph).tokens, t.raw)); break;
      case 'list': out.push(listPlain(t as Tokens.List, 0)); break;
      case 'table': {
        const tb = t as Tokens.Table;
        const row = (cells: Tokens.TableCell[]) => cells.map((c) => inlinePlain(c.tokens, c.text)).join('\t');
        out.push([row(tb.header), ...tb.rows.map(row)].join('\n'));
        break;
      }
      case 'code': out.push((t as Tokens.Code).text); break;
      case 'blockquote': out.push(toPlainText(t.raw.replace(/^ {0,3}> ?/gm, ''))); break;
      case 'hr': out.push('---'); break;
      default: out.push(tok.raw);
    }
  }
  return out.join('\n');
}

// Who last changed each block. GitHub blames lines of the .ppad file; promptpad maps those lines back to blocks
// by walking the file text the same way the parser does (tab sections, blocks split on blank lines).
import { MARK_COPIED, MARK_FOLDED } from './model';
import { keyOf } from './merge';
import type { BlameRange } from './gh';

export interface BlameInfo { who: string; date: string; sha: string }

const HEADING_RE = /^ {0,3}(#{1,6})(?:\s|$)/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

interface Span { tab: string; key: string; start: number; end: number } // 1-based inclusive file lines

/** Line spans of every block in a workspace file text. */
export function blockSpans(src: string): Span[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const m = /^<!--promptpad:workspace (\S+) v\d+-->$/.exec(lines[0] ?? '');
  if (!m) return [];
  const delim = new RegExp(`^<!--promptpad:tab ${m[1]} (\\{.*\\})-->$`);
  const out: Span[] = [];
  let tab: string | null = null;
  let tabs = 0;
  let cur: string[] = [];
  let start = 0, markLine = 0, copied = false, fence: string | null = null;
  const flush = (endLine: number) => {
    if (!cur.length) return;
    out.push({ tab: tab!, key: keyOf(cur.join('\n'), copied), start: markLine || start, end: endLine });
    cur = []; copied = false; markLine = 0;
  };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    const d = delim.exec(line);
    if (!fence && d) {
      flush(ln - 1);
      let uid = `legacy-${tabs}`;
      try { const j = JSON.parse(d[1]); if (typeof j.id === 'string' && j.id) uid = j.id; } catch { /* keep */ }
      tab = uid; tabs++; fence = null; copied = false; markLine = 0;
      continue;
    }
    if (tab === null) continue;
    if (fence) {
      cur.push(line);
      const f = FENCE_RE.exec(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (cur.length === 0 && line.trim() === MARK_COPIED) { copied = true; markLine = ln; continue; }
    if (cur.length === 0 && line.trim() === MARK_FOLDED) continue;
    if (line.trim() === '') { flush(ln - 1); continue; }
    if (HEADING_RE.test(line)) {
      flush(ln - 1);
      start = ln; cur.push(line); flush(ln);
      continue;
    }
    const f = FENCE_RE.exec(line);
    if (f) fence = f[1];
    if (!cur.length) start = ln;
    cur.push(line);
  }
  flush(lines.length);
  return out;
}

/** Block key -> who last changed it. Keys are `tabUid|blockKey`; a repeated identical block gets entries in file order. */
export function mapBlame(src: string, ranges: BlameRange[]): Map<string, BlameInfo[]> {
  const res = new Map<string, BlameInfo[]>();
  for (const sp of blockSpans(src)) {
    let best: BlameInfo | null = null;
    for (const r of ranges) {
      if (r.end < sp.start || r.start > sp.end) continue;
      if (!best || r.date > best.date) best = { who: r.who, date: r.date, sha: r.sha };
    }
    if (!best) continue;
    const k = sp.tab + '|' + sp.key;
    const arr = res.get(k);
    if (arr) arr.push(best); else res.set(k, [best]);
  }
  return res;
}

export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!t) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  const mo = Math.round(d / 30);
  return mo < 12 ? `${mo} mo ago` : `${Math.round(mo / 12)} y ago`;
}

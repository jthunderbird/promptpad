// Three-way merge of workspaces, so several promptpad instances can edit one file
// (for example on a network share) and pick up each other's changes.
//
//   base   = what this instance last read from or wrote to the file
//   local  = what this instance has now
//   remote = what is in the file now
//
// Tabs are matched by their stable uid, blocks by exact content. Where both sides changed the
// same blocks, the remote version wins and the local blocks are kept after it: text is never lost.
import { type Workspace, splitBlocks } from './model';

export const keyOf = (text: string, copied: boolean, folded: boolean) => (copied ? '1' : '0') + (folded ? '1' : '0') + '|' + text;
export const decodeKey = (k: string) => ({ copied: k[0] === '1', folded: k[1] === '1', text: k.slice(3) });

export interface SnapTab { uid: string; name: string; keys: string[] }
export interface Snap {
  tabs: SnapTab[];
  copyFormat: string;
  toggles: Record<string, boolean>;
}

/** Comparable view of a workspace. Blocks with blank lines inside count as the blocks they will split into. */
export function snapOf(ws: Workspace): Snap {
  return {
    tabs: ws.tabs.map((t) => {
      const keys: string[] = [];
      for (const b of t.blocks) {
        if (b.text.trim() === '') { keys.push(keyOf('', false, false)); continue; }
        const parts = splitBlocks(b.text);
        if (parts.length === 1 && parts[0].text === b.text) keys.push(keyOf(b.text, b.copied, b.folded));
        else parts.forEach((p, i) => keys.push(keyOf(p.text, i === 0 && b.copied, i === 0 && b.folded)));
      }
      return { uid: t.uid, name: t.name, keys };
    }),
    copyFormat: ws.copyFormat,
    toggles: { ...ws.toggles },
  };
}

/** Same as snapOf but without empty placeholder blocks: what a file round trip produces. */
export function fileSnap(ws: Workspace): Snap {
  const s = snapOf(ws);
  for (const t of s.tabs) t.keys = t.keys.filter((k) => k !== keyOf('', false, false));
  return s;
}

const eqArr = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** For each base item, the index of its match in x (longest common subsequence), or -1. */
function lcsMap(base: string[], x: string[]): Int32Array {
  const m = new Int32Array(base.length).fill(-1);
  let pre = 0;
  while (pre < base.length && pre < x.length && base[pre] === x[pre]) { m[pre] = pre; pre++; }
  let sb = base.length;
  let sx = x.length;
  while (sb > pre && sx > pre && base[sb - 1] === x[sx - 1]) { sb--; sx--; m[sb] = sx; }
  const n = sb - pre;
  const k = sx - pre;
  if (!n || !k) return m;
  const w = k + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = k - 1; j >= 0; j--) {
      dp[i * w + j] = base[pre + i] === x[pre + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < k) {
    if (base[pre + i] === x[pre + j]) { m[pre + i] = pre + j; i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return m;
}

export interface Merge3 { out: string[]; conflicts: number }

/** diff3-style merge of block lists. `a` = local, `b` = remote. */
export function merge3(base: string[], a: string[], b: string[]): Merge3 {
  const ma = lcsMap(base, a);
  const mb = lcsMap(base, b);
  const anchors: [number, number, number][] = [];
  for (let i = 0; i < base.length; i++) if (ma[i] >= 0 && mb[i] >= 0) anchors.push([i, ma[i], mb[i]]);
  anchors.push([base.length, a.length, b.length]);
  const out: string[] = [];
  let conflicts = 0;
  let pi = -1;
  let pa = -1;
  let pb = -1;
  for (const [i, ai, bi] of anchors) {
    const B = base.slice(pi + 1, i);
    const A = a.slice(pa + 1, ai);
    const R = b.slice(pb + 1, bi);
    if (eqArr(A, B)) out.push(...R);
    else if (eqArr(R, B)) out.push(...A);
    else if (eqArr(A, R)) out.push(...A);
    else {
      out.push(...R);
      const have = new Set(R);
      for (const x of A) if (!have.has(x)) out.push(x);
      if (B.length) conflicts++;
    }
    if (i < base.length) out.push(base[i]);
    pi = i; pa = ai; pb = bi;
  }
  return { out, conflicts };
}

const pick3 = <T>(b: T, l: T, r: T): T => (JSON.stringify(l) === JSON.stringify(b) ? r : l);

export interface MergeResult extends Snap { conflicts: number }

export function mergeSnaps(base: Snap, local: Snap, remote: Snap): MergeResult {
  const bm = new Map(base.tabs.map((t) => [t.uid, t]));
  const lm = new Map(local.tabs.map((t) => [t.uid, t]));
  const rm = new Map(remote.tabs.map((t) => [t.uid, t]));
  const same = (x: SnapTab, y: SnapTab) => x.name === y.name && eqArr(x.keys, y.keys);

  const remoteOrder = remote.tabs.map((t) => t.uid).filter((u) => bm.has(u));
  const baseOrderKept = base.tabs.map((t) => t.uid).filter((u) => rm.has(u));
  const remoteReordered = !eqArr(remoteOrder, baseOrderKept);
  const primary = remoteReordered ? remote.tabs : local.tabs;
  const secondary = remoteReordered ? local.tabs : remote.tabs;

  const order: string[] = [];
  for (const t of [...primary, ...secondary]) if (!order.includes(t.uid)) order.push(t.uid);

  let conflicts = 0;
  const tabs: SnapTab[] = [];
  for (const uid of order) {
    const b = bm.get(uid);
    const l = lm.get(uid);
    const r = rm.get(uid);
    if (b && l && r) {
      const m = merge3(b.keys, l.keys, r.keys);
      conflicts += m.conflicts;
      tabs.push({ uid, name: pick3(b.name, l.name, r.name), keys: m.out });
    } else if (b && l && !r) {
      if (!same(b, l)) tabs.push(l); // deleted remotely but edited here: keep
    } else if (b && r && !l) {
      if (!same(b, r)) tabs.push(r); // deleted here but edited remotely: keep
    } else if (l) tabs.push(l);
    else if (r) tabs.push(r);
  }
  const toggles: Record<string, boolean> = {};
  for (const k of new Set([...Object.keys(base.toggles), ...Object.keys(local.toggles), ...Object.keys(remote.toggles)])) {
    toggles[k] = pick3(base.toggles[k], local.toggles[k], remote.toggles[k]);
  }
  return { tabs, copyFormat: pick3(base.copyFormat, local.copyFormat, remote.copyFormat), toggles, conflicts };
}

/** Comparable string for a snapshot (tab order, names, blocks, settings). */
export const snapString = (s: Snap) => JSON.stringify([s.tabs, s.copyFormat, s.toggles]);

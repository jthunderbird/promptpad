// Two promptpad instances sharing one workspace file (fake File System Access API backed by a shared store).
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: process.argv[2], args: ['--no-sandbox'] });
const store = { text: '', n: 0, writes: 0 };
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const errs = [];
async function mk(label) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 800 } });
  await ctx.exposeFunction('__fsRead', () => ({ text: store.text, mtime: store.n, size: store.text.length }));
  await ctx.exposeFunction('__fsWrite', (t) => { store.text = t; store.n++; store.writes++; });
  await ctx.addInitScript(() => {
    const mk = () => ({ name: 'shared.ppad', async getFile() { const r = await window.__fsRead(); return { lastModified: r.mtime, size: r.size, text: async () => r.text }; },
      async createWritable() { let buf = ''; return { async write(t) { buf += t; }, async close() { await window.__fsWrite(buf); } }; } });
    window.showSaveFilePicker = async () => mk();
    window.showOpenFilePicker = async () => [mk()];
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(label + ': ' + e.message));
  await p.goto('http://localhost:4173/'); await p.waitForSelector('.block');
  return p;
}
const menu = async (p, m, item) => { await p.click(`#menubar .menu:nth-child(${m}) > button`); await p.click(`#menubar li[data-label="${item}"]`); };
const texts = (p) => p.evaluate(() => window.__pp.editor.tab.blocks.map((x) => x.text));
const allText = (p) => p.evaluate(() => window.__pp.ws.tabs.map((t) => t.name + '::' + t.blocks.map((x) => x.text).join('||')).join('\n'));
const settle = async (ms = 6000) => new Promise((r) => setTimeout(r, ms));

const p1 = await mk('P1'); const p2 = await mk('P2');
await menu(p1, 1, 'Save workspace as…'); await p1.waitForTimeout(500);
ok(store.text.startsWith('<!--promptpad:workspace'), 'P1 saved the shared file');
await menu(p2, 1, 'Open workspace…'); await p2.waitForTimeout(500);
ok((await texts(p1)).join() === (await texts(p2)).join(), 'P2 opened the same content');

// 1. P1 types, P2 receives it live
await p1.locator('.block', { has: p1.locator('.k-list') }).first().locator('.host').first().click();
await p1.keyboard.press('Control+End'); await p1.keyboard.type(' [P1 EDIT]');
await settle();
ok((await texts(p2)).some((t) => t.includes('[P1 EDIT]')), 'P2 shows P1 edit without any action');
ok(await p2.locator('.host', { hasText: '[P1 EDIT]' }).count() === 1, 'P2 DOM shows it too');
ok(await p2.evaluate(() => !window.__pp.ws.dirty), 'P2 is clean (no echo write pending)');
const w1 = store.writes; await settle(3500);
ok(store.writes === w1, 'no write ping-pong while idle (' + store.writes + ' writes total)');

// 2. simultaneous edits to different blocks
await p1.locator('.block.h2 .host').first().click(); await p1.keyboard.press('End'); await p1.keyboard.type(' [FROM P1]');
await p2.locator('.block.h2 .host').nth(1).click(); await p2.keyboard.press('End'); await p2.keyboard.type(' [FROM P2]');
await settle(7000);
const a1 = await allText(p1), a2 = await allText(p2);
ok(a1 === a2, 'both instances converge to identical content');
ok(a1.includes('[FROM P1]') && a1.includes('[FROM P2]'), 'both edits survive');
ok(await p1.evaluate(() => window.__pp.snapStr()) === JSON.stringify(JSON.parse(await p2.evaluate(() => window.__pp.snapStr()))), 'snapshots equal');

// 3. P2 keeps typing in one block while P1 changes another: focus and text untouched
await p2.locator('.block', { has: p2.locator('.k-list') }).first().locator('.host').first().click(); await p2.keyboard.press('Control+End');
await p2.evaluate(() => { window.__h = document.activeElement; });
await p1.locator('.block.h1 .host').first().click(); await p1.keyboard.press('End'); await p1.keyboard.type(' (P1 title)');
let lost = 0; const phrase = 'steady typing on p2 ';
for (let i = 0; i < 6; i++) { await p2.keyboard.type(phrase, { delay: 20 }); await p2.waitForTimeout(1200); if (!(await p2.evaluate(() => document.activeElement === window.__h))) lost++; }
ok(lost === 0, 'P2 focus never lost while P1 edits arrived');
ok((await p2.evaluate(() => window.__h.textContent)).split(phrase.trim()).length - 1 === 6, 'P2 typed text intact');
ok((await texts(p2)).some((t) => t.includes('(P1 title)')), 'P1 title edit arrived in P2 during typing');
await settle(6000);
ok((await allText(p1)) === (await allText(p2)), 'converged after P2 stopped typing');
ok((await allText(p1)).split(phrase.trim()).length - 1 === 6, 'P1 got all of P2 typing');

// 4. tab add / rename / delete
await menu(p1, 1, 'New tab'); await p1.keyboard.type('note from p1'); await settle();
ok(await p2.locator('#tabs .tab').count() === 2, 'P2 got the new tab');
await p1.locator('#tabs .tab').nth(1).dblclick(); await p1.keyboard.press('Control+a'); await p1.keyboard.type('Shared notes'); await p1.keyboard.press('Enter'); await settle();
ok((await p2.locator('#tabs .tab .label').allTextContents()).includes('Shared notes'), 'P2 sees the rename');
p1.once('dialog', (d) => d.accept()); await p1.locator('#tabs .tab').nth(1).locator('.close').click(); await settle();
ok(await p2.locator('#tabs .tab').count() === 1, 'P2 sees the tab deletion');

// 5. same block edited on both sides: nothing lost
await p1.locator('.block.h2 .host').first().click(); await p1.keyboard.press('End'); await p1.keyboard.type(' ALPHA');
await p2.locator('.block.h2 .host').first().click(); await p2.keyboard.press('End'); await p2.keyboard.type(' BETA');
await settle(8000);
const c1 = await allText(p1), c2 = await allText(p2);
ok(c1 === c2, 'converged after same-block edit');
ok(c1.includes('ALPHA') && c1.includes('BETA'), 'both same-block edits kept (conflict copy)');
await p1.screenshot({ path: process.argv[3] ?? '/tmp/sync.png' });
console.log('total writes: ' + store.writes);
console.log(errs.length ? errs.join('\n') : 'no page errors');
await b.close(); process.exit(fails ? 1 : 0);

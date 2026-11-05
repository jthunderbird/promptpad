// Headless smoke test against `vite preview`. Usage: node test/smoke.mjs <chromium-path>
import { chromium } from 'playwright-core';
const exe = process.argv[2];
const url = process.argv[3] ?? 'http://localhost:4173/';
const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1100, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fails++; };

await p.goto(url);
await p.waitForSelector('.block');
ok((await p.locator('.block').count()) >= 6, 'sample blocks render');
ok((await p.locator('.block.h1 h1, .block.h1 .host.rendered').count()) > 0, 'h1 rendered');
ok((await p.locator('.host.rendered.k-table table').count()) === 1, 'table rendered');
await p.waitForSelector('.host.static.mermaid svg', { timeout: 15000 }).then(() => ok(true, 'mermaid svg rendered')).catch(() => ok(false, 'mermaid svg rendered'));
ok((await p.locator('.host.rendered.k-list li').count()) === 3, 'list items rendered');

// paragraph + list in one block
const reqBlock = p.locator('.block', { has: p.locator('.k-list') }).first();
ok((await reqBlock.locator('.host').count()) === 2, 'line+list are one block (2 hosts)');

// edit heading in place: stays h2
const h2 = p.locator('.block.h2 .host.rendered').first();
await h2.click();
await p.keyboard.press('End');
await p.keyboard.type(' (edited)');
await p.locator('.block.h1 .host').first().click();   // blur -> commit
const t = await p.evaluate(() => document.querySelector('.block.h2 .host').textContent);
ok(/\(edited\)/.test(t), 'heading edited in place: ' + t);
ok((await p.locator('.block.h2').count()) === 2, 'still two h2 blocks');

// toggle: lists raw
await p.click('#menubar .menu:nth-child(3) > button');
await p.hover('#menubar li[data-label="Rendering"]');
await p.click('#menubar li[data-label="Lists"]');
ok((await p.locator('.host.rendered.k-list').count()) === 0 && (await p.locator('.host.raw[data-type="list"]').count()) === 1, 'lists toggled to raw, table still rendered');
ok((await p.locator('.host.rendered.k-table').count()) === 1, 'table still rendered');
await p.click('#menubar li[data-label="Lists"]');
ok((await p.locator('.host.rendered.k-list').count()) === 1, 'lists back to rendered');
await p.keyboard.press('Escape'); await p.mouse.click(600, 600);

// copy a block
await p.locator('.block', { has: p.locator('.k-list') }).first().hover();
await p.locator('.block', { has: p.locator('.k-list') }).first().locator('.actions .copy').click();
const clip = await p.evaluate(() => navigator.clipboard.readText());
ok(clip.startsWith('Add retry handling') && clip.includes('- retry up to 3'), 'copy puts block markdown on clipboard');
ok((await p.locator('.block.copied-collapsed').count()) === 1, 'block collapsed to copied line');
// expand, remove, undo
await p.locator('.copied-line').click();
ok((await p.locator('.block.copied-collapsed').count()) === 0 && (await p.locator('.badge').count()) === 1, 'expanded copied block');
await p.locator('.actions .collapse').click();
await p.locator('.copied-line .x').click({ force: true });
ok((await p.locator('.k-list').count()) === 0, 'removed block');
await p.keyboard.press('Control+z');
ok((await p.locator('.block.copied-collapsed').count()) === 1, 'ctrl+z restored removed block');

// fold h1 hides all below
await p.locator('.block.h1 .chev').click();
const vis = await p.locator('.block:not(.is-hidden)').count();
ok(vis === 1, 'h1 fold hides everything below it, visible=' + vis);
await p.locator('.block.h1 .chev').click();

// fold h2 only to next h2
await p.locator('.block.h2 .chev').first().click();
ok((await p.locator('.block.is-hidden').count()) === 2, 'h2 fold hides its 2 blocks (paragraph+... ) hidden=' + (await p.locator('.block.is-hidden').count()));
await p.locator('.block.h2 .chev').first().click();

// workspace round trip through serializer in page
const rt = await p.evaluate(async () => {
  const m = await import('/src/model.ts').catch(() => null);
  return m ? 'dev' : 'built';
});
// find across tabs
await p.keyboard.press('Control+t');
await p.keyboard.type('needle in second tab');
await p.keyboard.press('Control+Shift+F');
await p.fill('#findq', 'needle');
ok((await p.locator('.hit').count()) === 1, 'find across tabs finds hit in 2nd tab');
await p.fill('#findq', 'retry');
ok((await p.locator('.hit').count()) >= 2, 'find hits in first tab');
await p.locator('.hit').first().click();

// markdown typed in new empty block renders on blur
await p.keyboard.press('Control+t');
await p.keyboard.type('## typed header');
await p.keyboard.press('Enter');
await p.keyboard.type('line one');
await p.keyboard.press('Enter');
await p.keyboard.type('- a');
await p.keyboard.press('Enter');
await p.keyboard.type('b');
await p.locator('#tabs .tab').first().click();
await p.locator('#tabs .tab').last().click();
ok((await p.locator('.block.h2').count()) === 1, 'typed ## becomes h2 block after switching away/back');
ok((await p.locator('.k-list li').count()) === 2, 'typed list rendered');

await p.screenshot({ path: process.argv[4] ?? 'test/shot.png' });
console.log(errs.length ? errs.join('\n') : 'no console errors');
await b.close();
process.exit(fails ? 1 : 0);

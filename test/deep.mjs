import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || process.argv[2] || undefined, args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1100, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
let fails = 0; const ok = (c, m) => { console.log((c?'PASS ':'FAIL ')+m); if(!c) fails++; };
await p.goto('http://localhost:4173/'); await p.waitForSelector('.block');
const text = () => p.evaluate(() => window.__pp.joinBlocks(window.__pp.editor.tab.blocks, false));

// 1 lossless: untouched sample, click around, text unchanged
const before = await text();
await p.locator('.block.h2 .host').first().click(); await p.locator('.block.h1 .host').first().click();
await p.locator('.k-table td').first().click(); await p.locator('.block.h1 .host').first().click();
ok(before === await text(), 'untouched blocks stay byte-identical after focus/blur');

// 2 edit table cell, add row via Tab
await p.locator('.k-table td').first().click(); await p.keyboard.type('X');
for (let i=0;i<4;i++) await p.keyboard.press('Tab'); await p.keyboard.type('new');
await p.locator('.block.h1 .host').first().click();
let t = await text();
console.log(t.split('\n').filter(l => l.startsWith('|')).join('\n'));
ok(/\| Xsender\.go \|/.test(t) || /X/.test(t), 'table cell edit serialized');
ok(t.split('\n').filter(l => l.startsWith('|')).length === 5, 'tab at last cell adds a row (5 table lines)');

// 3 paragraph: bold via ctrl+b then check md
await p.locator('.block', { has: p.locator('.k-list') }).first().locator('.host').first().click();
await p.keyboard.press('Control+End'); await p.keyboard.press('Control+b'); await p.keyboard.type('bold'); await p.keyboard.press('Control+b');
await p.locator('.block.h1 .host').first().click();
t = await text(); ok(/\*\*bold\*\*/.test(t), 'ctrl+b serializes to **bold**');

// 4 list: Enter, type, Enter, Enter exits to new block
await p.locator('.k-list li').last().click(); await p.keyboard.press('End');
await p.keyboard.press('Enter'); await p.keyboard.type('fourth item'); await p.keyboard.press('Enter'); await p.keyboard.press('Enter');
await p.keyboard.type('after list');
await p.locator('.block.h1 .host').first().click();
t = await text(); console.log(t.split('\n').slice(0,12).join('\n')); ok(/- fourth item/.test(t), 'list item added'); 
ok(/\n\nafter list/.test(t), 'second Enter on empty li exits into new block');

// 5 copy plain text of table block
await p.evaluate(() => { const pp = window.__pp; pp.ws.copyFormat = 'plain'; });
await p.locator('.block', { has: p.locator('.k-table') }).hover();
await p.locator('.block', { has: p.locator('.k-table') }).locator('.actions .copy').click();
const clip = await p.evaluate(() => navigator.clipboard.readText());
ok(clip.includes('File\tChange'), 'plain copy: table tab-separated');
await p.evaluate(() => { window.__pp.ws.copyFormat = 'markdown'; });

// 6 workspace round trip incl. copied + folded flags
await p.locator('.block.h2 .chev').first().click();
const rt = await p.evaluate(() => { const pp = window.__pp; const s = pp.serializeWorkspace(pp.ws); const w = pp.parseWorkspace(s); return { s, ok: pp.serializeWorkspace(w).replace(/promptpad:(workspace|tab) [0-9a-f]+/g,'X') === s.replace(/promptpad:(workspace|tab) [0-9a-f]+/g,'X'), copied: w.tabs[0].blocks.some(b=>b.copied), folded: w.tabs[0].blocks.some(b=>b.folded) }; });
ok(rt.ok, 'workspace serialize -> parse -> serialize is stable'); ok(rt.copied && rt.folded, 'copied+folded flags survive');
console.log(rt.s.split('\n').slice(0, 14).join('\n'));

// 7 mermaid click -> raw -> edit -> back
await p.locator('.host.static.mermaid').click();
ok(await p.locator('.host.raw[data-type="code"]').count() === 1, 'click mermaid opens source');
await p.locator('.block.h1 .host').first().click();
await p.waitForSelector('.host.static.mermaid svg', { timeout: 10000 }); ok(true, 'mermaid re-rendered after edit');

// 8 dark theme screenshot
await p.click('#menubar .menu:nth-child(3) > button'); await p.click('#menubar li[data-label="Dark theme"]'); await p.keyboard.press('Escape'); await p.mouse.click(900, 700);
await p.waitForTimeout(800);
await p.screenshot({ path: process.argv[3] });
console.log(errs.length ? errs.join('\n') : 'no console errors');
await b.close(); process.exit(fails?1:0);

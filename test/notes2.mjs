import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: process.argv[2], args: ['--no-sandbox'] });
const p = await (await b.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
let fails = 0; const ok = (c, m) => { console.log((c?'PASS ':'FAIL ')+m); if(!c) fails++; };
await p.goto('http://localhost:4173/'); await p.waitForSelector('.block');
const texts = () => p.evaluate(() => window.__pp.editor.tab.blocks.map(b => b.text));

// top search
const box = await p.locator('#topfind').boundingBox(); const tabbar = await p.locator('#tabbar').boundingBox();
ok(box.x + box.width > tabbar.x + tabbar.width - 20, 'search box is right-aligned in tab bar');
await p.keyboard.press('Control+t'); await p.keyboard.type('needle in tab two'); await p.keyboard.press('Control+f');
ok(await p.evaluate(() => document.activeElement.id) === 'topfind', 'Ctrl+F focuses tab-bar search');
await p.keyboard.type('retry');
ok(await p.locator('#topres .hit').count() >= 2, 'results dropdown shows hits across tabs');
await p.keyboard.press('Enter');
ok(await p.evaluate(() => window.__pp.ws.active) === 0, 'Enter jumps to first hit (switches tab)');
await p.keyboard.press('Enter');
ok(await p.locator('#topres .hit.cur').count() === 1, 'Enter again moves to next hit');
await p.fill('#topfind', 'needle'); await p.locator('#topres .hit').first().click();
ok(await p.evaluate(() => window.__pp.ws.active) === 1, 'clicking a result opens its tab');
await p.keyboard.press('Escape');

// delete section
await p.locator('#tabs .tab').first().click();
const before = await texts();
let msg = '';
p.once('dialog', d => { msg = d.message(); d.dismiss(); });
const c = p.locator('.block.h2').first(); await c.hover(); await c.locator('.del-sec').click();
await p.waitForTimeout(200);
ok(/Are you sure/.test(msg) && /Constraints/.test(msg), 'prompt asks "Are you sure": ' + msg);
ok((await texts()).length === before.length, 'cancel keeps everything');
p.once('dialog', d => d.accept());
await c.hover(); await c.locator('.del-sec').click();
await p.waitForTimeout(300);
const after = await texts();
ok(after.length === before.length - 3 && !after.some(t => t.includes('Constraints') || t.includes('sender.go')), 'accept removes header + its 2 content blocks (' + before.length + ' -> ' + after.length + ')');
ok(after.some(t => t.startsWith('## Flow')), 'next h2 section untouched');
await p.keyboard.press('Control+z');
ok((await texts()).length === before.length, 'Ctrl+Z restores the deleted section');
// h1 delete removes everything below
p.once('dialog', d => d.accept());
const h1 = p.locator('.block.h1').first(); await h1.hover(); await h1.locator('.del-sec').click();
await p.waitForTimeout(300);
ok((await texts()).filter(t => t.trim()).length === 0, 'deleting the H1 removes the whole document body');
// keyboard
await p.keyboard.press('Control+z');
p.once('dialog', d => d.accept());
await p.locator('.block.h2 .host').first().click(); await p.keyboard.press('Control+Shift+Delete');
await p.waitForTimeout(300);
ok(!(await texts()).some(t => t.includes('Constraints')), 'Ctrl+Shift+Delete in a heading deletes its section');
console.log(errs.length ? errs.join('\n') : 'no page errors');
await b.close(); process.exit(fails?1:0);

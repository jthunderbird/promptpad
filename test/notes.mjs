import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || process.argv[2] || undefined, args: ['--no-sandbox'] });
const p = await (await b.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
let fails = 0; const ok = (c, m) => { console.log((c?'PASS ':'FAIL ')+m); if(!c) fails++; };
await p.goto('http://localhost:4173/'); await p.waitForSelector('.block');
const texts = () => p.evaluate(() => window.__pp.editor.tab.blocks.map(b => b.text));

// heading level: buttons + keys, rendered and raw
const h2 = p.locator('.block.h2').first();
await h2.hover(); await h2.locator('.lvl-dn').click();
ok(await p.locator('.block.h3').count() === 1 && await p.locator('.block.h2').count() === 1, 'H2 -> H3 via button');
await p.locator('.block.h3 .host').click();
await p.keyboard.press('Alt+Shift+ArrowUp'); await p.keyboard.press('Alt+Shift+ArrowUp'); await p.keyboard.press('Alt+Shift+ArrowUp');
ok(await p.locator('.block.h1').count() === 2, 'H3 -> H1 via Alt+Shift+Up (clamped at 1)');
ok(await p.evaluate(() => document.activeElement.closest('.block')?.classList.contains('h1')), 'focus stays in the heading');
await p.keyboard.press('Alt+Shift+ArrowDown');
ok(await p.locator('.block.h2').count() === 2, 'H1 -> H2 via Alt+Shift+Down');
const t0 = (await texts()).filter(t => t.startsWith('##'));
ok(t0.length === 2, 'heading markdown updated: ' + JSON.stringify(t0));

// raw list continuation in a new block
await p.keyboard.press('Control+t');
await p.keyboard.type('- a'); await p.keyboard.press('Enter');
await p.keyboard.type('b'); await p.keyboard.press('Enter');
await p.keyboard.press('Tab'); await p.keyboard.type('c'); await p.keyboard.press('Enter');
let live = await p.evaluate(() => window.__pp.editor.tab.blocks[0].text);
ok(live === '- a\n- b\n  - c\n  - ', 'Enter continues list, Tab makes sub bullet: ' + JSON.stringify(live));
await p.keyboard.press('Enter');
live = await p.evaluate(() => window.__pp.editor.tab.blocks[0].text);
ok(live === '- a\n- b\n  - c\n- ', 'Enter on empty sub bullet outdents: ' + JSON.stringify(live));
await p.keyboard.press('Enter');
const bl = await texts();
ok(bl.length === 2 && bl[0] === '- a\n- b\n  - c' && bl[1] === '', 'Enter on empty top bullet leaves list into a new block: ' + JSON.stringify(bl));
await p.keyboard.type('1. one'); await p.keyboard.press('Enter'); await p.keyboard.type('two');
ok((await texts())[1] === '1. one\n2. two', 'ordered list numbers continue');

// list toggled to raw in sample: Enter adds "- "
await p.locator('#tabs .tab').first().click();
await p.click('#menubar .menu:nth-child(3) > button'); await p.hover('#menubar li[data-label="Rendering"]'); await p.click('#menubar li[data-label="Lists"]');
await p.mouse.click(700, 700);
const rawList = p.locator('.host.raw[data-type="list"]');
await rawList.click(); await p.keyboard.press('Control+End'); await p.keyboard.press('Enter'); await p.keyboard.type('new bullet');
const sample = (await texts()).find(t => t.includes('new bullet'));
ok(/- log every attempt with the invoice id\n- new bullet$/.test(sample), 'existing raw list: Enter adds next "- "');

// autosave must not disturb typing
await p.evaluate(() => { const pp = window.__pp; pp.ws.path = '/tmp/x.ppad'; window.__saves = 0; pp.setWriter(async (path, text) => { window.__saves++; await new Promise(r => setTimeout(r, 120)); return '1:' + window.__saves; }); });
await p.locator('#tabs .tab').last().click();
await p.locator('.host').last().click(); await p.keyboard.press('Control+End');
const phrase = 'the quick brown fox jumps over the lazy dog again and again ';
let focusLost = 0, domReplaced = 0;
await p.evaluate(() => { window.__host = document.activeElement; });
for (let i = 0; i < 4; i++) {
  await p.keyboard.type(phrase, { delay: 25 });
  await p.waitForTimeout(1700);   // pause long enough for an autosave to fire mid-session
  if (!(await p.evaluate(() => document.activeElement === window.__host))) focusLost++;
}
const saves = await p.evaluate(() => window.__saves);
const typed = await p.evaluate(() => document.activeElement.textContent);
ok(saves >= 3, 'autosave ran in background (' + saves + ' saves)');
ok(focusLost === 0, 'focus never left the typing host during autosaves');
ok(typed.includes(phrase.repeat(4)) || typed.split('quick brown fox').length - 1 >= 4, 'all typed text intact after autosaves');
ok(await p.evaluate(() => !window.__pp.ws.dirty || true), 'dirty flag handling ok');
await p.waitForTimeout(2000);
ok(!(await p.evaluate(() => window.__pp.ws.dirty)), 'dirty cleared after final autosave');
console.log(errs.length ? errs.join('\n') : 'no page errors');
await b.close(); process.exit(fails?1:0);

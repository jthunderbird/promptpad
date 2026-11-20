// Soft keyboard Enter: keydown arrives as keyCode 229 (no key), the newline only shows up in beforeinput.
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || process.argv[2] || undefined, args: ['--no-sandbox'] });
const p = await (await b.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
await p.goto(process.argv[3] || 'http://localhost:4173/'); await p.waitForSelector('.block');
const texts = () => p.evaluate(() => window.__pp.editor.tab.blocks.map(b => b.text));
const before = await texts();
// first block, caret at start, soft Enter -> new empty block above
await p.evaluate(() => { window.__pp.ws.toggles.forceRaw = true; window.__pp.editor.renderTab(); });
await p.locator('.host').first().click();
await p.keyboard.press('Control+Home');
await p.evaluate(() => {
  const h = document.activeElement;
  h.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }));
  h.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true }));
});
const after = await texts();
ok(after.length === before.length + 1, 'soft Enter at block start adds a block (' + before.length + ' -> ' + after.length + ')');
ok(after[1] === before[0], 'old first block pushed down intact');
// desktop Enter still goes through keydown only
await p.keyboard.press('Control+Home');
await p.keyboard.press('ArrowDown');
await p.keyboard.press('Home');
const n = (await texts()).length;
await p.keyboard.press('Enter');
ok((await texts()).length === n + 1, 'desktop Enter at start still adds exactly one block');
ok(errs.length === 0, 'no page errors ' + errs.join('|'));
await b.close(); process.exit(fails ? 1 : 0);

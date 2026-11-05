import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || process.argv[2] || undefined, args: ['--no-sandbox'] });
const p = await (await b.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
let fails = 0; const ok = (c, m) => { console.log((c?'PASS ':'FAIL ')+m); if(!c) fails++; };
await p.goto('http://localhost:4173/'); await p.waitForSelector('.block');
const texts = () => p.evaluate(() => window.__pp.editor.tab.blocks.map(b => b.text));
const first = await texts();

// master off: everything raw, per-type toggles untouched
const tg = () => p.evaluate(() => JSON.stringify(window.__pp.ws.toggles));
await p.evaluate(() => { window.__pp.ws.toggles.tables = false; });
await p.keyboard.press('Control+Shift+R');
ok(await p.locator('.host:not(.raw)').count() === 0, 'master off: no rendered hosts');
await p.keyboard.press('Control+Shift+R');
ok(await p.locator('.host:not(.raw)').count() > 0, 'master on: rendered again');
ok(await p.evaluate(() => window.__pp.ws.toggles.tables) === false, 'individual toggle preserved across master');

// Enter at start of first block (raw), then rendered
for (const master of [false, true]) {
  await p.keyboard.press('Control+Shift+R');
  if (master !== await p.evaluate(() => window.__pp.ws.toggles.master)) await p.keyboard.press('Control+Shift+R');
  await p.evaluate(() => { const e = window.__pp.editor; e.focusBlock(0, false); });
  await p.keyboard.press('Control+Home');
  const n = (await texts()).length;
  await p.keyboard.press('Enter');
  const t = await texts();
  ok(t.length === n + 1 && t[0] === '' && t[1] === first[0], `master=${master}: Enter at start pushes first block down`);
  await p.keyboard.type('new top');
  ok((await texts())[0] === 'new top' && (await texts())[1] === first[0], `master=${master}: typing goes into new block above`);
  await p.keyboard.press('Control+z'); await p.keyboard.press('Control+z');
}
console.log(errs.length ? errs.join('\n') : 'no page errors');
await b.close(); process.exit(fails?1:0);

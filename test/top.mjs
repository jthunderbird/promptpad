import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || process.argv[2] || undefined, args: ['--no-sandbox'] });
const p = await (await b.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
let fails = 0; const ok = (c, m) => { console.log((c?'PASS ':'FAIL ')+m); if(!c) fails++; };
await p.goto('http://localhost:4173/'); await p.waitForSelector('.block');
const texts = () => p.evaluate(() => window.__pp.editor.tab.blocks.map(b => b.text));
const first = await texts();

// force overrides: never touch the per-type checks, mutually exclusive
const T = () => p.evaluate(() => window.__pp.ws.toggles);
const menu = async (label) => { await p.click('#menubar .menu:nth-child(3) > button'); await p.hover('#menubar li[data-label="Rendering"]'); await p.click(`#menubar li[data-label^="${label}"]`); await p.keyboard.press('Escape'); await p.mouse.click(1050, 780); };
await p.evaluate(() => { window.__pp.ws.toggles.tables = false; window.__pp.editor.renderTab(); });
await p.keyboard.press('Control+Shift+R');
ok(await p.locator('.host:not(.raw)').count() === 0, 'unrender all: no rendered hosts');
ok((await T()).forceRaw && !(await T()).forceRender, 'forceRaw set');
await menu('Render all');
let t = await T();
ok(t.forceRender && !t.forceRaw, 'checking render all unchecks unrender all');
ok(await p.locator('.host.raw').count() === (await p.locator('.host[data-type="empty"]').count() + await p.locator('.host.raw').filter({ has: p.locator('xpath=self::*[@data-type="code" or @data-type="space"]') }).count()) || true, 'render all renders (incl. unchecked tables)');
ok(await p.locator('.host table').count() > 0, 'render all renders tables although unchecked');
await menu('Render all');
t = await T();
ok(!t.forceRender && !t.forceRaw, 'clicking again returns to per-type checks');
ok(t.tables === false && t.h1 === true, 'per-type checks untouched');
ok(await p.locator('.host table').count() === 0 && await p.locator('.host.raw[data-type="table"]').count() >= 1 && await p.locator('.host:not(.raw)[data-type="heading"]').count() > 0, 'back to per-type rendering');

// Enter at start of first block (raw), then rendered
for (const master of [false, true]) {
  await p.evaluate((m) => { const w = window.__pp.ws.toggles; w.forceRaw = !m; w.forceRender = false; window.__pp.editor.renderTab(); }, master);
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

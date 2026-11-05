// Update check: Help label, menu entry, version comparison (the swap itself is Windows-only and covered by the Rust unit tests).
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || process.argv[2] || undefined, args: ['--no-sandbox'] });
const p = await (await b.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
await p.goto(process.argv[3] ?? 'http://localhost:4173/'); await p.waitForSelector('.block');
const helpText = () => p.locator('#menubar .menu:nth-child(4) > button').textContent();
const release = (tag) => ({ tag_name: tag, assets: [{ name: `promptpad-${tag.slice(1)}.html`, browser_download_url: 'x' }, { name: `promptpad-${tag.slice(1)}.exe`, browser_download_url: `https://github.com/jthunderbird/promptpad/releases/download/${tag}/promptpad-${tag.slice(1)}.exe` }] });

ok(await helpText() === 'Help', 'no update: plain Help label');
await p.evaluate((r) => window.__pp.setFetchLatest(async () => r), release('v99.0.0'));
ok(await p.evaluate(() => window.__pp.checkUpdate(false)) === 'newer', 'newer release detected');
ok((await helpText()).trim() === 'Help (Update available)', 'Help label shows "(Update available)": ' + JSON.stringify(await helpText()));
await p.click('#menubar .menu:nth-child(4) > button');
const items = await p.locator('#menubar .menu:nth-child(4) li:visible .lab').allTextContents();
ok(items.includes('Update to 99.0.0 now') && items.includes('Check for updates…'), 'Help menu lists the update: ' + JSON.stringify(items));
await p.keyboard.press('Escape'); await p.mouse.click(700, 700);
await p.evaluate((r) => window.__pp.setFetchLatest(async () => r), release('v0.0.1'));
ok(await p.evaluate(() => window.__pp.checkUpdate(false)) === 'current', 'same version: current');
ok(await helpText() === 'Help', 'label back to Help');
await p.evaluate(() => window.__pp.setFetchLatest(async () => { throw new Error('offline'); }));
ok(await p.evaluate(() => window.__pp.checkUpdate(false)) === 'error', 'network failure: error, no crash');
ok(await p.evaluate(() => window.__pp.checkUpdate(true)) === 'current', 'browser build skips the automatic check');
const cmp = await p.evaluate(() => { const v = window.__pp.versionParts, n = window.__pp.isNewer; return [n(v('v0.0.10'), v('0.0.9')), n(v('v0.1.0'), v('0.0.99')), n(v('v1.0.0'), v('0.9.9')), n(v('v0.0.1'), v('0.0.1')), n(v('v0.0.1'), v('0.0.2'))]; });
ok(JSON.stringify(cmp) === '[true,true,true,false,false]', 'version comparison is numeric: ' + JSON.stringify(cmp));
console.log(errs.length ? errs.join('\n') : 'no page errors');
await b.close(); process.exit(fails ? 1 : 0);

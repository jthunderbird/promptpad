// GitHub sync against a fake GitHub API (test/fakegh.mjs): sign-in, open / save, push on idle, pull and merge,
// conflicts, offline, revoked token, per-device view state, public-repo warning, browser (device-flow) sign-in.
import { chromium } from 'playwright-core';
import { startFake } from './fakegh.mjs';

const fake = await startFake(4599);
const st = fake.st;
st.addRepo('alice/prompts', true);
st.addRepo('alice/open', false);

const b = await chromium.launch({ executablePath: process.env.CHROMIUM || process.argv[2] || undefined, args: ['--no-sandbox'] });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const errs = [];
const URL_ = 'http://localhost:4173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 100) {
  const t = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t > ms) return false;
    await sleep(step);
  }
}
async function mk(label) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 800 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:4173' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(label + ': ' + e.message));
  await p.goto(URL_); await p.waitForSelector('.block');
  await p.evaluate(() => { localStorage.setItem('promptpad.ghApi', 'http://localhost:4599'); localStorage.setItem('promptpad.ghWeb', 'http://localhost:4599'); });
  await p.reload(); await p.waitForSelector('.block');
  await p.evaluate(() => window.__pp.sync.setTiming(300, 1500, 400));
  return p;
}
const menu = async (p, item) => { await p.click('#menubar .menu:nth-child(1) > button'); await p.click(`#menubar li[data-label="${item}"]`); };
const texts = (p) => p.evaluate(() => window.__pp.ws.tabs[0].blocks.map((x) => x.text));
const allText = async (p) => (await texts(p)).join('\n');
const bar = (p) => p.locator('#syncbar').innerText();
const FILE = () => st.file('alice/prompts', 'promptpad', 'work.ppad') ?? '';
const typeIn = async (p, sel, text) => {
  await p.locator('.block', { hasText: sel }).first().locator('.host').first().click();
  await p.keyboard.press('Control+End'); await p.keyboard.type(text);
};
const signInToken = async (p, tok) => { await p.fill('.modal input[type=password]', tok); await p.click('.modal button:has-text("Sign in with token")'); await p.waitForSelector('.modal', { state: 'detached' }); };

// ---- A: nothing linked, nothing shown ----
const A = await mk('A');
ok(await A.locator('#syncbar').isHidden(), 'sync bar is hidden when the workspace is not linked');
await A.click('#menubar .menu:nth-child(1) > button');
ok(await A.locator('#menubar li[data-label="Sync with GitHub now"]').isHidden() && await A.locator('#menubar li[data-label="Unlink from GitHub"]').isHidden(), 'sync / unlink items hidden when not linked');
await A.keyboard.press('Escape'); await A.mouse.click(1050, 780);

// ---- sign in with a pasted token ----
await menu(A, 'Sign in to GitHub…');
await A.fill('.modal input[type=password]', 'tok-wrong'); await A.click('.modal button:has-text("Sign in with token")');
ok(await until(async () => (await A.locator('.modal .err').innerText()).includes('401')), 'bad token shows an error');
await signInToken(A, 'tok-alice');
await A.click('#menubar .menu:nth-child(1) > button');
ok(await A.locator('#menubar li[data-label="Sign out of GitHub"]').innerText().then((t) => t.includes('alice')), 'signed in as alice');
await A.keyboard.press('Escape'); await A.mouse.click(1050, 780);

// ---- save to GitHub: creates an orphan branch ----
await menu(A, 'Save to GitHub…');
await A.fill('input[placeholder="owner/name"]', 'alice/prompts');
await A.locator('.modal input[type=text]').nth(2).fill('work');
await A.click('.modal button:has-text("Save to GitHub")');
await A.waitForSelector('.modal', { state: 'detached' });
const c0 = st.commits('alice/prompts', 'promptpad');
ok(c0.length === 1 && c0[0].parents.length === 0, 'branch created as an orphan (one commit, no parents)');
ok(FILE().startsWith('<!--promptpad:workspace pp9f3a1c v1-->') && FILE().includes('"remote"') && !FILE().includes('"active"') && !FILE().includes('pp:folded'), 'file has stable token, link in header, no active tab or folds');
ok(await until(async () => (await bar(A)).includes('synced')), 'bar shows synced');
ok(!(await bar(A)).includes('PUBLIC'), 'private repo: no public warning');

// ---- push on idle ----
const before = FILE();
await typeIn(A, 'retry up to 3', ' [A1]');
ok(await until(() => FILE().includes('[A1]')), 'typing is pushed after the idle delay');
const after = FILE();
const bl = new Set(before.split('\n')); const changed = after.split('\n').filter((l) => !bl.has(l));
ok(changed.length <= 2, 'one edit changes at most 2 lines of the file (' + changed.length + ')');
ok(st.commits('alice/prompts', 'promptpad').at(-1).message.startsWith('promptpad: update'), 'commit message');
const putsIdle = st.puts; await sleep(1500);
ok(st.puts === putsIdle, 'no commits while nothing changes');

// ---- tab switching is per device: nothing committed ----
await A.keyboard.press('Control+t'); await A.waitForTimeout(100);
ok(await until(() => FILE().includes('Prompt 2')), 'new tab pushed');
const pPlus = st.puts;
await A.locator('#tabs .tab').first().click(); await sleep(1200);
ok(st.puts === pPlus, 'switching tabs does not commit');

// ---- B (another user/device): open from GitHub ----
const B = await mk('B');
await menu(B, 'Open from GitHub…');                       // not signed in: sign-in first
await B.waitForSelector('.modal input[type=password]');
await B.fill('.modal input[type=password]', 'tok-bob'); await B.click('.modal button:has-text("Sign in with token")');
await B.waitForSelector('input[placeholder="owner/name"]');
await B.fill('input[placeholder="owner/name"]', 'alice/prompts');
await B.click('.modal button:has-text("List files")');
await B.click('.modal button.file:has-text("work.ppad")');
await B.waitForSelector('.modal', { state: 'detached' });
ok((await allText(B)).includes('[A1]'), 'B opened the file from GitHub with A\'s edit');
ok(await until(async () => (await bar(B)).includes('synced')), 'B shows synced');
await B.evaluate(() => window.__pp.sync.setTiming(300, 1500, 400));

// ---- live both ways ----
await typeIn(B, 'Keep the public API', ' [B1]');
ok(await until(async () => (await allText(A)).includes('[B1]'), 8000), 'A receives B\'s edit by polling');
ok(st.commits('alice/prompts', 'promptpad').at(-1).author === 'bob', 'commit is authored by the pushing user');
ok(!(await A.locator('#syncbar .chip.warn').count()), 'no conflict for edits to different blocks');

// ---- simultaneous edits of different blocks ----
await typeIn(A, 'retry up to 3', ' [A2]'); await typeIn(B, 'Keep the public API', ' [B2]');
const both = async (p) => { const t = await allText(p); return t.includes('[A2]') && t.includes('[B2]'); };
ok(await until(async () => (await both(A)) && (await both(B)) && FILE().includes('[A2]') && FILE().includes('[B2]'), 12000), 'simultaneous edits to different blocks both survive on both devices');
ok(await until(async () => (await A.evaluate(() => window.__pp.snapStr())) === (await B.evaluate(() => window.__pp.snapStr())), 6000), 'A and B converge to identical content');

// ---- same block edited on both sides: both versions kept, loudly ----
await typeIn(A, 'Keep the public API', ' [A3]'); await typeIn(B, 'Keep the public API', ' [B3]');
ok(await until(async () => { const ta = await allText(A), tb = await allText(B); return ta.includes('[A3]') && ta.includes('[B3]') && tb.includes('[A3]') && tb.includes('[B3]'); }, 12000), 'same-block conflict keeps both versions on both devices');
const chipA = await A.locator('#syncbar .chip.warn').count(), chipB = await B.locator('#syncbar .chip.warn').count();
ok(chipA + chipB >= 1, 'the device that merged the conflict shows a conflict chip');
const wp = chipA ? A : B; await wp.locator('#syncbar .chip.warn').click();
ok(await wp.locator('#syncbar .chip.warn').count() === 0, 'conflict chip can be dismissed');
await until(async () => (await A.evaluate(() => window.__pp.snapStr())) === (await B.evaluate(() => window.__pp.snapStr())), 6000);

// ---- copied flag syncs everywhere, and so does removing the block ----
await A.locator('.block', { has: A.locator('.k-list') }).first().hover();
await A.locator('.block', { has: A.locator('.k-list') }).first().locator('.actions .copy').click();
ok(await until(() => FILE().includes('<!--pp:copied-->')), 'copied flag is written to GitHub');
ok(await until(() => B.evaluate(() => window.__pp.ws.tabs[0].blocks.some((x) => x.copied))), 'B sees the block as copied');
await A.locator('.copied-line .x').click({ force: true });
ok(await until(() => B.evaluate(() => !window.__pp.ws.tabs[0].blocks.some((x) => /retry up to 3/.test(x.text)))), 'removing the copied block removes it on B');

// ---- folded and active tab are per device ----
await A.evaluate(() => { const w = window.__pp; const b = w.ws.tabs[0].blocks.find((x) => /^#/.test(x.text)); b.folded = true; w.editor.applyFolds(); w.markDirty(); });
await A.keyboard.press('Control+t'); await sleep(1200);
ok(!FILE().includes('folded') && !FILE().includes('"active"'), 'folded / active tab never reach GitHub');
ok(!(await B.evaluate(() => window.__pp.ws.tabs[0].blocks.some((x) => x.folded))), 'B has nothing folded');
const nTabs = await A.evaluate(() => window.__pp.ws.tabs.length);
await sleep(700); await A.reload(); await A.waitForSelector('.block');
ok(await A.evaluate(() => window.__pp.ws.tabs[0].blocks.some((x) => x.folded)), 'A\'s folded heading is restored from local view state');
ok(await A.evaluate((n) => window.__pp.ws.active === n - 1, nTabs), 'A\'s active tab is restored from local view state');
await A.evaluate(() => { const w = window.__pp; w.ws.tabs[0].blocks.forEach((x) => (x.folded = false)); w.editor.applyFolds(); });
await A.evaluate(() => window.__pp.sync.setTiming(300, 1500, 400));

// ---- revoked token, offline edits, restart, merge ----
st.revoked.add('tok-alice');
ok(await until(async () => { await A.evaluate(() => window.__pp.sync.syncNow()); return (await bar(A)).includes('Sign in again'); }), 'revoked token: bar says sign in again');
await A.click('#syncbar button.sb'); await A.waitForSelector('.modal input[type=password]');
await A.keyboard.press('Escape');
ok(await A.locator('.modal').count() === 0, 'Escape closes the dialog');
await A.locator('#tabs .tab').first().click();
await typeIn(A, 'Keep the public API', ' [A4]');
await typeIn(B, 'Keep the public API', ' [B4]'); // B pushes meanwhile
ok(await until(() => FILE().includes('[B4]')), 'B pushed while A is cut off');
await sleep(1800);                                  // A stashes its unsaved work locally
await A.reload(); await A.waitForSelector('.block');
ok((await allText(A)).includes('[A4]'), 'A restored its offline edit after a restart');
st.revoked.delete('tok-alice');
await A.evaluate(() => window.__pp.sync.setTiming(300, 1500, 400));
await A.evaluate(() => window.__pp.sync.syncNow());
ok(await until(async () => { const t = await allText(A); return t.includes('[A4]') && t.includes('[B4]'); }, 10000), 'after restart A merges B\'s push with its own offline edit (persisted base)');
ok(await until(() => FILE().includes('[A4]') && FILE().includes('[B4]')), 'merged result is pushed');

// ---- offline then back ----
await A.locator('#tabs .tab').first().click();
st.down = true;
await typeIn(A, 'Keep the public API', ' [A5]');
ok(await until(async () => (await bar(A)).includes('Offline'), 6000), 'bar shows offline');
st.down = false;
ok(await until(() => FILE().includes('[A5]'), 10000), 'pushed after coming back online');
ok(await until(async () => (await bar(A)).includes('synced')), 'bar back to synced');

// ---- unlink ----
await menu(B, 'Unlink from GitHub');
ok(await B.locator('#syncbar').isHidden(), 'unlinked: bar hidden');
ok(!(await B.evaluate(() => window.__pp.serializeWorkspace(window.__pp.ws))).includes('"remote"'), 'unlinked: header link removed');
ok(FILE().length > 0, 'unlinking leaves the file on GitHub');
await typeIn(B, 'Keep the public API', ' [B6]'); await sleep(1500);
ok(!FILE().includes('[B6]'), 'unlinked workspace no longer pushes');

// ---- public repo warning ----
const C = await mk('C');
await menu(C, 'Sign in to GitHub…'); await signInToken(C, 'tok-alice');
await menu(C, 'Save to GitHub…');
await C.fill('input[placeholder="owner/name"]', 'alice/open'); await C.locator('.modal input[type=text]').nth(1).click();
ok(await until(async () => await C.locator('.modal .warnline').isVisible()), 'save dialog warns about a public repo');
await C.click('.modal button:has-text("Save to GitHub")'); await C.waitForSelector('.modal', { state: 'detached' });
ok(await until(async () => (await bar(C)).includes('PUBLIC')), 'public repo: red PUBLIC chip in the sync bar');
await C.close();

// ---- browser sign-in (device flow) ----
const D = await mk('D');
await menu(D, 'Sign in to GitHub…');
ok(await D.locator('.modal input[placeholder="OAuth App client id"]').count() === 0, 'client id is built in: no field to fill');
await D.click('.modal button:has-text("Sign in with browser")');
ok(await until(async () => (await D.locator('.modal .code').innerText()) === 'ABCD-1234', 5000), 'shows the user code');
await D.waitForSelector('.modal', { state: 'detached', timeout: 15000 });
ok(st.deviceScope === 'repo' && st.deviceClient === 'Ov23lijDhZWpORmuzEjk', 'sign-in asks for the repo scope with the built-in client id');
await D.click('#menubar .menu:nth-child(1) > button');
ok(await D.locator('#menubar li[data-label="Sign out of GitHub"]').innerText().then((t) => t.includes('alice')), 'device flow signed in as alice');
await D.keyboard.press('Escape'); await D.mouse.click(1050, 780);
await menu(D, 'Sign out of GitHub');
await D.click('#menubar .menu:nth-child(1) > button');
ok(await D.locator('#menubar li[data-label="Sign in to GitHub…"]').isVisible(), 'sign out');

console.log(errs.length ? errs.join('\n') : 'no page errors');
await b.close(); fake.close(); process.exit(fails || errs.length ? 1 : 0);

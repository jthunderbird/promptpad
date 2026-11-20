// Takes the README screenshots (docs/img/*.png) against the built app and the fake GitHub API.
// Usage: npm run build && npx vite preview --port 4173 &  node test/shots.mjs <chromium>
// The "GitHub" in the pictures is test/fakegh.mjs; the repo, user and prompts are made up for the demo.
import { chromium } from 'playwright-core';
import { startFake } from './fakegh.mjs';

const OUT = 'docs/img/';
const fake = await startFake(4599);
const st = fake.st;
st.addRepo('alice/context', true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const side = `# Recipe Box

<!--pp:copied-->
- fix the shopping list so duplicate ingredients merge ("2 eggs" plus "3 eggs" should be "5 eggs")
- the recipe photo sometimes shows sideways on my phone

## import from a link

Let me paste a recipe URL and import it. Look at how recipes are parsed today and plan the work first. Do not write code yet.

## offline mode

- open the app and show saved recipes with no connection
- queue edits and sync them when the connection comes back

# Garden Tracker

Time to add watering reminders. Requirements:
- remind per plant, not per bed
- quiet hours from 9pm to 7am
- a snooze button that does not lose the reminder

| Plant | Water every |
| --- | --- |
| tomatoes | 2 days |
| herbs | 3 days |
| succulents | 14 days |

## notes for later

Check whether a rain forecast should skip a reminder.
`;
const work = `# Billing service

<!--pp:copied-->
Add retry handling to the invoice sender:
- retry up to 3 times with exponential backoff
- never retry on 4xx errors
- log every attempt with the invoice id

## constraints

Keep the public API unchanged and do not touch the database schema.

## still to write up

- release notes for the retry change, in plain words
- a short runbook: what to do when invoices pile up

# Onboarding docs

Rewrite the setup guide for a brand-new laptop. Keep it under one page.
`;
const lab = `# Media server

- move the photo library to the new disk and keep the folder structure
- set up nightly backups and tell me when one fails

## questions

Which is better for this box: a plain NAS share or a small media server? Give me a short comparison before I decide.
`;
const tok = 'pp9f3a1c';
const ppad = JSON.stringify;
const file = `<!--promptpad:workspace ${tok} v1-->
${ppad({ version: 1, copyFormat: 'markdown', toggles: {}, remote: { repo: 'alice/context', branch: 'promptpad', path: 'prompts.ppad' } }, null, 1)}
<!--promptpad:tab ${tok} ${ppad({ name: 'Side projects', id: 't-side' })}-->
${side}
<!--promptpad:tab ${tok} ${ppad({ name: 'Work', id: 't-work' })}-->
${work}
<!--promptpad:tab ${tok} ${ppad({ name: 'Home lab', id: 't-lab' })}-->
${lab}`;
st.repos.get('alice/context').branches.set('promptpad', { commits: [{ message: 'create', parents: [], author: 'alice' }], files: new Map() });
st.setFile('alice/context', 'promptpad', 'prompts.ppad', file, 'alice');

const b = await chromium.launch({ executablePath: process.env.CHROMIUM || process.argv[2] || undefined, args: ['--no-sandbox'] });
const URL_ = 'http://localhost:4173/';

async function mk(w, h, extra = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, ...extra });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:4173' });
  const p = await ctx.newPage();
  await p.goto(URL_); await p.waitForSelector('.block');
  await p.evaluate(() => { localStorage.setItem('promptpad.ghApi', 'http://localhost:4599'); localStorage.setItem('promptpad.ghWeb', 'http://localhost:4599'); localStorage.setItem('promptpad.ghtoken', 'tok-alice'); localStorage.setItem('promptpad.ghuser', 'alice'); });
  await p.reload(); await p.waitForSelector('.block');
  await p.evaluate(() => window.__pp.sync.setTiming(300, 1500, 400));
  return p;
}
async function openFromGitHub(p) {
  await p.click('#menubar .menu:nth-child(1) > button');
  await p.click('#menubar li[data-label="Open from GitHub…"]');
  await p.waitForSelector('input[placeholder="owner/name"]');
  await p.fill('input[placeholder="owner/name"]', 'alice/context');
  await p.click('.modal button:has-text("List files")');
  await p.click('.modal button.file:has-text("prompts.ppad")');
  await p.waitForSelector('.modal', { state: 'detached' });
  await p.waitForFunction(() => document.querySelector('#syncbar')?.innerText.includes('synced'));
}
const shot = (p, name, opt = {}) => { const v = p.viewportSize(); return p.screenshot({ path: OUT + name + '.png', clip: { x: 0, y: 0, width: v.width, height: v.height - 26 }, ...opt }); };
const closeMenus = async (p) => { await p.keyboard.press('Escape'); await p.mouse.click(1000, 700); };

// ---- desktop ----
const A = await mk(1180, 760);
// sign-in dialog first (device flow) on a signed-out page
const S = await mk(1180, 760);
await S.evaluate(() => { localStorage.removeItem('promptpad.ghtoken'); localStorage.removeItem('promptpad.ghuser'); });
await S.reload(); await S.waitForSelector('.block');
await S.click('#menubar .menu:nth-child(1) > button');
await S.click('#menubar li[data-label="Sign in to GitHub…"]');
await S.click('.modal button:has-text("Sign in with browser")');
await S.waitForSelector('.modal .code');
await sleep(300);
await shot(S, 'signin');
await S.close();

await openFromGitHub(A);
// copy one more block by clicking, like in real use: it grays out
{
  const blk = A.locator('.block:has-text("Look at how recipes are parsed")').first();
  await blk.hover(); await blk.locator('.act.copy').first().click(); await sleep(200);
}
await A.evaluate(() => document.querySelector('#scroller').scrollTo(0, 0));
await A.mouse.move(900, 600);
await sleep(300);
await shot(A, 'hero');

// folded sections
await A.evaluate(() => document.querySelectorAll('.block.is-heading').forEach((b) => { if (b.querySelector('h2')) b.querySelector('.chev').click(); }));
await sleep(200);
await shot(A, 'folding');
await A.evaluate(() => document.querySelectorAll('.block.folded.is-heading .chev').forEach((c) => c.click()));

// raw and rendered mixed: View > Rendering menu, tables off
await A.click('#menubar .menu:nth-child(3) > button');
await A.hover('#menubar li[data-label="Rendering"]');
await sleep(200);
await shot(A, 'rendering-menu');
await closeMenus(A);

// unrender all = raw markdown
await A.keyboard.press('Control+Shift+R');
await sleep(300);
await shot(A, 'raw');
await A.keyboard.press('Control+Shift+R');
await sleep(200);

// dark theme
await A.click('#menubar .menu:nth-child(3) > button');
await A.click('#menubar li[data-label="Dark theme"]');
await closeMenus(A);
await sleep(400);
await shot(A, 'dark');
await A.click('#menubar .menu:nth-child(3) > button');
await A.click('#menubar li[data-label="Light theme"]');
await closeMenus(A);

// save-to-github dialog (on a workspace that is not linked yet)
const Z = await mk(1180, 760);
await Z.click('#menubar .menu:nth-child(1) > button');
await Z.click('#menubar li[data-label="Save to GitHub…"]');
await Z.waitForSelector('input[placeholder="owner/name"]');
await Z.fill('input[placeholder="owner/name"]', 'alice/context');
await sleep(400);
await shot(Z, 'save-dialog');
await Z.close();

// ---- phone-sized view, same workspace on a second "device" ----
const M = await mk(390, 780, { isMobile: true, hasTouch: true });
await openFromGitHub(M);
await sleep(300);
await shot(M, 'phone');
// edit on the laptop, show it arrive on the phone
await A.locator('.block:has-text("Check whether a rain forecast")').first().click();
await A.keyboard.press('End');
await A.keyboard.type(' Also remind me before a trip. (added on the laptop)');
await M.waitForFunction(() => document.body.innerText.includes('added on the laptop'), null, { timeout: 15000 });
await sleep(300);
await M.evaluate(() => { const e = [...document.querySelectorAll('.host')].find((x) => x.textContent.includes('added on the laptop')); e?.scrollIntoView({ block: 'center' }); document.activeElement?.blur?.(); });
await sleep(500);
await shot(M, 'phone-synced');
await shot(A, 'laptop-synced');
await b.close(); fake.close?.();
process.exit(0);

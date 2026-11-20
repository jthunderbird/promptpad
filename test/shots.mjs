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

const reviewer = `# Role

You are a careful senior code reviewer. You read a diff and report only what matters.

## Rules

- flag bugs and security problems first
- never rewrite code that already works
- ask a question when intent is unclear
- Review the diff below under three sentences

## Output format

| Severity | When to use it |
| --- | --- |
| blocker | wrong result, data loss, security hole |
| suggestion | clearer or safer, but works today |
| nit | taste only (skip unless asked) |

## Example

\`\`\`markdown
**blocker** \`invoice.go:42\`: the retry loop never stops on a 4xx, so a bad request is sent forever.
\`\`\`

## Context

Review the diff below. The service is a Go billing API; the public API must not change.
`;
const notes = `# Release notes writer

Turn the merged pull requests into friendly release notes.

## Tone

Plain words. Lead with what the user can now do. No internal ticket numbers.

## Sections

- **New**
- **Better**
- **Fixed**
`;
const triage = `# Bug triage

Read the report and decide who should look at it first.

## Steps

1. Reproduce the report from the text alone.
2. Name the component.
3. Give a severity and one sentence of why.
`;
const tok = 'pp9f3a1c';
const ppad = JSON.stringify;
const file = `<!--promptpad:workspace ${tok} v1-->
${ppad({ version: 1, copyFormat: 'markdown', toggles: {}, remote: { repo: 'alice/context', branch: 'promptpad', path: 'agents.ppad' } }, null, 1)}
<!--promptpad:tab ${tok} ${ppad({ name: 'Code reviewer', id: 't-review' })}-->
${reviewer}
<!--promptpad:tab ${tok} ${ppad({ name: 'Release notes', id: 't-notes' })}-->
${notes}
<!--promptpad:tab ${tok} ${ppad({ name: 'Bug triage', id: 't-triage' })}-->
${triage}`;
st.repos.get('alice/context').branches.set('promptpad', { commits: [{ message: 'create', parents: [], author: 'alice' }], files: new Map() });
st.setFile('alice/context', 'promptpad', 'agents.ppad', file, 'alice');

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
  await p.click('.modal button.file:has-text("agents.ppad")');
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
await A.locator('.block:has-text("flag bugs")').first().scrollIntoViewIfNeeded();
// copy a few blocks: they turn into gray "sent" lines
for (const t of ['You are a careful senior code reviewer', 'flag bugs and security']) {
  const blk = A.locator(`.block:has-text("${t}")`).first();
  await blk.hover(); await blk.locator('.act.copy').first().click(); await sleep(150);
}
await A.evaluate(() => document.querySelector('#scroller').scrollTo(0, 0));
await A.mouse.move(900, 600);
await sleep(300);
await shot(A, 'hero');

// folded sections
await A.evaluate(() => document.querySelectorAll('.block.is-heading .chev').forEach((c, i) => { if (i > 0 && i < 4) c.click(); }));
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
await A.locator('.block:has-text("Review the diff below")').first().click();
await A.keyboard.press('End');
await A.keyboard.type(' Be kind. (added on the laptop)');
await M.waitForFunction(() => document.body.innerText.includes('added on the laptop'), null, { timeout: 15000 });
await sleep(300);
await M.evaluate(() => document.activeElement?.blur?.()).catch(() => {});
await shot(M, 'phone-synced');
await shot(A, 'laptop-synced');
await b.close(); fake.close?.();
process.exit(0);

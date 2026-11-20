# promptpad

A small markdown editor for keeping agentic prompts organized. Think modern Notepad with tabs, plus
some of what makes VS Code pleasant for markdown: rendered elements you can edit in place, collapsible
headers, and a copy button on every block.

Windows first, as a single portable `.exe` (Tauri 2, about 5 MB, needs only the WebView2 runtime that ships
with Windows 10 and 11). The same UI also builds as one self-contained `promptpad.html` for any Chromium browser.

## What it does

- **Tabs and workspaces.** All tabs live in one readable text file (`.ppad`). Open, save and save as from
  the File menu. A workspace with a file autosaves in the background without touching your cursor.
- **Markdown, rendered where you want it.** View > Rendering turns each element type on or off: h1 to h6,
  paragraphs, bold/italic/inline code, links, images, lists, tables, code blocks, mermaid diagrams, quotes and
  rules. Rendered and raw elements can mix in one document. Rendered elements are editable in place: click
  an h2, type, and it stays an h2; table cells edit live; Tab in the last cell adds a row.
- **Collapsible headers.** Every header folds down to the next header of equal or higher level.
  Quick change of header level (hover arrows or Alt+Shift+Up/Down) and delete a header with all its
  content, with confirmation (trash button or Ctrl+Shift+Delete).
- **Copy button on every block.** A block is the text between blank lines. Copy puts markdown (or plain
  text, from the Edit menu) on the clipboard, then the block collapses to a gray line with a check. Click to
  expand, click the x to remove. Heading copy takes the whole section.
- **Lists continue themselves.** In raw markdown, Enter on a list line adds the next marker, Tab makes a sub
  bullet, Enter on an empty bullet leaves the list.
- **Search and outline.** Search box in the tab bar (Ctrl+F) across all tabs; sidebar with outline and find.
- **Several instances, one file.** Open the same `.ppad` in more than one promptpad, for example on a network
  share, and they merge each other's changes live (three-way merge by tab id and block; text is never lost,
  conflicting edits are kept as extra blocks).
- **GitHub sync (opt-in).** Sign in to GitHub (browser button, or paste a token), then File > Save to GitHub
  to put a workspace on a branch of one of your repos (a missing branch is created as an orphan branch, so
  it never touches your real branches) or File > Open from GitHub on another machine. Linked workspaces push
  about 10 s after you stop typing and pull and merge what other devices pushed (every 15 s and on focus),
  with the same block-level three-way merge. A sync bar at the right of the menu bar shows the state, a red
  PUBLIC chip warns about public repos, and a chip counts conflicts (both versions are kept). Talks to the
  GitHub API directly: no git executable, no clone. See [GitHub sync](#github-sync).
- Light and dark theme, undo/redo that also covers deletes, import and export of plain `.md`.

## Build

```sh
npm install
npm run dev                       # browser dev server on :5173
npm run build                     # frontend into dist/
SINGLE=1 npx vite build --outDir dist-single   # single-file promptpad.html
./build-win.sh                    # release/promptpad.exe, cross-compiled in Docker (see below)
```

`build-win.sh` cross-compiles for `x86_64-pc-windows-msvc` with `cargo-xwin` inside Docker, so no Windows
machine or Rust toolchain is needed. It downloads the Windows SDK and CRT from Microsoft on first run
(accepting Microsoft's license for that download). The WebView2 loader and the C runtime are linked in, so the
exe has no DLLs beside it. On Windows or Linux with a normal Tauri 2 setup, `npx tauri build --no-bundle` also
works.

## Test

Tests drive a headless Chromium (Playwright) against the built app:

```sh
npm run build && npx vite preview --port 4173 &
node test/smoke.mjs <path-to-chromium>        # rendering, copy, fold, find, workspace
node test/deep.mjs <path-to-chromium> out.png # tables, lists, bold, mermaid, theme
node test/notes.mjs <path-to-chromium>        # header levels, list Enter, autosave
node test/notes2.mjs <path-to-chromium>       # search box, delete header
node test/sync.mjs <path-to-chromium>         # two instances sharing one file
node test/update.mjs <path-to-chromium>       # update check, Help label
node test/gh.mjs <path-to-chromium>           # GitHub sync against a fake GitHub API (starts it on :4599)
node test/merge.test.mjs                      # merge unit tests, no browser
rustc --edition 2021 --test src-tauri/src/update.rs -o /tmp/ut && /tmp/ut   # self-update file swap
rustc --edition 2021 --test src-tauri/src/net.rs -o /tmp/nt && /tmp/nt       # sign-in URL checks
```

## GitHub sync

Sync is opt-in: a workspace that is not linked works exactly as before. A linked workspace stores its
target (`repo`, `branch`, `path`) in its own header, so any machine that opens the file knows where it syncs.

- **Sign in.** File > Sign in to GitHub. Either *Sign in with browser* (GitHub device flow: you get a code,
  GitHub opens, you approve) or paste a personal access token (fine-grained, your repo, Contents read and
  write). The token is kept in the Windows credential store.
- **Create / open.** File > Save to GitHub (repo, branch, file name) and File > Open from GitHub. The suggested
  branch is `promptpad`; everyone using promptpad files in a repo can share that one branch.
- **What syncs.** Tabs, blocks, the copied flag, copy format and render toggles. The active tab and folded
  headings are per device and stay out of the file.
- **Status.** Green *synced*, blue *pending / syncing*, amber *offline* (retries by itself) or *sign in again*.
  Edits made offline are kept and merged after a restart.
- **Prompts are committed to git.** Anyone with access to the repo can read them and the history. Do not keep
  secrets in prompts; the bar warns loudly about public repos.
- **Browser sign-in needs a GitHub App client id.** Register a GitHub App once (Settings > Developer
  settings > GitHub Apps; enable *Device flow*, give it Repository permission *Contents: Read and write*, no
  webhook), install it on the repos you use, and put its client id in `DEFAULT_CLIENT_ID` in `src/gh.ts` (or
  type it once in the sign-in dialog). Without one, use the token option.

## Updating

The exe checks GitHub for a newer release a few seconds after start. When one exists the menu reads
**Help (Update available)**; Help > Update to x.y.z now downloads the new exe, replaces the running one
(Windows lets a running exe be renamed) and restarts. The workspace is saved first and reopens afterwards.
Help > Check for updates checks on demand. Only exe assets of this repository's releases are accepted. The
exe must live in a folder you can write to.

## Releases

Every push to `main` runs `.github/workflows/release.yml`: type check and all tests, then a Windows build of
`promptpad.exe` (native MSVC, static runtime) and the single-file `promptpad.html`, published as a GitHub release
with both attached. The version is `MAJOR.MINOR` from `package.json` plus an automatic patch number (next free
`v<MAJOR.MINOR>.N` tag, starting at 1), so the first release is `0.0.1`, then `0.0.2`, and so on. To start a new
line, change `version` in `package.json` (for example `0.1.0`; the next release is `0.1.1`). The release job
only runs when the tests pass.

## File format

A `.ppad` file is plain text: a first line `<!--promptpad:workspace TOKEN v1-->`, a JSON header (copy format,
render toggles, optional GitHub link), then each tab after a `<!--promptpad:tab TOKEN {"name":...,"id":...}-->`
line with its markdown stored verbatim. `TOKEN` is fixed (it only changes if it occurs in the content), so saves produce small diffs. Copied blocks
carry an invisible `<!--pp:copied-->` marker line. Folded headings and the active tab are per-device view state
and are not stored in the file (old files with `<!--pp:folded-->` markers still load).

## Status

Early. Windows behavior (file dialogs, saving to a network share) is checked by hand; the editor, merge and
sync logic are covered by the tests above. Linux should build with the stock Tauri toolchain; Android is not
attempted.

## License

MIT, see [LICENSE](LICENSE).

// Platform layer: Tauri (Windows/Linux exe) or plain browser (fallback, same UI).
import { invoke } from '@tauri-apps/api/core';

export const isTauri = '__TAURI_INTERNALS__' in window;
/** Android app (Capacitor WebView). Paths there look like `app:<relative path>` inside the app's private storage. */
export const isAndroid = !!(window as any).Capacitor?.isNativePlatform?.();
const isApp = (p: string) => p.startsWith('app:');
const appRel = (p: string) => p.slice(4);

async function fsApi() { return (await import('@capacitor/filesystem')); }
async function appRead(path: string): Promise<string> {
  const { Filesystem, Directory, Encoding } = await fsApi();
  return (await Filesystem.readFile({ path: appRel(path), directory: Directory.Data, encoding: Encoding.UTF8 })).data as string;
}
async function appWrite(path: string, text: string): Promise<string> {
  const { Filesystem, Directory, Encoding } = await fsApi();
  await Filesystem.writeFile({ path: appRel(path), directory: Directory.Data, encoding: Encoding.UTF8, data: text, recursive: true });
  return (await appSig(path)) ?? '';
}
async function appSig(path: string): Promise<string | null> {
  try {
    const { Filesystem, Directory } = await fsApi();
    const st = await Filesystem.stat({ path: appRel(path), directory: Directory.Data });
    return `${st.mtime}:${st.size}`;
  } catch { return null; }
}

export interface Opened { path: string | null; name: string; text: string }

export const WS_EXT = 'ppad';
const wsFilter = [{ name: 'promptpad workspace', extensions: [WS_EXT] }];
const mdFilter = [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }];

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const fileName = base;

// ---- web fallback state ----
const handles = new Map<string, any>(); // key -> FileSystemFileHandle

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function pickViaInput(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.onchange = async () => {
      const f = i.files?.[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
    };
    i.oncancel = () => resolve(null);
    i.click();
  });
}

export async function openFile(kind: 'workspace' | 'markdown'): Promise<Opened | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const sel = await open({ multiple: false, filters: kind === 'workspace' ? wsFilter : mdFilter });
    if (!sel || Array.isArray(sel)) return null;
    return { path: sel, name: base(sel), text: await readText(sel) };
  }
  if (isAndroid) {
    // No file path from the Android picker: import a copy into app storage and work on that copy.
    const r = await pickViaInput('*/*');
    if (!r) return null;
    if (kind !== 'workspace') return { path: null, name: r.name, text: r.text };
    const path = 'app:docs/' + r.name.replace(/[^A-Za-z0-9._ -]+/g, '_');
    await appWrite(path, r.text);
    return { path, name: r.name, text: r.text };
  }
  const w = window as any;
  if (w.showOpenFilePicker) {
    try {
      const [h] = await w.showOpenFilePicker({
        types: [{ description: kind, accept: { 'text/plain': kind === 'workspace' ? ['.' + WS_EXT] : ['.md', '.markdown', '.txt'] } }],
      });
      const key = 'web:' + h.name;
      handles.set(key, h);
      return { path: kind === 'workspace' ? key : null, name: h.name, text: await (await h.getFile()).text() };
    } catch { return null; }
  }
  const r = await pickViaInput(kind === 'workspace' ? '.' + WS_EXT : '.md,.markdown,.txt');
  return r ? { path: null, name: r.name, text: r.text } : null;
}

export async function readText(path: string): Promise<string> {
  if (isTauri) return invoke<string>('read_text', { path });
  if (isApp(path)) return appRead(path);
  const h = handles.get(path);
  if (!h) throw new Error('no file handle for ' + path);
  return (await h.getFile()).text();
}

/** Change signature (modified time + size) of a workspace file, or null if unreadable. */
export async function fileSig(path: string): Promise<string | null> {
  try {
    if (isTauri) return (await invoke<string | null>('file_sig', { path })) ?? null;
    if (isApp(path)) return appSig(path);
    const h = handles.get(path);
    if (!h) return null;
    const f = await h.getFile();
    return `${f.lastModified}:${f.size}`;
  } catch { return null; }
}

/** Write text to a known path (Tauri: atomic; web: via a remembered file handle).
 *  Returns the file's new signature, or null if there is no target. */
export async function writeKnown(path: string, text: string): Promise<string | null> {
  if (isTauri) return invoke<string>('write_text', { path, text });
  if (isApp(path)) return appWrite(path, text);
  const h = handles.get(path);
  if (!h) return null;
  const w = await h.createWritable();
  await w.write(text);
  await w.close();
  return (await fileSig(path)) ?? '';
}

/** Ask for a save location and write. Returns the new path (or null if cancelled). */
export async function saveAs(defaultName: string, text: string, kind: 'workspace' | 'markdown'): Promise<string | null> {
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const p = await save({ defaultPath: defaultName, filters: kind === 'workspace' ? wsFilter : mdFilter });
    if (!p) return null;
    await invoke('write_text', { path: p, text });
    return p;
  }
  if (isAndroid) {
    if (kind === 'workspace') {
      const name = window.prompt('File name', defaultName);
      if (!name) return null;
      const path = 'app:docs/' + (name.toLowerCase().endsWith('.' + WS_EXT) ? name : name + '.' + WS_EXT).replace(/[^A-Za-z0-9._ -]+/g, '_');
      await appWrite(path, text);
      return path;
    }
    // Markdown export: hand the file to the Android share sheet (save to Files, send, ...).
    const { Filesystem, Directory, Encoding } = await fsApi();
    const f = await Filesystem.writeFile({ path: 'export/' + defaultName, directory: Directory.Cache, encoding: Encoding.UTF8, data: text, recursive: true });
    const { Share } = await import('@capacitor/share');
    try { await Share.share({ title: defaultName, files: [f.uri] }); } catch { return null; }
    return defaultName;
  }
  const w = window as any;
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({
        suggestedName: defaultName,
        types: [{ description: kind, accept: { 'text/plain': [kind === 'workspace' ? '.' + WS_EXT : '.md'] } }],
      });
      const key = 'web:' + h.name;
      handles.set(key, h);
      await writeKnown(key, text);
      return key;
    } catch { return null; }
  }
  download(defaultName, text);
  return kind === 'workspace' ? 'download:' + defaultName : defaultName;
}

export async function startupPath(): Promise<string | null> {
  if (!isTauri) return null;
  return (await invoke<string | null>('startup_arg')) ?? null;
}

export async function pathExists(path: string): Promise<boolean> {
  if (isApp(path)) return (await appSig(path)) !== null;
  return isTauri ? invoke<boolean>('path_exists', { path }) : false;
}

export async function setWindowTitle(title: string) {
  document.title = title;
  if (!isTauri) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().setTitle(title);
}

export async function confirmDialog(message: string, okLabel: string, cancelLabel: string): Promise<boolean> {
  if (isTauri) {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return ask(message, { title: 'promptpad', kind: 'warning', okLabel, cancelLabel });
  }
  return window.confirm(message);
}

/** Run handler before the window closes; handler resolves true to allow. */
export async function onCloseRequested(handler: () => Promise<boolean>, isDirty: () => boolean) {
  if (isTauri) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.onCloseRequested(async (e) => {
      e.preventDefault();
      if (await handler()) await win.destroy();
    });
  } else {
    window.addEventListener('beforeunload', (e) => {
      if (isDirty()) e.preventDefault();
    });
  }
}

export async function exitApp() {
  if (isTauri) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  } else window.close();
}

/** Download the exe at `url`, replace the running exe with it and restart (Windows exe only). */
export async function applyUpdate(url: string): Promise<void> {
  await invoke('apply_update', { url });
}

// ---- GitHub sign-in support ----

const TOKEN_LS = 'promptpad.ghtoken';

/** The GitHub token: OS credential store in the exe, browser storage in the web build. */
export async function getToken(): Promise<string | null> {
  try {
    if (isTauri) return (await invoke<string | null>('secret_get')) ?? null;
    return localStorage.getItem(TOKEN_LS); // Android: the WebView's private app storage
  } catch { return null; }
}

export async function setToken(token: string | null): Promise<void> {
  if (isTauri) {
    if (token) await invoke('secret_set', { value: token });
    else await invoke('secret_delete');
    return;
  }
  try {
    if (token) localStorage.setItem(TOKEN_LS, token);
    else localStorage.removeItem(TOKEN_LS);
  } catch { /* ignore */ }
}

/** POST JSON to a sign-in endpoint (those do not allow cross-origin requests, so the exe does it in Rust). */
export async function httpPostJson(url: string, body: string): Promise<string> {
  if (isTauri) return invoke<string>('http_post', { url, body });
  if (isAndroid) {
    // The native HTTP layer is not bound by CORS (the sign-in endpoints do not allow it).
    const { CapacitorHttp } = await import('@capacitor/core');
    const r = await CapacitorHttp.post({ url, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, data: JSON.parse(body) });
    return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  }
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body });
  return r.text();
}

export async function openUrl(url: string): Promise<void> {
  if (isTauri) await invoke('open_url', { url });
  else if (isAndroid) { const { Browser } = await import('@capacitor/browser'); await Browser.open({ url }); }
  else window.open(url, '_blank', 'noopener');
}

/** Where promptpad keeps the local copy of a workspace opened from GitHub (exe only). */
export async function managedPath(repo: string, branch: string, file: string): Promise<string | null> {
  const safe0 = (x: string) => x.replace(/[^A-Za-z0-9._-]+/g, '_');
  if (isAndroid) return `app:synced/${safe0(repo)}__${safe0(branch)}__${safe0(file)}`;
  if (!isTauri) return null;
  const { appLocalDataDir, join } = await import('@tauri-apps/api/path');
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');
  return join(await appLocalDataDir(), 'synced', `${safe(repo)}__${safe(branch)}__${safe(file)}`);
}

/** Android: run `cb` when the app goes to the background (it may be killed there, so push edits now). */
export async function onBackground(cb: () => void): Promise<void> {
  if (!isAndroid) return;
  const { App } = await import('@capacitor/app');
  await App.addListener('pause', cb);
}

/** Android: download the APK at `url` and open Android's installer. First time, send the user to the permission screen. */
export async function installApk(url: string): Promise<void> {
  const { registerPlugin } = await import('@capacitor/core');
  const A = registerPlugin<{ canInstall(): Promise<{ allowed: boolean }>; openPermissionSettings(): Promise<void>; install(o: { url: string }): Promise<void> }>('ApkInstaller');
  if (!(await A.canInstall()).allowed) {
    await A.openPermissionSettings();
    throw new Error('Allow promptpad to install updates on the screen that just opened, then come back and update again.');
  }
  await A.install({ url });
}

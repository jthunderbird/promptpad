// Platform layer: Tauri (Windows/Linux exe) or plain browser (fallback, same UI).
import { invoke } from '@tauri-apps/api/core';

export const isTauri = '__TAURI_INTERNALS__' in window;

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
  const h = handles.get(path);
  if (!h) throw new Error('no file handle for ' + path);
  return (await h.getFile()).text();
}

/** Change signature (modified time + size) of a workspace file, or null if unreadable. */
export async function fileSig(path: string): Promise<string | null> {
  try {
    if (isTauri) return (await invoke<string | null>('file_sig', { path })) ?? null;
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

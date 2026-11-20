#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod net;
mod update;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Cheap change signature of a file: modified time (ns) and size.
fn sig_of(path: &Path) -> Option<String> {
    let m = fs::metadata(path).ok()?;
    let t = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(format!("{}:{}", t.as_nanos(), m.len()))
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn file_sig(path: String) -> Option<String> {
    sig_of(Path::new(&path))
}

/// Atomic write: write a temp file beside the target, then rename over it.
/// Returns the new change signature so the caller can ignore its own write.
#[tauri::command]
fn write_text(path: String, text: String) -> Result<String, String> {
    let target = PathBuf::from(&path);
    if let Some(dir) = target.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let tmp = PathBuf::from(format!("{path}.tmp"));
    fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{}: {e}", target.display())
    })?;
    Ok(sig_of(&target).unwrap_or_default())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// First existing file argument (a workspace opened by double-click or CLI).
#[tauri::command]
fn startup_arg() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).is_file())
}

/// Download `url` to `dest` with PowerShell (present on every supported Windows, no extra dependency).
#[cfg(windows)]
fn fetch(url: &str, dest: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let q = |s: &str| s.replace('\'', "''");
    let script = format!(
        "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '{}' -OutFile '{}'",
        q(url),
        q(&dest.display().to_string())
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("cannot start PowerShell: {e}"))?;
    if !out.status.success() {
        return Err(format!("download failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

#[cfg(not(windows))]
fn fetch(_url: &str, _dest: &Path) -> Result<(), String> {
    Err("Self-update is only supported on Windows".into())
}

/// Download the new exe next to the running one and swap it in. Returns the path of the (new) exe.
fn download_and_swap(url: &str) -> Result<PathBuf, String> {
    if !update::url_ok(url) {
        return Err("refusing to download from that address".into());
    }
    let current = std::env::current_exe().map_err(|e| e.to_string())?;
    let new = update::sibling(&current, ".new");
    let _ = fs::remove_file(&new);
    if let Err(e) = fetch(url, &new) {
        let _ = fs::remove_file(&new);
        return Err(e);
    }
    if let Err(e) = update::looks_like_exe(&new, 1_000_000) {
        let _ = fs::remove_file(&new);
        return Err(e);
    }
    update::swap_in(&current, &new).inspect_err(|_| {
        let _ = fs::remove_file(&new);
    })?;
    Ok(current)
}

/// Replace this exe with the one at `url` and restart. Returns only on failure.
#[tauri::command]
async fn apply_update(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let exe = tauri::async_runtime::spawn_blocking(move || download_and_swap(&url))
        .await
        .map_err(|e| e.to_string())??;
    std::process::Command::new(&exe)
        .args(std::env::args().skip(1))
        .spawn()
        .map_err(|e| format!("updated, but could not restart: {e}"))?;
    app.exit(0);
    Ok(())
}

// ---- GitHub sign-in helpers ----

/// The GitHub token lives in the OS credential store (Windows Credential Manager).
fn secret_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("promptpad", "github-token").map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get() -> Result<Option<String>, String> {
    match secret_entry()?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_set(value: String) -> Result<(), String> {
    secret_entry()?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_delete() -> Result<(), String> {
    match secret_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// POST JSON to a GitHub device-flow endpoint and return the response body. Done here, not in the webview,
/// because those endpoints do not allow cross-origin requests. Uses PowerShell like the updater.
#[cfg(windows)]
fn post_json(url: &str, body: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let script = format!(
        "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; \
         $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri '{}' -Headers @{{Accept='application/json'}} -ContentType 'application/json' -Body '{}'; \
         [Console]::OutputEncoding=[Text.Encoding]::UTF8; $r.Content",
        net::ps_quote(url),
        net::ps_quote(body)
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| format!("cannot start PowerShell: {e}"))?;
    if !out.status.success() {
        return Err(format!("request failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(not(windows))]
fn post_json(_url: &str, _body: &str) -> Result<String, String> {
    Err("browser sign-in is only supported on Windows".into())
}

#[tauri::command]
async fn http_post(url: String, body: String) -> Result<String, String> {
    if !net::post_url_ok(&url) {
        return Err("refusing to post to that address".into());
    }
    tauri::async_runtime::spawn_blocking(move || post_json(&url, &body))
        .await
        .map_err(|e| e.to_string())?
}

/// Open a github.com page in the default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !net::open_url_ok(&url) {
        return Err("refusing to open that address".into());
    }
    #[cfg(windows)]
    let prog = "explorer";
    #[cfg(not(windows))]
    let prog = "xdg-open";
    std::process::Command::new(prog).arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn main() {
    if let Ok(exe) = std::env::current_exe() {
        update::cleanup(&exe);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_text,
            write_text,
            file_sig,
            path_exists,
            startup_arg,
            apply_update,
            secret_get,
            secret_set,
            secret_delete,
            http_post,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running promptpad");
}

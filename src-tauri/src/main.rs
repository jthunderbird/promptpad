#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_text,
            write_text,
            file_sig,
            path_exists,
            startup_arg
        ])
        .run(tauri::generate_context!())
        .expect("error while running promptpad");
}

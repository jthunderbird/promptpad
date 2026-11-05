//! Self-update helpers: validate the download URL, check the downloaded file, and swap it in place of the
//! running exe. Windows lets a running exe be renamed (not overwritten), so the swap is rename + rename.
//! Kept free of Tauri types so it can be unit tested on its own: `rustc --test src/update.rs`.
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const ALLOWED_PREFIX: &str = "https://github.com/jthunderbird/promptpad/releases/download/";

/// Only exe assets of this project's own releases, with nothing a shell could interpret.
pub fn url_ok(url: &str) -> bool {
    url.starts_with(ALLOWED_PREFIX)
        && url.ends_with(".exe")
        && !url
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '\'' | '"' | '`' | '$' | ';' | '&' | '|' | '<' | '>' | '^' | '%'))
}

/// `promptpad.exe` + ".old" -> `promptpad.exe.old`
pub fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// A downloaded Windows executable: at least `min` bytes and starts with "MZ".
pub fn looks_like_exe(path: &Path, min: u64) -> Result<(), String> {
    let meta = fs::metadata(path).map_err(|e| format!("downloaded file missing: {e}"))?;
    if meta.len() < min {
        return Err(format!("downloaded file is too small ({} bytes)", meta.len()));
    }
    let mut head = [0u8; 2];
    fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .map_err(|e| format!("cannot read downloaded file: {e}"))?;
    if &head != b"MZ" {
        return Err("downloaded file is not a Windows executable".into());
    }
    Ok(())
}

/// current -> current.old, new -> current. If the second step fails the first is undone.
pub fn swap_in(current: &Path, new: &Path) -> Result<(), String> {
    let old = sibling(current, ".old");
    let _ = fs::remove_file(&old);
    fs::rename(current, &old).map_err(|e| format!("cannot move the running exe aside (is the folder writable?): {e}"))?;
    if let Err(e) = fs::rename(new, current) {
        let _ = fs::rename(&old, current);
        return Err(format!("cannot put the new exe in place: {e}"));
    }
    Ok(())
}

/// Remove leftovers of a previous update. Best effort: the old file may still be locked.
pub fn cleanup(current: &Path) {
    let _ = fs::remove_file(sibling(current, ".old"));
    let _ = fs::remove_file(sibling(current, ".new"));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pp-update-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn url_rules() {
        assert!(url_ok("https://github.com/jthunderbird/promptpad/releases/download/v0.0.3/promptpad-0.0.3.exe"));
        assert!(!url_ok("https://github.com/evil/promptpad/releases/download/v1/promptpad-1.exe"));
        assert!(!url_ok("http://github.com/jthunderbird/promptpad/releases/download/v1/p.exe"));
        assert!(!url_ok("https://github.com/jthunderbird/promptpad/releases/download/v1/p.html"));
        assert!(!url_ok("https://github.com/jthunderbird/promptpad/releases/download/v1/p'; calc;'.exe"));
        assert!(!url_ok("https://github.com/jthunderbird/promptpad/releases/download/v1/a b.exe"));
        assert!(!url_ok("https://github.com/jthunderbird/promptpad/releases/download/v1/$(x).exe"));
    }

    #[test]
    fn exe_check() {
        let d = tmp("exe");
        let good = d.join("good.exe");
        let mut data = vec![0u8; 2000];
        data[0] = b'M';
        data[1] = b'Z';
        fs::write(&good, &data).unwrap();
        assert!(looks_like_exe(&good, 1000).is_ok());
        assert!(looks_like_exe(&good, 5000).is_err());
        let html = d.join("page.exe");
        fs::write(&html, vec![b'<'; 2000]).unwrap();
        assert!(looks_like_exe(&html, 1000).is_err());
        assert!(looks_like_exe(&d.join("missing.exe"), 1).is_err());
    }

    #[test]
    fn swap_and_cleanup() {
        let d = tmp("swap");
        let cur = d.join("promptpad.exe");
        let new = sibling(&cur, ".new");
        fs::write(&cur, b"OLD").unwrap();
        fs::write(&new, b"NEW").unwrap();
        swap_in(&cur, &new).unwrap();
        assert_eq!(fs::read(&cur).unwrap(), b"NEW");
        assert_eq!(fs::read(sibling(&cur, ".old")).unwrap(), b"OLD");
        assert!(!new.exists());
        // a second update replaces the previous .old
        fs::write(&new, b"NEWER").unwrap();
        swap_in(&cur, &new).unwrap();
        assert_eq!(fs::read(&cur).unwrap(), b"NEWER");
        assert_eq!(fs::read(sibling(&cur, ".old")).unwrap(), b"NEW");
        cleanup(&cur);
        assert!(!sibling(&cur, ".old").exists());
        assert_eq!(fs::read(&cur).unwrap(), b"NEWER");
    }

    /// The premise of self-update: Windows lets a running exe be renamed.
    #[cfg(windows)]
    #[test]
    fn swap_while_running() {
        let d = tmp("running");
        let fake = d.join("fake.exe");
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        fs::copy(format!("{sys}\\System32\\cmd.exe"), &fake).unwrap();
        let mut child = std::process::Command::new(&fake)
            .args(["/c", "ping -n 8 127.0.0.1 > nul"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(800));
        assert!(child.try_wait().unwrap().is_none(), "helper process exited early");
        let new = sibling(&fake, ".new");
        fs::write(&new, b"NEW").unwrap();
        let r = swap_in(&fake, &new);
        let _ = child.kill();
        let _ = child.wait();
        assert!(r.is_ok(), "{r:?}");
        assert_eq!(fs::read(&fake).unwrap(), b"NEW");
    }

    #[test]
    fn swap_failure_restores() {
        let d = tmp("fail");
        let cur = d.join("promptpad.exe");
        fs::write(&cur, b"OLD").unwrap();
        // new file does not exist: second rename fails, first is undone
        assert!(swap_in(&cur, &d.join("nope.new")).is_err());
        assert_eq!(fs::read(&cur).unwrap(), b"OLD");
        // current missing: cannot move aside
        assert!(swap_in(&d.join("ghost.exe"), &cur).is_err());
        assert_eq!(fs::read(&cur).unwrap(), b"OLD");
    }
}

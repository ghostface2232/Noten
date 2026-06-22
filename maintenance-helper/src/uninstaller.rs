use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use windows::Win32::System::Threading::CREATE_NO_WINDOW;

use crate::constants::{
    default_notes_dir, install_dir, roaming_app_dir, settings_path, APP_EXE_NAME, SETUP_EXE_NAME,
};

pub fn run_nsis_uninstall() {
    let uninstall_path = install_dir().join("uninstall.exe");
    if !uninstall_path.exists() {
        return;
    }

    match Command::new(&uninstall_path)
        .creation_flags(CREATE_NO_WINDOW.0)
        .arg("/S")
        .status()
    {
        Ok(status) if status.success() => {}
        Ok(status) => {
            eprintln!("[maintenance-helper] warning: uninstall.exe exited with status {status}");
        }
        Err(error) => {
            eprintln!(
                "[maintenance-helper] warning: failed to run {}: {error}",
                uninstall_path.display()
            );
        }
    }
}

pub fn remove_app_data(remove_user_data: bool) {
    let install_path = install_dir();
    if let Ok(entries) = fs::read_dir(&install_path) {
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    eprintln!(
                        "[maintenance-helper] warning: failed to enumerate install dir for {}: {error}",
                        APP_EXE_NAME
                    );
                    continue;
                }
            };

            let path = entry.path();
            let file_name = entry.file_name();
            if file_name
                .to_string_lossy()
                .eq_ignore_ascii_case(SETUP_EXE_NAME)
            {
                continue;
            }

            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    eprintln!(
                        "[maintenance-helper] warning: failed to inspect {}: {error}",
                        path.display()
                    );
                    continue;
                }
            };

            let result = if file_type.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            };

            if let Err(error) = result {
                eprintln!(
                    "[maintenance-helper] warning: failed to remove {}: {error}",
                    path.display()
                );
            }
        }
    }

    if !remove_user_data {
        return;
    }

    let roaming_path = roaming_app_dir();

    // Resolve and remove the notes directory first (settings.json lives inside
    // roaming_path, so it must still exist at this point).
    if let Some(notes_dir) = resolve_notes_dir() {
        if let Err(error) = remove_notes_dir_if_safe(&notes_dir, &[&roaming_path, &install_path]) {
            eprintln!("[maintenance-helper] warning: {error}");
        }
    }

    // Remove the roaming app data directory (settings, caches, etc.).
    if let Err(error) = remove_dir_if_safe(&roaming_path, &[&install_path]) {
        eprintln!("[maintenance-helper] warning: {error}");
    }
}

// Safe-deletion helpers (ported from bootstrapper/src/cleanup.rs)
fn resolve_notes_dir() -> Option<PathBuf> {
    let configured = read_notes_directory_setting().unwrap_or_default();
    let configured = configured.trim();
    if configured.is_empty() {
        Some(default_notes_dir())
    } else {
        let path = PathBuf::from(configured);
        path.is_absolute().then_some(path)
    }
}

fn read_notes_directory_setting() -> Option<String> {
    let raw = fs::read_to_string(settings_path()).ok()?;
    extract_json_string(&raw, "notesDirectory")
}

fn remove_dir_if_safe(path: &Path, additional_blocked: &[&Path]) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let resolved = canonical_dir(path)?;
    validate_delete_path(&resolved, additional_blocked)?;
    fs::remove_dir_all(&resolved)
        .map_err(|error| format!("failed to remove {}: {error}", resolved.display()))
}

fn remove_notes_dir_if_safe(path: &Path, additional_blocked: &[&Path]) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let resolved = canonical_dir(path)?;
    validate_delete_path(&resolved, additional_blocked)?;

    let default_notes = normalize_existing_or_raw(&default_notes_dir());
    let is_default_notes = normalize_path(&resolved) == default_notes;

    // Recognise both legacy (manifest.json) and current (.meta directory or
    // .groups.json sidecar) notes-directory markers. Without `.meta` in this
    // list, a fresh-install user with a custom notes path would never trip the
    // marker check (manifest.json is never written by current code) and the
    // uninstaller would silently refuse to delete the very data they opted
    // into removing.
    let has_legacy_manifest = resolved.join("manifest.json").is_file();
    let has_meta_dir = resolved.join(".meta").is_dir();
    let has_groups_sidecar = resolved.join(".groups.json").is_file();
    let looks_like_notes_dir = has_legacy_manifest || has_meta_dir || has_groups_sidecar;
    if !is_default_notes && !looks_like_notes_dir {
        return Err(format!(
            "refusing to delete custom notes directory without a recognised marker (.meta/, .groups.json, or manifest.json): {}",
            resolved.display()
        ));
    }

    if is_default_notes {
        // Noten's own dedicated folder — nothing else lives here, so removing it
        // wholesale is safe.
        return fs::remove_dir_all(&resolved)
            .map_err(|error| format!("failed to remove {}: {error}", resolved.display()));
    }

    // A custom folder may be one the user already kept other files in (they can
    // point Noten at any directory). Deleting it wholesale would take unrelated
    // files with it, so remove only Noten-owned artifacts and leave the rest —
    // including the directory itself when anything foreign remains.
    remove_noten_artifacts(&resolved);
    Ok(())
}

/// Remove only the files and folders Noten creates inside a notes directory,
/// leaving unrelated user files untouched. Best-effort: a failure on one item
/// is logged and the rest proceed. The directory itself is removed only if it
/// ends up empty (so a dedicated folder is cleaned up, but a shared one stays).
fn remove_noten_artifacts(dir: &Path) {
    // Note bodies are `{noteId}.md` with a primary sidecar at
    // `.meta/{noteId}.json`. Treat a root `*.md` as Noten's only when that
    // sidecar exists, so a foreign markdown file the user kept here survives.
    let meta_dir = dir.join(".meta");
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let is_md = path
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("md"))
                .unwrap_or(false);
            if !is_md {
                continue;
            }
            let Some(stem) = path.file_stem() else { continue };
            let sidecar = meta_dir.join(format!("{}.json", stem.to_string_lossy()));
            if sidecar.is_file() {
                remove_file_logged(&path);
            }
        }
    }

    // Structural artifacts that are unambiguously Noten's.
    for rel in [".meta", ".trash", ".conflicts", ".assets"] {
        let path = dir.join(rel);
        if path.is_dir() {
            if let Err(error) = fs::remove_dir_all(&path) {
                eprintln!(
                    "[maintenance-helper] warning: failed to remove {}: {error}",
                    path.display()
                );
            }
        }
    }
    for rel in [".groups.json", "manifest.json", "manifest.legacy.json"] {
        let path = dir.join(rel);
        if path.is_file() {
            remove_file_logged(&path);
        }
    }

    // Remove the directory only when nothing unrelated is left. A non-empty
    // error is the expected outcome for a shared folder — not a failure.
    match fs::remove_dir(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            eprintln!(
                "[maintenance-helper] note: kept {} (still contains non-Noten files)",
                dir.display()
            );
        }
    }
}

fn remove_file_logged(path: &Path) {
    if let Err(error) = fs::remove_file(path) {
        eprintln!(
            "[maintenance-helper] warning: failed to remove {}: {error}",
            path.display()
        );
    }
}

fn validate_delete_path(path: &Path, additional_blocked: &[&Path]) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!(
            "refusing to delete non-absolute path: {}",
            path.display()
        ));
    }

    let rendered = path.as_os_str().to_string_lossy().trim().to_string();
    if rendered.is_empty() {
        return Err("cleanup target is empty".to_string());
    }

    let components: Vec<Component<'_>> = path.components().collect();
    if components.is_empty() || path.parent().is_none() || components.len() <= 1 {
        return Err(format!("refusing to delete root path: {}", path.display()));
    }

    let protected = [
        std::env::var("APPDATA").ok().map(PathBuf::from),
        std::env::var("LOCALAPPDATA").ok().map(PathBuf::from),
        std::env::var("USERPROFILE").ok().map(PathBuf::from),
    ];

    for blocked in protected.into_iter().flatten().chain(
        additional_blocked
            .iter()
            .map(|path| normalize_existing_or_raw(path).into()),
    ) {
        if same_path(path, blocked.as_path()) {
            return Err(format!(
                "refusing to delete protected path: {}",
                path.display()
            ));
        }
    }

    Ok(())
}

fn same_path(left: &Path, right: &Path) -> bool {
    normalize_path(left) == normalize_path(right)
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn canonical_dir(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|error| format!("failed to resolve {}: {error}", path.display()))
}

fn normalize_existing_or_raw(path: &Path) -> String {
    match fs::canonicalize(path) {
        Ok(resolved) => normalize_path(&resolved),
        Err(_) => normalize_path(path),
    }
}

fn extract_json_string(raw: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let key_index = raw.find(&needle)?;
    let after_key = &raw[key_index + needle.len()..];
    let colon_index = after_key.find(':')?;
    let mut chars = after_key[colon_index + 1..].chars().peekable();

    while matches!(chars.peek(), Some(ch) if ch.is_whitespace()) {
        chars.next();
    }
    if chars.next()? != '"' {
        return None;
    }

    let mut escaped = false;
    let mut value = String::new();
    for ch in chars {
        if escaped {
            value.push(match ch {
                '"' => '"',
                '\\' => '\\',
                '/' => '/',
                'b' => '\u{0008}',
                'f' => '\u{000C}',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
            escaped = false;
            continue;
        }

        if ch == '\\' {
            escaped = true;
            continue;
        }

        if ch == '"' {
            return Some(value);
        }

        value.push(ch);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "noten-uninstall-test-{}-{nanos}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    #[test]
    fn removes_noten_artifacts_but_keeps_foreign_files() {
        let dir = temp_dir();
        let id = "11111111-1111-1111-1111-111111111111";
        write(&dir.join(format!("{id}.md")), "note body");
        write(&dir.join(".meta").join(format!("{id}.json")), "{}");
        write(
            &dir.join(".trash")
                .join("22222222-2222-2222-2222-222222222222.md"),
            "trashed",
        );
        write(&dir.join(".conflicts").join("c.md"), "conflict");
        write(&dir.join(".assets").join(id).join("img.png"), "png");
        write(&dir.join(".groups.json"), "[]");
        write(&dir.join("manifest.legacy.json"), "{\"notes\":[]}");
        // Unrelated user data that must survive an uninstall.
        write(&dir.join("budget.xlsx"), "spreadsheet");
        write(&dir.join("notes-i-wrote.md"), "foreign markdown, no sidecar");
        write(&dir.join("photos").join("vacation.jpg"), "jpg");

        remove_noten_artifacts(&dir);

        // Noten artifacts are gone.
        assert!(!dir.join(format!("{id}.md")).exists());
        assert!(!dir.join(".meta").exists());
        assert!(!dir.join(".trash").exists());
        assert!(!dir.join(".conflicts").exists());
        assert!(!dir.join(".assets").exists());
        assert!(!dir.join(".groups.json").exists());
        assert!(!dir.join("manifest.legacy.json").exists());
        // Foreign files — and the directory itself — are preserved.
        assert!(dir.join("budget.xlsx").is_file());
        assert!(dir.join("notes-i-wrote.md").is_file());
        assert!(dir.join("photos").join("vacation.jpg").is_file());
        assert!(dir.exists());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn removes_the_directory_when_only_noten_data_remains() {
        let dir = temp_dir();
        let id = "33333333-3333-3333-3333-333333333333";
        write(&dir.join(format!("{id}.md")), "body");
        write(&dir.join(".meta").join(format!("{id}.json")), "{}");
        write(&dir.join(".groups.json"), "[]");

        remove_noten_artifacts(&dir);

        // A dedicated folder ends up empty and is removed.
        assert!(!dir.exists());
    }

    #[test]
    fn keeps_markdown_without_a_meta_sidecar() {
        let dir = temp_dir();
        write(&dir.join("README.md"), "user readme, not a Noten note");

        remove_noten_artifacts(&dir);

        assert!(dir.join("README.md").is_file());
        assert!(dir.exists());

        fs::remove_dir_all(&dir).ok();
    }
}

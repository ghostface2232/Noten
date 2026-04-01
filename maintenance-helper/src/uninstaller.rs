use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use crate::constants::{
    default_notes_dir, install_dir, roaming_app_dir, settings_path, APP_EXE_NAME, SETUP_EXE_NAME,
};

pub fn run_nsis_uninstall() {
    let uninstall_path = install_dir().join("uninstall.exe");
    if !uninstall_path.exists() {
        return;
    }

    match Command::new(&uninstall_path).arg("/S").status() {
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

// ---------------------------------------------------------------------------
// Safe-deletion helpers (ported from bootstrapper/src/cleanup.rs)
// ---------------------------------------------------------------------------

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
    if !is_default_notes && !resolved.join("manifest.json").is_file() {
        return Err(format!(
            "refusing to delete custom notes directory without manifest.json: {}",
            resolved.display()
        ));
    }

    fs::remove_dir_all(&resolved)
        .map_err(|error| format!("failed to remove {}: {error}", resolved.display()))
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

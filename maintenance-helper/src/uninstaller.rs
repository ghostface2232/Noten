use std::fs;
use std::process::Command;

use crate::constants::{APP_EXE_NAME, SETUP_EXE_NAME, install_dir, roaming_app_dir};

pub fn run_nsis_uninstall() {
    let uninstall_path = install_dir().join("uninstall.exe");
    if !uninstall_path.exists() {
        return;
    }

    match Command::new(&uninstall_path).arg("/S").status() {
        Ok(status) if status.success() => {}
        Ok(status) => {
            eprintln!(
                "[maintenance-helper] warning: uninstall.exe exited with status {status}"
            );
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
            if file_name.to_string_lossy().eq_ignore_ascii_case(SETUP_EXE_NAME) {
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
    if roaming_path.exists() {
        if let Err(error) = fs::remove_dir_all(&roaming_path) {
            eprintln!(
                "[maintenance-helper] warning: failed to remove {}: {error}",
                roaming_path.display()
            );
        }
    }
}

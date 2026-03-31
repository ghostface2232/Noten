use std::env;
use std::fs;
use std::process::Command;

use crate::constants::{APP_EXE_NAME, NSIS_TEMP_NAME, SETUP_EXE_NAME, install_dir};

const NSIS_BYTES: &[u8] = include_bytes!("../assets/nsis-payload.exe");

pub fn extract_and_run_nsis() -> Result<(), String> {
    let temp_path = env::temp_dir().join(NSIS_TEMP_NAME);
    fs::write(&temp_path, NSIS_BYTES)
        .map_err(|error| format!("failed to write NSIS payload: {error}"))?;

    let status = Command::new(&temp_path)
        .arg("/S")
        .status()
        .map_err(|error| format!("failed to run NSIS payload: {error}"))?;

    let _ = fs::remove_file(&temp_path);

    if !status.success() {
        return Err(format!("NSIS payload failed with status: {status}"));
    }

    Ok(())
}

pub fn run_uninstall() -> Result<(), String> {
    let uninstall_path = install_dir().join("uninstall.exe");
    if !uninstall_path.exists() {
        return Err(format!(
            "uninstall.exe not found at {}",
            uninstall_path.display()
        ));
    }

    let status = Command::new(uninstall_path)
        .arg("/S")
        .status()
        .map_err(|error| format!("failed to run uninstall.exe: {error}"))?;

    if !status.success() {
        return Err(format!("uninstall.exe failed with status: {status}"));
    }

    Ok(())
}

pub fn copy_bootstrapper_to_install_dir() -> Result<(), String> {
    let current_exe = env::current_exe()
        .map_err(|error| format!("failed to resolve current executable: {error}"))?;
    let target_dir = install_dir();
    fs::create_dir_all(&target_dir)
        .map_err(|error| format!("failed to create install directory: {error}"))?;

    let target_path = target_dir.join(SETUP_EXE_NAME);
    fs::copy(current_exe, target_path)
        .map_err(|error| format!("failed to copy bootstrapper: {error}"))?;
    Ok(())
}

pub fn launch_app() {
    let app_path = install_dir().join(APP_EXE_NAME);
    let _ = Command::new(app_path).spawn();
}

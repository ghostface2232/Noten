use std::env;
use std::fs;
use std::os::windows::process::CommandExt;
use std::process::Command;

use crate::constants::{APP_EXE_NAME, NSIS_TEMP_NAME, install_dir};
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

const NSIS_BYTES: &[u8] = include_bytes!("../assets/nsis-payload.exe");

pub fn extract_and_run_nsis() -> Result<(), String> {
    let temp_path = env::temp_dir().join(NSIS_TEMP_NAME);
    fs::write(&temp_path, NSIS_BYTES)
        .map_err(|error| format!("failed to write NSIS payload: {error}"))?;

    let status = Command::new(&temp_path)
        .creation_flags(CREATE_NO_WINDOW.0)
        .arg("/S")
        .status()
        .map_err(|error| format!("failed to run NSIS payload: {error}"))?;

    let _ = fs::remove_file(&temp_path);

    if !status.success() {
        return Err(format!("NSIS payload failed with status: {status}"));
    }

    Ok(())
}
pub fn launch_app() {
    let app_path = install_dir().join(APP_EXE_NAME);
    let _ = Command::new(app_path)
        .creation_flags(CREATE_NO_WINDOW.0)
        .spawn();
}

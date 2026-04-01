use std::path::PathBuf;

pub const PRODUCT_NAME: &str = "Noten";
pub const APP_EXE_NAME: &str = "Noten.exe";
pub const NSIS_TEMP_NAME: &str = "Noten_silent_setup.exe";
pub const UNINSTALL_REG_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Noten";

pub fn install_dir() -> PathBuf {
    let local_app_data = std::env::var("LOCALAPPDATA").expect("LOCALAPPDATA not set");
    PathBuf::from(local_app_data).join(PRODUCT_NAME)
}

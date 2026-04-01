use std::path::PathBuf;

pub const PRODUCT_NAME: &str = "Noten";
pub const APP_IDENTIFIER: &str = "com.noten.app";
pub const APP_EXE_NAME: &str = "Noten.exe";
pub const SETUP_EXE_NAME: &str = "maintenance-helper.exe";
pub const UNINSTALL_REG_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Noten";

pub fn install_dir() -> PathBuf {
    let local_app_data = std::env::var("LOCALAPPDATA").expect("LOCALAPPDATA not set");
    PathBuf::from(local_app_data).join(PRODUCT_NAME)
}

pub fn roaming_app_dir() -> PathBuf {
    let app_data = std::env::var("APPDATA").expect("APPDATA not set");
    PathBuf::from(app_data).join(APP_IDENTIFIER)
}

pub fn settings_path() -> PathBuf {
    roaming_app_dir().join("settings.json")
}

pub fn default_notes_dir() -> PathBuf {
    roaming_app_dir().join("notes")
}

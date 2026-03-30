use std::mem::size_of;
use std::slice;

use windows::core::PCWSTR;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_SZ, RegCloseKey, RegOpenKeyExW, RegSetValueExW,
};

use crate::constants::{SETUP_EXE_NAME, UNINSTALL_REG_KEY, install_dir};

pub fn fix_uninstall_string() {
    unsafe {
        let uninstall_path = install_dir().join(SETUP_EXE_NAME);
        let uninstall_string = format!("\"{}\" --uninstall", uninstall_path.display());

        let mut subkey: Vec<u16> = UNINSTALL_REG_KEY.encode_utf16().collect();
        subkey.push(0);

        let mut key = HKEY::default();
        let open_status = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            Some(0),
            KEY_SET_VALUE,
            &mut key,
        );
        if open_status != ERROR_SUCCESS {
            panic!("failed to open uninstall registry key: {open_status:?}");
        }

        let mut set_status = set_reg_sz(key, "UninstallString", &uninstall_string);
        if set_status == ERROR_SUCCESS {
            set_status = set_reg_sz(key, "QuietUninstallString", &uninstall_string);
        }
        let _ = RegCloseKey(key);

        if set_status != ERROR_SUCCESS {
            panic!("failed to set uninstall registry values: {set_status:?}");
        }
    }
}

unsafe fn set_reg_sz(key: HKEY, name: &str, value: &str) -> windows::Win32::Foundation::WIN32_ERROR {
    let mut value_name: Vec<u16> = name.encode_utf16().collect();
    value_name.push(0);

    let mut value_data: Vec<u16> = value.encode_utf16().collect();
    value_data.push(0);

    let data_bytes = unsafe {
        slice::from_raw_parts(
            value_data.as_ptr() as *const u8,
            value_data.len() * size_of::<u16>(),
        )
    };

    unsafe {
        RegSetValueExW(
            key,
            PCWSTR(value_name.as_ptr()),
            Some(0),
            REG_SZ,
            Some(data_bytes),
        )
    }
}

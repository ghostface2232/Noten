use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RegDeleteKeyW};
use windows::core::PCWSTR;

use crate::constants::UNINSTALL_REG_KEY;

pub fn remove_uninstall_registry() -> Result<(), String> {
    unsafe {
        let mut subkey: Vec<u16> = UNINSTALL_REG_KEY.encode_utf16().collect();
        subkey.push(0);

        let status = RegDeleteKeyW(HKEY_CURRENT_USER, PCWSTR(subkey.as_ptr()));
        if status != ERROR_SUCCESS {
            return Err(format!(
                "failed to delete uninstall registry key: {status:?}"
            ));
        }
    }

    Ok(())
}

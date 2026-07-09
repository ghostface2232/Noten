use std::env;
use std::fs;
use std::io;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager, Runtime, path::BaseDirectory};

const CREATE_NO_WINDOW_FLAG: u32 = 0x08000000;
const INPUT_KEYBOARD: u32 = 1;
const KEYEVENTF_KEYUP: u32 = 0x0002;
const VK_LWIN: u16 = 0x5B;
const VK_OEM_PERIOD: u16 = 0xBE;

#[repr(C)]
#[derive(Clone, Copy)]
struct KeybdInput {
    w_vk: u16,
    w_scan: u16,
    dw_flags: u32,
    time: u32,
    dw_extra_info: usize,
}

#[repr(C)]
union InputUnion {
    ki: KeybdInput,
}

#[repr(C)]
struct Input {
    input_type: u32,
    union: InputUnion,
}

extern "system" {
    fn SendInput(c_inputs: u32, p_inputs: *const Input, cb_size: i32) -> u32;
}

#[tauri::command]
fn toggle_devtools<R: Runtime>(window: tauri::WebviewWindow<R>) {
    // `open_devtools` / `close_devtools` compile only in debug builds or when
    // the `devtools` Cargo feature is enabled; production release builds keep
    // the devtools surface stripped from the binary.
    #[cfg(any(debug_assertions, feature = "devtools"))]
    {
        if window.is_devtools_open() {
            window.close_devtools();
        } else {
            window.open_devtools();
        }
    }
    #[cfg(not(any(debug_assertions, feature = "devtools")))]
    {
        let _ = window;
    }
}

#[tauri::command]
async fn print_to_pdf(html: String, output_path: String) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let temp_html = temp_dir.join("noten_print_preview.html");
    fs::write(&temp_html, &html).map_err(|e| format!("Failed to write temp HTML: {e}"))?;

    let edge_paths = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ];

    let edge_path = edge_paths
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .ok_or_else(|| "Microsoft Edge not found".to_string())?;

    let temp_html_url = format!("file:///{}", temp_html.to_string_lossy().replace('\\', "/"));
    let print_arg = format!("--print-to-pdf={}", output_path);

    let output = Command::new(edge_path)
        .args([
            "--headless",
            "--disable-gpu",
            "--no-pdf-header-footer",
            "--run-all-compositor-stages-before-draw",
            &print_arg,
            &temp_html_url,
        ])
        .output()
        .map_err(|e| format!("Failed to run Edge: {e}"))?;

    let _ = fs::remove_file(&temp_html);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Edge PDF generation failed: {stderr}"));
    }

    Ok(())
}

fn reg_add_value(reg_key: &str, value_name: &str, value_data: &str) -> Result<(), String> {
    let output = Command::new("reg.exe")
        .creation_flags(CREATE_NO_WINDOW_FLAG)
        .args([
            "add",
            reg_key,
            "/v",
            value_name,
            "/t",
            "REG_SZ",
            "/d",
            value_data,
            "/f",
        ])
        .output()
        .map_err(|e| format!("failed to run reg.exe add: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

fn parse_reg_dword(stdout: &str, value_name: &str) -> Result<Option<u32>, String> {
    let value_name_lower = value_name.to_ascii_lowercase();
    for line in stdout.lines() {
        let trimmed = line.trim();
        let mut parts = trimmed.split_whitespace();
        let Some(name) = parts.next() else {
            continue;
        };
        if name.to_ascii_lowercase() != value_name_lower {
            continue;
        }
        let Some(kind) = parts.next() else {
            continue;
        };
        if !kind.eq_ignore_ascii_case("REG_DWORD") {
            continue;
        }
        let Some(raw_value) = parts.next() else {
            return Err(format!("missing REG_DWORD data for {value_name}"));
        };
        let value = if let Some(hex) = raw_value.strip_prefix("0x").or_else(|| raw_value.strip_prefix("0X")) {
            u32::from_str_radix(hex, 16)
        } else {
            raw_value.parse::<u32>()
        }
        .map_err(|e| format!("invalid REG_DWORD data for {value_name}: {e}"))?;
        return Ok(Some(value));
    }
    Ok(None)
}

fn reg_query_dword(reg_key: &str, value_name: &str) -> Result<Option<u32>, String> {
    let output = Command::new("reg.exe")
        .creation_flags(CREATE_NO_WINDOW_FLAG)
        .args(["query", reg_key, "/v", value_name])
        .output()
        .map_err(|e| format!("failed to run reg.exe query: {e}"))?;

    if !output.status.success() {
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_reg_dword(&stdout, value_name)
}

#[tauri::command]
fn get_windows_app_theme() -> Result<Option<&'static str>, String> {
    let value = reg_query_dword(
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
        "AppsUseLightTheme",
    )?;
    Ok(value.map(|v| if v == 0 { "dark" } else { "light" }))
}

fn keyboard_input(vk: u16, flags: u32) -> Input {
    Input {
        input_type: INPUT_KEYBOARD,
        union: InputUnion {
            ki: KeybdInput {
                w_vk: vk,
                w_scan: 0,
                dw_flags: flags,
                time: 0,
                dw_extra_info: 0,
            },
        },
    }
}

#[tauri::command]
fn open_windows_emoji_picker() -> Result<(), String> {
    let inputs = [
        keyboard_input(VK_LWIN, 0),
        keyboard_input(VK_OEM_PERIOD, 0),
        keyboard_input(VK_OEM_PERIOD, KEYEVENTF_KEYUP),
        keyboard_input(VK_LWIN, KEYEVENTF_KEYUP),
    ];

    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<Input>() as i32,
        )
    };

    if sent == inputs.len() as u32 {
        Ok(())
    } else {
        Err(format!(
            "failed to open Windows emoji picker: {}",
            io::Error::last_os_error()
        ))
    }
}

fn ensure_maintenance_helper<R: Runtime>(app_handle: AppHandle<R>) {
    let Ok(resource_helper_path) =
        app_handle
            .path()
            .resolve("maintenance-helper.exe", BaseDirectory::Resource)
    else {
        return;
    };

    let Ok(local_app_data) = env::var("LOCALAPPDATA") else {
        return;
    };

    let target_dir = PathBuf::from(local_app_data).join("Noten");
    if let Err(err) = fs::create_dir_all(&target_dir) {
        eprintln!("failed to create maintenance helper directory: {err}");
        return;
    }

    let target_helper_path = target_dir.join("maintenance-helper.exe");
    if let Err(err) = fs::copy(&resource_helper_path, &target_helper_path) {
        eprintln!(
            "failed to copy maintenance-helper.exe to {}: {err}",
            target_helper_path.display()
        );
    }

    let uninstall_string = format!("\"{}\" --uninstall", target_helper_path.display());
    let reg_key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Noten";

    if let Err(err) = reg_add_value(reg_key, "UninstallString", &uninstall_string) {
        eprintln!("failed to repair UninstallString: {err}");
    }

    if let Err(err) = reg_add_value(reg_key, "QuietUninstallString", &uninstall_string) {
        eprintln!("failed to repair QuietUninstallString: {err}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            print_to_pdf,
            toggle_devtools,
            get_windows_app_theme,
            open_windows_emoji_picker
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            std::thread::spawn(move || ensure_maintenance_helper(app_handle));

            // Mica is applied by tauri.conf.json windowEffects and frontend setEffects().
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::parse_reg_dword;

    #[test]
    fn parse_reg_dword_reads_hex_theme_value() {
        let output = r#"
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize
    AppsUseLightTheme    REG_DWORD    0x0
"#;

        assert_eq!(parse_reg_dword(output, "AppsUseLightTheme").unwrap(), Some(0));
    }

    #[test]
    fn parse_reg_dword_reads_decimal_theme_value() {
        let output = r#"
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize
    AppsUseLightTheme    REG_DWORD    1
"#;

        assert_eq!(parse_reg_dword(output, "AppsUseLightTheme").unwrap(), Some(1));
    }
}

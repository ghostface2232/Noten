use std::env;
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use tauri::{Listener, Manager};

const CREATE_NO_WINDOW_FLAG: u32 = 0x08000000;

#[tauri::command]
async fn print_to_pdf(html: String, output_path: String) -> Result<(), String> {
    // Write HTML to a temp file
    let temp_dir = std::env::temp_dir();
    let temp_html = temp_dir.join("noten_print_preview.html");
    fs::write(&temp_html, &html).map_err(|e| format!("Failed to write temp HTML: {e}"))?;

    // Find Edge executable
    let edge_paths = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ];

    let edge_path = edge_paths
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .ok_or_else(|| "Microsoft Edge not found".to_string())?;

    // Run Edge headless to generate PDF
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

    // Clean up temp file
    let _ = fs::remove_file(&temp_html);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Edge PDF generation failed: {stderr}"));
    }

    Ok(())
}

fn resolve_bootstrapper_path() -> Option<PathBuf> {
    if let Ok(current_exe) = env::current_exe() {
        if let Some(dir) = current_exe.parent() {
            let path = dir.join("noten-setup.exe");
            if path.exists() {
                return Some(path);
            }
        }
    }

    let Ok(local_app_data) = env::var("LOCALAPPDATA") else {
        return None;
    };

    let path = PathBuf::from(local_app_data)
        .join("Noten")
        .join("noten-setup.exe");
    path.exists().then_some(path)
}

fn reg_query_value(reg_key: &str, value_name: &str) -> Option<String> {
    let output = Command::new("reg.exe")
        .creation_flags(CREATE_NO_WINDOW_FLAG)
        .args(["query", reg_key, "/v", value_name])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    Some(String::from_utf8_lossy(&output.stdout).into_owned())
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

fn ensure_bootstrapper_uninstall_string() {
    let Some(bootstrapper_path) = resolve_bootstrapper_path() else {
        return;
    };

    if !bootstrapper_path.exists() {
        return;
    }

    let uninstall_string = format!("\"{}\" --uninstall", bootstrapper_path.display());
    let expected = uninstall_string.to_ascii_lowercase();
    let reg_key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Noten";

    let uninstall_ok = reg_query_value(reg_key, "UninstallString")
        .map(|value| value.to_ascii_lowercase().contains(&expected))
        .unwrap_or(false);
    let quiet_uninstall_ok = reg_query_value(reg_key, "QuietUninstallString")
        .map(|value| value.to_ascii_lowercase().contains(&expected))
        .unwrap_or(false);

    if uninstall_ok && quiet_uninstall_ok {
        return;
    }

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
        .invoke_handler(tauri::generate_handler![print_to_pdf])
        .setup(|app| {
            std::thread::spawn(ensure_bootstrapper_uninstall_string);

            // Apply Mica to all existing windows
            for (_, window) in app.webview_windows() {
                let _ = window.set_effects(tauri::utils::config::WindowEffectsConfig {
                    effects: vec![tauri::window::Effect::Mica],
                    state: None,
                    radius: None,
                    color: None,
                });
            }

            // Apply Mica to dynamically created windows
            let app_handle = app.handle().clone();
            app.listen("tauri://webview-created", move |_event| {
                for (_, window) in app_handle.webview_windows() {
                    let _ = window.set_effects(tauri::utils::config::WindowEffectsConfig {
                        effects: vec![tauri::window::Effect::Mica],
                        state: None,
                        radius: None,
                        color: None,
                    });
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

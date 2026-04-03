use std::env;
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager, Runtime, path::BaseDirectory};

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
        .invoke_handler(tauri::generate_handler![print_to_pdf])
        .setup(|app| {
            let app_handle = app.handle().clone();
            std::thread::spawn(move || ensure_maintenance_helper(app_handle));

            // Mica는 tauri.conf.json의 windowEffects와 프론트엔드의
            // setEffects() 호출로 적용됨 — 여기서 중복 적용하지 않음
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

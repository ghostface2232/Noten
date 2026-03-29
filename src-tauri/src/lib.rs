use std::fs;
use std::process::Command;
use tauri::{Listener, Manager};

#[tauri::command]
async fn print_to_pdf(html: String, output_path: String) -> Result<(), String> {
    // Write HTML to a temp file
    let temp_dir = std::env::temp_dir();
    let temp_html = temp_dir.join("aa_print_preview.html");
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![print_to_pdf])
        .setup(|app| {
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

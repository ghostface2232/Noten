use std::env;
use std::fs;
use std::io;
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{path::BaseDirectory, AppHandle, Manager, Runtime};
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND};
use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_LWIN, VK_OEM_PERIOD,
};

const CREATE_NO_WINDOW_FLAG: u32 = 0x08000000;

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

// Headless Edge occasionally wedges (GPU/profile lock, another instance mid-
// shutdown). Without a bound the command future never resolves and the export
// UI waits forever, so cap the run and kill the child instead.
const PDF_RENDER_TIMEOUT: Duration = Duration::from_secs(90);
const PDF_POLL_INTERVAL: Duration = Duration::from_millis(50);
const PDF_EXIT_GRACE: Duration = Duration::from_secs(2);

/// Removes `dir`, retrying for up to 2 s: Edge's child processes can still
/// hold files in its profile briefly after the browser process has gone.
fn remove_dir_when_released(dir: &Path) {
    for _ in 0..20 {
        match fs::remove_dir_all(dir) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => {
                std::thread::sleep(PDF_POLL_INTERVAL * 2)
            }
            _ => return,
        }
    }
}

// Per-invocation temp file stem. A fixed name let two windows exporting at the
// same time overwrite each other's HTML, so one PDF rendered the other note's
// body. Process id plus a monotonic counter keeps concurrent exports apart
// within a process and across the multi-window instances of the app.
fn print_temp_stem() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("noten_print_{}_{}_{}", std::process::id(), nanos, seq)
}

#[tauri::command]
async fn print_to_pdf(html: String, output_path: String) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let stem = print_temp_stem();
    let temp_html = temp_dir.join(format!("{stem}.html"));
    // Edge's stderr goes to a file rather than a pipe: nothing reads the pipe
    // while we poll for exit, so a chatty child could fill the buffer, block,
    // and be killed by the timeout below.
    let temp_err = temp_dir.join(format!("{stem}.log"));
    // Edge prints to a fresh temp path so the file's appearance means this run
    // wrote it; the user's file is replaced only once the PDF is complete.
    let temp_pdf = temp_dir.join(format!("{stem}.pdf"));
    // Edge's own profile for this run. Without one, headless Edge made a
    // %TEMP%\HeadlessEdge<N> folder per export and never removed it (46 of
    // them, 3 GB, mostly components it had downloaded while printing).
    let temp_profile = temp_dir.join(format!("{stem}_profile"));

    fs::write(&temp_html, &html).map_err(|e| format!("Failed to write temp HTML: {e}"))?;

    // Every early return past this point must clear the temp files — they hold
    // the full note body in plain text. Edge must have exited by then, or its
    // profile folder is still in use.
    let cleanup = || {
        let _ = fs::remove_file(&temp_html);
        let _ = fs::remove_file(&temp_err);
        let _ = fs::remove_file(&temp_pdf);
        remove_dir_when_released(&temp_profile);
    };

    let edge_paths = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ];

    let Some(edge_path) = edge_paths
        .iter()
        .find(|p| std::path::Path::new(p).exists())
    else {
        cleanup();
        return Err("Microsoft Edge not found".to_string());
    };

    let temp_html_url = format!("file:///{}", temp_html.to_string_lossy().replace('\\', "/"));
    let print_arg = format!("--print-to-pdf={}", temp_pdf.to_string_lossy());
    let profile_arg = format!("--user-data-dir={}", temp_profile.to_string_lossy());

    let stderr_sink = match fs::File::create(&temp_err) {
        Ok(file) => Stdio::from(file),
        Err(_) => Stdio::null(),
    };

    let spawned = Command::new(edge_path)
        .args([
            "--headless",
            "--disable-gpu",
            "--no-pdf-header-footer",
            "--run-all-compositor-stages-before-draw",
            &profile_arg,
            // Printing needs none of Edge's background work; with it Edge
            // synced the signed-in account and fetched extensions and
            // components while it printed.
            "--disable-extensions",
            "--disable-sync",
            "--disable-background-networking",
            "--disable-component-update",
            "--no-first-run",
            &print_arg,
            &temp_html_url,
        ])
        .stdout(Stdio::null())
        .stderr(stderr_sink)
        .spawn();

    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => {
            cleanup();
            return Err(format!("Failed to run Edge: {e}"));
        }
    };

    let deadline = Instant::now() + PDF_RENDER_TIMEOUT;
    let exit = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            // Edge can write the whole PDF and then not exit (a 300-image note
            // was done in ~60 s and still running at 240 s); the timeout below
            // must not throw that finished file away.
            Ok(None) if is_written_file(&temp_pdf) => {
                // It normally exits ~0.2 s after closing the file; a killed
                // Edge leaves its child processes to wind down on their own.
                let grace = Instant::now() + PDF_EXIT_GRACE;
                while Instant::now() < grace && matches!(child.try_wait(), Ok(None)) {
                    std::thread::sleep(PDF_POLL_INTERVAL);
                }
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let stderr = fs::read_to_string(&temp_err).unwrap_or_default();
                    cleanup();
                    return Err(format!(
                        "Edge PDF generation timed out after {}s{}",
                        PDF_RENDER_TIMEOUT.as_secs(),
                        failure_reason(&stderr)
                    ));
                }
                std::thread::sleep(PDF_POLL_INTERVAL);
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                cleanup();
                return Err(format!("Failed to wait for Edge: {e}"));
            }
        }
    };

    if exit.is_some_and(|status| !status.success()) {
        let stderr = fs::read_to_string(&temp_err).unwrap_or_default();
        cleanup();
        return Err(format!("Edge PDF generation failed: {stderr}"));
    }

    // A successful exit does not mean the PDF exists: the launched msedge.exe
    // can hand the job to another Edge process and exit at once (seen while an
    // Edge update was pending), and that process renders later. Deleting the
    // HTML now made it print its "file not found" page instead of the note, so
    // keep everything until the PDF has been written and closed. An Edge that
    // exited because its renderer crashed will write nothing, so say why now.
    let stderr = fs::read_to_string(&temp_err).unwrap_or_default();
    if !is_written_file(&temp_pdf) && stderr.contains(RENDERER_CRASH) {
        cleanup();
        let reason = failure_reason(&stderr);
        return Err(format!("Edge could not print the note{reason}"));
    }
    if !wait_for_written_file(&temp_pdf, deadline, PDF_POLL_INTERVAL) {
        let stderr = fs::read_to_string(&temp_err).unwrap_or_default();
        cleanup();
        return Err(format!("Edge exited without writing the PDF: {stderr}"));
    }

    // Copy rather than rename: a renamed file would keep %TEMP%'s owner-only
    // permissions instead of inheriting the target folder's, as Edge's own
    // file did when it printed there directly.
    let saved = fs::copy(&temp_pdf, &output_path);
    cleanup();
    saved
        .map(|_| ())
        .map_err(|e| format!("Failed to save the PDF: {e}"))
}

/// What Edge 153 logs when a renderer dies, e.g. out of memory: a note with
/// ~500 MB of images needed ~10 GB. Edge then exits without a PDF or, with the
/// default profile, hangs until the timeout.
const RENDERER_CRASH: &str = "Abnormal renderer termination";

/// Why a run failed, when Edge's log says. The message is only a hint, so an
/// Edge release that rewords its log just loses the explanation.
fn failure_reason(stderr: &str) -> &'static str {
    if stderr.contains(RENDERER_CRASH) {
        ": Edge's renderer crashed, most likely out of memory. The note may have too many or too large images to print at once."
    } else {
        ""
    }
}

/// Whether `path` exists, is non-empty and no process holds it open: an
/// exclusive open succeeds only after the writer has closed its handle.
fn is_written_file(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    fs::metadata(path).map(|m| m.len() > 0).unwrap_or(false)
        && fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(path)
            .is_ok()
}

/// Waits until `path` is a written file (`is_written_file`) or `deadline`
/// passes. Returns whether the file is complete.
fn wait_for_written_file(path: &Path, deadline: Instant, poll: Duration) -> bool {
    loop {
        if is_written_file(path) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(poll);
    }
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

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn reg_query_current_user_dword(sub_key: &str, value_name: &str) -> Result<Option<u32>, String> {
    let sub_key = wide_null(sub_key);
    let wide_value_name = wide_null(value_name);
    let mut value = 0u32;
    let mut value_size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            sub_key.as_ptr(),
            wide_value_name.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut value as *mut u32).cast(),
            &mut value_size,
        )
    };

    match status {
        0 => Ok(Some(value)),
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Ok(None),
        code => Err(format!(
            "failed to read registry DWORD {value_name}: Win32 error {code}"
        )),
    }
}

#[tauri::command]
fn get_windows_app_theme() -> Result<Option<&'static str>, String> {
    let value = reg_query_current_user_dword(
        r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
        "AppsUseLightTheme",
    )?;
    Ok(value.map(|v| if v == 0 { "dark" } else { "light" }))
}

// SendInput validates the full INPUT union size, which is larger than KEYBDINPUT on 64-bit Windows.
fn keyboard_input(vk: VIRTUAL_KEY, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

#[tauri::command]
fn open_windows_emoji_picker() -> Result<(), String> {
    let inputs = [
        keyboard_input(VK_LWIN, KEYEVENTF_EXTENDEDKEY),
        keyboard_input(VK_OEM_PERIOD, 0),
        keyboard_input(VK_OEM_PERIOD, KEYEVENTF_KEYUP),
        keyboard_input(VK_LWIN, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP),
    ];

    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
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

/// URI scheme the editor's `<img>` elements load note images from
/// (`http://noten-asset.localhost/<percent-encoded absolute path>` on Windows,
/// built by `convertFileSrc(path, "noten-asset")`).
const NOTE_ASSET_SCHEME: &str = "noten-asset";

/// Content type of a servable note image, by extension; anything else is
/// refused.
fn note_image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// Whether `path` (already canonical) is a note image the webview may load: an
/// image file inside a `.assets` directory under one of `roots` (canonical).
/// Canonical paths resolve `..`, symlinks and junctions first, so a link
/// inside `.assets` that points elsewhere is judged by where it lands.
fn is_servable_note_image(path: &Path, roots: &[PathBuf]) -> bool {
    note_image_mime(path).is_some()
        && roots.iter().any(|root| path.starts_with(root))
        && path
            .parent()
            .is_some_and(|dir| dir.components().any(|c| c == Component::Normal(".assets".as_ref())))
}

/// Canonical roots note images are served from: the same as the fs scope.
fn note_image_roots<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    [
        app.path().home_dir(),
        app.path().app_data_dir(),
        app.path().app_local_data_dir(),
    ]
    .into_iter()
    .filter_map(|dir| dir.ok().and_then(|dir| fs::canonicalize(dir).ok()))
    .collect()
}

/// The files PDF export may point headless Edge at, one per requested image
/// path: its canonical path when the `noten-asset` scheme would serve it and
/// it is a file, else `None`. The export must not reach anything the editor
/// could not show, and this is the scheme's own gate (canonical, so `..`
/// aliases, symlinks and junctions are judged by where they land).
#[tauri::command]
async fn note_image_files<R: Runtime>(
    app: AppHandle<R>,
    paths: Vec<String>,
) -> Vec<Option<String>> {
    let roots = note_image_roots(&app);
    paths
        .iter()
        .map(|raw| servable_note_image_file(raw, &roots))
        .collect()
}

/// `raw`'s canonical path if it is a file the `noten-asset` scheme would serve.
fn servable_note_image_file(raw: &str, roots: &[PathBuf]) -> Option<String> {
    let path = fs::canonicalize(raw).ok()?;
    (path.is_file() && is_servable_note_image(&path, roots))
        .then(|| path.to_string_lossy().into_owned())
}

/// Serves note images for the editor. Unlike Tauri's asset protocol, which
/// reads files synchronously on the UI thread (where WebView2 delivers the
/// request), the read runs on a blocking worker: an image that OneDrive still
/// has to download must not freeze the window and every IPC call behind it.
/// The allowed set is fixed here — image files under a `.assets` directory in
/// the same roots as the fs scope — so nothing at runtime can widen it.
fn note_asset_response<R: Runtime>(
    app: &AppHandle<R>,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    // Tauri treats every registered scheme's origin as local, so a document
    // served from it would get the app's IPC permissions. Nothing here is
    // meant to be a document: forbid scripts and sniffing on every response
    // (an <img> ignores both), so a navigated-to SVG cannot run code.
    let response = |code: u16| {
        tauri::http::Response::builder()
            .status(code)
            .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
            .header("X-Content-Type-Options", "nosniff")
    };
    // Not cached: an image OneDrive has not synced yet must load once it has.
    let status = |code: u16| {
        response(code)
            .header("Cache-Control", "no-store")
            .body(Vec::new())
            .expect("static response")
    };
    let encoded = request.uri().path().as_bytes();
    let raw = percent_encoding::percent_decode(encoded.get(1..).unwrap_or_default())
        .decode_utf8_lossy()
        .into_owned();
    let Ok(path) = fs::canonicalize(&raw) else {
        return status(404);
    };
    if !is_servable_note_image(&path, &note_image_roots(app)) {
        return status(403);
    }
    match fs::read(&path) {
        Ok(bytes) => response(200)
            .header("Content-Type", note_image_mime(&path).unwrap_or("application/octet-stream"))
            .body(bytes)
            .expect("image response"),
        Err(_) => status(404),
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
        .register_asynchronous_uri_scheme_protocol(NOTE_ASSET_SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(note_asset_response(&app, &request));
            });
        })
        .invoke_handler(tauri::generate_handler![
            print_to_pdf,
            note_image_files,
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
    use super::{
        failure_reason, is_servable_note_image, note_image_mime, print_temp_stem,
        remove_dir_when_released, servable_note_image_file, wait_for_written_file, wide_null,
    };
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    #[test]
    fn waits_for_a_pdf_written_after_the_launcher_exits() {
        // Stands in for the Edge process that keeps rendering after the one we
        // launched has exited: the file appears late and stays open a while.
        let path = std::env::temp_dir().join(format!("{}.pdf", print_temp_stem()));
        let closed = Arc::new(AtomicBool::new(false));
        let writer = {
            let (path, closed) = (path.clone(), closed.clone());
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(200));
                let mut file = std::fs::File::create(&path).unwrap();
                file.write_all(b"%PDF-1.4 partial").unwrap();
                std::thread::sleep(Duration::from_millis(300));
                file.write_all(b" rest").unwrap();
                closed.store(true, Ordering::SeqCst);
            })
        };
        let poll = Duration::from_millis(10);
        let deadline = Instant::now() + Duration::from_secs(10);
        assert!(wait_for_written_file(&path, deadline, poll));
        // Returned only once the writer let go of the file, never mid-write.
        assert!(closed.load(Ordering::SeqCst));
        writer.join().unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"%PDF-1.4 partial rest");
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn export_gets_only_files_the_image_scheme_would_serve() {
        let root = std::env::temp_dir().join(format!("{}_root", print_temp_stem()));
        let assets = root.join("notes").join(".assets").join("n");
        std::fs::create_dir_all(assets.join("dir.png")).unwrap();
        std::fs::write(assets.join("a.png"), b"png").unwrap();
        std::fs::write(assets.join("note.md"), b"md").unwrap();
        std::fs::write(root.join("notes").join("outside.png"), b"png").unwrap();
        let roots = vec![std::fs::canonicalize(&root).unwrap()];
        let file = |p: PathBuf| servable_note_image_file(&p.to_string_lossy(), &roots);

        let served = file(assets.join("a.png")).expect("an image inside .assets is served");
        let canonical = std::fs::canonicalize(assets.join("a.png")).unwrap();
        assert_eq!(PathBuf::from(served), canonical);
        // Win32 strips the trailing space, so `.. ` climbs out of `.assets`:
        // judged by where it lands, like the editor's own request.
        let climbing = assets.join(".. ").join(".. ").join("outside.png");
        assert_eq!(file(climbing), None);
        assert_eq!(file(root.join("notes").join("outside.png")), None);
        assert_eq!(file(assets.join("note.md")), None);
        assert_eq!(file(assets.join("dir.png")), None);
        assert_eq!(file(assets.join("missing.png")), None);
        assert_eq!(servable_note_image_file("", &roots), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn removes_edges_profile_once_its_files_are_released() {
        // An Edge child process still holding a file in the profile.
        let dir = std::env::temp_dir().join(format!("{}_profile", print_temp_stem()));
        std::fs::create_dir_all(dir.join("Default")).unwrap();
        let held = std::fs::File::create(dir.join("Default").join("Cookies")).unwrap();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(held);
        });
        remove_dir_when_released(&dir);
        releaser.join().unwrap();
        assert!(!dir.exists());
        // Nothing to remove is not an error, and returns at once.
        remove_dir_when_released(&dir);
    }

    #[test]
    fn explains_a_failure_caused_by_a_renderer_crash() {
        // The line Edge 153 logged when printing a 627-image note ran it out
        // of memory and left it hung.
        let log = "[8028:29440:0922/132140.815:ERROR:components\\headless\\command_handler\\headless_command_handler.cc:395] Abnormal renderer termination.";
        assert!(failure_reason(log).contains("out of memory"));
        assert_eq!(failure_reason("unrelated noise"), "");
    }

    #[test]
    fn gives_up_on_a_pdf_that_never_appears() {
        let path = std::env::temp_dir().join(format!("{}.pdf", print_temp_stem()));
        let start = Instant::now();
        let poll = Duration::from_millis(10);
        let deadline = start + Duration::from_millis(150);
        assert!(!wait_for_written_file(&path, deadline, poll));
        assert!(start.elapsed() >= Duration::from_millis(150));
    }

    #[test]
    fn serves_only_images_inside_assets_under_a_root() {
        let roots = vec![PathBuf::from(r"C:\Users\u")];
        let ok = |p: &str| is_servable_note_image(Path::new(p), &roots);
        assert!(ok(r"C:\Users\u\notes\.assets\n1\a.png"));
        assert!(ok(r"C:\Users\u\OneDrive\문서\notes\.assets\n1\사진.JPG"));
        // Not an image, not under .assets, or outside every root.
        assert!(!ok(r"C:\Users\u\notes\.assets\n1\note.md"));
        assert!(!ok(r"C:\Users\u\notes\n1.png"));
        assert!(!ok(r"C:\Users\u\notes\foo.assets\a.png"));
        assert!(!ok(r"C:\Users\u\.assets.png"));
        assert!(!ok(r"D:\notes\.assets\n1\a.png"));
        assert!(!ok(r"C:\Users\uu\notes\.assets\a.png"));
    }

    #[test]
    fn image_mime_by_extension() {
        assert_eq!(note_image_mime(Path::new("a.SVG")), Some("image/svg+xml"));
        assert_eq!(note_image_mime(Path::new("a.jpeg")), Some("image/jpeg"));
        assert_eq!(note_image_mime(Path::new("a.html")), None);
        assert_eq!(note_image_mime(Path::new("noext")), None);
    }

    #[test]
    fn wide_null_encodes_utf16_with_one_terminator() {
        assert_eq!(wide_null("Theme"), vec![84, 104, 101, 109, 101, 0]);
        assert_eq!(wide_null("테마").last(), Some(&0));
    }

    #[test]
    fn print_temp_stem_is_unique_per_call() {
        let a = print_temp_stem();
        let b = print_temp_stem();
        assert_ne!(a, b);
        assert!(a.starts_with("noten_print_"));
    }
}

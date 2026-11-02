use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LUID};
use windows_sys::Win32::Security::Authentication::Identity::{
    LsaFreeReturnBuffer, LsaGetLogonSessionData, SECURITY_LOGON_SESSION_DATA,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenStatistics, TOKEN_QUERY, TOKEN_STATISTICS,
};
use windows_sys::Win32::System::SystemInformation::GetTickCount;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

const CLAIMS_DIRNAME: &str = "logon-update-claims";

// Only the installed app may replace itself. The installer ends every process
// with this binary name and overwrites the install folder, so a dev, bench or
// isolated test build that updated itself would take the real app with it. The
// override exists for the end-to-end test of this path, which builds its own
// product name and binary name and so has no real install to overwrite.
const SELF_UPDATE_IDENTIFIER: &str = match option_env!("NOTEN_SELF_UPDATE_IDENTIFIER") {
    Some(identifier) => identifier,
    None => "com.noten.app",
};

static HELD_CLAIM: Mutex<Option<PathBuf>> = Mutex::new(None);
static PDF_EXPORTS_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Holds off an automatic update for as long as it lives: installing ends the
/// process, and an export can run for a minute with no input at all.
pub struct PdfExportGuard;

impl PdfExportGuard {
    pub fn new() -> Self {
        PDF_EXPORTS_IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for PdfExportGuard {
    fn drop(&mut self) {
        PDF_EXPORTS_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Identifies this Windows logon. The id alone is unique only until a restart,
/// so the logon time goes with it.
fn logon_session_key() -> io::Result<String> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut statistics: TOKEN_STATISTICS = std::mem::zeroed();
        let mut written = 0u32;
        let read = GetTokenInformation(
            token,
            TokenStatistics,
            (&raw mut statistics).cast(),
            size_of::<TOKEN_STATISTICS>() as u32,
            &mut written,
        );
        let read_error = io::Error::last_os_error();
        CloseHandle(token);
        if read == 0 {
            return Err(read_error);
        }

        let logon_id: LUID = statistics.AuthenticationId;
        let mut session: *mut SECURITY_LOGON_SESSION_DATA = std::ptr::null_mut();
        let status = LsaGetLogonSessionData(&logon_id, &mut session);
        if status != 0 || session.is_null() {
            return Err(io::Error::other(format!(
                "LsaGetLogonSessionData failed with {status:#x}"
            )));
        }
        let logon_time = (*session).LogonTime;
        LsaFreeReturnBuffer(session.cast());
        Ok(format!(
            "{:x}-{:x}-{logon_time:x}",
            logon_id.HighPart, logon_id.LowPart
        ))
    }
}

/// Creating the marker is the claim, so two Noten processes starting together
/// cannot both win. Markers of earlier logons are removed only by the winner.
fn claim_in(dir: &Path, key: &str) -> io::Result<Option<PathBuf>> {
    fs::create_dir_all(dir)?;
    let marker = dir.join(key);
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)
    {
        Ok(_) => {}
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => return Ok(None),
        Err(err) => return Err(err),
    }
    for entry in fs::read_dir(dir)?.flatten() {
        if entry.path() != marker {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(Some(marker))
}

/// True for the first launch of this Windows logon, once per logon. The claim
/// stays held until settled: a process that exits first gives it back, so an
/// update it never got to install is retried by the next launch.
#[tauri::command]
pub fn claim_logon_update_check<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    if cfg!(debug_assertions) || app.config().identifier != SELF_UPDATE_IDENTIFIER {
        return Ok(false);
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join(CLAIMS_DIRNAME);
    let key = logon_session_key().map_err(|err| err.to_string())?;
    let claimed = claim_in(&dir, &key).map_err(|err| err.to_string())?;
    let won = claimed.is_some();
    if won {
        *HELD_CLAIM.lock().unwrap_or_else(|e| e.into_inner()) = claimed;
    }
    Ok(won)
}

/// `consumed: false` lets the next launch of this logon try again.
#[tauri::command]
pub fn settle_logon_update_check(consumed: bool) {
    let held = HELD_CLAIM.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let (false, Some(marker)) = (consumed, held) {
        let _ = fs::remove_file(marker);
    }
}

/// Runs when the app exits normally. The installer's exit skips the event loop,
/// so the claim of an update being installed survives and the relaunched app
/// does not check again.
pub fn release_held_claim() {
    settle_logon_update_check(false);
}

/// Milliseconds since the last keyboard or mouse input anywhere in this Windows
/// session, not only in Noten: restarting brings a window forward, which is no
/// better while the user is typing in another app, and this also sees every
/// other Noten window and process. Zero when an update must not start.
#[tauri::command]
pub fn auto_update_idle_ms() -> u32 {
    if PDF_EXPORTS_IN_FLIGHT.load(Ordering::SeqCst) > 0 {
        return 0;
    }
    let mut info = LASTINPUTINFO {
        cbSize: size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    unsafe {
        if GetLastInputInfo(&mut info) == 0 {
            return 0;
        }
        // Both are 32-bit tick counts that wrap about every 49 days.
        GetTickCount().wrapping_sub(info.dwTime)
    }
}

#[cfg(test)]
mod tests {
    use super::{auto_update_idle_ms, claim_in, logon_session_key, PdfExportGuard};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("noten_claims_{}_{nanos}_{count}", std::process::id()))
    }

    #[test]
    fn a_logon_is_claimed_once_and_a_new_logon_replaces_the_old_marker() {
        let dir = temp_dir();
        let first = claim_in(&dir, "logon-a").unwrap().expect("first launch wins");
        assert!(claim_in(&dir, "logon-a").unwrap().is_none());

        let next = claim_in(&dir, "logon-b").unwrap().expect("a new logon wins");
        assert!(!first.exists());
        assert!(next.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn concurrent_launches_produce_one_winner() {
        let dir = temp_dir();
        let launches: Vec<_> = (0..16)
            .map(|_| {
                let dir = dir.clone();
                std::thread::spawn(move || claim_in(&dir, "logon").unwrap().is_some())
            })
            .collect();
        let winners = launches
            .into_iter()
            .map(|launch| launch.join().unwrap())
            .filter(|won| *won)
            .count();
        assert_eq!(winners, 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_logon_session_key_is_stable_within_a_logon() {
        assert_eq!(logon_session_key().unwrap(), logon_session_key().unwrap());
    }

    #[test]
    fn a_running_export_reads_as_not_idle() {
        let _export = PdfExportGuard::new();
        assert_eq!(auto_update_idle_ms(), 0);
    }
}

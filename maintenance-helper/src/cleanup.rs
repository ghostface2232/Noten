use std::fs;
use std::os::windows::process::CommandExt;
use std::process::{Command, id};
use std::time::{SystemTime, UNIX_EPOCH};

use windows::Win32::System::Threading::CREATE_NO_WINDOW;

use crate::constants::install_dir;

pub fn schedule_self_cleanup() -> Result<(), String> {
    let pid = id();
    let target_dir = install_dir();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("failed to resolve timestamp: {error}"))?
        .as_millis();

    let script_path = std::env::temp_dir().join(format!("noten-cleanup-{timestamp}.cmd"));
    let script = format!(
        "@echo off\r\n\
set \"target_pid={pid}\"\r\n\
set \"target_dir={}\"\r\n\
set attempts=0\r\n\
\r\n\
:wait\r\n\
set /a wait_count+=1\r\n\
if %wait_count% gtr 30 goto cleanup\r\n\
tasklist /FI \"PID eq %target_pid%\" 2>NUL | find \"%target_pid%\" >NUL\r\n\
if not errorlevel 1 (\r\n\
    timeout /t 1 /nobreak >NUL\r\n\
    goto wait\r\n\
)\r\n\
\r\n\
:cleanup\r\n\
set /a attempts+=1\r\n\
if %attempts% gtr 15 goto done\r\n\
rd /s /q \"%target_dir%\" 2>NUL\r\n\
if exist \"%target_dir%\" (\r\n\
    ping 127.0.0.1 -n 1 -w 200 >NUL\r\n\
    goto cleanup\r\n\
)\r\n\
\r\n\
:done\r\n\
del /f /q \"%~f0\"\r\n",
        target_dir.display()
    );

    fs::write(&script_path, script)
        .map_err(|error| format!("failed to write cleanup script: {error}"))?;

    Command::new("cmd")
        .creation_flags(CREATE_NO_WINDOW.0)
        .current_dir(std::env::temp_dir())
        .args(["/c", &script_path.to_string_lossy()])
        .spawn()
        .map_err(|error| format!("failed to launch cleanup script: {error}"))?;

    Ok(())
}

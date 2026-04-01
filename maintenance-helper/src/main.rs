#![allow(dead_code)]

use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};

mod cleanup;
mod constants;
mod registry;
mod splash;
mod uninstaller;

use splash::{CompletionAction, SplashConfig};

fn main() {
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };

    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|arg| arg == "--uninstall") {
        println!("maintenance-helper.exe --uninstall");
        return;
    }

    let outcome = splash::run_splash(
        SplashConfig {
            status_ko: "제거 중...",
            status_en: "Removing...",
            completed_status_ko: "제거 완료",
            completed_status_en: "Removed",
            failed_status_ko: "제거 실패",
            failed_status_en: "Removal failed",
            ready_status_ko: Some("제거 옵션을 확인하세요"),
            ready_status_en: Some("Review the uninstall option"),
            primary_button_label_ko: "닫기",
            primary_button_label_en: "Close",
            ready_button_label_ko: Some("제거"),
            ready_button_label_en: Some("Remove"),
            secondary_button_label_ko: Some("취소"),
            secondary_button_label_en: Some("Cancel"),
            completion_action: CompletionAction::CloseWindow,
            auto_start: false,
            checkbox_label_ko: Some("노트 및 설정 데이터도 삭제"),
            checkbox_label_en: Some("Also delete notes and settings data"),
            checkbox_checked: false,
        },
        |remove_user_data| {
            uninstaller::run_nsis_uninstall();
            uninstaller::remove_app_data(remove_user_data);
            registry::remove_uninstall_registry()?;
            Ok(())
        },
    );

    if outcome.success {
        if let Err(error) = cleanup::schedule_self_cleanup() {
            eprintln!("[maintenance-helper] warning: {error}");
        }
    }
}

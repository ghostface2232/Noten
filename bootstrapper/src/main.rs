use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};

mod constants;
mod installer;
mod registry;
mod splash;
use splash::{CompletionAction, SplashConfig};

fn main() {
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };

    println!("[noten-setup] Running install...");
    let _ = splash::run_splash(
        SplashConfig {
            status_ko: "설치 중...",
            status_en: "Installing...",
            completed_status_ko: "완료",
            completed_status_en: "Complete",
            failed_status_ko: "설치 실패",
            failed_status_en: "Installation failed",
            ready_status_ko: None,
            ready_status_en: None,
            primary_button_label_ko: "앱 실행",
            primary_button_label_en: "Launch App",
            ready_button_label_ko: None,
            ready_button_label_en: None,
            secondary_button_label_ko: None,
            secondary_button_label_en: None,
            completion_action: CompletionAction::LaunchApp,
            auto_start: true,
            checkbox_label_ko: None,
            checkbox_label_en: None,
            checkbox_checked: false,
        },
        |_| {
            installer::extract_and_run_nsis()?;
            registry::fix_uninstall_string()?;
            Ok(())
        },
    );
}

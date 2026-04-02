use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr::copy_nonoverlapping;
use std::time::Instant;

use crate::installer;
use windows::Win32::Foundation::*;
use windows::Win32::Globalization::GetUserDefaultUILanguage;
use windows::Win32::Graphics::Dwm::{
    DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND, DwmSetWindowAttribute,
};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Graphics::GdiPlus::*;
use windows::Win32::System::Com::IStream;
use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows::Win32::UI::HiDpi::GetDpiForSystem;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::PCWSTR;

const WM_WORK_DONE: u32 = WM_USER + 1;
const WM_PRIMARY_ACTION: u32 = WM_USER + 2;
const WM_START_WORK: u32 = WM_USER + 3;
const SPLASH_W: i32 = 480;
const SPLASH_H: i32 = 300;
const SPLASH_H_WITH_CHECKBOX: i32 = 332;
const ANIMATION_TIMER_ID: usize = 1;
const ANIMATION_INTERVAL_MS: u32 = 16;
const ANIMATION_DURATION_MS: f32 = 1200.0;
const PROGRESS_SIDE_MARGIN: i32 = 60;
const PROGRESS_HEIGHT: i32 = 4;
const PROGRESS_RADIUS: i32 = 2;
const PROGRESS_BLOCK_WIDTH_RATIO: f32 = 0.30;
const BUTTON_W: i32 = 120;
const BUTTON_H: i32 = 36;
const BUTTON_GAP: i32 = 12;
const BUTTON_BOTTOM_OFFSET: i32 = 40;
const BUTTON_RADIUS: i32 = 4;
const LOGO_SIZE: i32 = 64;
const LOGO_TOP: i32 = 42;
const TITLE_TOP: i32 = 142;
const TITLE_BOTTOM: i32 = 174;
const STATUS_TOP: i32 = 172;
const STATUS_BOTTOM: i32 = 198;
const CHECKBOX_TOP: i32 = 206;
const CHECKBOX_ROW_H: i32 = 22;
const CHECKBOX_BOX_SIZE: i32 = 16;
const CHECKBOX_LABEL_GAP: i32 = 10;
const TITLE_FONT_SIZE: i32 = 18;
const STATUS_FONT_SIZE: i32 = 13;
const BUTTON_FONT_SIZE: i32 = 13;
const CHECKBOX_FONT_SIZE: i32 = 13;

const BG_COLOR: COLORREF = COLORREF(0x00FAFAFA);
const TITLE_COLOR: COLORREF = COLORREF(0x001F1B1B);
const STATUS_COLOR: COLORREF = COLORREF(0x00616161);
const CHECKBOX_TEXT_COLOR: COLORREF = COLORREF(0x00444444);
const TRACK_COLOR: u32 = 0xFFE0E0E0;
const BLOCK_COLOR: u32 = 0xFF0078D4;
const BUTTON_BG_COLOR: u32 = 0xFF0078D4;
const BUTTON_HOVER_BG_COLOR: u32 = 0xFF106EBE;
const BUTTON_TEXT_COLOR: COLORREF = COLORREF(0x00FFFFFF);
const SECONDARY_BUTTON_BG_COLOR: u32 = 0xFFFFFFFF;
const SECONDARY_BUTTON_HOVER_BG_COLOR: u32 = 0xFFF3F2F1;
const SECONDARY_BUTTON_BORDER_COLOR: u32 = 0xFFD1D1D1;
const SECONDARY_BUTTON_TEXT_COLOR: COLORREF = COLORREF(0x00323232);
const CHECKBOX_BORDER_COLOR: u32 = 0xFF8A8886;
const CHECKBOX_BG_COLOR: u32 = 0xFFFFFFFF;
const CHECKBOX_CHECK_COLOR: u32 = 0xFF0078D4;
const GDIP_OK: Status = Status(0);

const FONT_FACE: &str = "Pretendard JP Medium";
const APP_LOGO_PNG: &[u8] = include_bytes!("../assets/Noten_icon_512.png");
const FONT_MEDIUM: &[u8] = include_bytes!("../assets/PretendardJP-Medium.otf");

struct LogoAsset {
    image: *mut GpImage,
    _stream: IStream,
}

#[derive(Clone, Copy)]
pub enum CompletionAction {
    LaunchApp,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SplashStage {
    Ready,
    Running,
    Success,
    Failure,
}

pub struct SplashConfig<'a> {
    pub status_ko: &'a str,
    pub status_en: &'a str,
    pub completed_status_ko: &'a str,
    pub completed_status_en: &'a str,
    pub failed_status_ko: &'a str,
    pub failed_status_en: &'a str,
    pub ready_status_ko: Option<&'a str>,
    pub ready_status_en: Option<&'a str>,
    pub primary_button_label_ko: &'a str,
    pub primary_button_label_en: &'a str,
    pub ready_button_label_ko: Option<&'a str>,
    pub ready_button_label_en: Option<&'a str>,
    pub secondary_button_label_ko: Option<&'a str>,
    pub secondary_button_label_en: Option<&'a str>,
    pub completion_action: CompletionAction,
    pub auto_start: bool,
    pub checkbox_label_ko: Option<&'a str>,
    pub checkbox_label_en: Option<&'a str>,
    pub checkbox_checked: bool,
}

#[derive(Clone, Copy, Default)]
pub struct SplashOutcome {
    pub success: bool,
    pub checkbox_checked: bool,
}

struct CheckboxState {
    label_ko: String,
    label_en: String,
    checked: bool,
    hovered: bool,
}

struct SplashData {
    status_ko: String,
    status_en: String,
    completed_status_ko: String,
    completed_status_en: String,
    failed_status_ko: String,
    failed_status_en: String,
    ready_status_ko: Option<String>,
    ready_status_en: Option<String>,
    button_label_ko: String,
    button_label_en: String,
    ready_button_label_ko: Option<String>,
    ready_button_label_en: Option<String>,
    secondary_button_label_ko: Option<String>,
    secondary_button_label_en: Option<String>,
    completion_action: CompletionAction,
    logo: Option<LogoAsset>,
    font_handles: Vec<HANDLE>,
    dpi: u32,
    window_w: i32,
    window_h: i32,
    animation_started: Instant,
    block_offset_px: i32,
    stage: SplashStage,
    auto_start: bool,
    button_hovered: bool,
    secondary_button_hovered: bool,
    use_korean: bool,
    checkbox: Option<CheckboxState>,
    work: Option<Box<dyn FnOnce(bool) -> Result<(), String> + Send + 'static>>,
    work_result: Option<Result<(), String>>,
}

struct SplashWindowState {
    data: SplashData,
    outcome: *mut SplashOutcome,
}

fn scale_dpi(value: i32, dpi: u32) -> i32 {
    ((value as i64 * dpi as i64) / 96) as i32
}

fn load_fonts() -> Vec<HANDLE> {
    let mut handles = Vec::new();
    for font_data in [FONT_MEDIUM] {
        unsafe {
            let mut num_fonts: u32 = 0;
            let handle = AddFontMemResourceEx(
                font_data.as_ptr() as *const c_void,
                font_data.len() as u32,
                None,
                &mut num_fonts,
            );
            if !handle.is_invalid() {
                handles.push(handle);
            }
        }
    }
    handles
}

fn unload_fonts(handles: &[HANDLE]) {
    for &handle in handles {
        unsafe {
            let _ = RemoveFontMemResourceEx(handle);
        }
    }
}

fn create_font(size: i32, weight: i32) -> HFONT {
    create_font_with_face(FONT_FACE, size, weight)
}

fn create_font_with_face(face: &str, size: i32, weight: i32) -> HFONT {
    let mut wide: Vec<u16> = face.encode_utf16().collect();
    wide.push(0);
    unsafe {
        CreateFontW(
            -size,
            0,
            0,
            0,
            weight,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            CLEARTYPE_QUALITY,
            0,
            PCWSTR(wide.as_ptr()),
        )
    }
}

fn prefers_korean() -> bool {
    unsafe { (GetUserDefaultUILanguage() & 0x03ff) == 0x0012 }
}

fn localized_text<'a>(ko: &'a str, en: &'a str, use_korean: bool) -> &'a str {
    if use_korean { ko } else { en }
}

fn load_logo_asset() -> Option<LogoAsset> {
    if APP_LOGO_PNG.is_empty() {
        return None;
    }

    unsafe {
        let hglobal = GlobalAlloc(GMEM_MOVEABLE, APP_LOGO_PNG.len()).ok()?;
        let buffer = GlobalLock(hglobal) as *mut u8;
        if buffer.is_null() {
            return None;
        }

        copy_nonoverlapping(APP_LOGO_PNG.as_ptr(), buffer, APP_LOGO_PNG.len());
        let _ = GlobalUnlock(hglobal);

        let stream = CreateStreamOnHGlobal(hglobal, true).ok()?;
        let mut bitmap: *mut GpBitmap = std::ptr::null_mut();
        if GdipCreateBitmapFromStream(&stream, &mut bitmap) != GDIP_OK || bitmap.is_null() {
            return None;
        }

        Some(LogoAsset {
            image: bitmap as *mut GpImage,
            _stream: stream,
        })
    }
}

pub fn run_splash<F>(config: SplashConfig<'_>, work: F) -> SplashOutcome
where
    F: FnOnce(bool) -> Result<(), String> + Send + 'static,
{
    unsafe {
        let mut gdi_token: usize = 0;
        let gdi_input = GdiplusStartupInput {
            GdiplusVersion: 1,
            ..Default::default()
        };
        GdiplusStartup(&mut gdi_token, &gdi_input, std::ptr::null_mut());

        let hinstance =
            HINSTANCE(GetModuleHandleW(None).expect("GetModuleHandleW").0 as *mut c_void);
        let font_handles = load_fonts();
        let class_name = windows::core::w!("NotenSplash");

        let wc = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinstance,
            hbrBackground: HBRUSH::default(),
            lpszClassName: class_name,
            ..Default::default()
        };

        RegisterClassW(&wc);

        let dpi = GetDpiForSystem();
        let window_w = scale_dpi(SPLASH_W, dpi);
        let wants_checkbox =
            config.checkbox_label_ko.is_some() && config.checkbox_label_en.is_some();
        let window_h = scale_dpi(
            if wants_checkbox {
                SPLASH_H_WITH_CHECKBOX
            } else {
                SPLASH_H
            },
            dpi,
        );
        let screen_w = GetSystemMetrics(SM_CXSCREEN);
        let screen_h = GetSystemMetrics(SM_CYSCREEN);
        let x = (screen_w - window_w) / 2;
        let y = (screen_h - window_h) / 2;

        let mut outcome = Box::new(SplashOutcome::default());
        let outcome_ptr = outcome.as_mut() as *mut SplashOutcome;

        let data = SplashData {
            status_ko: config.status_ko.to_string(),
            status_en: config.status_en.to_string(),
            completed_status_ko: config.completed_status_ko.to_string(),
            completed_status_en: config.completed_status_en.to_string(),
            failed_status_ko: config.failed_status_ko.to_string(),
            failed_status_en: config.failed_status_en.to_string(),
            ready_status_ko: config.ready_status_ko.map(str::to_string),
            ready_status_en: config.ready_status_en.map(str::to_string),
            button_label_ko: config.primary_button_label_ko.to_string(),
            button_label_en: config.primary_button_label_en.to_string(),
            ready_button_label_ko: config.ready_button_label_ko.map(str::to_string),
            ready_button_label_en: config.ready_button_label_en.map(str::to_string),
            secondary_button_label_ko: config.secondary_button_label_ko.map(str::to_string),
            secondary_button_label_en: config.secondary_button_label_en.map(str::to_string),
            completion_action: config.completion_action,
            logo: load_logo_asset(),
            font_handles,
            dpi,
            window_w,
            window_h,
            animation_started: Instant::now(),
            block_offset_px: progress_start_offset(window_w, dpi),
            stage: if config.auto_start {
                SplashStage::Running
            } else {
                SplashStage::Ready
            },
            auto_start: config.auto_start,
            button_hovered: false,
            secondary_button_hovered: false,
            use_korean: prefers_korean(),
            checkbox: config
                .checkbox_label_ko
                .zip(config.checkbox_label_en)
                .map(|(ko, en)| CheckboxState {
                    label_ko: ko.to_string(),
                    label_en: en.to_string(),
                    checked: config.checkbox_checked,
                    hovered: false,
                }),
            work: Some(Box::new(work)),
            work_result: None,
        };

        let state = Box::new(SplashWindowState {
            data,
            outcome: outcome_ptr,
        });

        let _hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name,
            windows::core::w!("Noten Setup"),
            WS_POPUP | WS_VISIBLE,
            x,
            y,
            window_w,
            window_h,
            None,
            None,
            Some(hinstance),
            Some(Box::into_raw(state) as *const c_void),
        )
        .expect("CreateWindowExW");

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        GdiplusShutdown(gdi_token);
        *outcome
    }
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe {
        match msg {
            WM_CREATE => {
                let cs = &*(lparam.0 as *const CREATESTRUCTW);
                let state_ptr = cs.lpCreateParams as isize;
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr);
                let corner_preference = DWMWCP_ROUND;
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_WINDOW_CORNER_PREFERENCE,
                    &corner_preference as *const _ as *const c_void,
                    std::mem::size_of_val(&corner_preference) as u32,
                );

                let state = &mut *(state_ptr as *mut SplashWindowState);
                if state.data.auto_start {
                    let _ = PostMessageW(Some(hwnd), WM_START_WORK, WPARAM(0), LPARAM(0));
                }
                LRESULT(0)
            }
            WM_PAINT => {
                let mut ps = PAINTSTRUCT::default();
                let hdc = BeginPaint(hwnd, &mut ps);

                let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                if state_ptr != 0 {
                    let state = &*(state_ptr as *const SplashWindowState);
                    paint_splash(hdc, &state.data, &ps.rcPaint);
                }

                let _ = EndPaint(hwnd, &ps);
                LRESULT(0)
            }
            WM_ERASEBKGND => LRESULT(1),
            WM_TIMER => {
                if wparam.0 == ANIMATION_TIMER_ID {
                    let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                    if state_ptr != 0 {
                        let state = &mut *(state_ptr as *mut SplashWindowState);
                        state.data.block_offset_px = progress_block_offset(
                            &state.data,
                            state.data.animation_started.elapsed().as_secs_f32(),
                        );

                        let bar_rect = progress_track_rect(&state.data);
                        let _ = InvalidateRect(Some(hwnd), Some(&bar_rect), false);
                    }
                    return LRESULT(0);
                }
                DefWindowProcW(hwnd, msg, wparam, lparam)
            }
            WM_START_WORK => {
                let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                if state_ptr != 0 {
                    let state = &mut *(state_ptr as *mut SplashWindowState);
                    if state.data.work.is_none() {
                        return LRESULT(0);
                    }

                    let delete_user_data = state
                        .data
                        .checkbox
                        .as_ref()
                        .map(|checkbox| checkbox.checked)
                        .unwrap_or(false);
                    state.data.stage = SplashStage::Running;
                    state.data.button_hovered = false;
                    state.data.secondary_button_hovered = false;
                    state.data.animation_started = Instant::now();
                    state.data.block_offset_px =
                        progress_start_offset(state.data.window_w, state.data.dpi);
                    let _ = SetTimer(Some(hwnd), ANIMATION_TIMER_ID, ANIMATION_INTERVAL_MS, None);

                    if let Some(work) = state.data.work.take() {
                        let hwnd_val = hwnd.0 as usize;
                        std::thread::spawn(move || {
                            let result = catch_unwind(AssertUnwindSafe(|| work(delete_user_data)))
                                .unwrap_or_else(|_| {
                                    Err("unexpected bootstrapper panic".to_string())
                                });
                            let success = result.is_ok();
                            let result_ptr = Box::into_raw(Box::new(result));
                            let _ = PostMessageW(
                                Some(HWND(hwnd_val as *mut c_void)),
                                WM_WORK_DONE,
                                WPARAM(result_ptr as usize),
                                LPARAM(success as isize),
                            );
                        });
                    }

                    let _ = InvalidateRect(Some(hwnd), None, false);
                }
                LRESULT(0)
            }
            WM_WORK_DONE => {
                let _ = KillTimer(Some(hwnd), ANIMATION_TIMER_ID);
                let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                if state_ptr != 0 {
                    let state = &mut *(state_ptr as *mut SplashWindowState);
                    let result_ptr = wparam.0 as *mut Result<(), String>;
                    if !result_ptr.is_null() {
                        state.data.work_result = Some(*Box::from_raw(result_ptr));
                    }
                    state.data.button_hovered = false;
                    state.data.secondary_button_hovered = false;
                    state.data.stage = if lparam.0 != 0 {
                        SplashStage::Success
                    } else {
                        SplashStage::Failure
                    };
                }
                let _ = InvalidateRect(Some(hwnd), None, false);
                LRESULT(0)
            }
            WM_PRIMARY_ACTION => {
                let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                if state_ptr != 0 {
                    let state = &mut *(state_ptr as *mut SplashWindowState);
                    if state.data.stage == SplashStage::Ready {
                        let _ = PostMessageW(Some(hwnd), WM_START_WORK, WPARAM(0), LPARAM(0));
                        return LRESULT(0);
                    }

                    if state.data.stage == SplashStage::Success
                        && matches!(state.data.completion_action, CompletionAction::LaunchApp)
                    {
                        installer::launch_app();
                    }
                }
                let _ = DestroyWindow(hwnd);
                LRESULT(0)
            }
            WM_MOUSEMOVE => {
                let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                if state_ptr != 0 {
                    let state = &mut *(state_ptr as *mut SplashWindowState);
                    let x = get_x_lparam(lparam);
                    let y = get_y_lparam(lparam);
                    let button_hovered = show_primary_button(&state.data)
                        && point_in_rect(x, y, &primary_button_rect(&state.data));
                    let secondary_button_hovered = show_secondary_button(&state.data)
                        && point_in_rect(x, y, &secondary_button_rect(&state.data));
                    let checkbox_hovered = state.data.stage == SplashStage::Ready
                        && state.data.checkbox.is_some()
                        && point_in_rect(x, y, &checkbox_hit_rect(&state.data));

                    let mut changed = button_hovered != state.data.button_hovered;
                    state.data.button_hovered = button_hovered;
                    if secondary_button_hovered != state.data.secondary_button_hovered {
                        state.data.secondary_button_hovered = secondary_button_hovered;
                        changed = true;
                    }
                    if let Some(checkbox) = state.data.checkbox.as_mut() {
                        if checkbox.hovered != checkbox_hovered {
                            checkbox.hovered = checkbox_hovered;
                            changed = true;
                        }
                    }
                    if changed {
                        let _ = InvalidateRect(Some(hwnd), None, false);
                    }
                }
                LRESULT(0)
            }
            WM_LBUTTONUP => {
                let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                if state_ptr != 0 {
                    let state = &mut *(state_ptr as *mut SplashWindowState);
                    let x = get_x_lparam(lparam);
                    let y = get_y_lparam(lparam);

                    if state.data.stage == SplashStage::Ready {
                        let checkbox_rect = checkbox_hit_rect(&state.data);
                        if let Some(checkbox) = state.data.checkbox.as_mut() {
                            if point_in_rect(x, y, &checkbox_rect) {
                                checkbox.checked = !checkbox.checked;
                                let _ = InvalidateRect(Some(hwnd), None, false);
                                return LRESULT(0);
                            }
                        }
                    }

                    if show_secondary_button(&state.data)
                        && point_in_rect(x, y, &secondary_button_rect(&state.data))
                    {
                        let _ = DestroyWindow(hwnd);
                        return LRESULT(0);
                    }

                    if show_primary_button(&state.data)
                        && point_in_rect(x, y, &primary_button_rect(&state.data))
                    {
                        let _ = PostMessageW(Some(hwnd), WM_PRIMARY_ACTION, WPARAM(0), LPARAM(0));
                        return LRESULT(0);
                    }
                }
                LRESULT(0)
            }
            WM_DESTROY => {
                let _ = KillTimer(Some(hwnd), ANIMATION_TIMER_ID);
                let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                if ptr != 0 {
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                    let state = Box::from_raw(ptr as *mut SplashWindowState);
                    if let Some(ref logo) = state.data.logo {
                        let _ = GdipDisposeImage(logo.image);
                    }
                    unload_fonts(&state.data.font_handles);
                    if !state.outcome.is_null() {
                        (*state.outcome).success = state.data.stage == SplashStage::Success;
                        (*state.outcome).checkbox_checked = state
                            .data
                            .checkbox
                            .as_ref()
                            .map(|checkbox| checkbox.checked)
                            .unwrap_or(false);
                    }
                }
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

unsafe fn paint_splash(hdc: HDC, data: &SplashData, rc_paint: &RECT) {
    unsafe {
        let buffer_dc = CreateCompatibleDC(Some(hdc));
        if buffer_dc.is_invalid() {
            return;
        }

        let buffer_bitmap = CreateCompatibleBitmap(hdc, data.window_w, data.window_h);
        if buffer_bitmap.is_invalid() {
            let _ = DeleteDC(buffer_dc);
            return;
        }

        let old_bitmap = SelectObject(buffer_dc, buffer_bitmap.into());
        paint_splash_contents(buffer_dc, data);

        let width = rc_paint.right - rc_paint.left;
        let height = rc_paint.bottom - rc_paint.top;
        let _ = BitBlt(
            hdc,
            rc_paint.left,
            rc_paint.top,
            width,
            height,
            Some(buffer_dc),
            rc_paint.left,
            rc_paint.top,
            SRCCOPY,
        );

        SelectObject(buffer_dc, old_bitmap);
        let _ = DeleteObject(buffer_bitmap.into());
        let _ = DeleteDC(buffer_dc);
    }
}

unsafe fn paint_splash_contents(hdc: HDC, data: &SplashData) {
    unsafe {
        let full_rect = RECT {
            left: 0,
            top: 0,
            right: data.window_w,
            bottom: data.window_h,
        };

        let bg = CreateSolidBrush(BG_COLOR);
        FillRect(hdc, &full_rect, bg);
        let _ = DeleteObject(bg.into());

        SetBkMode(hdc, TRANSPARENT);

        if let Some(logo) = &data.logo {
            let logo_size = scale_dpi(LOGO_SIZE, data.dpi);
            let logo_top = scale_dpi(LOGO_TOP, data.dpi);
            let logo_left = (data.window_w - logo_size) / 2;
            let mut graphics = std::ptr::null_mut();
            if GdipCreateFromHDC(hdc, &mut graphics) == GDIP_OK && !graphics.is_null() {
                let _ = GdipSetInterpolationMode(graphics, InterpolationModeHighQualityBicubic);
                let _ = GdipSetPixelOffsetMode(graphics, PixelOffsetModeHighQuality);
                let _ = GdipSetCompositingQuality(graphics, CompositingQualityHighQuality);
                let _ = GdipDrawImageRectI(
                    graphics, logo.image, logo_left, logo_top, logo_size, logo_size,
                );
                let _ = GdipDeleteGraphics(graphics);
            }
        }

        let title_font = create_font(scale_dpi(TITLE_FONT_SIZE, data.dpi), FW_MEDIUM.0 as i32);
        let old_font = SelectObject(hdc, title_font.into());
        SetTextColor(hdc, TITLE_COLOR);
        let mut title_rect = RECT {
            left: 0,
            top: scale_dpi(TITLE_TOP, data.dpi),
            right: data.window_w,
            bottom: scale_dpi(TITLE_BOTTOM, data.dpi),
        };
        let mut title: Vec<u16> = "Noten".encode_utf16().collect();
        DrawTextW(hdc, &mut title, &mut title_rect, DT_CENTER | DT_SINGLELINE);

        let status_font = create_font(scale_dpi(STATUS_FONT_SIZE, data.dpi), FW_MEDIUM.0 as i32);
        SelectObject(hdc, status_font.into());
        SetTextColor(hdc, STATUS_COLOR);
        let mut status_rect = RECT {
            left: 0,
            top: scale_dpi(STATUS_TOP, data.dpi),
            right: data.window_w,
            bottom: scale_dpi(STATUS_BOTTOM, data.dpi),
        };
        let mut status: Vec<u16> = current_status(data).encode_utf16().collect();
        DrawTextW(
            hdc,
            &mut status,
            &mut status_rect,
            DT_CENTER | DT_SINGLELINE,
        );

        if data.stage == SplashStage::Ready {
            if let Some(checkbox) = &data.checkbox {
                paint_checkbox(hdc, data, checkbox);
            }
        }

        if data.stage == SplashStage::Running {
            paint_progress_bar(hdc, data, data.block_offset_px);
        } else if show_primary_button(data) {
            if show_secondary_button(data) {
                paint_secondary_button(
                    hdc,
                    data,
                    data.secondary_button_hovered,
                    current_secondary_button_label(data),
                );
            }
            paint_launch_button(hdc, data, data.button_hovered, current_button_label(data));
        }

        SelectObject(hdc, old_font);
        let _ = DeleteObject(title_font.into());
        let _ = DeleteObject(status_font.into());
    }
}

fn current_status<'a>(data: &'a SplashData) -> &'a str {
    match data.stage {
        SplashStage::Ready => localized_text(
            data.ready_status_ko.as_deref().unwrap_or(&data.status_ko),
            data.ready_status_en.as_deref().unwrap_or(&data.status_en),
            data.use_korean,
        ),
        SplashStage::Running => localized_text(&data.status_ko, &data.status_en, data.use_korean),
        SplashStage::Success => localized_text(
            &data.completed_status_ko,
            &data.completed_status_en,
            data.use_korean,
        ),
        SplashStage::Failure => localized_text(
            &data.failed_status_ko,
            &data.failed_status_en,
            data.use_korean,
        ),
    }
}

fn current_button_label<'a>(data: &'a SplashData) -> &'a str {
    match data.stage {
        SplashStage::Ready => localized_text(
            data.ready_button_label_ko
                .as_deref()
                .unwrap_or(&data.button_label_ko),
            data.ready_button_label_en
                .as_deref()
                .unwrap_or(&data.button_label_en),
            data.use_korean,
        ),
        SplashStage::Success => localized_text(
            &data.button_label_ko,
            &data.button_label_en,
            data.use_korean,
        ),
        SplashStage::Failure => localized_text("닫기", "Close", data.use_korean),
        SplashStage::Running => "",
    }
}

fn current_secondary_button_label<'a>(data: &'a SplashData) -> &'a str {
    localized_text(
        data.secondary_button_label_ko.as_deref().unwrap_or("취소"),
        data.secondary_button_label_en
            .as_deref()
            .unwrap_or("Cancel"),
        data.use_korean,
    )
}

fn show_primary_button(data: &SplashData) -> bool {
    matches!(
        data.stage,
        SplashStage::Ready | SplashStage::Success | SplashStage::Failure
    )
}

fn show_secondary_button(data: &SplashData) -> bool {
    data.stage == SplashStage::Ready
        && data.secondary_button_label_ko.is_some()
        && data.secondary_button_label_en.is_some()
}

fn progress_track_rect(data: &SplashData) -> RECT {
    let side_margin = scale_dpi(PROGRESS_SIDE_MARGIN, data.dpi);
    let bottom = data.window_h - scale_dpi(64, data.dpi);
    let height = scale_dpi(PROGRESS_HEIGHT, data.dpi).max(1);
    RECT {
        left: side_margin,
        top: bottom - height,
        right: data.window_w - side_margin,
        bottom,
    }
}

fn primary_button_rect(data: &SplashData) -> RECT {
    let button_w = scale_dpi(BUTTON_W, data.dpi);
    let button_h = scale_dpi(BUTTON_H, data.dpi);
    let gap = scale_dpi(BUTTON_GAP, data.dpi);
    let left = if show_secondary_button(data) {
        (data.window_w - ((button_w * 2) + gap)) / 2 + button_w + gap
    } else {
        (data.window_w - button_w) / 2
    };
    let bottom = data.window_h - scale_dpi(BUTTON_BOTTOM_OFFSET, data.dpi);
    RECT {
        left,
        top: bottom - button_h,
        right: left + button_w,
        bottom,
    }
}

fn secondary_button_rect(data: &SplashData) -> RECT {
    let button_w = scale_dpi(BUTTON_W, data.dpi);
    let button_h = scale_dpi(BUTTON_H, data.dpi);
    let gap = scale_dpi(BUTTON_GAP, data.dpi);
    let left = (data.window_w - ((button_w * 2) + gap)) / 2;
    let bottom = data.window_h - scale_dpi(BUTTON_BOTTOM_OFFSET, data.dpi);
    RECT {
        left,
        top: bottom - button_h,
        right: left + button_w,
        bottom,
    }
}

fn checkbox_row_rect(data: &SplashData) -> RECT {
    let side_margin = scale_dpi(PROGRESS_SIDE_MARGIN, data.dpi);
    RECT {
        left: side_margin,
        top: scale_dpi(CHECKBOX_TOP, data.dpi),
        right: data.window_w - side_margin,
        bottom: scale_dpi(CHECKBOX_TOP + CHECKBOX_ROW_H, data.dpi),
    }
}

fn checkbox_box_rect(data: &SplashData) -> RECT {
    let row = checkbox_row_rect(data);
    let box_size = scale_dpi(CHECKBOX_BOX_SIZE, data.dpi);
    let top = row.top + ((row.bottom - row.top - box_size) / 2);
    RECT {
        left: row.left,
        top,
        right: row.left + box_size,
        bottom: top + box_size,
    }
}

fn checkbox_hit_rect(data: &SplashData) -> RECT {
    checkbox_row_rect(data)
}

fn progress_start_offset(window_w: i32, dpi: u32) -> i32 {
    -progress_block_width(window_w, dpi)
}

fn progress_track_width(data: &SplashData) -> i32 {
    let rect = progress_track_rect(data);
    rect.right - rect.left
}

fn progress_block_width(window_w: i32, dpi: u32) -> i32 {
    let side_margin = scale_dpi(PROGRESS_SIDE_MARGIN, dpi);
    let track_width = window_w - (side_margin * 2);
    ((track_width as f32) * PROGRESS_BLOCK_WIDTH_RATIO).round() as i32
}

fn progress_block_offset(data: &SplashData, elapsed_secs: f32) -> i32 {
    let block_width = progress_block_width(data.window_w, data.dpi);
    let travel = (progress_track_width(data) + block_width) as f32;
    let cycle = (elapsed_secs * 1000.0 / ANIMATION_DURATION_MS).fract();
    (-(block_width as f32) + (travel * cycle)).round() as i32
}

fn point_in_rect(x: i32, y: i32, rect: &RECT) -> bool {
    x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
}

fn get_x_lparam(lparam: LPARAM) -> i32 {
    (lparam.0 as i16) as i32
}

fn get_y_lparam(lparam: LPARAM) -> i32 {
    ((lparam.0 >> 16) as i16) as i32
}

unsafe fn paint_progress_bar(hdc: HDC, data: &SplashData, block_offset_px: i32) {
    unsafe {
        let mut graphics = std::ptr::null_mut();
        if GdipCreateFromHDC(hdc, &mut graphics) != GDIP_OK || graphics.is_null() {
            return;
        }

        let _ = GdipSetSmoothingMode(graphics, SmoothingModeAntiAlias);

        let track_rect = progress_track_rect(data);
        let progress_radius = scale_dpi(PROGRESS_RADIUS, data.dpi).max(1);
        fill_rounded_rect(graphics, TRACK_COLOR, &track_rect, progress_radius);

        let block_width = progress_block_width(data.window_w, data.dpi);
        let block_rect = RECT {
            left: track_rect.left + block_offset_px,
            top: track_rect.top,
            right: track_rect.left + block_offset_px + block_width,
            bottom: track_rect.bottom,
        };

        let clip_path = create_rounded_rect_path(&track_rect, progress_radius);
        if !clip_path.is_null() {
            let _ = GdipSetClipPath(graphics, clip_path, CombineModeReplace);
            fill_rounded_rect(graphics, BLOCK_COLOR, &block_rect, progress_radius);
            let _ = GdipResetClip(graphics);
            let _ = GdipDeletePath(clip_path);
        }

        let _ = GdipDeleteGraphics(graphics);
    }
}

unsafe fn paint_launch_button(hdc: HDC, data: &SplashData, hovered: bool, label: &str) {
    unsafe {
        let mut graphics = std::ptr::null_mut();
        if GdipCreateFromHDC(hdc, &mut graphics) != GDIP_OK || graphics.is_null() {
            return;
        }

        let _ = GdipSetSmoothingMode(graphics, SmoothingModeAntiAlias);
        let button_rect = primary_button_rect(data);
        let button_radius = scale_dpi(BUTTON_RADIUS, data.dpi).max(1);
        fill_rounded_rect(
            graphics,
            if hovered {
                BUTTON_HOVER_BG_COLOR
            } else {
                BUTTON_BG_COLOR
            },
            &button_rect,
            button_radius,
        );
        let _ = GdipDeleteGraphics(graphics);

        let button_font = create_font(scale_dpi(BUTTON_FONT_SIZE, data.dpi), FW_MEDIUM.0 as i32);
        let old_font = SelectObject(hdc, button_font.into());
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, BUTTON_TEXT_COLOR);

        let mut label: Vec<u16> = label.encode_utf16().collect();
        let mut text_rect = button_rect;
        DrawTextW(
            hdc,
            &mut label,
            &mut text_rect,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE,
        );

        SelectObject(hdc, old_font);
        let _ = DeleteObject(button_font.into());
    }
}

unsafe fn paint_secondary_button(hdc: HDC, data: &SplashData, hovered: bool, label: &str) {
    unsafe {
        let button_rect = secondary_button_rect(data);
        let button_radius = scale_dpi(BUTTON_RADIUS, data.dpi).max(1);
        let mut graphics = std::ptr::null_mut();
        if GdipCreateFromHDC(hdc, &mut graphics) != GDIP_OK || graphics.is_null() {
            return;
        }

        let _ = GdipSetSmoothingMode(graphics, SmoothingModeAntiAlias);
        fill_rounded_rect(
            graphics,
            if hovered {
                SECONDARY_BUTTON_HOVER_BG_COLOR
            } else {
                SECONDARY_BUTTON_BG_COLOR
            },
            &button_rect,
            button_radius,
        );

        let path = create_rounded_rect_path(&button_rect, button_radius);
        if !path.is_null() {
            let mut pen = std::ptr::null_mut();
            if GdipCreatePen1(SECONDARY_BUTTON_BORDER_COLOR, 1.0, UnitPixel, &mut pen) == GDIP_OK
                && !pen.is_null()
            {
                let _ = GdipDrawPath(graphics, pen, path);
                let _ = GdipDeletePen(pen);
            }
            let _ = GdipDeletePath(path);
        }

        let _ = GdipDeleteGraphics(graphics);

        let button_font = create_font(scale_dpi(BUTTON_FONT_SIZE, data.dpi), FW_MEDIUM.0 as i32);
        let old_font = SelectObject(hdc, button_font.into());
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, SECONDARY_BUTTON_TEXT_COLOR);

        let mut label_text: Vec<u16> = label.encode_utf16().collect();
        let mut text_rect = button_rect;
        DrawTextW(
            hdc,
            &mut label_text,
            &mut text_rect,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE,
        );

        SelectObject(hdc, old_font);
        let _ = DeleteObject(button_font.into());
    }
}

unsafe fn paint_checkbox(hdc: HDC, data: &SplashData, checkbox: &CheckboxState) {
    unsafe {
        let mut graphics = std::ptr::null_mut();
        if GdipCreateFromHDC(hdc, &mut graphics) != GDIP_OK || graphics.is_null() {
            return;
        }

        let _ = GdipSetSmoothingMode(graphics, SmoothingModeAntiAlias);
        let box_rect = checkbox_box_rect(data);
        let radius = scale_dpi(4, data.dpi).max(1);
        fill_rounded_rect(
            graphics,
            if checkbox.checked {
                CHECKBOX_CHECK_COLOR
            } else {
                CHECKBOX_BG_COLOR
            },
            &box_rect,
            radius,
        );

        let path = create_rounded_rect_path(&box_rect, radius);
        if !path.is_null() {
            let mut pen = std::ptr::null_mut();
            if GdipCreatePen1(CHECKBOX_BORDER_COLOR, 1.0, UnitPixel, &mut pen) == GDIP_OK
                && !pen.is_null()
            {
                let _ = GdipDrawPath(graphics, pen, path);
                let _ = GdipDeletePen(pen);
            }
            let _ = GdipDeletePath(path);
        }

        if checkbox.checked {
            let mut pen = std::ptr::null_mut();
            if GdipCreatePen1(0xFFFFFFFF, 1.8, UnitPixel, &mut pen) == GDIP_OK && !pen.is_null() {
                let left = box_rect.left + scale_dpi(4, data.dpi);
                let mid_x = box_rect.left + scale_dpi(7, data.dpi);
                let right = box_rect.left + scale_dpi(12, data.dpi);
                let low_y = box_rect.top + scale_dpi(8, data.dpi);
                let mid_y = box_rect.top + scale_dpi(11, data.dpi);
                let high_y = box_rect.top + scale_dpi(5, data.dpi);
                let _ = GdipDrawLineI(graphics, pen, left, low_y, mid_x, mid_y);
                let _ = GdipDrawLineI(graphics, pen, mid_x, mid_y, right, high_y);
                let _ = GdipDeletePen(pen);
            }
        }

        let _ = GdipDeleteGraphics(graphics);

        let label_font = create_font(scale_dpi(CHECKBOX_FONT_SIZE, data.dpi), FW_MEDIUM.0 as i32);
        let old_font = SelectObject(hdc, label_font.into());
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, CHECKBOX_TEXT_COLOR);

        let mut text_rect = checkbox_row_rect(data);
        text_rect.left += scale_dpi(CHECKBOX_BOX_SIZE + CHECKBOX_LABEL_GAP, data.dpi);
        let mut label: Vec<u16> =
            localized_text(&checkbox.label_ko, &checkbox.label_en, data.use_korean)
                .encode_utf16()
                .collect();
        DrawTextW(
            hdc,
            &mut label,
            &mut text_rect,
            DT_LEFT | DT_VCENTER | DT_SINGLELINE,
        );

        SelectObject(hdc, old_font);
        let _ = DeleteObject(label_font.into());
    }
}

unsafe fn fill_rounded_rect(graphics: *mut GpGraphics, color: u32, rect: &RECT, radius: i32) {
    unsafe {
        let path = create_rounded_rect_path(rect, radius);
        if path.is_null() {
            return;
        }

        let mut brush = std::ptr::null_mut();
        if GdipCreateSolidFill(color, &mut brush) == GDIP_OK && !brush.is_null() {
            let _ = GdipFillPath(graphics, brush as *mut GpBrush, path);
            let _ = GdipDeleteBrush(brush as *mut GpBrush);
        }

        let _ = GdipDeletePath(path);
    }
}

unsafe fn create_rounded_rect_path(rect: &RECT, radius: i32) -> *mut GpPath {
    unsafe {
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return std::ptr::null_mut();
        }

        let mut path = std::ptr::null_mut();
        if GdipCreatePath(FillModeAlternate, &mut path) != GDIP_OK || path.is_null() {
            return std::ptr::null_mut();
        }

        let diameter = (radius * 2).min(width).min(height);
        if diameter <= 0 {
            let _ = GdipAddPathLineI(path, rect.left, rect.top, rect.right, rect.top);
            let _ = GdipAddPathLineI(path, rect.right, rect.top, rect.right, rect.bottom);
            let _ = GdipAddPathLineI(path, rect.right, rect.bottom, rect.left, rect.bottom);
            let _ = GdipClosePathFigure(path);
            return path;
        }

        let right = rect.right - diameter;
        let bottom = rect.bottom - diameter;
        let _ = GdipStartPathFigure(path);
        let _ = GdipAddPathArcI(path, rect.left, rect.top, diameter, diameter, 180.0, 90.0);
        let _ = GdipAddPathArcI(path, right, rect.top, diameter, diameter, 270.0, 90.0);
        let _ = GdipAddPathArcI(path, right, bottom, diameter, diameter, 0.0, 90.0);
        let _ = GdipAddPathArcI(path, rect.left, bottom, diameter, diameter, 90.0, 90.0);
        let _ = GdipClosePathFigure(path);
        path
    }
}

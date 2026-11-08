//! The co-op window: F9 anywhere in the game (title screen included) opens a small window over it with a session
//! name, a password, "Sukurti" (host) and "Prisijungti" (join). Plain Win32 on its own thread, so the game never
//! waits for it. Loaded at game start because the ASI loader loads coopnet64.asi.


use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Graphics::Gdi::*;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentProcessId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, SetFocus, VK_F9};
use windows_sys::Win32::UI::WindowsAndMessaging::*;


const ID_NAME: i32 = 101;
const ID_PW: i32 = 102;
const ID_HOST: i32 = 103;
const ID_JOIN: i32 = 104;
const ID_STATUS: i32 = 105;
const TIMER: usize = 1;

#[allow(dead_code)]
pub(crate) fn wide(s: &str) -> Vec<u16> {
    w(s)
}

fn w(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// Watches F9 while one of the game's windows has focus. Runs for the life of the game.
pub fn hotkey_thread() {
    let mut was = false;
    loop {
        std::thread::sleep(std::time::Duration::from_millis(40));
        let down = unsafe { GetAsyncKeyState(VK_F9 as i32) } as u16 & 0x8000 != 0;
        // F9 toggles the co-op menu drawn inside the game (the Win32 window is only a fallback, see run_window)
        if down && !was && game_has_focus() {
            crate::overlay::toggle();
        }
        was = down;
    }
}

fn game_has_focus() -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, &mut pid);
        !fg.is_null() && pid == GetCurrentProcessId()
    }
}

unsafe fn text_of(hwnd: HWND, id: i32) -> String {
    let ctl = GetDlgItem(hwnd, id);
    let mut buf = [0u16; 64];
    let n = GetWindowTextW(ctl, buf.as_mut_ptr(), buf.len() as i32);
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn status_text() -> &'static str {
    match crate::status_code() {
        1 => "Jungiamasi per Steam...",
        2 => "Prisijungta. Įkelk išsaugojimą arba grįžk į žaidimą.",
        3 => "Serveris nepriėmė.",
        5 => "Tokios sesijos nėra. Patikrink pavadinimą.",
        6 => "Neteisingas slaptažodis.",
        7 => "Steam nepasiekiamas. Ar Steam įjungtas?",
        8 => "Sesija pilna (4 žaidėjai).",
        _ => "Įvesk sesijos pavadinimą ir slaptažodį.",
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_COMMAND => {
            let id = (wp & 0xffff) as i32;
            if id == ID_HOST || id == ID_JOIN {
                let name = text_of(hwnd, ID_NAME).trim().to_string();
                let pw = text_of(hwnd, ID_PW);
                if name.is_empty() {
                    SetWindowTextW(GetDlgItem(hwnd, ID_STATUS), w("Pirma įvesk pavadinimą.").as_ptr());
                } else {
                    crate::start_steam_session(id == ID_HOST, name, pw);
                }
            }
            0
        }
        WM_TIMER => {
            SetWindowTextW(GetDlgItem(hwnd, ID_STATUS), w(status_text()).as_ptr());
            0
        }
        WM_CLOSE => {
            DestroyWindow(hwnd);
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

#[allow(dead_code)]
unsafe fn run_window() {
    let inst = GetModuleHandleW(std::ptr::null());
    let class = w("SaCoopWindow");
    let wc = WNDCLASSW {
        style: 0,
        lpfnWndProc: Some(wndproc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: inst,
        hIcon: std::ptr::null_mut(),
        hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
        hbrBackground: (COLOR_WINDOW + 1) as usize as HBRUSH,
        lpszMenuName: std::ptr::null(),
        lpszClassName: class.as_ptr(),
    };
    RegisterClassW(&wc); // a second registration fails harmlessly
    let (sw, sh) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
    let (ww, wh) = (380, 250);
    let hwnd = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
        class.as_ptr(),
        w("SA Co-op").as_ptr(),
        WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
        (sw - ww) / 2,
        (sh - wh) / 2,
        ww,
        wh,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        inst,
        std::ptr::null(),
    );
    if hwnd.is_null() {
        return;
    }
    let font = GetStockObject(DEFAULT_GUI_FONT);
    let add = |cls: &str, text: &str, style: u32, x: i32, y: i32, cw: i32, ch: i32, id: i32| {
        let c = CreateWindowExW(
            if cls == "EDIT" { WS_EX_CLIENTEDGE } else { 0 },
            w(cls).as_ptr(),
            w(text).as_ptr(),
            WS_CHILD | WS_VISIBLE | style,
            x, y, cw, ch,
            hwnd,
            id as isize as HMENU,
            inst,
            std::ptr::null(),
        );
        SendMessageW(c, WM_SETFONT, font as usize, 1);
    };
    add("STATIC", "Sesijos pavadinimas:", 0, 16, 16, 340, 18, 0);
    add("EDIT", "", WS_TABSTOP | ES_AUTOHSCROLL as u32, 16, 36, 340, 24, ID_NAME);
    add("STATIC", "Slaptažodis:", 0, 16, 70, 340, 18, 0);
    add("EDIT", "", WS_TABSTOP | ES_AUTOHSCROLL as u32 | ES_PASSWORD as u32, 16, 90, 340, 24, ID_PW);
    add("BUTTON", "Sukurti", WS_TABSTOP | BS_DEFPUSHBUTTON as u32, 16, 128, 165, 30, ID_HOST);
    add("BUTTON", "Prisijungti", WS_TABSTOP | BS_PUSHBUTTON as u32, 191, 128, 165, 30, ID_JOIN);
    add("STATIC", status_text(), 0, 16, 170, 340, 36, ID_STATUS);
    SetTimer(hwnd, TIMER, 500, None);
    SetForegroundWindow(hwnd);
    SetFocus(GetDlgItem(hwnd, ID_NAME));

    let mut msg: MSG = std::mem::zeroed();
    while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
        if IsDialogMessageW(hwnd, &msg) == 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

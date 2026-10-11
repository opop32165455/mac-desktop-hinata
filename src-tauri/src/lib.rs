//! PURPLE · 片刻 的独立应用外壳（只支持 macOS）。
//! 每块显示器一个无边框的全屏窗口，垫在所有应用窗口和 Dock 下面；视频作为打包资源经 asset 协议读取。
//! 不依赖 Plash、本地 http 服务或 osascript，也不改写系统桌面图片。

use std::{
    ffi::{c_char, c_void, CStr},
    fs,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, Wry,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

static HIDDEN: AtomicBool = AtomicBool::new(false);
/// true = 可操作（盖住桌面图标，能点击）；false = 纯壁纸（在桌面图标下面，界面收起）。
static INTERACTIVE: AtomicBool = AtomicBool::new(true);
/// 每次重建窗口换一批标签：旧窗口的销毁是异步的，标签不能马上复用。
static GENERATION: AtomicUsize = AtomicUsize::new(0);
/// 当前窗口对应的显示器布局 (x, y, w, h)，用来发现显示器的增减和分辨率变化。
static LAYOUT: Mutex<Vec<(i32, i32, u32, u32)>> = Mutex::new(Vec::new());

struct TrayItems {
    hidden: MenuItem<Wry>,
    wallpaper: CheckMenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
}

fn sync_tray(app: &AppHandle) {
    let Some(items) = app.try_state::<TrayItems>() else { return };
    let _ = items.hidden.set_text(if HIDDEN.load(Ordering::SeqCst) { "展示壁纸" } else { "隐藏壁纸" });
    let _ = items.wallpaper.set_checked(!INTERACTIVE.load(Ordering::SeqCst));
    let _ = items.autostart.set_checked(app.autolaunch().is_enabled().unwrap_or(false));
}

/// 隐藏 / 展示壁纸：一键藏起或恢复所有桌面窗口，并通知前端静音。
fn toggle_hidden(app: &AppHandle) {
    let hidden = !HIDDEN.load(Ordering::SeqCst);
    HIDDEN.store(hidden, Ordering::SeqCst);
    for (_, w) in app.webview_windows() {
        let _ = if hidden { w.hide() } else { w.show() };
    }
    let _ = app.emit("wallpaper-hidden", hidden);
    sync_tray(app);
}

/// 模式记在应用的配置目录里，下次启动（包括登录时自动启动）沿用。
fn mode_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("mode"))
}

fn toggle_interactive(app: &AppHandle) {
    let interactive = !INTERACTIVE.load(Ordering::SeqCst);
    INTERACTIVE.store(interactive, Ordering::SeqCst);
    if let Some(file) = mode_file(app) {
        if let Some(dir) = file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(file, if interactive { "interactive" } else { "wallpaper" });
    }
    for (_, w) in app.webview_windows() {
        set_level(&w, interactive);
    }
    let _ = app.emit("interactive-mode", interactive);
    sync_tray(app);
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowLevelForKey(key: i32) -> i32;
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *mut c_void;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(object: *mut c_void);
}

/// 窗口层级。数值随系统版本不同，必须运行时查询：2 = 桌面，18 = 桌面图标。
/// 纯壁纸：桌面 + 1（系统壁纸之上、桌面图标之下）。
/// 可操作：桌面图标 + 2，能接收点击，仍在所有应用窗口（0）和 Dock（20）之下。
/// 不能用「图标 + 1」：系统在那一层放了菜单栏的衬底窗口，同层时上下顺序不固定，菜单栏下方会出现时有时无的亮带。
fn set_level(window: &WebviewWindow, interactive: bool) {
    use objc2::{msg_send, runtime::AnyObject};
    const BEHAVIOR: usize = 1 /* canJoinAllSpaces */ | 16 /* stationary */ | 64 /* ignoresCycle */;
    let (desktop, icons) = unsafe { (CGWindowLevelForKey(2) as isize, CGWindowLevelForKey(18) as isize) };
    let level = if interactive { icons + 2 } else { desktop + 1 };
    if let Ok(ptr) = window.ns_window() {
        unsafe {
            let ns: &AnyObject = &*(ptr as *mut AnyObject);
            let _: () = msg_send![ns, setLevel: level];
            let _: () = msg_send![ns, setCollectionBehavior: BEHAVIOR];
        }
    }
}

/// 用户是否在看桌面：最前面的应用是桌面本身（本应用 / 访达 / 程序坞 / 控制中心等），
/// 或者它在屏幕上没有任何普通窗口。只读应用标识与窗口位置，不需要屏幕录制权限。必须在主线程调用。
fn on_desktop() -> bool {
    use objc2::{class, msg_send, runtime::AnyObject};
    const DESKTOP_APPS: [&str; 6] = [
        "com.apple.finder",
        "com.apple.dock",
        "com.apple.controlcenter",
        "com.apple.notificationcenterui",
        "com.apple.WindowManager",
        "com.apple.loginwindow",
    ];
    unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let front: *mut AnyObject = msg_send![workspace, frontmostApplication];
        if front.is_null() {
            return true;
        }
        let pid: i32 = msg_send![front, processIdentifier];
        if pid == std::process::id() as i32 {
            return true;
        }
        let bundle: *mut AnyObject = msg_send![front, bundleIdentifier];
        if !bundle.is_null() {
            let utf8: *const c_char = msg_send![bundle, UTF8String];
            if !utf8.is_null() && DESKTOP_APPS.contains(&CStr::from_ptr(utf8).to_str().unwrap_or("")) {
                return true;
            }
        }

        // 1 = 只要屏幕上的窗口，16 = 排除桌面元素。返回的 CFArray / CFDictionary 可直接当 NSArray / NSDictionary 用。
        let list = CGWindowListCopyWindowInfo(1 | 16, 0);
        if list.is_null() {
            return true;
        }
        let key = |name: &CStr| -> *mut AnyObject { msg_send![class!(NSString), stringWithUTF8String: name.as_ptr()] };
        let int = |dict: *mut AnyObject, name: &CStr| -> i32 {
            let value: *mut AnyObject = msg_send![dict, objectForKey: key(name)];
            if value.is_null() { -1 } else { msg_send![value, intValue] }
        };
        let windows = list as *mut AnyObject;
        let count: usize = msg_send![windows, count];
        let mut has_window = false;
        for i in 0..count {
            let info: *mut AnyObject = msg_send![windows, objectAtIndex: i];
            if int(info, c"kCGWindowOwnerPID") != pid || int(info, c"kCGWindowLayer") != 0 {
                continue;
            }
            let bounds: *mut AnyObject = msg_send![info, objectForKey: key(c"kCGWindowBounds")];
            // 忽略应用自己留在屏幕上的小辅助窗口
            if !bounds.is_null() && int(bounds, c"Width") >= 100 && int(bounds, c"Height") >= 100 {
                has_window = true;
                break;
            }
        }
        CFRelease(list);
        !has_window
    }
}

fn monitor_layout(app: &AppHandle) -> Vec<(i32, i32, u32, u32)> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| (m.position().x, m.position().y, m.size().width, m.size().height))
        .collect()
}

/// 为每块显示器创建一个覆盖整屏（含菜单栏和 Dock 后面）的窗口，替换掉旧的。
fn create_screen_windows(app: &AppHandle) -> tauri::Result<()> {
    let old: Vec<WebviewWindow> = app.webview_windows().into_values().collect();
    let layout = monitor_layout(app);
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst);
    let interactive = INTERACTIVE.load(Ordering::SeqCst);
    for (i, &(x, y, w, h)) in layout.iter().enumerate() {
        // 主屏的原点是 (0, 0)。只有主屏出声，其余屏幕静音，避免几块屏幕各放一遍声音。
        let script = format!("window.__PURPLE_SHELL__={{interactive:{interactive},primary:{}}};", x == 0 && y == 0);
        let window = WebviewWindowBuilder::new(app, format!("screen-{generation}-{i}"), WebviewUrl::App("index.html".into()))
            .title("Purple Moment")
            .initialization_script(&script)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .visible(false)
            .build()?;
        window.set_position(PhysicalPosition::new(x, y))?;
        window.set_size(PhysicalSize::new(w, h))?;
        set_level(&window, interactive);
        if !HIDDEN.load(Ordering::SeqCst) {
            window.show()?;
        }
    }
    *LAYOUT.lock().unwrap() = layout;
    for window in old {
        let _ = window.destroy();
    }
    Ok(())
}

/// 每秒一次（主线程）：显示器布局变了就重建窗口；把「是否在看桌面」告诉前端，用于离开时静音。
fn tick(app: &AppHandle) {
    let layout = monitor_layout(app);
    if !layout.is_empty() && layout != *LAYOUT.lock().unwrap() {
        let _ = create_screen_windows(app);
    }
    let _ = app.emit("app-active", !HIDDEN.load(Ordering::SeqCst) && on_desktop());
}

pub fn run() {
    tauri::Builder::default()
        // 只允许运行一个实例：重复启动会叠出两层全屏窗口。
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_hidden(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            app.set_activation_policy(tauri::ActivationPolicy::Accessory); // 不占 Dock 图标
            let handle = app.handle().clone();

            let wallpaper = mode_file(&handle).and_then(|file| fs::read_to_string(file).ok()).is_some_and(|mode| mode.trim() == "wallpaper");
            INTERACTIVE.store(!wallpaper, Ordering::SeqCst);
            create_screen_windows(&handle)?;

            // 隐藏 / 展示壁纸的快捷键 Cmd + Option + Shift + H（Cmd + Option + H 是系统的「隐藏其他」，不能占用）。
            // 被别的应用占用时注册会失败，不影响启动，菜单栏里仍可操作。
            let _ = app.global_shortcut().register(Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT | Modifiers::SHIFT), Code::KeyH));

            // 快捷键直接显示在菜单项右侧，用户不用记。
            let hidden = MenuItem::with_id(app, "hidden", "隐藏壁纸", true, Some("Cmd+Alt+Shift+H"))?;
            let mode = CheckMenuItem::with_id(app, "wallpaper", "纯壁纸模式", true, wallpaper, None::<&str>)?;
            let autostart = CheckMenuItem::with_id(app, "autostart", "登录时自动启动", true, false, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 Purple Moment", true, None::<&str>)?;
            // 功能说明收在子菜单里，不占第一层。说明条目不可点击。
            let note = |text: &str| MenuItem::new(app, text, false, None::<&str>);
            let help = Submenu::with_items(
                app,
                "！功能说明",
                true,
                &[
                    &note("隐藏壁纸 / 展示壁纸")?,
                    &note("    一键把壁纸藏起来并静音，露出原来的系统桌面；再点一次恢复")?,
                    &note("    快捷键：⌥⇧⌘H（Option + Shift + Command + H），在任何应用里都能用")?,
                    &PredefinedMenuItem::separator(app)?,
                    &note("纯壁纸模式")?,
                    &note("    不勾选：可以点击换装、改设置，会盖住桌面图标")?,
                    &note("    勾选：界面全部收起，桌面图标露出来，画面不可点击")?,
                    &PredefinedMenuItem::separator(app)?,
                    &note("登录时自动启动")?,
                    &note("    开机登录后自动运行，不用每次手动打开")?,
                ],
            )?;
            let menu = Menu::with_items(
                app,
                &[&hidden, &mode, &autostart, &PredefinedMenuItem::separator(app)?, &help, &PredefinedMenuItem::separator(app)?, &quit],
            )?;
            app.manage(TrayItems { hidden, wallpaper: mode, autostart });
            sync_tray(&handle);
            TrayIconBuilder::new()
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true) // 单色剪影，随菜单栏深浅自动变白 / 黑
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "hidden" => toggle_hidden(app),
                    "wallpaper" => toggle_interactive(app),
                    "autostart" => {
                        let launcher = app.autolaunch();
                        let _ = if launcher.is_enabled().unwrap_or(false) { launcher.disable() } else { launcher.enable() };
                        sync_tray(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(1));
                let app = handle.clone();
                let _ = handle.run_on_main_thread(move || tick(&app));
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("启动失败")
        .run(|_app, event| {
            // 重建窗口时会短暂地一个窗口都没有，不能因此退出；只有菜单里的「退出」（带退出码）才真的退出。
            if let RunEvent::ExitRequested { api, code: None, .. } = event {
                api.prevent_exit();
            }
        });
}

//! Hinata Moment（PURPLE · 片刻）的独立应用外壳（只支持 macOS）。
//! 每块显示器一个无边框的全屏窗口，垫在所有应用窗口和 Dock 下面；视频作为打包资源经 asset 协议读取。
//! 不依赖 Plash、本地 http 服务或 osascript，也不改写系统桌面图片。

use std::{
    ffi::{c_void, CStr},
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

/// 各块屏幕是否被别的应用的普通窗口遮住一半以上。
/// 只看遮挡面积，不看谁是最前面的应用：点一下壁纸或访达，最前面的应用就成了桌面本身，但别的窗口仍然盖着桌面；
/// 反过来，「显示桌面」只是把窗口推到屏幕边缘外，最前面的应用仍然有窗口，桌面却已经露出来了。
/// `screens` 是各块屏幕的 (x, y, 宽, 高)，单位是点，原点在主屏左上角，与 kCGWindowBounds 一致。
/// 只读窗口位置，不需要屏幕录制权限。必须在主线程调用。
fn covered_screens(screens: &[[f64; 4]]) -> Vec<bool> {
    use objc2::{class, msg_send, runtime::AnyObject};
    let own = std::process::id() as i32;
    unsafe {
        // 1 = 只要屏幕上的窗口，16 = 排除桌面元素。返回的 CFArray / CFDictionary 可直接当 NSArray / NSDictionary 用。
        let list = CGWindowListCopyWindowInfo(1 | 16, 0);
        if list.is_null() {
            return vec![false; screens.len()];
        }
        let key = |name: &CStr| -> *mut AnyObject { msg_send![class!(NSString), stringWithUTF8String: name.as_ptr()] };
        let int = |dict: *mut AnyObject, name: &CStr| -> i32 {
            let value: *mut AnyObject = msg_send![dict, objectForKey: key(name)];
            if value.is_null() { -1 } else { msg_send![value, intValue] }
        };
        let float = |dict: *mut AnyObject, name: &CStr| -> f64 {
            let value: *mut AnyObject = msg_send![dict, objectForKey: key(name)];
            if value.is_null() { 0.0 } else { msg_send![value, doubleValue] }
        };
        let windows = list as *mut AnyObject;
        let count: usize = msg_send![windows, count];
        let mut rects: Vec<[f64; 4]> = Vec::new();
        for i in 0..count {
            let info: *mut AnyObject = msg_send![windows, objectAtIndex: i];
            if int(info, c"kCGWindowOwnerPID") == own || int(info, c"kCGWindowLayer") != 0 || float(info, c"kCGWindowAlpha") <= 0.0 {
                continue;
            }
            let bounds: *mut AnyObject = msg_send![info, objectForKey: key(c"kCGWindowBounds")];
            if bounds.is_null() {
                continue;
            }
            let rect = [float(bounds, c"X"), float(bounds, c"Y"), float(bounds, c"Width"), float(bounds, c"Height")];
            // 忽略应用留在屏幕上的小辅助窗口
            if rect[2] < 100.0 || rect[3] < 100.0 {
                continue;
            }
            rects.push(rect);
        }
        CFRelease(list);
        screens.iter().map(|screen| coverage(screen, &rects) >= 0.5).collect()
    }
}

/// 一组窗口（可以互相重叠）盖住了屏幕的多大比例，0 到 1。矩形都是 (x, y, 宽, 高)。
fn coverage(screen: &[f64; 4], windows: &[[f64; 4]]) -> f64 {
    let [sx, sy, sw, sh] = *screen;
    if sw <= 0.0 || sh <= 0.0 {
        return 0.0;
    }
    // 裁到屏幕范围内，换成 (左, 上, 右, 下)
    let clipped: Vec<[f64; 4]> = windows
        .iter()
        .map(|&[x, y, w, h]| [x.max(sx), y.max(sy), (x + w).min(sx + sw), (y + h).min(sy + sh)])
        .filter(|r| r[2] > r[0] && r[3] > r[1])
        .collect();
    let mut xs: Vec<f64> = clipped.iter().flat_map(|r| [r[0], r[2]]).collect();
    xs.sort_by(f64::total_cmp);
    xs.dedup();
    // 按竖条累加：每一条里把落在其中的窗口的上下区间合并后求长度
    let mut area = 0.0;
    for strip in xs.windows(2) {
        let mut spans: Vec<(f64, f64)> = clipped.iter().filter(|r| r[0] <= strip[0] && r[2] >= strip[1]).map(|r| (r[1], r[3])).collect();
        spans.sort_by(|a, b| a.0.total_cmp(&b.0));
        let (mut height, mut end) = (0.0, f64::NEG_INFINITY);
        for (top, bottom) in spans {
            if bottom > end {
                height += bottom - top.max(end);
                end = bottom;
            }
        }
        area += height * (strip[1] - strip[0]);
    }
    area / (sw * sh)
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
        let label = format!("screen-{generation}-{i}");
        let script = format!("window.__PURPLE_SHELL__={{interactive:{interactive},primary:{},label:'{label}'}};", x == 0 && y == 0);
        let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
            .title("Hinata Moment")
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

/// 每秒一次（主线程）：显示器布局变了就重建窗口；把桌面的状态告诉前端，用于离开时静音、被遮住时暂停。
/// 事件内容是被遮住一半以上的窗口的标签。壁纸隐藏时所有窗口都算被遮住。
fn tick(app: &AppHandle) {
    let layout = monitor_layout(app);
    if !layout.is_empty() && layout != *LAYOUT.lock().unwrap() {
        let _ = create_screen_windows(app);
    }
    let windows: Vec<WebviewWindow> = app.webview_windows().into_values().collect();
    // 窗口铺满各自的屏幕，它的位置和大小（换算成点）就是屏幕的范围
    let screens: Vec<[f64; 4]> = windows
        .iter()
        .map(|w| {
            let scale = w.scale_factor().unwrap_or(1.0);
            let (position, size) = (w.outer_position().unwrap_or_default(), w.outer_size().unwrap_or_default());
            [position.x as f64 / scale, position.y as f64 / scale, size.width as f64 / scale, size.height as f64 / scale]
        })
        .collect();
    let hidden = HIDDEN.load(Ordering::SeqCst);
    let covered = covered_screens(&screens);
    let covered: Vec<&str> = windows.iter().zip(&covered).filter(|(_, &c)| hidden || c).map(|(w, _)| w.label()).collect();
    let _ = app.emit("app-active", covered);
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
            let quit = MenuItem::with_id(app, "quit", "退出 Hinata Moment", true, None::<&str>)?;
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

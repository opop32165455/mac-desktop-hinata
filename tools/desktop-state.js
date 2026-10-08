// PURPLE · 片刻 —— 常驻助手：判断「用户是否在看桌面」（离开桌面时静音），并让系统桌面图片跟随当前穿搭（菜单栏跟随衣橱）。
//
// 用 macOS 自带的 osascript（JavaScript for Automation）运行，不需要安装任何东西：
//   /usr/bin/osascript -l JavaScript tools/desktop-state.js OUTPUT.json [阈值] [项目目录]
//   /usr/bin/osascript -l JavaScript tools/desktop-state.js --restore STATE_DIR    （卸载时恢复原桌面图片）
//
// 每秒输出一次状态到 JSON，由本地 Apache 以 /desktop-state 提供给页面：
//   {"onDesktop":true,"covered":0.12,"front":"Finder","at":1760000000}
//
// 「不在桌面」由两个条件判定，满足其一即可：
//   1. 最前面的应用不是「桌面本身」（访达 / 程序坞 / 控制中心 / Plash 等），并且它在
//      主屏上有一个可见的普通窗口 —— 也就是「你正在用别的程序」。
//      这一条是主判据：切到别的程序就静音，小窗口（覆盖率判不到）也照样静音。
//   2. 普通层级（layer 0）的窗口挡住主屏超过阈值（默认 0.5，即一半）的比例 —— 兜底，
//      覆盖「前台仍是访达、但桌面已被大窗口盖住」这类情况。
//
// 阈值为什么是 0.5 而不是 0.75：单个「大但没最大化」的窗口在 1920×1080 上通常占 50%–70%，
// 0.75 的门槛几乎只有铺满全屏才够得到，切到程序里也一直有声音。按用户要求「占用超过一半就静音」。
//
// 只读取窗口的位置、所属应用与最前面应用的名称，不读取窗口内容或标题，
// 因此不需要「屏幕录制」权限。at 是写入时间（秒），页面据此判断这个文件是否还在更新
// （助手停了就不再静音）。
//
// 由 launchd 常驻（tools/plash-setup.sh 安装），API 均为 macOS 10.10 起就有的。
ObjC.import('AppKit');
ObjC.import('CoreGraphics');

const COLS = 96, ROWS = 54;
// 小于这个边长的窗口（浮窗、提示条、迷你播放器）不算「正在用的程序」。
const MIN_WINDOW = 40;
// 这些应用本身就是「桌面」的一部分：它们在最前面时，用户看的还是桌面。
const DESKTOP_BUNDLES = {
  'com.apple.finder': 1,
  'com.apple.dock': 1,
  'com.apple.controlcenter': 1,
  'com.apple.systemuiserver': 1,
  'com.apple.notificationcenterui': 1,
  'com.sindresorhus.Plash': 1
};
// 按名字再兜一层（Bundle ID 读取失败时用）。
const DESKTOP_NAMES = {'Finder': 1, 'Plash': 1};

// 最前面的应用：是否是「桌面本身」，以及它的进程号（用来找它的窗口）。
function frontApp() {
  try {
    const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!app || app.isNil()) return {pid: 0, name: '', away: false};
    const bundle = app.bundleIdentifier ? app.bundleIdentifier.js : '';
    const name = app.localizedName ? app.localizedName.js : '';
    const desktop = Boolean(DESKTOP_BUNDLES[bundle] || DESKTOP_NAMES[name]);
    return {pid: app.processIdentifier, name: name, away: !desktop};
  } catch (_) {
    // 读不到就当作在看桌面：宁可多放声音，也不要莫名静音。
    return {pid: 0, name: '', away: false};
  }
}

function sample(threshold) {
  const frame = $.NSScreen.mainScreen.frame;
  const W = frame.size.width, H = frame.size.height;
  const info = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0);
  const windows = ObjC.deepUnwrap(ObjC.castRefToObject(info)) || [];
  const front = frontApp();
  const grid = new Uint8Array(COLS * ROWS);
  let frontOnMain = false;
  for (const w of windows) {
    // Plash 的壁纸窗口在桌面层级，不在 layer 0；这里再按名字排除一次以防万一。
    if (w.kCGWindowLayer !== 0 || w.kCGWindowOwnerName === 'Plash') continue;
    if (w.kCGWindowAlpha !== undefined && w.kCGWindowAlpha <= 0.05) continue;
    const b = w.kCGWindowBounds;
    if (!b) continue;
    const x0 = Math.max(0, b.X), y0 = Math.max(0, b.Y);
    const x1 = Math.min(W, b.X + b.Width), y1 = Math.min(H, b.Y + b.Height);
    if (x1 - x0 < MIN_WINDOW || y1 - y0 < MIN_WINDOW) continue;
    // 最前面的应用在主屏上有可见窗口吗？没有（窗口全收起、被隐藏）就不算离开桌面。
    if (front.pid && w.kCGWindowOwnerPID === front.pid) frontOnMain = true;
    for (let y = Math.floor(y0 / H * ROWS); y < Math.min(ROWS, Math.ceil(y1 / H * ROWS)); y++) {
      for (let x = Math.floor(x0 / W * COLS); x < Math.min(COLS, Math.ceil(x1 / W * COLS)); x++) grid[y * COLS + x] = 1;
    }
  }
  let count = 0;
  for (let i = 0; i < grid.length; i++) count += grid[i];
  const covered = count / grid.length;
  const away = (front.away && frontOnMain) || covered >= threshold;
  return {onDesktop: !away, covered: Math.round(covered * 1000) / 1000, front: front.name};
}

function write(path, text) {
  $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}

function readJSON(path) {
  try {
    const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
    return text && !text.isNil() ? JSON.parse(text.js) : null;
  } catch (_) { return null; }
}

/* ===== 菜单栏跟随衣橱 =====
 * Plash 的壁纸窗口从菜单栏下方开始，菜单栏那一条露出的是系统桌面图片。这里把主屏的系统
 * 桌面图片换成「与当前穿搭画面衔接」的图：背景层与页面 .ambient 一样铺满，定格图按页面的
 * 画面比例（完整 / 铺满）放在菜单栏下方，菜单栏那一条在画面上方没有内容时用画面顶边镜像补齐。
 *
 * 页面经 tools/wallpaper.cgi 写入 wallpaper-request.json（当前穿搭、画面比例、明暗、开关），
 * 这里每秒读一次；状态记在 wallpaper-sync.json：
 *   backup   接管前用户原来的桌面图片（file URL），关闭功能 / 卸载时恢复
 *   lastSet  最近一次设置的图片路径
 *   paused   用户自己换了桌面图片：不再跟随，也不覆盖用户的选择（关掉再打开开关即重新接管）
 * 只改主屏；macOS 的桌面图片按「每个空间」分别记录，切到别的空间时会在那个空间上补设一次。 */
const WALL_TAG = '/purple-desktop/wallpapers/';

function mainScreen() { return $.NSScreen.mainScreen; }

function currentDesktopURL() {
  const url = $.NSWorkspace.sharedWorkspace.desktopImageURLForScreen(mainScreen());
  return url && !url.isNil() ? url.absoluteString.js : '';
}

function setDesktop(url) {
  const ws = $.NSWorkspace.sharedWorkspace;
  const options = $.NSMutableDictionary.dictionary;
  options.setObjectForKey($.NSNumber.numberWithInteger($.NSImageScaleProportionallyUpOrDown), $.NSWorkspaceDesktopImageScalingKey);
  options.setObjectForKey($.NSNumber.numberWithBool(true), $.NSWorkspaceDesktopImageAllowClippingKey);
  return ws.setDesktopImageURLForScreenOptionsError($.NSURL.URLWithString(url), mainScreen(), options, null);
}

function fileURL(path) { return $.NSURL.fileURLWithPath(path).absoluteString.js; }

// 生成与页面顶边衔接的桌面图片（主屏像素尺寸），已存在且比素材新就直接复用。
function composeWallpaper(root, dir, look, fit, bright) {
  const scr = mainScreen(), f = scr.frame, vf = scr.visibleFrame, s = scr.backingScaleFactor;
  const W = Math.round(f.size.width * s), H = Math.round(f.size.height * s);
  const bar = Math.max(0, Math.round((f.origin.y + f.size.height - (vf.origin.y + vf.size.height)) * s));
  const out = dir + '/desktop-' + look + '-' + fit + '-' + bright + '-' + W + 'x' + H + '-' + bar + '.jpg';
  const stillPath = root + '/images/look-' + look + '.jpg', ambientPath = root + '/images/ambient-' + look + '.jpg';
  const fm = $.NSFileManager.defaultManager;
  if (fm.fileExistsAtPath(out)) {
    const outTime = fm.attributesOfItemAtPathError(out, null).fileModificationDate.timeIntervalSince1970;
    const srcTime = fm.attributesOfItemAtPathError(stillPath, null).fileModificationDate.timeIntervalSince1970;
    if (outTime >= srcTime) return out;
  }
  const still = $.NSImage.alloc.initWithContentsOfFile(stillPath);
  const ambient = $.NSImage.alloc.initWithContentsOfFile(ambientPath);
  if (still.isNil() || ambient.isNil()) return '';
  const iw = still.size.width, ih = still.size.height, aw = ambient.size.width, ah = ambient.size.height;
  const area = H - bar;
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, W, H, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  // 注意：必须调用 setCurrentContext()，给 currentContext 属性赋值不会生效（画出来是空白）。
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  const op = $.NSCompositingOperationSourceOver;
  const ak = Math.max(W / aw, H / ah);
  ambient.drawInRectFromRectOperationFraction($.NSMakeRect((W - aw * ak) / 2, (H - ah * ak) / 2, aw * ak, ah * ak), $.NSZeroRect, op, 1);
  const k = fit === 'cover' ? Math.max(W / iw, area / ih) : Math.min(W / iw, area / ih);
  const vw = iw * k, vh = ih * k, vx = (W - vw) / 2, top = bar + (area - vh) / 2;
  const y0 = H - top - vh;   // 绘图坐标原点在左下
  still.drawInRectFromRectOperationFraction($.NSMakeRect(vx, y0, vw, vh), $.NSZeroRect, op, 1);
  if (top > 0) {
    const srcH = top / k, t = $.NSAffineTransform.transform;
    t.translateXByYBy(0, 2 * (H - top)); t.scaleXByYBy(1, -1); t.concat;
    still.drawInRectFromRectOperationFraction($.NSMakeRect(vx, H - 2 * top, vw, top), $.NSMakeRect(0, ih - srcH, iw, srcH), op, 1);
    t.invert; t.concat;
  }
  if (bright < 100) {
    $.NSColor.colorWithCalibratedWhiteAlpha(0, 1 - bright / 100).setFill;
    $.NSBezierPath.fillRect($.NSMakeRect(vx, Math.max(0, y0), vw, H - Math.max(0, y0)));
  }
  $.NSGraphicsContext.restoreGraphicsState;
  fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), null);
  const data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypeJPEG, $({NSImageCompressionFactor: 0.9}));
  return data.writeToFileAtomically(out, true) ? out : '';
}

function syncWallpaper(root, stateDir) {
  const request = readJSON(stateDir + '/wallpaper-request.json');
  if (!request || !root) return;
  const syncPath = stateDir + '/wallpaper-sync.json';
  const sync = readJSON(syncPath) || {};
  const save = () => write(syncPath, JSON.stringify(sync));
  const current = currentDesktopURL();
  const ours = current.indexOf(WALL_TAG) !== -1;

  if (!request.enabled) {
    // 关闭：恢复原来的桌面图片（用户已自行换过就保留用户的）。
    if (sync.active && !sync.paused && sync.backup && ours) setDesktop(sync.backup);
    if (sync.active || sync.paused) write(syncPath, '{}');
    return;
  }
  if (sync.paused) return;
  if (sync.active && current && !ours && current !== sync.backup) {
    // 用户自己换了桌面图片：尊重用户，不再跟随（关掉再打开「菜单栏跟随衣橱」即重新接管）。
    sync.paused = true; sync.userChoice = current; save();
    return;
  }
  if (!sync.active) {
    if (!current || ours) return;   // 读不到原图时不接管，免得之后无法恢复
    sync.active = true; sync.backup = current;
  }
  const bright = Math.max(50, Math.min(150, Math.round(Number(request.b) || 100)));
  const path = composeWallpaper(root, stateDir + '/wallpapers', request.look, request.fit === 'cover' ? 'cover' : 'contain', bright);
  if (!path) return;
  const url = fileURL(path);
  // 当前空间显示的还是原图（刚接管，或切到了另一个空间）也补设一次。
  if (url !== current) {
    setDesktop(url);
    sync.lastSet = url;
    save();
  }
}

// 卸载时调用：恢复接管前的桌面图片。
function restoreWallpaper(stateDir) {
  const sync = readJSON(stateDir + '/wallpaper-sync.json') || {};
  if (sync.active && !sync.paused && sync.backup && currentDesktopURL().indexOf(WALL_TAG) !== -1) setDesktop(sync.backup);
  write(stateDir + '/wallpaper-sync.json', '{}');
  return 'restored';
}

function run(argv) {
  if (argv[0] === '--restore') return restoreWallpaper(argv[1]);
  const output = argv[0];
  const threshold = Number(argv[1]) || 0.5;
  const root = argv[2] || '';
  if (!output) return 'usage: osascript -l JavaScript desktop-state.js OUTPUT.json [threshold] [PROJECT_DIR]';
  // OUTPUT 位于 STATE_DIR/public/desktop-state.json
  const stateDir = $(output).stringByDeletingLastPathComponent.stringByDeletingLastPathComponent.js;
  for (;;) {
    // 必须用运行循环等待，不能用 delay()：delay() 会阻塞运行循环，NSWorkspace 收不到
    // 「前台应用变了」的通知，frontmostApplication 会一直停在进程刚启动时的那个应用
    // （实测：启动时是访达，之后切到别的程序仍然报访达）。
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(1));
    let state;
    try { state = sample(threshold); } catch (error) { state = {onDesktop: true, covered: 0, error: String(error)}; }
    state.at = Math.floor(Date.now() / 1000);
    write(output, JSON.stringify(state));
    try { syncWallpaper(root, stateDir); } catch (_) {}
  }
}

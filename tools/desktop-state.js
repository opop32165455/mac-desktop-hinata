// PURPLE · 片刻 —— 判断「用户是否在看桌面」，供「离开桌面时静音」使用。
//
// 用 macOS 自带的 osascript（JavaScript for Automation）运行，不需要安装任何东西：
//   /usr/bin/osascript -l JavaScript tools/desktop-state.js OUTPUT.json [阈值]
//
// 每秒统计一次主屏上普通层级（layer 0）的可见窗口覆盖了多大比例的屏幕，覆盖超过阈值
// （默认 0.75）就认为桌面被挡住。只读取窗口的位置与所属应用，不读取窗口内容或标题，
// 因此不需要「屏幕录制」权限。结果写成 JSON，由本地 Apache 以 /desktop-state 提供给页面：
//   {"onDesktop":true,"covered":0.12,"at":1760000000}
// at 是写入时间（秒），页面据此判断这个文件是否还在更新（助手停了就不再静音）。
//
// 由 launchd 常驻（tools/plash-setup.sh 安装），API 均为 macOS 10.10 起就有的。
ObjC.import('AppKit');
ObjC.import('CoreGraphics');

const COLS = 96, ROWS = 54;

function sample(threshold) {
  const frame = $.NSScreen.mainScreen.frame;
  const W = frame.size.width, H = frame.size.height;
  const info = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0);
  const windows = ObjC.deepUnwrap(ObjC.castRefToObject(info)) || [];
  const grid = new Uint8Array(COLS * ROWS);
  for (const w of windows) {
    // Plash 的壁纸窗口在桌面层级，不在 layer 0；这里再按名字排除一次以防万一。
    if (w.kCGWindowLayer !== 0 || w.kCGWindowOwnerName === 'Plash') continue;
    if (w.kCGWindowAlpha !== undefined && w.kCGWindowAlpha <= 0.05) continue;
    const b = w.kCGWindowBounds;
    if (!b) continue;
    const x0 = Math.max(0, b.X), y0 = Math.max(0, b.Y);
    const x1 = Math.min(W, b.X + b.Width), y1 = Math.min(H, b.Y + b.Height);
    if (x1 - x0 < 40 || y1 - y0 < 40) continue;
    for (let y = Math.floor(y0 / H * ROWS); y < Math.min(ROWS, Math.ceil(y1 / H * ROWS)); y++) {
      for (let x = Math.floor(x0 / W * COLS); x < Math.min(COLS, Math.ceil(x1 / W * COLS)); x++) grid[y * COLS + x] = 1;
    }
  }
  let count = 0;
  for (let i = 0; i < grid.length; i++) count += grid[i];
  const covered = count / grid.length;
  return {onDesktop: covered < threshold, covered: Math.round(covered * 1000) / 1000};
}

function write(path, text) {
  $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}

function run(argv) {
  const output = argv[0];
  const threshold = Number(argv[1]) || 0.75;
  if (!output) return 'usage: osascript -l JavaScript desktop-state.js OUTPUT.json [threshold]';
  for (;;) {
    let state;
    try { state = sample(threshold); } catch (error) { state = {onDesktop: true, covered: 0, error: String(error)}; }
    state.at = Math.floor(Date.now() / 1000);
    write(output, JSON.stringify(state));
    delay(1);
  }
}

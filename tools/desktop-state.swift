// PURPLE · 片刻 —— 判断「用户是否在看桌面」，供 plash-server.py 的 /desktop-state 使用。
//
// 统计主显示器上普通层级（layer 0）的可见窗口覆盖了多大比例的屏幕：
// 覆盖超过阈值，就认为桌面被挡住、用户不在看壁纸。
// 只读取窗口的位置与所属应用，不读取窗口内容或标题，因此不需要「屏幕录制」权限。
//
// 输出一行 JSON：{"onDesktop":true,"covered":0.12}
// 由 plash-server.py 首次需要时用 swiftc 编译到缓存目录，无需手动构建。
import CoreGraphics
import Foundation

let threshold = Double(CommandLine.arguments.dropFirst().first ?? "") ?? 0.8
let screen = CGDisplayBounds(CGMainDisplayID())
let cols = 96, rows = 54
var grid = [Bool](repeating: false, count: cols * rows)
let selfPid = ProcessInfo.processInfo.processIdentifier

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let windows = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
for info in windows {
  guard (info[kCGWindowLayer as String] as? Int) == 0,
        (info[kCGWindowAlpha as String] as? Double ?? 1) > 0.05,
        (info[kCGWindowOwnerPID as String] as? Int32) != selfPid,
        let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
        let bounds = CGRect(dictionaryRepresentation: boundsDict) else { continue }
  // Plash 的壁纸窗口在桌面层级，不会出现在 layer 0；这里再按名字排除一次以防万一。
  if (info[kCGWindowOwnerName as String] as? String) == "Plash" { continue }
  let rect = bounds.intersection(screen)
  if rect.isNull || rect.width < 40 || rect.height < 40 { continue }
  let x0 = Int(((rect.minX - screen.minX) / screen.width * Double(cols)).rounded(.down))
  let x1 = Int(((rect.maxX - screen.minX) / screen.width * Double(cols)).rounded(.up))
  let y0 = Int(((rect.minY - screen.minY) / screen.height * Double(rows)).rounded(.down))
  let y1 = Int(((rect.maxY - screen.minY) / screen.height * Double(rows)).rounded(.up))
  for y in max(0, y0)..<min(rows, y1) {
    for x in max(0, x0)..<min(cols, x1) { grid[y * cols + x] = true }
  }
}
let covered = Double(grid.filter { $0 }.count) / Double(grid.count)
print("{\"onDesktop\":\(covered < threshold),\"covered\":\(String(format: "%.3f", covered))}")

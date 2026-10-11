# AGENTS.md —— 给 AI 编程助手

面向人的说明在 [README.md](README.md)。这里是修改代码前需要知道、但从代码里不容易看出来的事实。

## 规则

- 不要修改用户的系统音量、静音、桌面图片或任何系统设置；需要用户手动做的事列给用户。
- 应用是独立的：不依赖 Plash、本地 http 服务、osascript 或任何需要用户另外安装的东西。
- 应用启动后会铺满全屏。窗口层级改错会盖住用户的所有应用和 Dock，动层级之前先读下面「窗口层级」，改完用 `CGWindowListCopyWindowInfo` 查实际层级。
- 原作归 B 站 FRAC_LAB 所有，界面里的署名和 README 的声明不要删。

## 打包与发布

需要 Rust、Node.js 和 Xcode 命令行工具。

- `npm install` 后 `npm run build`：通用版（Apple 芯片 + Intel，需要 `rustup target add x86_64-apple-darwin`），产物在 `src-tauri/target/universal-apple-darwin/release/bundle/`。只打本机架构用 `npm run build:arm`。
- 发布：把 DMG 改名为 `PurpleMoment-版本号-universal.dmg`（原文件名带空格）传到 GitHub Release。版本号在 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 三处。
- 只有临时签名（ad-hoc），没有 Apple 公证，用户第一次打开要到「隐私与安全性」点「仍要打开」。
- 打包失败后可能留下挂载着的 `rw.*.dmg`（在 `bundle/macos/`），先 `hdiutil detach` 再删掉，否则下一次 DMG 步骤会失败。
- `.gitignore` 里的 `Icon?` 会匹配到 `src-tauri/icons`，往里加文件要 `git add -f`。

## 结构

- **前端**在仓库根目录，纯静态、没有打包器：`index.html`、`app.js`（一个大的 IIFE）、`catalog.js`（穿搭数据）、`images/`。打包前 `tools/app-stage.sh` 把它们拷到 `build/app-frontend/`：Tauri 会把前端目录整个嵌进可执行文件，不能直接指向根目录。
- **视频是打包资源**：`media/` 经 `tauri.conf.json` 的 `bundle.resources` 放进应用的资源目录，运行时经 asset 协议读取（范围 `$RESOURCE/media/**`，支持 Range）。不要放进前端目录。
- **外壳**：`src-tauri/src/lib.rs` 是全部原生逻辑，一个文件。
- **外壳与页面的接口**：`native-adapter.js`（先于 `app.js` 加载，只在应用里生效）提供 `window.PURPLE_NATIVE`，`app.js` 里用到 `NATIVE` 的地方都是为它准备的；样式在 `native.css`。外壳发三个事件：`app-active`（每秒一次，是否在看桌面）、`boss-key`（是否已隐藏）、`interactive-mode`。`<html>` 上的 `is-native`、`is-interactive` 两个类区分状态。
- **离开桌面时静音**：外壳每秒在主线程判断一次，最前面的应用是桌面本身（本应用 / 访达 / 程序坞 / 控制中心），或它在屏幕上没有普通窗口，才算在看桌面。只读应用标识和窗口位置，不需要屏幕录制权限。
- **多显示器**：每块屏幕一个窗口，只有主屏出声；显示器增减或分辨率变化时整批重建窗口。只在单显示器上实际运行过。
- **模式记忆**：纯壁纸 / 可操作记在 `~/Library/Application Support/com.purplemoment.desktop/mode`。页面偏好在 WebView 的 `localStorage`。

## 窗口层级

层级数值随系统版本不同，**不能写死**，运行时用 `CGWindowLevelForKey` 查（2 = 桌面，18 = 桌面图标）。

| 模式 | 层级 | 原因 |
| --- | --- | --- |
| 纯壁纸 | 桌面 + 1 | 系统壁纸之上、桌面图标之下 |
| 可操作 | 桌面图标 + 2 | 能接收点击，仍在所有应用窗口（0）和 Dock（20）之下 |

可操作模式必须是「图标 + 2」：系统在「图标 + 1」放了菜单栏的衬底窗口，同层时上下顺序不固定，菜单栏下方会出现时有时无的亮带。不要用高于 0 的层级：全屏窗口会挡住所有应用和 Dock。

窗口被完全挡住时 WebKit 不绘制：验证画面时如果另一个全屏壁纸应用盖在上面，截到的是一片灰，不是出错。

## 修改代码前要知道的

- **往复循环**：每个视频是「正放 + 倒放」合并文件（HTML5 视频不支持负向播放）。片尾转向在文件内部连续完成；折返点转向由两个 `<video>` 牌组接力（备用牌组预滚、在折返帧会合后只对调层级，会合时机按实测偏差自适应）。细节见 `app.js` 的 watchFrames / preparePivot / swapLoopDecks 注释。
- **折返点**：`catalog.js` 每套的 `pivot`（秒，对齐 1/60）。取在最后一次明显鞋跟声之后、动作最静止的帧。片尾约 12.0 秒，素材之后没有内容。
- **声音**：每套第一次正放有声音，进入循环后音量淡到 0；切换穿搭的倒带恢复声音。一律通过**音量**实现，不切换 `muted`（WebKit 无手势取消静音会暂停视频）。不使用 Web Audio。
- **视频**：`media/look-XX.mp4`，HEVC（hvc1）CRF 14，3840×2160，60fps，0.5 秒闭合 GOP，每个 36 到 49MB；正放取母版前 N 帧（去掉末尾 2 帧跳变），倒放为 N-2…0 再补一帧 0；倒放段音轨保留脚步声（每一下仍正着播放，对准落脚帧）。
  **不要改成 H.264 或提高码率**：试过 H.264 4K60（约 1GB），内存占用大得多。
  重新生成需要 ffmpeg、Python 3 和仓库外的 WebM 母版（`../desktop-website-webm-masters/look-XX.webm`）：`tools/build-loop-media.sh [编号]`；只重做倒放音轨：`tools/remux-reverse-audio.sh 编号`。环境变量：`FFMPEG`、`MASTERS`、`CRF`、`CODEC`、`TRIM_END`。
- **浏览器预览**：在仓库根目录起一个静态服务后打开 `index.html`（没有外壳，声音始终开启）。改了 JS / CSS 要更新 `index.html` 里所有 `?v=`；重新生成视频要更新 `app.js` 的 `MEDIA_VERSION`。
- **调试参数**：`minuteMs=2000` 把「1 分钟」缩短用于测试定时换装。
- `preview.jpg`、`project.json` 是原作的 Wallpaper Engine 文件，macOS 版不使用，保留原样。

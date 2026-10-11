# AGENTS.md —— 给 AI 编程助手

面向人的说明在 [README.md](README.md)。这里是部署步骤与修改代码前需要知道的事实。
现在推荐的分发方式是独立应用（见下方「独立应用」）；Plash 方式仍然保留。

## 规则

- 不要修改用户的系统音量、静音或任何系统设置；需要用户手动做的事列给用户。
- 运行时只依赖 macOS 自带程序：`/usr/sbin/httpd`（Apache）、`/usr/bin/osascript`、`bash`、`curl`、`unzip`、`launchctl`。
- **不要调用** `/usr/bin/python3`、`git`、`swift`：新装的 macOS（12+）上它们只是占位程序，一运行就弹窗要求安装命令行开发者工具。只有确认 `xcode-select -p` 能输出路径时才可使用。Python / ffmpeg 只用于重新生成视频。

## 部署步骤（macOS + Plash，旧方式）

按顺序执行，每步验证后再继续。

1. **确认 Plash**：`ls /Applications/Plash.app`。没有就执行
   `open "macappstore://apps.apple.com/app/id1494023538"`，请用户点「获取」安装后再继续。

2. **问用户安装位置**，默认建议 `~/PurpleWallpaper`。
   不要用「桌面」「文稿」「下载」（macOS 隐私保护会阻止开机自启的后台服务读取，壁纸无法加载）、iCloud 云盘或外接硬盘。装好后不要移动；移动后需重新执行第 4 步。

3. **下载**（约 370MB）：

   ```bash
   DEST="$HOME/PurpleWallpaper"   # 换成用户同意的位置；该文件夹必须还不存在
   curl -L --fail -o /tmp/purple-wallpaper.zip \
     https://github.com/opop32165455/mac-desktop-hinata/archive/refs/heads/main.zip
   rm -rf /tmp/purple-wallpaper-src && mkdir -p "$(dirname "$DEST")"
   unzip -q /tmp/purple-wallpaper.zip -d /tmp/purple-wallpaper-src
   mv /tmp/purple-wallpaper-src/mac-desktop-hinata-main "$DEST"
   rm -rf /tmp/purple-wallpaper.zip /tmp/purple-wallpaper-src
   cd "$DEST" && ls index.html media/look-01.mp4 tools/plash-setup.sh
   ```

   用 `curl` 下载不会带隔离标记；若用户是用浏览器下载的 ZIP，执行 `xattr -dr com.apple.quarantine "$DEST"` 后脚本才能直接运行。

4. **启动本地服务并设为开机自启**：`bash tools/plash-setup.sh start`

5. **验证**：

   ```bash
   bash tools/plash-setup.sh status
   # 开机自启：已加载 / 桌面状态助手：已加载（{...}）/ 本地服务：正常
   curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:47070/index.html                         # 200
   curl -s -o /dev/null -w "%{http_code}\n" -H 'Range: bytes=0-1' http://127.0.0.1:47070/media/look-01.mp4  # 206（必须）
   curl -s http://127.0.0.1:47070/desktop-state                                                         # {"onDesktop":...,"at":...}
   ```

6. **加入 Plash**：

   ```bash
   open "plash:add?url=http://127.0.0.1:47070/index.html&title=PURPLE%20%C2%B7%20%E7%89%87%E5%88%BB"
   ```

7. **告诉用户自己设置**：Plash 设置 → Advanced 关闭静音；Plash 设置 → 登录时启动；系统设置 → 桌面与程序坞 → 触发角设一个「桌面」。

卸载：`bash tools/plash-setup.sh stop`（等同双击 `plash-stop.command`），再在 Plash 里删除该网站。

## 独立应用（Tauri，推荐的分发方式）

用户从 GitHub Releases 下载 DMG 安装，不需要 Plash、本地服务或任何别的软件。上面的「规则」里关于运行时依赖的两条只针对 Plash 方式；构建独立应用需要 Rust、Node.js 和 Xcode 命令行工具。

- **打包**：`npm install` 后 `npm run build`（通用版，需要 `rustup target add x86_64-apple-darwin`），产物在 `src-tauri/target/universal-apple-darwin/release/bundle/`。只打本机架构用 `npm run build:arm`。
  发布时把 DMG 改名为 `PurpleMoment-版本号-universal.dmg` 再传到 Release（原文件名带空格）。版本号在 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 三处。
- **前端不搬家**：页面文件仍在仓库根目录，Plash 方式照常可用。打包前 `tools/app-stage.sh` 把 `index.html`、`*.js`、`*.css`、`images/` 拷到 `build/app-frontend/`（Tauri 会把前端目录整个嵌进可执行文件，不能直接指向根目录）。
- **视频是打包资源**：`media/` 经 `tauri.conf.json` 的 `bundle.resources` 放进应用的资源目录，运行时经 asset 协议读取（范围 `$RESOURCE/media/**`，支持 Range）。不要放进前端目录：会被嵌进可执行文件。视频与 Plash 方式是同一批文件（HEVC），不需要为应用另外转码。
- **外壳与页面的接口**：`src-tauri/src/lib.rs` 是全部原生逻辑。`native-adapter.js`（先于 `app.js` 加载，只在应用里生效）提供 `window.PURPLE_NATIVE`，`app.js` 里凡是 `NATIVE` 开头的分支都是为它准备的；样式在 `native.css`。外壳发三个事件：`app-active`（每秒一次，是否在看桌面）、`boss-key`（是否已隐藏）、`interactive-mode`。
- **窗口层级**：数值随系统版本不同，运行时用 `CGWindowLevelForKey` 查（2 = 桌面，18 = 桌面图标）。纯壁纸 = 桌面 + 1；可操作 = 桌面图标 + 2。不能用「图标 + 1」（与系统的菜单栏衬底窗口同层，菜单栏下方会出现时有时无的亮带），也不能用高于 0 的层级（会挡住所有应用和 Dock）。
- **离开桌面时静音**：外壳每秒在主线程判断一次，最前面的应用是桌面本身（本应用 / 访达 / 程序坞 / 控制中心），或它在屏幕上没有普通窗口，才算在看桌面。只读应用标识和窗口位置，不需要屏幕录制权限。
- **多显示器**：每块屏幕一个窗口，只有主屏出声；显示器增减或分辨率变化时整批重建窗口。只在单显示器上实际运行过。
- **签名**：只有临时签名（ad-hoc），没有 Apple 公证，用户第一次打开要到「隐私与安全性」点「仍要打开」。
- **窗口被完全挡住时 WebKit 不绘制**：验证画面时如果另一个全屏壁纸应用盖在上面，截到的会是一片灰，不是出错。
- **打包失败后**可能留下挂载着的 `rw.*.dmg`（在 `bundle/macos/`），先 `hdiutil detach` 再删掉，否则下一次 DMG 步骤会失败。

## 运行结构（Plash 方式）

- **本地服务**：launchd 代理 `com.purple-moment-mac.server`（`~/Library/LaunchAgents/`）运行 `tools/plash-server.sh`，生成 `~/Library/Application Support/purple-desktop/httpd.conf` 后前台运行系统 Apache。只监听 `127.0.0.1:47070`；原生 Range；全部响应 `Cache-Control: no-cache`；拒绝隐藏文件。模块路径从 `/etc/apache2/httpd.conf` 读取以适配不同 macOS 版本。
  Plash 不支持 `file://`，所以必须有本地 http 服务。
- **桌面状态助手**：代理 `com.purple-moment-mac.desktop-state` 用 osascript 运行 `tools/desktop-state.js`，每秒把「用户是否在看桌面」写到 `.../purple-desktop/public/desktop-state.json`，Apache 以 `/desktop-state` 提供。判据两条，满足其一即「不在桌面」：① 最前面的应用不是桌面本身（访达 / 程序坞 / 控制中心 / Plash）且它在主屏上有可见窗口；② 普通窗口挡住主屏超过 50%（兜底）。只读窗口位置与最前面的应用名，不需要屏幕录制权限。页面超过 10 秒未见更新就不做静音。
  **两个坑不要踩回去**：① 不要退回「只看覆盖率」——单个没最大化的窗口在 1920×1080 上通常只占 50%–70%，够不到阈值，切进程序后仍会出声；② 脚本里必须用 `NSRunLoop.runUntilDate` 等待，**不能用 `delay()`**——`delay()` 阻塞运行循环，NSWorkspace 收不到「前台应用变了」的通知，`frontmostApplication` 会一直停在进程启动时的那个应用。
- **菜单栏跟随衣橱**：Plash 的壁纸窗口从菜单栏下方开始，菜单栏那一条露出的是系统桌面图片。页面在穿搭 / 画面比例 / 明暗 / 开关变化时请求 `/wallpaper?look=05&fit=contain&b=100&enabled=1`（必须带请求头 `X-Purple: 1`），由 `tools/wallpaper.cgi`（Apache 唯一的 CGI，严格校验参数）写入 `.../purple-desktop/wallpaper-request.json`；常驻助手 `desktop-state.js` 每秒读取，用 AppKit 生成与页面顶边衔接的图片（背景层铺满 + 定格图按页面比例放在菜单栏下方 + 菜单栏那一条用画面顶边镜像补齐），缓存在 `.../purple-desktop/wallpapers/`，设为**主屏**的系统桌面图片。
  `wallpaper-sync.json` 记录接管前的原图（`backup`）：关闭开关或卸载（`plash-setup.sh stop` 调 `desktop-state.js --restore`）时恢复；用户自己换了桌面图片（既不是我们的图也不是原图）就标记 `paused`，不再覆盖，关掉再打开开关才重新接管。桌面图片按「空间」记录，切到别的空间会在那里补设一次。
- **日志**：`/tmp/purple-plash-access.log`（页面文件与每个视频的首次请求）、`/tmp/purple-plash-server.log`（错误输出）。
- **端口**：固定 47070。页面偏好在 `localStorage`，按地址（含端口）隔离，换端口会回到默认。换端口：`PLASH_PORT=端口 bash tools/plash-setup.sh start`，并在 Plash 改用新地址。
- **Plash 适配**：`plash-adapter.js`（先于 `app.js` 加载）+ `plash.css`，只在 Plash 中生效：固定上报页面可见、首次进入设默认播放方式（往复）与换装间隔、隐藏顶部光边、点选前预解码定格图。

## 修改代码前要知道的

- **改完必须更新版本号**，否则 Plash 用缓存旧文件：改 JS / CSS → 更新 `index.html` 里所有 `?v=`；重新生成视频 → 再更新 `app.js` 的 `MEDIA_VERSION`。然后 `open -g "plash:reload"`，在访问日志里确认请求的是新版本号。
- **往复循环**：每个视频是「正放 + 倒放」合并文件（HTML5 视频不支持负向播放）。片尾转向在文件内部连续完成；折返点转向由两个 `<video>` 牌组接力（备用牌组预滚、在折返帧会合后只对调层级，会合时机按实测偏差自适应）。细节见 `app.js` 的 watchFrames / preparePivot / swapLoopDecks 注释。
- **折返点**：`catalog.js` 每套的 `pivot`（秒，对齐 1/60）。取在最后一次明显鞋跟声之后、动作最静止的帧。片尾约 12.0 秒，素材之后没有内容。
- **声音**：每套第一次正放有声音，进入循环后音量淡到 0；切换穿搭的倒带恢复声音。一律通过**音量**实现，不切换 `muted`（WebKit 无手势取消静音会暂停视频）。不使用 Web Audio。
- **视频**：`media/look-XX.mp4`，HEVC（hvc1）CRF 14，3840×2160，60fps，0.5 秒闭合 GOP；正放取母版前 N 帧（去掉末尾 2 帧跳变），倒放为 N-2…0 再补一帧 0；倒放段音轨保留脚步声（每一下仍正着播放，对准落脚帧）。
  重新生成需要 ffmpeg、Python 3 和仓库外的 WebM 母版（`../desktop-website-webm-masters/look-XX.webm`）：`tools/build-loop-media.sh [编号]`；只重做倒放音轨：`tools/remux-reverse-audio.sh 编号`。环境变量：`FFMPEG`、`MASTERS`、`CRF`、`CODEC`、`TRIM_END`。
- **调试参数**（`http://127.0.0.1:47070/index.html?...`）：`plash=1|0` 强制开/关 Plash 适配；`playback=freeze|single|all|loop`；`interval=0–60`；`minuteMs=2000` 把「1 分钟」缩短用于测试定时换装。
- `preview.jpg`、`project.json` 是原作的 Wallpaper Engine 文件，macOS 版不使用，保留原样。

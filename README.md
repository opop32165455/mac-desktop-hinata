# PURPLE · 片刻

> 一张会陪你换装的桌面互动壁纸。

![预览](preview.jpg)

九套穿搭，慢慢挑。定格喜欢的那一秒，或者让她在桌面上来回不停。

Windows 上由 **Wallpaper Engine** 承载，macOS 上由 **Plash** 承载。

| 平台 | 承载方式 | 支持情况 |
| --- | --- | --- |
| Windows | Wallpaper Engine（Web 壁纸） | 原生支持（视频编码见「媒体与编码」） |
| macOS 12+ | Plash（把网页设为桌面壁纸） | 已适配，提供一键脚本 |

---

## 给智能体的快速部署（macOS + Plash）

> 把这一节交给 AI 编程助手即可完成部署。所有命令都在项目根目录执行，按顺序进行，每步都有验证方法。

### 1. 前置条件

| 依赖 | 说明 | 检查命令 |
| --- | --- | --- |
| macOS 12 或更新 | — | `sw_vers -productVersion` |
| Plash | **唯一需要安装的东西**。App Store 免费：<https://apps.apple.com/app/plash/id1494023538> | `ls /Applications/Plash.app` |

其余全部使用 macOS 自带的程序：本地服务是系统自带的 **Apache**（`/usr/sbin/httpd`），桌面状态助手用系统自带的 **osascript**（JavaScript for Automation）。
**不需要** Python、Xcode 或「命令行开发者工具」。注意不要调用 `/usr/bin/python3`、`swift`、`git` 等：在新装的 macOS 上它们只是占位程序，一运行就会弹窗要求安装命令行开发者工具。

只有在**重新生成视频**时才需要 ffmpeg、Python 3 与 WebM 母版（见「媒体与编码」），部署和日常使用都不需要。

### 2. 启动本地服务（开机自启）

```bash
./tools/plash-setup.sh start
```

期望输出：

```
已安装开机自启：~/Library/LaunchAgents/com.frac-lab.purple-plash-server.plist
                ~/Library/LaunchAgents/com.frac-lab.purple-desktop-state.plist
本地服务已就绪：http://127.0.0.1:47070/index.html
```

脚本是幂等的，重复执行即重启（也会把旧版的 Python 服务升级为 Apache）。

### 开机自启的内容

| launchd 代理（`~/Library/LaunchAgents/`） | 作用 | 运行的程序 |
| --- | --- | --- |
| `com.frac-lab.purple-plash-server.plist` | 本地服务，只监听 `127.0.0.1:47070` | `/usr/sbin/httpd`（系统自带 Apache，配置由 `tools/plash-server.sh` 生成到 `~/Library/Application Support/purple-desktop/httpd.conf`） |
| `com.frac-lab.purple-desktop-state.plist` | 「离开桌面时静音」的桌面遮挡判断，每秒写一次 `~/Library/Application Support/purple-desktop/public/desktop-state.json` | `/usr/bin/osascript -l JavaScript tools/desktop-state.js`（约 0.3% CPU） |

两者都是**登录后自动运行、崩溃自动重启**的用户级代理，不需要管理员权限。
另外请在 Plash 自己的设置里打开「登录时启动」（Launch at login），这样开机后壁纸会自动出现。
项目文件夹**移动位置后**，代理里记录的路径会失效，需要重新执行 `./tools/plash-setup.sh start` 或双击 `plash-start.command`。

### 3. 验证服务

```bash
./tools/plash-setup.sh status
# 开机自启：已加载
# 桌面状态助手：已加载（{"onDesktop":true,"covered":0.12,"at":...}）
# 本地服务：正常（http://127.0.0.1:47070/index.html）

curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:47070/index.html
# 200

curl -s -o /dev/null -w "%{http_code}\n" -H 'Range: bytes=0-1' http://127.0.0.1:47070/media/look-01.mp4
# 206   ← 必须是 206：Safari / Plash 播放 MP4 依赖 Range 请求，返回 200 会卡顿或播到一半停住
```

日志：`/tmp/purple-plash-access.log`（访问日志，只记页面文件与每个视频的首次请求）、`/tmp/purple-plash-server.log`（服务与助手的错误输出）。

```bash
curl -s http://127.0.0.1:47070/desktop-state
# {"onDesktop":true,"covered":0.12,"at":1760000000}   ← at 每秒更新
```

### 4. 把壁纸加入 Plash

```bash
open "plash:add?url=http://127.0.0.1:47070/index.html"
```

或者直接双击 **`plash-start.command`**：它会依次确认 Plash 已安装、启动服务、调用 `plash:add` 注册壁纸。
也可以在 Plash 菜单 → Add Website 手动填入 `http://127.0.0.1:47070/index.html`。

> 首次双击 `.command` 时 macOS 可能提示「无法验证开发者」，在「系统设置 → 隐私与安全性」中点「仍要打开」。

### 5. Plash 里需要确认的设置

- **声音**：Plash 默认静音网页声音。需要声音时在 Plash 设置 → Advanced 中关闭静音（页面里的声音按钮也要打开）。
- **浏览模式（Browsing Mode）**：开启后才能点击壁纸上的界面（换装、设置等）；关闭后是纯净壁纸。
- 修改代码或配置后，在 Plash 菜单里 **Reload** 一次（或执行 `open -g "plash:reload"`）。

### 6. 停止 / 卸载

```bash
./tools/plash-setup.sh stop     # 停止两个代理并移除开机自启（等同双击 plash-stop.command）
```

---

## Windows · Wallpaper Engine

1. 完整解压 `PURPLE_桌面互动壁纸_WallpaperEngine.zip`，打开里面的 `PURPLE_桌面互动壁纸` 文件夹。
2. 打开 Wallpaper Engine 的壁纸编辑器，将文件夹中的 `index.html` 拖入，创建 Web 壁纸项目。
3. 如果提示导入同文件夹的其他文件，请**全部导入**。请保留 `images`、`media` 及其他配套文件，不要只复制 `index.html`。
4. 保存项目，在 Wallpaper Engine 中选中这张壁纸并应用即可。

属性面板（`project.json`）可调：初始穿搭、画面明暗、画面比例、声音、自动换装间隔（0–60 分钟，0 = 不换）、15 秒后自动收起界面。

> 仓库里的视频是 **HEVC** 编码，Wallpaper Engine（Chromium 内核）通常无法播放 HEVC。
> 给 Windows 打包前，用 `CODEC=h264 tools/build-loop-media.sh` 重新生成 H.264 版本（见「媒体与编码」）。

---

## 功能

- **衣橱**：九套穿搭，分三章 —— 「日常靠近」「慢慢心动」「没说完的话」
- **播放方式**：定格 / 单套循环 / 全部轮播 / 收藏轮播 / **往复循环（默认）**
- **往复循环**：正放到片尾，再在「折返点 ↔ 片尾」之间来回不停（见下节）
- **隔一段时间换一套**：定格与往复两种模式都支持；1–60 分钟滑杆，另有 5 / 15 / 30 分钟快捷按钮，「等我来选」为关闭
- **定格**：拖动时间轴，挑选属于你的那一帧
- **交给心动**：随机换一套，且不连续重复
- **离开桌面时静音**：普通窗口挡住主屏大部分时，壁纸音量淡到 0；回到桌面再淡回来（默认开启，可在设置里关）
- **氛围设置**：画面明暗、声音大小、画面比例、水平位置、切换穿搭的方式（倒带 / 闪入）、安静时自动收起界面
- **沉浸模式**：一键隐藏界面
- **时钟**：右上角常驻显示当前时间

---

## 往复循环

设置面板里的「入场往复循环」开关（默认开启；关闭 = 定格模式）。开启后每一套：

1. 第一次正放 `0 → 片尾`，**有声音**；
2. 倒放 `片尾 → 折返点`；
3. 正放 `折返点 → 片尾`，如此往复。循环段**静音**（音量淡到 0，不是 mute）。

切换穿搭（手动或定时）时，先从当前位置倒放回 `0`（这段倒带**有声音**，脚步声保留），再换下一套。
设置里「切换穿搭的方式」选「闪入」则直接切换，不倒带。

### 每套的折返点

折返点写在 `catalog.js` 对应 look 的 `pivot` 字段（秒），取值规则：

- 放在**最后一次明显的「咚」（鞋跟声）之后**，循环段里不再有大的声响；
- 放在**动作最静止的那一帧**，转向时不显得卡；
- 对齐到 60fps 帧：`pivot = 帧号 / 60`，例如第 652 帧 → `10.866667`。

当前取值：

| 套 | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | 09 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 折返点（秒） | 10.783 | 10.283 | 10.350 | 10.867 | 10.433 | 9.867 | 11.183 | 10.883 | 10.750 |

片尾约 12.0 秒，所以循环段约 0.8–2.1 秒。素材只有 12 秒，无法在 12 秒之后继续正放。

### 实现要点（改代码前先读）

- HTML5 视频**不支持负向播放**，所以每个视频预先做成「正放 + 倒放」的合并文件（`[0, N)` 正放，`[N, 2N)` 倒放），倒放就是正向播放后半段。
- 片尾转向发生在同一个文件内部，连续、无 seek。
- 折返点转向由两个 `<video>` 牌组接力：备用牌组提前停在折返点前，主牌组倒放接近折返点时备用牌组起播，两者在折返帧会合后只对调层级。会合时机按每轮实测偏差自适应校准，WebKit 实测误差约 ±1 帧。
- 静音一律通过**音量**实现，不切换 `muted`：WebKit 在无用户手势时取消静音会直接暂停视频。

---

## 媒体与编码

`media/look-XX.mp4`（9 个，每个约 36–49MB）是「正放 + 倒放」合并文件：

| 项 | 值 |
| --- | --- |
| 编码 | HEVC（`hvc1`），CRF 14，3840×2160，60fps，每 0.5 秒一个闭合 GOP |
| 帧布局 | 正放取母版前 N 帧（去掉母版最后 2 帧的跳变），倒放为 N-2 … 0 再补一帧 0 |
| 音轨 | 正放段为原声；倒放段每一下脚步声仍正着播放，对准倒放画面里落脚的那一帧 |

重新生成（开发用，需要 ffmpeg、Python 3，以及项目旁边的 WebM 母版目录 `../desktop-website-webm-masters/look-XX.webm`，**母版不在仓库里**）：

```bash
tools/build-loop-media.sh            # 全部 9 个
tools/build-loop-media.sh 04         # 只生成第 04 套
CODEC=h264 tools/build-loop-media.sh # 生成 H.264 版本（Wallpaper Engine 用）
tools/remux-reverse-audio.sh 04      # 只重做倒放音轨，视频流原样复制
```

可用环境变量：`FFMPEG`（ffmpeg 路径）、`MASTERS`（母版目录）、`CRF`、`CODEC`、`TRIM_END`（去掉母版末尾几帧，默认 2）。

**改完必须更新版本号**，否则 Plash 会继续用缓存里的旧文件：

- 改了 JS / CSS：把 `index.html` 里所有 `?v=` 改成新值；
- 重新生成了视频：同时改 `app.js` 里的 `MEDIA_VERSION`。

然后在 Plash 里 Reload 一次。

---

## macOS · Plash 说明

### 为什么需要本地服务

Plash **不支持 `file://` 本地文件地址**，只能加载 `http(s)`。本项目用 macOS 自带的 Apache 在 `127.0.0.1:47070` 上运行一个**仅监听本机**的静态服务（`tools/plash-server.sh` 生成配置并启动），它提供：

- **Range 请求**（206）：Safari / Plash 播放与拖动 MP4 必需（Apache 原生支持）；
- **`Cache-Control: no-cache`**：每次都向服务确认文件是否更新；
- `/desktop-state`：桌面状态助手写出的 JSON，「离开桌面时静音」用。助手只读取窗口位置，**不需要屏幕录制权限**；助手没在运行（文件不存在或 10 秒未更新）时，页面自动不做静音，其余一切正常；
- 隐藏文件（如 `.git`）一律拒绝访问。

Apache 与 osascript 在 macOS 12 到最新版本中都是系统自带的；模块路径从系统的 `/etc/apache2/httpd.conf` 读取，不同版本路径不同也能适配。

端口固定为 **47070**（避开 AnyDesk 等使用的 7070，且低于 macOS 临时端口段 49152+）。页面偏好存在 `localStorage`，按地址（含端口）隔离，**换端口会让偏好回到默认**。
需要换端口时：`PLASH_PORT=端口号 ./tools/plash-setup.sh start`，并在 Plash 里改用新地址。

### 在 Plash 中的表现

| 场景 | 表现 |
| --- | --- |
| 普通显示（默认） | 隐藏全部界面，呈现纯净壁纸 |
| 播放方式 | 默认「往复循环」 |
| 开启 Browsing Mode（浏览模式） | 界面恢复，可点击衣橱、切换播放方式、打开设置 |

适配层（`plash-adapter.js` + `plash.css`）只在检测到运行于 Plash 中时生效：固定上报页面可见（避免视频被暂停）、首次进入设默认播放方式与换装间隔、隐藏紧贴菜单栏的顶部光边、点选前预解码定格大图。

---

## 已知问题与使用提示

**浏览模式下无法像以前那样快速回到桌面**
开启 Plash 的浏览模式后，点击桌面会点到壁纸页面本身，macOS「点按墙纸以显示桌面」这类操作不再生效。建议换成以下任意一种：

- **触发角（推荐）**：系统设置 → 桌面与程序坞 → 触发角，把左下角或右下角设为「桌面」。鼠标甩到那个角就回到桌面。
- 键盘：`Fn + F11`（或在 系统设置 → 键盘 → 键盘快捷键 → 调度中心 里给「显示桌面」设一个快捷键）。
- 触控板：拇指与三指张开。

**屏幕顶部的菜单栏显示的还是原来的系统壁纸**
Plash 的壁纸窗口从菜单栏**下方**开始（例如 1920×1080 的屏幕上从 y=30 开始），菜单栏那一条露出的是系统桌面图片，壁纸应用无法覆盖菜单栏。可选做法：

- 系统设置 → 控制中心（新版本为「菜单栏」）→ 自动隐藏和显示菜单栏 → 选「始终」；
- 把系统桌面图片换成与壁纸接近的图（例如 `images/look-XX.jpg`），让那一条颜色衔接；
- 系统设置 → 辅助功能 → 显示 → 降低透明度：菜单栏变为不透明纯色。

位于屏幕底部的程序坞同理。

**改了配置 / 代码，Plash 里看不到变化**
多半是缓存：按「媒体与编码」最后一段更新 `?v=` / `MEDIA_VERSION`，然后 Reload。可在 `/tmp/purple-plash-access.log` 确认 Plash 请求的是新版本号。

**电脑突然被静音（尤其在语音输入之后）**
页面不会、也无法修改 macOS 的系统音量或静音。若使用蓝牙耳机 / 音箱同时作为麦克风，语音输入法或通话一打开麦克风，设备会切到「免提通话」模式，macOS 把它当作另一个有独立静音状态的设备，看起来就像电脑被静音了。可在 系统设置 → 声音 → 输入 选择其他麦克风，或检查输入法里「录音时静音其他声音」一类的选项。

**没有声音**
依次检查：Plash 设置 → Advanced 的静音开关；页面里的声音按钮；「离开桌面时静音」（被窗口挡住时会自动淡出）；往复循环段本身是静音的，只有每套第一次正放和切换时的倒带有声音。

**壁纸是静止的，不动**
1. `./tools/plash-setup.sh status` 确认服务正常；
2. Plash 设置 → Advanced 里的省电选项（如电池供电时暂停）；
3. 在浏览模式里确认播放方式不是「定格」。

**项目移动了位置**
开机自启记录的是绝对路径，移动后重新执行 `./tools/plash-setup.sh start`。

**会影响 Wallpaper Engine 吗**
不会。适配层只在 Plash 中生效；`/desktop-state` 等接口在 Wallpaper Engine 里不存在，页面会自动跳过。

---

## 目录结构

```
desktop-website/
├── index.html                  壁纸入口页面（脚本 / 样式带 ?v= 版本号）
├── app.js                      交互主逻辑（MEDIA_VERSION 在这里）
├── catalog.js                  穿搭数据（每套的 pivot 折返点在这里）
├── dialogue-engine.js          对白引擎
├── style.css / glass.css       样式
├── plash.css                   Plash 壁纸模式样式（仅 html.is-plash-mode 下生效）
├── plash-adapter.js            Plash 适配层（先于 app.js 加载）
├── images/                     定格图、背景图与缩略图
├── media/                      视频（9 个 HEVC MP4，正放 + 倒放）
├── preview.jpg                 预览图
├── project.json                Wallpaper Engine 项目描述
├── plash-start.command          一键启动并加入 Plash
├── plash-stop.command          停止服务并移除开机自启
├── AGENTS.md                   给 AI 编程助手的要点
└── tools/
    ├── plash-setup.sh          开机自启的 start / stop / status（两个 launchd 代理）
    ├── plash-server.sh         生成 Apache 配置并以前台方式运行系统自带的 httpd
    ├── desktop-state.js        桌面状态助手（osascript JXA），「离开桌面时静音」用
    ├── build-loop-media.sh     从 WebM 母版生成合并视频（开发用，需要 ffmpeg）
    ├── remux-reverse-audio.sh  只重做倒放音轨（开发用）
    └── reverse-audio-events.py 保留脚步声的倒放音轨生成（开发用，需要 Python 3）
```

## 调试

在浏览器中打开 `http://127.0.0.1:47070/index.html` 即可预览。URL 参数：

- `?plash=1` / `?plash=0`：强制开启 / 关闭 Plash 适配
- `?playback=freeze|single|all|loop`：指定播放方式
- `?interval=0–60`：指定换装间隔（分钟，`0` = 不换）
- `?minuteMs=2000`：把「1 分钟」缩短为 2 秒，用于验证定时换装

## 声明

AI 生成，所有角色均为虚构。

B 站：FRAC_LAB

# PURPLE · 片刻

> 一张会陪你换装的桌面互动壁纸。

![预览](preview.jpg)

九套穿搭，慢慢挑。定格喜欢的那一秒，让它留在桌面上。

Windows 上由 **Wallpaper Engine** 承载，macOS 上由 **Plash** 承载。

| 平台 | 承载方式 | 支持情况 |
| --- | --- | --- |
| Windows | Wallpaper Engine（Web 壁纸） | 原生支持 |
| macOS | Plash（把网页设为桌面壁纸） | 已适配，提供一键脚本 |

## 功能

- **衣橱**：九套穿搭，分三章 —— 「日常靠近」「慢慢心动」「没说完的话」
- **定格**：拖动时间轴，挑选属于你的那一帧
- **播放方式**：定格 / 单套循环 / 全部轮播 / 收藏轮播
- **交给心动**：随机换一套，且不连续重复
- **氛围设置**：画面明暗、声音大小、画面比例、水平位置、安静时自动收起界面
- **沉浸模式**：一键隐藏界面
- **时钟**：右上角常驻显示当前时间

---

## Windows · Wallpaper Engine

1. 完整解压 `PURPLE_桌面互动壁纸_WallpaperEngine.zip`，打开里面的 `PURPLE_桌面互动壁纸` 文件夹。
2. 打开 Wallpaper Engine 的壁纸编辑器，将文件夹中的 `index.html` 拖入，创建 Web 壁纸项目。
3. 如果提示导入同文件夹的其他文件，请**全部导入**。请保留 `images`、`media` 及其他配套文件，不要只复制 `index.html`。
4. 保存项目，在 Wallpaper Engine 中选中这张壁纸并应用即可。

在 Wallpaper Engine 的属性面板中可直接调整：初始穿搭、画面明暗、画面比例、声音、自动换装间隔、15 秒后自动收起界面。

---

## macOS · Plash

[Plash](https://sindresorhus.com/plash) 可以把任意网页作为 Mac 桌面壁纸显示。

### 为什么需要一个本地服务

Plash **不支持 `file://` 本地文件地址**，只能加载 `http(s)` 网址。
因此本项目在 `127.0.0.1:7070` 上运行一个**仅监听本机**的静态服务，再让 Plash 加载它。

端口固定为 **7070**：`localStorage` 中的偏好（收藏、自选定帧）与访问地址绑定，换端口会导致已有偏好丢失。

### 一键启动

1. 从 App Store 安装 Plash（免费）：<https://apps.apple.com/app/plash/id1494023538>
2. 双击项目根目录下的 **`plash-start.command`**。

脚本会自动完成三件事：

- 确认 Plash 已安装；
- 启动本地服务（写入开机自启，此后登录自动运行）；
- 调用 Plash 的 `plash:add` 命令把壁纸注册进 Plash。

脚本是**幂等**的：重复双击即为重启，不会产生重复服务。

> 首次双击时 macOS 可能提示"无法验证开发者"。在「系统设置 → 隐私与安全性」中点击「仍要打开」即可。

### 在 Plash 中的表现

| 场景 | 表现 |
| --- | --- |
| 普通显示（默认） | 隐藏全部界面，呈现纯净壁纸 |
| 播放方式 | 默认「全部轮播」：持续播放，并一套一套自动更换 |
| 开启 Browsing Mode（浏览模式） | 界面恢复，可点击衣橱、切换播放方式、调明暗 |

适配层做了两处针对性处理，保证壁纸在 Plash 中真正"动起来"：

- **可见性修补**：壁纸不存在"隐藏"状态，固定上报为可见，避免宿主因页面被判定为不可见而暂停视频；
- **默认播放方式**：由「定格模式」改为「全部轮播」，否则默认只会显示一张静止帧。

### 调整

- **播放方式**：底部播放控件可切换 定格 / 单套循环 / 全部轮播 / 收藏轮播，默认「全部轮播」。
- **换装间隔**：仅「定格模式」下生效，在浏览模式中打开右上角设置面板选择。
- **明暗 / 声音**：同上，设置面板内对应选项。
- **换端口**：设置环境变量 `PLASH_PORT` 后重新运行脚本，例如
  `PLASH_PORT=7080 ./tools/plash-setup.sh start`。注意换端口会重置偏好。

### 停止 / 卸载

双击 **`plash-stop.command`**：停止本地服务并移除开机自启。
重新双击 `plash-start.command` 即可恢复。

---

## 目录结构

```
desktop-website/
├── index.html                 壁纸入口页面
├── app.js                     交互主逻辑
├── catalog.js                 穿搭数据
├── dialogue-engine.js         对白引擎
├── style.css / glass.css      样式
├── plash.css                  Plash 壁纸模式样式（仅 html.is-plash-mode 下生效）
├── plash-adapter.js           Plash 适配层（先于 app.js 加载）
├── images/                    定格图与缩略图
├── media/                     入场视频（9 个 .webm）
├── preview.jpg                预览图
├── project.json               Wallpaper Engine 项目描述
├── plash-start.command        一键启动 Plash
├── plash-stop.command         停止服务并移除开机自启
└── tools/
    ├── plash-server.sh        本地静态服务（仅监听 127.0.0.1）
    └── plash-setup.sh         开机自启的启动 / 停止 / 状态查询
```

## 常见问题

**Plash 中壁纸显示无法连接**
本地服务未运行。双击 `plash-start.command`，或在本机终端执行：

```
./tools/plash-setup.sh start
```

日志位于 `/tmp/purple-plash-server.log`。

**壁纸是静止的，不动**
默认已设为「全部轮播」，正常情况下会持续播放并自动换装。若仍不动，依次排查：

1. 本地服务是否正常：`./tools/plash-setup.sh status`；
2. Plash 设置 → Advanced 中的省电选项（如电池供电时暂停）是否开启；
3. 在 Plash 中开启 Browsing Mode，用底部播放控件确认播放方式不是「定格模式」。

**不想开机自启**
双击 `plash-stop.command`，或执行 `./tools/plash-setup.sh stop`。
注意服务停止后壁纸将无法显示。

**没有声音**
Plash 默认静音，可在 Plash 设置 → Advanced 中开启。

**屏幕顶部的菜单栏还是显示原来的桌面**
这是 macOS 的层级限制，不是本项目的缺陷。Plash 的窗口位于**桌面图标之下、系统壁纸之上**，
而菜单栏属于系统层，任何壁纸应用都盖不住它。菜单栏默认半透明，底色取自系统壁纸，
因此那一栏透出的仍是原桌面。可选的处理方式：

- 系统设置 → 辅助功能 → 显示 → 打开「降低透明度」：菜单栏变为不透明纯色；
- 系统设置 → 控制中心 → 自动隐藏和显示菜单栏 → 选择「始终」：菜单栏自动收起，接近全屏覆盖；
- 把系统壁纸换成与壁纸同色系的图片，让那一栏的染色更接近。

位于屏幕底部的 Dock 同理。

**项目移动了位置**
开机自启记录的是绝对路径。移动项目后需重新双击 `plash-start.command`。

**会影响 Wallpaper Engine 吗**
不会。适配层只在检测到运行于 Plash 中时生效，Wallpaper Engine 与普通浏览器预览完全不受影响。

## 调试

在浏览器中打开 `http://127.0.0.1:7070/index.html` 即可预览。支持以下参数：

- `?plash=1` 强制启用壁纸模式（隐藏界面），便于在浏览器中查看效果
- `?plash=0` 强制关闭适配
- `?playback=freeze|single|all` 指定播放方式，默认 `all`（全部轮播）
- `?interval=0|5|15|30` 指定定格模式下的换装间隔，`0` 表示不自动换装

## 声明

AI 生成，所有角色均为虚构。

B 站：FRAC_LAB

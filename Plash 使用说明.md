# PURPLE · 片刻 —— Plash（macOS）使用说明

把本壁纸设为 Mac 桌面壁纸。[Plash](https://sindresorhus.com/plash) 可以把任意网页作为桌面壁纸显示。

## 为什么需要一个本地服务

Plash **不支持 `file://` 本地文件地址**，只能加载 `http(s)` 网址。
因此本项目在 `127.0.0.1:7070` 上运行一个**仅监听本机**的静态服务，再让 Plash 加载它。

端口固定为 **7070**：`localStorage` 里的偏好（收藏、自选定格）与访问地址绑定，换端口会导致已有偏好丢失。

## 一键加入

1. 从 App Store 安装 Plash（免费）：<https://apps.apple.com/app/plash/id1494023538>
2. 双击项目根目录下的 **`加入 Plash 壁纸.command`**。

脚本会自动完成三件事：

- 确认 Plash 已安装；
- 安装并启动本地服务（写入开机自启，此后登录自动运行）；
- 调用 Plash 的 `plash:add` 命令注册壁纸。

> 首次双击时 macOS 可能提示"无法验证开发者"。在「系统设置 → 隐私与安全性」中点击「仍要打开」即可。

## 在 Plash 中的表现

| 场景 | 表现 |
| --- | --- |
| 普通显示（默认） | 隐藏全部界面，呈现纯净壁纸 |
| 自动换装 | 默认每 15 分钟随机换一套穿搭 |
| 开启 Browsing Mode（浏览模式） | 界面恢复，可点击衣橱、调明暗、改换装间隔 |

## 调整

- **换装间隔**：在浏览模式中打开右上角设置面板，选择「偶尔换一套」的间隔。
- **明暗 / 声音**：同上，设置面板内对应选项。
- **换端口**：设置环境变量 `PLASH_PORT` 后重新运行脚本，例如
  `PLASH_PORT=7080 ./tools/plash-setup.sh install`。注意换端口会重置偏好。

## 停止 / 卸载

双击 **`停止 Plash 壁纸.command`**：移除开机自启并停止本地服务。
重新双击「加入 Plash 壁纸.command」即可恢复。

## 目录说明

| 文件 | 作用 |
| --- | --- |
| `加入 Plash 壁纸.command` | 一键加入：装自启 + 起服务 + 注册 Plash |
| `停止 Plash 壁纸.command` | 停止服务并移除开机自启 |
| `plash-adapter.js` | 适配层：识别运行环境、隐藏界面、首次开启自动换装 |
| `plash.css` | 壁纸模式样式（仅在 `html.is-plash-mode` 下生效） |
| `tools/plash-server.sh` | 本地静态服务（仅监听 127.0.0.1） |
| `tools/plash-setup.sh` | 开机自启的安装 / 卸载 / 状态查询 |

## 常见问题

**壁纸显示无法连接**
本地服务未运行。双击「加入 Plash 壁纸.command」，或在本机终端执行：

```
./tools/plash-setup.sh install
```

日志位于 `/tmp/purple-plash-server.log`。

**不想开机自启**
双击「停止 Plash 壁纸.command」，或执行 `./tools/plash-setup.sh uninstall`。
注意服务停止后壁纸将无法显示。

**没有声音**
Plash 默认静音，可在 Plash 设置 → Advanced 中开启。

**项目移动了位置**
开机自启记录的是绝对路径。移动项目后需重新双击「加入 Plash 壁纸.command」。

**会影响 Wallpaper Engine 吗**
不会。适配层只在检测到运行于 Plash 中时生效，Wallpaper Engine 与普通浏览器预览完全不受影响。

## 调试

在浏览器中打开 `http://127.0.0.1:7070/index.html` 即可预览。支持以下参数：

- `?plash=1` 强制启用壁纸模式（隐藏界面），便于在浏览器中查看效果
- `?plash=0` 强制关闭适配
- `?interval=0|5|15|30` 指定换装间隔，`0` 表示不自动换装

# AGENTS.md

部署与维护说明都在 [README.md](README.md)：

- 部署（macOS + Plash）：README「给智能体的快速部署」一节，按顺序执行并逐步验证。
- 调整往复折返点：`catalog.js` 的 `pivot`（秒，对齐到 1/60）。
- 改了 JS / CSS 必须更新 `index.html` 的 `?v=`；重新生成视频还要更新 `app.js` 的 `MEDIA_VERSION`，然后在 Plash 里 Reload。
- 本地服务是 macOS 自带的 Apache（tools/plash-server.sh），端口 47070，只监听 127.0.0.1；视频播放依赖 Range（206）。
- 运行时只允许依赖 macOS 自带程序（/usr/sbin/httpd、/usr/bin/osascript、bash、curl）。不要调用 /usr/bin/python3、swift、git 等：新装的 macOS 上它们是占位程序，会弹窗要求安装命令行开发者工具。Python / ffmpeg 只用于重新生成视频。
- 不要修改用户的系统音量、静音或系统设置。

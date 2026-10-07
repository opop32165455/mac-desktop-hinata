#!/bin/bash
# PURPLE · 片刻 —— 双击即可把本壁纸加入 Plash
#
# 作用：
#   1. 确认 Plash 已安装；
#   2. 确保本地服务在运行（未运行则安装开机自启并启动）；
#   3. 调用 Plash 的 plash:add 命令注册壁纸。
#
# 说明：Plash 不支持 file:// 本地文件地址，必须通过 http 访问，
#       因此这里先在 127.0.0.1 上起一个只监听本机的静态服务。
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

PORT="${PLASH_PORT:-7070}"
TITLE="PURPLE · 片刻"
URL="http://127.0.0.1:${PORT}/index.html"

printf '\n  PURPLE · 片刻 —— 接入 Plash\n\n'

if [ ! -d "/Applications/Plash.app" ]; then
  printf '未检测到 Plash。请先从 App Store 免费安装：\n'
  printf '  https://apps.apple.com/app/plash/id1494023538\n\n'
  read -r -p '按回车键退出…' _
  exit 1
fi

if curl -fsS -o /dev/null "$URL" 2>/dev/null; then
  printf '本地服务已在运行：http://127.0.0.1:%s\n' "$PORT"
else
  printf '本地服务未运行，正在安装并启动…\n'
  if ! ./tools/plash-setup.sh install; then
    printf '\n启动失败，请查看日志：/tmp/purple-plash-server.log\n\n'
    read -r -p '按回车键退出…' _
    exit 1
  fi
fi

if ! curl -fsS -o /dev/null "$URL" 2>/dev/null; then
  printf '\n本地服务仍无法访问，请查看日志：/tmp/purple-plash-server.log\n\n'
  read -r -p '按回车键退出…' _
  exit 1
fi

# Plash 的 URL 参数需要转义；Python 不可用时退回由 Plash 自动抓取页面标题。
ENCODED=""
if [ -x /usr/bin/python3 ]; then
  ENCODED="$(/usr/bin/python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$TITLE" 2>/dev/null)"
fi

if [ -n "$ENCODED" ]; then
  open -g "plash:add?url=${URL}&title=${ENCODED}"
else
  open -g "plash:add?url=${URL}"
fi

printf '\n已加入 Plash。\n\n'
printf '  · 壁纸地址：%s\n' "$URL"
printf '  · 若未立即显示，点菜单栏的水滴图标，选择「%s」。\n' "$TITLE"
printf '  · 想手动点击换装时，在菜单中开启 Browsing Mode（浏览模式）。\n'
printf '  · 默认每 15 分钟自动换一套，可在浏览模式的设置面板中调整。\n'
printf '  · 不再需要时，双击「停止 Plash 壁纸.command」。\n\n'
read -r -p '按回车键关闭此窗口…' _

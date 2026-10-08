#!/bin/bash
# PURPLE · 片刻 —— Plash 本地静态服务
#
# 由 launchd 开机自启调用，也可手动执行。
# 端口固定，因为 localStorage 偏好（收藏、自选定格）与访问地址绑定，
# 换端口会导致已有偏好丢失。
set -u

PORT="${PLASH_PORT:-7070}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${PLASH_PYTHON:-/usr/bin/python3}"

if [ ! -x "$PY" ]; then
  PY="$(command -v python3 || true)"
fi
if [ -z "$PY" ] || [ ! -x "$PY" ]; then
  echo "找不到可用的 python3，无法启动本地服务。" >&2
  exit 1
fi

# 仅监听回环地址，不对外网暴露；exec 让 launchd 直接管理该进程。
# 不用 `python3 -m http.server`：它不支持 Range，WebKit 播放 MP4 时每次 seek
# 都要从头重新下载整个文件，会造成卡顿与播放中途停住。
exec "$PY" "$ROOT/tools/plash-server.py" "$PORT" "$ROOT"

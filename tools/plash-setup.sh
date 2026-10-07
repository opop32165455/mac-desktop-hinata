#!/bin/bash
# PURPLE · 片刻 —— Plash 本地服务：安装 / 卸载开机自启
#
# 用法：
#   tools/plash-setup.sh install     安装并立即启动（此后登录自动运行）
#   tools/plash-setup.sh uninstall   卸载自启并停止服务
#   tools/plash-setup.sh status      查看当前状态
set -u

LABEL="com.frac-lab.purple-plash-server"
PORT="${PLASH_PORT:-7070}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$PROJECT_DIR/tools/plash-server.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
PYTHON="${PLASH_PYTHON:-/usr/bin/python3}"

die() { printf '%s\n' "$1" >&2; exit 1; }

wait_ready() {
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/index.html" 2>/dev/null; then
      return 0
    fi
    sleep 0.4
  done
  return 1
}

install_agent() {
  [ -x "$PYTHON" ] || die "找不到可用的 Python：$PYTHON"
  [ -f "$SERVER" ] || die "找不到服务脚本：$SERVER"
  mkdir -p "$HOME/Library/LaunchAgents"

  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$SERVER</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PLASH_PORT</key>
		<string>$PORT</string>
		<key>PLASH_PYTHON</key>
		<string>$PYTHON</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>/tmp/purple-plash-server.log</string>
	<key>StandardErrorPath</key>
	<string>/tmp/purple-plash-server.log</string>
</dict>
</plist>
PLIST_EOF

  # 先卸载旧实例，避免重复加载报错
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1

  local out=""
  if ! out="$(launchctl bootstrap "$DOMAIN" "$PLIST" 2>&1)"; then
    # 旧版系统的回退路径
    out="$(launchctl load -w "$PLIST" 2>&1)" || true
  fi

  if ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    printf '自启加载失败：%s\n' "${out:-未知错误}" >&2
    printf '\nlaunchd 只允许在已登录的图形会话中注册开机自启。\n' >&2
    printf '请在访达中双击「加入 Plash 壁纸.command」，或在本机终端里重试。\n' >&2
    return 1
  fi

  launchctl enable "$DOMAIN/$LABEL" >/dev/null 2>&1
  launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1

  printf '已安装开机自启：%s\n' "$PLIST"
  if wait_ready; then
    printf '本地服务已就绪：http://127.0.0.1:%s/index.html\n' "$PORT"
  else
    printf '自启已加载，但服务暂未响应，请查看日志：/tmp/purple-plash-server.log\n'
  fi
}

uninstall_agent() {
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
  if [ -f "$PLIST" ]; then
    rm -f "$PLIST"
    printf '已移除开机自启：%s\n' "$PLIST"
  else
    printf '未发现已安装的自启配置。\n'
  fi

  # 兜底：结束仍占用该端口的服务进程
  local pids
  pids="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null && printf '已停止本地服务（端口 %s）。\n' "$PORT"
  else
    printf '本地服务未在运行。\n'
  fi
}

status_agent() {
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    printf '开机自启：已加载\n'
  else
    printf '开机自启：未加载\n'
  fi
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/index.html" 2>/dev/null; then
    printf '本地服务：正常（http://127.0.0.1:%s/index.html）\n' "$PORT"
  else
    printf '本地服务：不可访问\n'
  fi
}

case "${1:-}" in
  install)   install_agent ;;
  uninstall) uninstall_agent ;;
  status)    status_agent ;;
  *) printf '用法：%s install | uninstall | status\n' "$0"; exit 1 ;;
esac

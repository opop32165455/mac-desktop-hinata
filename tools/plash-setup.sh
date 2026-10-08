#!/bin/bash
# PURPLE · 片刻 —— Plash 本地服务：安装 / 卸载开机自启
#
# 用法：
#   tools/plash-setup.sh start     启动服务并写入开机自启（此后登录自动运行）
#   tools/plash-setup.sh stop      停止服务并移除开机自启
#   tools/plash-setup.sh status    查看当前状态
#
# 兼容别名：install = start，uninstall = stop
#
# 安装两个 launchd 用户代理（只用 macOS 自带的程序，不需要安装任何东西）：
#   com.frac-lab.purple-plash-server   本地服务：系统自带的 Apache（/usr/sbin/httpd），127.0.0.1:47070
#   com.frac-lab.purple-desktop-state  桌面遮挡判断：系统自带的 osascript 运行 tools/desktop-state.js
# 配置文件在 ~/Library/LaunchAgents/，登录后自动运行，崩溃自动重启。
set -u

LABEL="com.frac-lab.purple-plash-server"
STATE_LABEL="com.frac-lab.purple-desktop-state"
PORT="${PLASH_PORT:-47070}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$PROJECT_DIR/tools/plash-server.sh"
STATE_SCRIPT="$PROJECT_DIR/tools/desktop-state.js"
STATE_DIR="$HOME/Library/Application Support/purple-desktop"
STATE_FILE="$STATE_DIR/public/desktop-state.json"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE_PLIST="$HOME/Library/LaunchAgents/$STATE_LABEL.plist"
DOMAIN="gui/$(id -u)"

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

# 注册并启动一个 launchd 代理：load_agent LABEL PLIST
load_agent() {
  local label="$1" plist="$2" out=""
  # 先卸载旧实例，避免重复加载报错
  launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1
  if ! out="$(launchctl bootstrap "$DOMAIN" "$plist" 2>&1)"; then
    # 旧版系统的回退路径
    out="$(launchctl load -w "$plist" 2>&1)" || true
  fi
  if ! launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
    printf '自启加载失败（%s）：%s\n' "$label" "${out:-未知错误}" >&2
    printf '\nlaunchd 只允许在已登录的图形会话中注册开机自启。\n' >&2
    printf '请在访达中双击 plash-start.command，或在本机终端里重试。\n' >&2
    return 1
  fi
  launchctl enable "$DOMAIN/$label" >/dev/null 2>&1
  launchctl kickstart -k "$DOMAIN/$label" >/dev/null 2>&1
}

install_state_agent() {
  [ -f "$STATE_SCRIPT" ] || die "找不到桌面状态脚本：$STATE_SCRIPT"
  mkdir -p "$STATE_DIR/public"
  cat > "$STATE_PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$STATE_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/osascript</string>
		<string>-l</string>
		<string>JavaScript</string>
		<string>$STATE_SCRIPT</string>
		<string>$STATE_FILE</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardErrorPath</key>
	<string>/tmp/purple-plash-server.log</string>
</dict>
</plist>
PLIST_EOF
  load_agent "$STATE_LABEL" "$STATE_PLIST"
}

install_agent() {
  [ -x /usr/sbin/httpd ] || die "找不到系统自带的 Apache：/usr/sbin/httpd"
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

  # 端口若仍被旧版服务（如 Python 版）占用，先结束它
  local stale
  stale="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
  # shellcheck disable=SC2086
  [ -n "$stale" ] && kill $stale 2>/dev/null
  load_agent "$LABEL" "$PLIST" || return 1
  install_state_agent || printf '「离开桌面时静音」的桌面状态助手未能启动，其余功能不受影响。\n' >&2

  printf '已安装开机自启：%s\n' "$PLIST"
  printf '                %s\n' "$STATE_PLIST"
  if wait_ready; then
    printf '本地服务已就绪：http://127.0.0.1:%s/index.html\n' "$PORT"
  else
    printf '自启已加载，但服务暂未响应，请查看日志：/tmp/purple-plash-server.log\n'
  fi
}

uninstall_agent() {
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
  launchctl bootout "$DOMAIN/$STATE_LABEL" >/dev/null 2>&1
  # 桌面状态文件停止更新后页面会自动忽略；这里一并清掉，避免残留。
  rm -f "$STATE_FILE"
  local found=""
  for plist in "$PLIST" "$STATE_PLIST"; do
    if [ -f "$plist" ]; then
      rm -f "$plist"
      printf '已移除开机自启：%s\n' "$plist"
      found=1
    fi
  done
  [ -n "$found" ] || printf '未发现已安装的自启配置。\n'

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
  if launchctl print "$DOMAIN/$STATE_LABEL" >/dev/null 2>&1; then
    printf '桌面状态助手：已加载（%s）\n' "$(cat "$STATE_FILE" 2>/dev/null || echo '尚无数据')"
  else
    printf '桌面状态助手：未加载（「离开桌面时静音」不生效）\n'
  fi
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/index.html" 2>/dev/null; then
    printf '本地服务：正常（http://127.0.0.1:%s/index.html）\n' "$PORT"
  else
    printf '本地服务：不可访问\n'
  fi
}

case "${1:-}" in
  start|install)   install_agent ;;
  stop|uninstall)  uninstall_agent ;;
  status)          status_agent ;;
  *) printf '用法：%s start | stop | status\n' "$0"; exit 1 ;;
esac

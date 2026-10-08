#!/bin/bash
# PURPLE · 片刻 —— Plash 本地静态服务（macOS 自带的 Apache，无需安装任何东西）
#
# 由 launchd 开机自启调用（tools/plash-setup.sh 安装），也可手动执行。
# 生成一份只属于本项目的 Apache 配置，以当前用户身份在前台运行：
#   - 只监听 127.0.0.1，不对外网暴露；
#   - 原生支持 Range（206）：Safari / Plash 播放与拖动 MP4 必需；
#   - 所有响应带 Cache-Control: no-cache，改了文件 Plash reload 即可看到；
#   - /desktop-state 指向 tools/desktop-state.js 写出的 JSON（「离开桌面时静音」）。
# 端口固定，因为 localStorage 偏好（收藏、自选定格）与访问地址绑定，换端口会导致已有偏好丢失。
#
# 注意：所有变量引用一律写成 ${var} 形式。macOS 自带 bash 3.2 在
#      变量名紧跟多字节字符（如 ${id}：）时会把中文误并入变量名。
set -u

PORT="${PLASH_PORT:-47070}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${PLASH_STATE_DIR:-${HOME}/Library/Application Support/purple-desktop}"
PUBLIC_DIR="${STATE_DIR}/public"
CONF="${STATE_DIR}/httpd.conf"
HTTPD="/usr/sbin/httpd"
SYSTEM_CONF="/etc/apache2/httpd.conf"
ACCESS_LOG="/tmp/purple-plash-access.log"

if [ ! -x "${HTTPD}" ]; then
  echo "找不到系统自带的 Apache（${HTTPD}），无法启动本地服务。" >&2
  exit 1
fi
mkdir -p "${PUBLIC_DIR}"

# 模块路径按系统配置里的 LoadModule 行取（不同 macOS 版本路径可能不同），找不到再用默认位置。
module() {
  local name="$1" path=""
  if [ -f "${SYSTEM_CONF}" ]; then
    path="$(grep -E "^#?LoadModule[[:space:]]+${name}_module[[:space:]]" "${SYSTEM_CONF}" | head -1 | awk '{print $3}')"
  fi
  [ -n "${path}" ] || path="libexec/apache2/mod_${name}.so"
  printf 'LoadModule %s_module %s\n' "${name}" "${path}"
}
MIME_TYPES="/private/etc/apache2/mime.types"
[ -f "${MIME_TYPES}" ] || MIME_TYPES="/etc/apache2/mime.types"

{
  printf 'ServerRoot "/usr"\n'
  printf 'Listen 127.0.0.1:%s\n' "${PORT}"
  printf 'ServerName 127.0.0.1\n'
  printf 'PidFile "%s/httpd.pid"\n' "${STATE_DIR}"
  printf 'ErrorLog "/dev/stderr"\n'
  for name in mpm_prefork authz_core unixd mime dir headers log_config setenvif alias; do module "${name}"; done
  cat <<CONF_EOF
StartServers 2
MinSpareServers 1
MaxSpareServers 4
MaxRequestWorkers 16
TypesConfig "${MIME_TYPES}"
AddType application/javascript .js
AddType video/mp4 .mp4
AddCharset utf-8 .html .js .css .json
DirectoryIndex index.html
Timeout 60
KeepAlive On

DocumentRoot "${ROOT}"
<Directory "/">
  AllowOverride None
  Require all denied
</Directory>
<Directory "${ROOT}">
  Options None
  AllowOverride None
  Require all granted
</Directory>
# 隐藏文件（.git 等）不对外提供。
<LocationMatch "/\\.">
  Require all denied
</LocationMatch>

Alias /desktop-state "${PUBLIC_DIR}/desktop-state.json"
<Directory "${PUBLIC_DIR}">
  Options None
  AllowOverride None
  Require all granted
</Directory>
<Location "/desktop-state">
  ForceType application/json
  Header set Cache-Control "no-store"
</Location>

Header setifempty Cache-Control "no-cache"

# 访问日志只记页面文件与每个视频的首次请求（Range 从 0 开始），视频分段与轮询不记。
LogFormat "%t \"%r\" %>s" purple
CustomLog "${ACCESS_LOG}" purple "expr=!(%{REQUEST_URI} =~ m#^/(media/|desktop-state)#) || (%{REQUEST_URI} =~ m#^/media/# && %{HTTP:Range} =~ m#^bytes=0-#)"
CONF_EOF
} > "${CONF}"

# 前台运行，由 launchd 直接管理（崩溃自动重启、登录自动运行）。
exec "${HTTPD}" -D FOREGROUND -f "${CONF}"

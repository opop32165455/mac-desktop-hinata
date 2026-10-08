#!/bin/bash
# PURPLE · 片刻 —— 「菜单栏跟随衣橱」的请求入口（Apache CGI，系统自带 bash 运行）。
#
# 页面在穿搭切换、改画面比例 / 明暗、开关「菜单栏跟随衣橱」时请求：
#   GET /wallpaper?look=05&fit=contain&b=100&enabled=1     （必须带请求头 X-Purple: 1）
# 这里只做严格校验并把请求写成 JSON；真正生成并设置桌面图片的是常驻的桌面状态助手
# （tools/desktop-state.js），它每秒读一次这个文件。
# 只接受固定格式的参数，不接受任何路径；自定义请求头让其它网站无法跨域触发。
set -u

STATE_DIR="${PURPLE_STATE_DIR:-${HOME}/Library/Application Support/purple-desktop}"
REQUEST="${STATE_DIR}/wallpaper-request.json"

reply() {
  printf 'Status: %s\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n\r\n%s\n' "$1" "$2"
  exit 0
}

[ "${HTTP_X_PURPLE:-}" = "1" ] || reply "403 Forbidden" '{"error":"forbidden"}'

look="" fit="contain" b="100" enabled="1"
IFS='&' read -r -a pairs <<< "${QUERY_STRING:-}"
for pair in "${pairs[@]}"; do
  key="${pair%%=*}" value="${pair#*=}"
  case "${key}" in
    look) look="${value}" ;;
    fit) fit="${value}" ;;
    b) b="${value}" ;;
    enabled) enabled="${value}" ;;
  esac
done

[[ "${look}" =~ ^[0-9]{2}$ ]] || reply "400 Bad Request" '{"error":"look"}'
[[ "${fit}" == "contain" || "${fit}" == "cover" ]] || reply "400 Bad Request" '{"error":"fit"}'
[[ "${b}" =~ ^[0-9]{2,3}$ ]] && [ "${b}" -ge 50 ] && [ "${b}" -le 150 ] || reply "400 Bad Request" '{"error":"b"}'
[[ "${enabled}" == "0" || "${enabled}" == "1" ]] || reply "400 Bad Request" '{"error":"enabled"}'

mkdir -p "${STATE_DIR}"
tmp="${REQUEST}.$$"
printf '{"look":"%s","fit":"%s","b":%s,"enabled":%s,"at":%s}\n' "${look}" "${fit}" "${b}" \
  "$([ "${enabled}" = 1 ] && echo true || echo false)" "$(date +%s)" > "${tmp}" && mv -f "${tmp}" "${REQUEST}"
reply "200 OK" '{"ok":true}'

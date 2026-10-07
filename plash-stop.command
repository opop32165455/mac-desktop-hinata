#!/bin/bash
# PURPLE · 片刻 —— 停止本地服务并移除开机自启
#
# 执行后壁纸将暂时无法显示，重新双击 plash-start.command 即可恢复。
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

printf '\n  PURPLE · 片刻 —— 停止本地服务\n\n'
./tools/plash-setup.sh uninstall
printf '\n完成。重新双击 plash-start.command 即可恢复。\n\n'
read -r -p '按回车键关闭此窗口…' _

#!/bin/bash
# PURPLE · 片刻 —— 给合并视频的倒放段配上倒放音轨（只重做音轨，视频流原样复制）
#
# 音轨布局与 build-loop-media.sh 的视频帧一一对应（N = 单段帧数，每帧 800 个采样）：
#   [0, N 帧)      正放音轨
#   [N, 2N-1 帧)   倒放：每一下脚步声仍正着播放，起点对准倒放画面里脚落下的那一帧，
#                  其余安静处沿用整段倒放（见 tools/reverse-audio-events.py）
# 音轨比视频少一帧，保证 duration 由视频决定。正放末尾转倒放时波形连续（镜像），不会爆音。
#
# 用法：tools/remux-reverse-audio.sh [look 编号；省略则处理全部]
set -eu

FF="${FFMPEG:-/Users/xczhang/.local/bin/ffmpeg}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MASTERS="${MASTERS:-$(dirname "${PROJECT_DIR}")/desktop-website-webm-masters}"

remux_one() {
  local id="$1"
  local mp4="${PROJECT_DIR}/media/look-${id}.mp4" src="${MASTERS}/look-${id}.webm"
  local out="${mp4}.new"
  [ -f "${mp4}" ] && [ -f "${src}" ] || { echo "跳过 look-${id}：缺少文件" >&2; return 0; }
  # 按视频包数还原 N（2N 帧）；容器时长受音轨影响，不可靠。
  local frames n
  frames="$("${FF}" -hide_banner -i "${mp4}" -map 0:v -c copy -f null - 2>&1 | grep -oE 'frame= *[0-9]+' | tail -1 | grep -oE '[0-9]+')"
  n=$((frames / 2))
  local raw="${mp4}.f32"
  /usr/bin/python3 "${PROJECT_DIR}/tools/reverse-audio-events.py" "${src}" "${n}" "${raw}" "${FF}"
  "${FF}" -y -hide_banner -loglevel error -i "${mp4}" -f f32le -ar 48000 -ac 2 -i "${raw}" \
    -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -movflags +faststart -f mp4 "${out}"
  rm -f "${raw}"
  mv "${out}" "${mp4}"
  echo "look-${id}：N=${n}，$(du -h "${mp4}" | cut -f1)"
}

if [ $# -gt 0 ]; then remux_one "$1"; else for id in 01 02 03 04 05 06 07 08 09; do remux_one "${id}"; done; fi

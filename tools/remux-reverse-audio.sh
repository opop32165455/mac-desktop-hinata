#!/bin/bash
# PURPLE · 片刻 —— 给合并视频的倒放段配上倒放音轨（只重做音轨，视频流原样复制）
#
# 音轨布局与 build-loop-media.sh 的视频帧一一对应（N = 单段帧数，每帧 800 个采样）：
#   [0, N 帧)      正放音轨
#   [N, 2N-1 帧)   原始音轨前 N-1 帧整段倒放 —— 第 k 帧倒放的正是画面第 N+k 帧对应的那一小段
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
  # 2N 帧的文件，容器时长常记作 2N-1 帧；按 ceil(时长 × 30) 还原 N（同 app.js clipDuration）。
  local dur n
  dur="$("${FF}" -hide_banner -i "${mp4}" 2>&1 | grep -oE 'Duration: [0-9:.]+' | head -1 | cut -d' ' -f2)"
  n="$(awk -v d="${dur}" 'BEGIN { split(d, p, ":"); s = p[1] * 3600 + p[2] * 60 + p[3]; x = s * 30 - .05; print (x == int(x)) ? x : int(x) + 1 }')"
  "${FF}" -y -hide_banner -loglevel error -i "${mp4}" -i "${src}" \
    -filter_complex "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=end_sample=$((n * 800)),asplit[f][r0];[r0]atrim=end_sample=$(((n - 1) * 800)),areverse[r];[f][r]concat=n=2:v=0:a=1[a]" \
    -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -movflags +faststart -f mp4 "${out}"
  mv "${out}" "${mp4}"
  echo "look-${id}：N=${n}，$(du -h "${mp4}" | cut -f1)"
}

if [ $# -gt 0 ]; then remux_one "$1"; else for id in 01 02 03 04 05 06 07 08 09; do remux_one "${id}"; done; fi

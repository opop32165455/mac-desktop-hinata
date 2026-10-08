#!/bin/bash
# PURPLE · 片刻 —— 生成「往复循环」视频
#
# 为每个 media/look-XX.mp4 生成一个约 24 秒的合并文件（同名覆盖）：
#   [0 – 12s]  正放：原始内容
#   [12 – 24s] 倒放：整段反向
# 正放段来自原文件解码（零额外损失），倒放段由帧序列重新编码。
# 正放段保留原始音轨，倒放段为静音（反向音频听感异常，故不保留）。
#
# 设计要点：
#  1. 不用 ffmpeg 的 reverse 滤镜 —— 它会把整段解码帧缓冲在内存里，
#     12 秒 4K60 约需 6.8GB，超过本机可用内存。改用「提取帧序列 → 反向
#     排序软链接 → 重新编码」，内存峰值降到约 1.2GB。
#  2. 用单次编码而不是 -c copy 拼接 —— 两段流的编码配置不一致时
#     （如 tv/bt709 与 pc/bt470bg），拼接文件的后半段会黑屏。
#
# 注意：所有变量引用一律写成 ${var} 形式。macOS 自带 bash 3.2 在
#      变量名紧跟多字节字符（如 ${id}：）时会把中文误并入变量名。
#
# 用法：
#   tools/build-loop-media.sh [look 编号，如 04；省略则处理全部]
set -eu

FF="${FFMPEG:-/Users/xczhang/.local/bin/ffmpeg}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

VIDEO_ARGS="-c:v libx264 -preset fast -b:v 15M -maxrate 18M -bufsize 30M -profile:v high -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv"
AUDIO_ARGS="-c:a aac -b:a 128k"

duration_of() {
  "${FF}" -hide_banner -i "$1" 2>&1 | grep -oE 'Duration: [0-9:.]+' | head -1 | cut -d' ' -f2
}

build_one() {
  local id="$1"
  local src="${PROJECT_DIR}/media/look-${id}.mp4"
  local out="${PROJECT_DIR}/media/look-${id}.mp4.new"
  if [ ! -f "${src}" ]; then
    echo "跳过 look-${id}：源文件不存在" >&2
    return 0
  fi

  echo "=== look-${id} 提取帧 ==="
  rm -rf "${WORK}/fwd" "${WORK}/rev"
  mkdir -p "${WORK}/fwd" "${WORK}/rev"
  "${FF}" -y -hide_banner -loglevel error -i "${src}" -an -q:v 1 "${WORK}/fwd/%05d.jpg"
  local n
  n="$(ls "${WORK}/fwd" | wc -l | tr -d ' ')"
  echo "    帧数 ${n}，源时长 $(duration_of "${src}")"

  /usr/bin/python3 - "${WORK}" <<'PY'
import os, sys, glob
work = sys.argv[1]
files = sorted(glob.glob(os.path.join(work, 'fwd', '*.jpg')))
n = len(files)
for i, f in enumerate(files):
    os.symlink(os.path.abspath(f), os.path.join(work, 'rev', '%05d.jpg' % (n - i)))
PY

  echo "=== look-${id} 单次编码（正放 + 倒放 + 音轨）==="
  # shellcheck disable=SC2086
  "${FF}" -y -hide_banner -loglevel error \
    -i "${src}" \
    -framerate 60 -i "${WORK}/rev/%05d.jpg" \
    -f lavfi -t 30 -i anullsrc=r=48000:cl=stereo \
    -filter_complex "[0:v]setpts=PTS-STARTPTS,fps=60,format=yuv420p[vf];[1:v]scale=in_range=full:out_range=limited,setpts=PTS-STARTPTS,fps=60,format=yuv420p[vr];[vf][vr]concat=n=2:v=1:a=0[vout];[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[af];[2:a]atrim=0:12.04,aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[ar];[af][ar]concat=n=2:v=0:a=1[aout]" \
    -map "[vout]" -map "[aout]" \
    ${VIDEO_ARGS} ${AUDIO_ARGS} -movflags +faststart -f mp4 "${out}"

  mv "${out}" "${src}"
  echo "    完成：$(du -h "${src}" | cut -f1)，时长 $(duration_of "${src}")"
}

if [ $# -gt 0 ]; then
  build_one "$1"
else
  for id in 01 02 03 04 05 06 07 08 09; do build_one "${id}"; done
fi

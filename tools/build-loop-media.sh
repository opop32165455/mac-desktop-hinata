#!/bin/bash
# PURPLE · 片刻 —— 从 WebM 母版生成「往复循环」视频
#
# 为每套穿搭生成一个合并文件 media/look-XX.mp4（同名覆盖），N = 母版帧数：
#   帧 [0, N)    正放：原始帧 0 … N-1
#   帧 [N, 2N)   倒放：原始帧 N-2 … 0，再补一帧 0
# 倒放段不重复正放末帧，所以片尾转倒放时没有定住的一帧；末尾补的一帧 0
# 只为让两段等长（时长 = 2N 帧，app.js 以 duration / 2 取单段片长）。
# 原始帧 i 的正放时间是 i/60，倒放时间是 (2N-2-i)/60 —— 见 app.js 的 mirror()。
#
# 设计要点：
#  1. 只做一次有损编码，源是 WebM 母版（VP9），不经过现有 MP4 或 JPEG 中间帧。
#  2. 不对整段用 reverse 滤镜（12 秒 4K60 要缓冲约 9GB 原始帧）。改为每 60 帧一块
#     倒序，存成无损中间文件，再按逆序拼接，内存峰值约 1GB。
#  3. HEVC（hvc1）：同样码率下比 H.264 清晰得多，Apple 芯片硬件解码，
#     Safari / Plash / macOS 上的 Chrome 都能播。Windows 上的 Wallpaper Engine
#     通常不能解 HEVC，需要时可用 CODEC=h264 生成 H.264 版本。
#  4. 每 30 帧（0.5 秒）一个闭合 GOP，关键帧落在整半秒上：默认折返点 7 秒
#     正好是关键帧，文件内 seek（倒带、折返）只需解码很少的帧。
#  5. 倒放段配倒放音轨，与画面逐帧对应；音轨比视频短一帧，保证 duration 由视频决定。
#
# 母版位置默认是项目旁边的 desktop-website-webm-masters/，可用 MASTERS=… 覆盖。
#
# 注意：所有变量引用一律写成 ${var} 形式。macOS 自带 bash 3.2 在
#      变量名紧跟多字节字符（如 ${id}：）时会把中文误并入变量名。
#
# 用法：
#   tools/build-loop-media.sh [look 编号，如 04；省略则处理全部]
#   CRF=14 CODEC=hevc|h264 MASTERS=/path/to/webm tools/build-loop-media.sh
set -eu

FF="${FFMPEG:-/Users/xczhang/.local/bin/ffmpeg}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MASTERS="${MASTERS:-$(dirname "${PROJECT_DIR}")/desktop-website-webm-masters}"
CRF="${CRF:-14}"
CODEC="${CODEC:-hevc}"
WORK="$(mktemp -d)"
trap '[ -n "${KEEP_WORK:-}" ] || rm -rf "${WORK}"' EXIT

COLOR_ARGS="-pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv"
if [ "${CODEC}" = "h264" ]; then
  VIDEO_ARGS="-c:v libx264 -preset slow -crf ${CRF} -profile:v high -g 30 -keyint_min 30 -sc_threshold 0 -flags +cgop"
else
  VIDEO_ARGS="-c:v libx265 -preset medium -crf ${CRF} -tag:v hvc1 -x265-params keyint=30:min-keyint=30:no-open-gop=1:scenecut=0:log-level=error"
fi
AUDIO_ARGS="-c:a aac -b:a 192k"
# 母版有 -0.007 秒的起始偏移；统一归零并锁定 60fps，正放与倒放块用完全相同的取帧方式。
# 倒放块按帧序号重排时间戳（setpts=N/60/TB）：中间 mkv 是毫秒时基，直接沿用会丢帧。
PREP="setpts=PTS-STARTPTS,fps=60,format=yuv420p"
CHUNK=60

frame_count() {
  "${FF}" -hide_banner -i "$1" -map 0:v -vf "${PREP}" -f null - 2>&1 | grep -oE 'frame= *[0-9]+' | tail -1 | grep -oE '[0-9]+'
}

build_one() {
  local id="$1"
  local src="${MASTERS}/look-${id}.webm"
  local out="${PROJECT_DIR}/media/look-${id}.mp4.new"
  if [ ! -f "${src}" ]; then
    echo "跳过 look-${id}：母版不存在 ${src}" >&2
    return 0
  fi
  local n
  n="$(frame_count "${src}")"
  echo "=== look-${id}：${n} 帧，倒序分块 ==="

  rm -rf "${WORK}/rev"; mkdir -p "${WORK}/rev"
  # 倒放段取原始帧 0 … N-2（不含末帧），每块内部倒序，块按逆序拼接。
  local last=$((n - 1)) start=0 end
  : > "${WORK}/rev/list.txt"
  while [ "${start}" -lt "${last}" ]; do
    end=$((start + CHUNK)); [ "${end}" -gt "${last}" ] && end="${last}"
    "${FF}" -y -hide_banner -loglevel error -i "${src}" -an \
      -vf "${PREP},trim=start_frame=${start}:end_frame=${end},setpts=PTS-STARTPTS,reverse" \
      -c:v libx264 -qp 0 -preset ultrafast -pix_fmt yuv420p "${WORK}/rev/$(printf '%05d' "${start}").mkv"
    start="${end}"
  done
  ls "${WORK}/rev"/*.mkv | sort -r | sed "s/^/file '/; s/$/'/" > "${WORK}/rev/list.txt"

  echo "=== look-${id}：单次编码（${CODEC}, CRF ${CRF}）==="
  # 每帧 800 个采样（48000 / 60）。正放音轨补齐到 N 帧；倒放段是原始音轨前 N-1 帧整段倒放，
  # 与倒放画面逐帧对应（音轨比视频少一帧，duration 由视频决定）。镜像接缝处波形连续，不会爆音。
  local fwd_samples=$((n * 800)) rev_samples=$(((n - 1) * 800))
  # shellcheck disable=SC2086
  "${FF}" -y -hide_banner -loglevel error \
    -i "${src}" \
    -f concat -safe 0 -i "${WORK}/rev/list.txt" \
    -filter_complex "[0:v]${PREP}[vf];[1:v]setpts=N/60/TB,tpad=stop=1:stop_mode=clone,format=yuv420p[vr];[vf][vr]concat=n=2:v=1:a=0[vout];[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=end_sample=${fwd_samples},asplit[af][ar0];[ar0]atrim=end_sample=${rev_samples},areverse[ar];[af][ar]concat=n=2:v=0:a=1[aout]" \
    -map "[vout]" -map "[aout]" \
    ${VIDEO_ARGS} ${COLOR_ARGS} ${AUDIO_ARGS} -movflags +faststart -f mp4 "${out}"

  local frames
  frames="$(frame_count "${out}")"
  if [ "${frames}" != "$((n * 2))" ]; then
    echo "look-${id}：帧数 ${frames} ≠ 预期 $((n * 2))，保留原文件不覆盖" >&2
    rm -f "${out}"
    return 1
  fi
  mv "${out}" "${PROJECT_DIR}/media/look-${id}.mp4"
  # 倒放段的音轨换成「保留脚步声」的版本（视频流原样复制）。
  "${PROJECT_DIR}/tools/remux-reverse-audio.sh" "${id}"
  echo "    完成：$(du -h "${PROJECT_DIR}/media/look-${id}.mp4" | cut -f1)，${frames} 帧"
}

if [ $# -gt 0 ]; then
  build_one "$1"
else
  for id in 01 02 03 04 05 06 07 08 09; do build_one "${id}"; done
fi

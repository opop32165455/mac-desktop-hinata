#!/usr/bin/env python3
"""PURPLE · 片刻 —— 生成「保留脚步声」的倒放音轨（仅标准库，兼容 macOS 自带 Python 3.9）。

整段 areverse 会把鞋跟「咚」的一声变成先渐强、后戛然而止的倒吸声。这里改为：
  1. 在正放音轨里找出每一下击打（包络 5ms 窗，从安静中陡然升高的点）；
  2. 倒放段里，每一下击打仍然「正着」播放，但起点放在画面倒放时脚落下的那一刻
     —— 正放时间 t 的击打，起点放在倒放段的 (N-1)/60 - t 处；
  3. 一下击打一直播到倒放段里下一下击打出现前 5ms，且不越过正放里的下一下击打（10ms 淡出）；
  4. 第一下击打之前（即片尾那段安静）沿用整段倒放，接缝处与正放末尾镜像连续。

输入：WebM 母版、单段帧数 N；输出：完整音轨（正放 N 帧 + 倒放 N-1 帧）的 f32le 双声道 48kHz 原始数据。
用法：reverse-audio-events.py MASTER.webm N OUT.f32 [FFMPEG]
"""
import array
import math
import subprocess
import sys

RATE = 48000
PER_FRAME = 800          # 48000 / 60
HOP = 240                # 5ms 包络窗
RISE_DB = 12.0           # 比前 50ms 的最低值高出这么多才算一下击打
FLOOR_DB = -32.0         # 击打峰值至少要到这个响度
MIN_GAP = 0.12           # 两下击打至少间隔 120ms
FADE = 480               # 10ms 淡出
LEAD = 240               # 击打起点往前留 5ms，保住起音


def decode(master, ffmpeg, samples):
    raw = subprocess.run(
        [ffmpeg, '-hide_banner', '-loglevel', 'error', '-i', master, '-vn',
         '-af', 'aresample=48000,aformat=sample_fmts=flt:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad',
         '-t', '%.6f' % (samples / RATE), '-f', 'f32le', '-'],
        check=True, capture_output=True).stdout
    data = array.array('f'); data.frombytes(raw)
    need = samples * 2
    if len(data) < need:
        data.extend([0.0] * (need - len(data)))
    return data[:need]


def onsets(data, samples):
    env = []
    for start in range(0, samples - HOP, HOP):
        acc = 0.0
        for i in range(start * 2, (start + HOP) * 2, 2):
            m = (data[i] + data[i + 1]) * 0.5
            acc += m * m
        env.append(10 * math.log10(acc / HOP + 1e-12))
    found, last = [], -1e9
    for k in range(10, len(env) - 4):
        floor = min(env[k - 10:k])
        peak = max(env[k:k + 4])
        if env[k] - floor >= RISE_DB and peak >= FLOOR_DB and env[k] > env[k - 1]:
            t = k * HOP
            if t - last >= MIN_GAP * RATE:
                found.append(t); last = t
    return found


def main():
    master, n = sys.argv[1], int(sys.argv[2])
    out_path = sys.argv[3]
    ffmpeg = sys.argv[4] if len(sys.argv) > 4 else 'ffmpeg'
    fwd_len, rev_len = n * PER_FRAME, (n - 1) * PER_FRAME
    data = decode(master, ffmpeg, fwd_len)
    hits = [t for t in onsets(data, fwd_len) if t < rev_len]

    # 底：整段倒放（只用于第一下击打之前的片尾安静段，和正放末尾镜像衔接）。
    rev = array.array('f', [0.0]) * (rev_len * 2)
    first = (rev_len - hits[-1]) if hits else rev_len
    for r in range(first):
        src = rev_len - 1 - r
        rev[r * 2] = data[src * 2]; rev[r * 2 + 1] = data[src * 2 + 1]

    # 每一下击打正着播，起点放在镜像时刻；播到倒放段里下一下击打出现前为止。
    # 同时不越过正放里的下一下击打，否则同一下会被播两次。
    following = {t: (hits[i + 1] if i + 1 < len(hits) else fwd_len) for i, t in enumerate(hits)}
    starts = sorted((rev_len - t, t) for t in hits)  # (倒放段位置, 正放时间)
    for idx, (r0, t) in enumerate(starts):
        r_begin = max(0, r0 - LEAD)
        r_end = starts[idx + 1][0] - LEAD if idx + 1 < len(starts) else rev_len
        length = min(r_end - r_begin, following[t] - t)
        for j in range(length):
            src = t - LEAD + j
            if src < 0 or src >= fwd_len:
                continue
            gain = 1.0
            if j >= length - FADE:
                gain = (length - j) / FADE
            if r_begin == 0 and j < FADE:
                gain *= j / FADE
            rev[(r_begin + j) * 2] = data[src * 2] * gain
            rev[(r_begin + j) * 2 + 1] = data[src * 2 + 1] * gain

    with open(out_path, 'wb') as out:
        data.tofile(out)
        rev.tofile(out)
    sys.stderr.write('hits: %s\n' % ', '.join('%.3f' % (t / RATE) for t in hits))


if __name__ == '__main__':
    main()

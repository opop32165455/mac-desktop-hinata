#!/bin/bash
# 把前端文件拷到 build/app-frontend，作为独立应用（Tauri）的前端目录。
# Tauri 会把前端目录整个嵌进可执行文件，所以不能直接用仓库根目录（里面有 360MB 视频）；
# 视频走 tauri.conf.json 的 bundle.resources，放在应用的资源目录里。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/app-frontend"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$ROOT"/index.html "$ROOT"/*.js "$ROOT"/*.css "$OUT"/
cp -R "$ROOT/images" "$OUT/images"
find "$OUT" -name .DS_Store -delete
echo "前端已准备：$OUT"

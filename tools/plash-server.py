#!/usr/bin/env python3
"""PURPLE · 片刻 —— 支持 Range 请求的本地静态服务（仅标准库，兼容 macOS 自带 Python 3.9）。

`python3 -m http.server` 不支持 HTTP Range：对 `Range: bytes=…` 一律回 200 全量。
Safari / Plash（WebKit + AVFoundation）播放 MP4 时按字节区间取数据，每次 seek
都会发新的区间请求；服务端不认 Range 时，WebKit 只能从文件开头重新下载整份
47MB 的视频再跳到目标位置，导致：
  - 往复折返、倒带等 seek 处卡顿（'waiting'）；
  - 某些片子播到一半停住，再也走不到结尾。
这里只补上单区间 Range（206 Partial Content）与 HTTP/1.1 长连接，其余行为不变。

用法：plash-server.py PORT ROOT
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

RANGE = re.compile(r'^bytes=(\d*)-(\d*)$')
CHUNK = 1 << 20

# /desktop-state：用户是否在看桌面（普通窗口覆盖主屏的比例低于阈值）。
# 由 tools/desktop-state.swift 判断，首次请求时编译到缓存目录；编译不了就返回 404，
# 页面会当作没有这项能力（Wallpaper Engine、普通浏览器同样如此）。
HERE = os.path.dirname(os.path.abspath(__file__))
HELPER_SRC = os.path.join(HERE, 'desktop-state.swift')
HELPER_BIN = os.path.expanduser('~/Library/Caches/purple-desktop/desktop-state')
COVER_THRESHOLD = '0.75'
_state_lock = threading.Lock()
_state = {'at': 0.0, 'body': None, 'broken': False}


def helper_ready():
    try:
        if os.path.getmtime(HELPER_BIN) >= os.path.getmtime(HELPER_SRC):
            return True
    except OSError:
        pass
    try:
        os.makedirs(os.path.dirname(HELPER_BIN), exist_ok=True)
        subprocess.run(['/usr/bin/xcrun', 'swiftc', '-O', HELPER_SRC, '-o', HELPER_BIN],
                       check=True, capture_output=True, timeout=180)
        return True
    except Exception as error:
        sys.stderr.write('desktop-state helper unavailable: %s\n' % error)
        return False


def desktop_state():
    with _state_lock:
        if _state['broken']:
            return None
        if _state['body'] is not None and time.monotonic() - _state['at'] < 0.8:
            return _state['body']
        if not helper_ready():
            _state['broken'] = True
            return None
        try:
            out = subprocess.run([HELPER_BIN, COVER_THRESHOLD], check=True, capture_output=True, timeout=5).stdout
            json.loads(out)
        except Exception as error:
            sys.stderr.write('desktop-state failed: %s\n' % error)
            return None
        _state['at'], _state['body'] = time.monotonic(), out.strip()
        return _state['body']


class RangeHandler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        # 每次都向服务器确认（未改动时只回 304），否则 Plash 的 WebKit 会按启发式缓存
        # 继续用旧的 catalog.js / app.js，改了配置 reload 也看不到。
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        if self.path.split('?', 1)[0] == '/desktop-state':
            body = desktop_state()
            if body is None:
                self.send_error(HTTPStatus.NOT_FOUND, 'desktop-state unavailable')
                return
            self.send_response(HTTPStatus.OK)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def send_head(self):
        self.range = None
        header = self.headers.get('Range')
        path = self.translate_path(self.path)
        if not header or os.path.isdir(path):
            return super().send_head()
        match = RANGE.match(header.strip())
        try:
            f = open(path, 'rb')
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, 'File not found')
            return None
        try:
            size = os.fstat(f.fileno()).st_size
            if not match or match.group(1) == match.group(2) == '':
                # 多区间或格式不认识：按规范退回 200 全量。
                f.close()
                return super().send_head()
            if match.group(1) == '':
                start = max(0, size - int(match.group(2)))
                end = size - 1
            else:
                start = int(match.group(1))
                end = min(int(match.group(2)), size - 1) if match.group(2) else size - 1
            if start >= size or start > end:
                f.close()
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header('Content-Range', 'bytes */%d' % size)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return None
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
            self.send_header('Content-Length', str(end - start + 1))
            self.send_header('Last-Modified', self.date_time_string(os.fstat(f.fileno()).st_mtime))
            self.end_headers()
            f.seek(start)
            self.range = (start, end)
            return f
        except Exception:
            f.close()
            raise

    def copyfile(self, source, outputfile):
        if not self.range:
            return super().copyfile(source, outputfile)
        remaining = self.range[1] - self.range[0] + 1
        while remaining > 0:
            data = source.read(min(CHUNK, remaining))
            if not data:
                break
            outputfile.write(data)
            remaining -= len(data)

    def handle(self):
        # WebKit 会随 seek 频繁取消区间请求，断开属正常现象，不必打印回溯。
        try:
            super().handle()
        except (ConnectionError, TimeoutError):
            pass

    def log_message(self, format, *args):
        # launchd 常驻：视频分段请求与 /desktop-state 轮询太多，不记；只记页面文件，
        # 便于确认 Plash reload 后确实取到了新版本。
        path = self.path.split('?', 1)[0]
        if path == '/desktop-state':
            return
        # 视频只记每个文件的第一次请求（Range 从 0 开始），用来确认加载的是哪个版本。
        if path.startswith('/media/') and not (self.headers.get('Range') or '').startswith('bytes=0-'):
            return
        sys.stderr.write('%s %s\n' % (self.log_date_time_string(), format % args))

    def log_error(self, format, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), format % args))


class Server(ThreadingHTTPServer):
    daemon_threads = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 7070
    root = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
    handler = partial(RangeHandler, directory=root)
    with Server(('127.0.0.1', port), handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()

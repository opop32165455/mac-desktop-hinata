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
import os
import re
import sys
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

RANGE = re.compile(r'^bytes=(\d*)-(\d*)$')
CHUNK = 1 << 20


class RangeHandler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()

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
        # launchd 常驻，日志只留错误，避免 /tmp 日志随播放无限增长。
        pass

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

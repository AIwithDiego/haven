"""A real PTY with a bounded JSON-lines transport. No third-party dependencies."""
import os
import sys
import json
import pty
import fcntl
import termios
import struct
import select
import signal
import codecs


def emit(event):
    print(json.dumps(event), flush=True)


def main():
    pid, master = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.environ['COLORTERM'] = 'truecolor'
        shell = os.environ.get('SHELL', '/bin/zsh')
        os.execv(shell, [shell, '-l'])
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    pending = b''
    try:
        while True:
            ready, _, _ = select.select([master, sys.stdin.buffer], [], [], 1)
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                emit({'type': 'data', 'data': decoder.decode(data)})
            if sys.stdin.buffer in ready:
                chunk = os.read(sys.stdin.fileno(), 65536)
                if not chunk:
                    break
                pending += chunk
                if len(pending) > 2000000:
                    raise ValueError('Terminal input exceeds limit')
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    item = json.loads(line)
                    if item['type'] == 'input':
                        payload = item['data'].encode()
                        while payload:
                            payload = payload[os.write(master, payload):]
                    elif item['type'] == 'resize':
                        rows = max(2, min(500, int(item['rows'])))
                        cols = max(2, min(1000, int(item['cols'])))
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                    elif item['type'] == 'stop':
                        return
    finally:
        try:
            os.killpg(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        os.close(master)
        emit({'type': 'exit'})


if __name__ == '__main__':
    main()

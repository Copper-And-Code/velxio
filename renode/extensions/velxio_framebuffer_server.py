import socket
import struct
import threading


MAX_READ_BYTES = 4 * 1024 * 1024


def _read_exact(stream, count):
    chunks = []
    remaining = count
    while remaining:
        data = stream.recv(remaining)
        if not data:
            return None
        chunks.append(data)
        remaining -= len(data)
    return b''.join(chunks)


def _write_header(stream, status):
    stream.sendall(b'VXFR' + struct.pack('<I', status))


def _client_loop(stream, sysbus):
    try:
        while True:
            header = _read_exact(stream, 12)
            if header is None:
                return
            command = header[:4]
            if command not in (b'VXFB', b'VXDW'):
                _write_header(stream, 2)
                return

            addr, count = struct.unpack('<II', header[4:])
            if command == b'VXDW':
                try:
                    sysbus.WriteDoubleWord(addr, count)
                except Exception:
                    _write_header(stream, 3)
                    continue
                _write_header(stream, 0)
                continue

            if count == 0 or count > MAX_READ_BYTES:
                _write_header(stream, 1)
                continue

            try:
                data = sysbus.ReadBytes(addr, count)
            except Exception:
                _write_header(stream, 3)
                continue

            _write_header(stream, 0)
            stream.sendall(bytes(bytearray(data)))
    finally:
        try:
            stream.close()
        except Exception:
            pass


def _server_loop(port, sysbus):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', port))
    server.listen(1)
    print('Velxio framebuffer binary server listening on 127.0.0.1:%d' % port)

    while True:
        client, _addr = server.accept()
        try:
            client.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except Exception:
            pass
        thread = threading.Thread(target=_client_loop, args=(client, sysbus))
        thread.daemon = True
        thread.start()


try:
    _velxio_fb_port = int(VELXIO_FB_PORT)
except Exception:
    raise Exception('VELXIO_FB_PORT must be set before loading velxio_framebuffer_server.py')

_velxio_fb_thread = threading.Thread(
    target=_server_loop,
    args=(_velxio_fb_port, self.Machine.SystemBus),
)
_velxio_fb_thread.daemon = True
_velxio_fb_thread.start()

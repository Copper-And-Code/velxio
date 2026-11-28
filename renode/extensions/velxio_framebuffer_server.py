"""Velxio's binary door into a Renode machine (IronPython, run by the .resc).

One TCP socket, little-endian, a 12-byte request (command, two words) and an
8-byte answer header ('VXFR', status: 0 done) before any data:

  VXFB addr count   read `count` bytes of memory (the LTDC framebuffer)
  VXDW addr value   write a doubleword (the touch mailbox)
  VXPK count 0      then `count` addresses: read each as a doubleword. The
                    answer is the machine's virtual time in microseconds (8
                    bytes) and the `count` values: the pads' and timers'
                    registers and the clock they were read at, in one trip.
  VXGI port pinval  drive a pad from outside: port is the letter's code
                    ('B' = 66), pinval the pin in bits 0-7 and the level in
                    bit 8 (GPIOPort.OnGPIO, what a Button does)

The Renode monitor does the same in text, a command a time: at twenty looks
a second with sixty registers each it could not keep up.
"""
import socket
import struct
import threading


MAX_READ_BYTES = 4 * 1024 * 1024
MAX_PEEK = 256


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


def _peek(stream, machine, sysbus, sysbus_lock, count):
    if count == 0 or count > MAX_PEEK:
        _write_header(stream, 1)
        return False
    raw = _read_exact(stream, 4 * count)
    if raw is None:
        return False
    addrs = struct.unpack('<%dI' % count, raw)
    try:
        with sysbus_lock:
            micros = int(machine.ElapsedVirtualTime.TimeElapsed.TotalMicroseconds)
            values = [int(sysbus.ReadDoubleWord(a)) & 0xFFFFFFFF for a in addrs]
    except Exception:
        _write_header(stream, 3)
        return True
    _write_header(stream, 0)
    stream.sendall(struct.pack('<Q%dI' % count, micros, *values))
    return True


def _gpio_input(stream, machine, ports, port_code, pinval):
    name = chr(port_code & 0xFF)
    try:
        port = ports.get(name)
        if port is None:
            port = machine['sysbus.gpioPort' + name]
            ports[name] = port
        port.OnGPIO(pinval & 0xFF, bool(pinval & 0x100))
    except Exception:
        _write_header(stream, 3)
        return
    _write_header(stream, 0)


def _client_loop(stream, machine, sysbus, sysbus_lock):
    ports = {}
    try:
        while True:
            header = _read_exact(stream, 12)
            if header is None:
                return
            command = header[:4]
            if command not in (b'VXFB', b'VXDW', b'VXPK', b'VXGI'):
                _write_header(stream, 2)
                return

            addr, count = struct.unpack('<II', header[4:])
            if command == b'VXPK':
                if not _peek(stream, machine, sysbus, sysbus_lock, addr):
                    return
                continue
            if command == b'VXGI':
                _gpio_input(stream, machine, ports, addr, count)
                continue
            if command == b'VXDW':
                try:
                    with sysbus_lock:
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
                with sysbus_lock:
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


def _server_loop(port, machine):
    sysbus = machine.SystemBus
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', port))
    server.listen(4)
    sysbus_lock = threading.Lock()
    print('Velxio framebuffer binary server listening on 127.0.0.1:%d' % port)

    while True:
        client, _addr = server.accept()
        try:
            client.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except Exception:
            pass
        thread = threading.Thread(target=_client_loop, args=(client, machine, sysbus, sysbus_lock))
        thread.daemon = True
        thread.start()


try:
    _velxio_fb_port = int(VELXIO_FB_PORT)
except Exception:
    raise Exception('VELXIO_FB_PORT must be set before loading velxio_framebuffer_server.py')

_velxio_fb_thread = threading.Thread(
    target=_server_loop,
    args=(_velxio_fb_port, self.Machine),
)
_velxio_fb_thread.daemon = True
_velxio_fb_thread.start()

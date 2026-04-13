#!/usr/bin/env python3
"""
dolbyx-daemon — DolbyX TCP audio processing daemon.

Runs the DDP ARM processor in the background and accepts TCP connections
from the VST plugin (or any client). Listens on all interfaces so both
WSL2 and Windows can connect.

Usage:
    cd DolbyX/arm
    python3 ../scripts/dolbyx-daemon.py [port]

    Default port: 19876

The daemon starts the qemu-arm-static DDP processor as a child process
and bridges TCP connections to its stdin/stdout pipe.

Protocol (same as the pipe protocol):
    Client connects → daemon sends 4-byte magic 0xDD901DAA
    Client sends:  uint32_t frame_count + int16_t pcm[frames*2]
    Daemon sends:  int16_t pcm[frames*2]
    Client sends:  frame_count=0xFFFFFFFF → disconnect
"""

import socket
import subprocess
import threading
import struct
import os
import sys
import signal
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 19876
READY_MAGIC = 0xDD901DAA
CMD_SHUTDOWN = 0xFFFFFFFF
CHANNELS = 2

# Change to arm/ directory
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ARM_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), 'arm')
os.chdir(ARM_DIR)

def log(msg):
    t = time.strftime('%H:%M:%S')
    print(f'[{t}] {msg}', flush=True)

def start_processor():
    """Start the DDP ARM processor as a subprocess."""
    env = os.environ.copy()
    env['LD_LIBRARY_PATH'] = 'build/lib'
    proc = subprocess.Popen(
        ['qemu-arm-static', '-L', '/usr/arm-linux-gnueabihf',
         'build/ddp_processor', 'build/lib/libdseffect.so',
         '48000', '-6', '0'],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env
    )

    # Read ready magic
    magic_bytes = proc.stdout.read(4)
    if len(magic_bytes) < 4:
        stderr = proc.stderr.read().decode('utf-8', errors='replace')
        log(f'Processor failed to start: {stderr[:200]}')
        proc.kill()
        return None
    magic = struct.unpack('<I', magic_bytes)[0]
    if magic != READY_MAGIC:
        log(f'Bad magic: 0x{magic:08X}')
        proc.kill()
        return None

    log('DDP processor ready')
    return proc

def recv_exact(sock, n):
    """Receive exactly n bytes from socket."""
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)

def handle_client(sock, addr):
    """Handle one VST client connection."""
    log(f'Client connected: {addr}')

    proc = start_processor()
    if not proc:
        log(f'Failed to start processor for {addr}')
        sock.close()
        return

    # Send ready magic to client
    sock.sendall(struct.pack('<I', READY_MAGIC))

    blocks = 0
    try:
        while True:
            # Read frame count from client
            header = recv_exact(sock, 4)
            if not header:
                break
            frame_count = struct.unpack('<I', header)[0]

            if frame_count == CMD_SHUTDOWN:
                break

            if frame_count > 65536:
                log(f'Frame count too large: {frame_count}')
                break

            # Read PCM from client
            pcm_bytes = frame_count * CHANNELS * 2
            pcm_in = recv_exact(sock, pcm_bytes)
            if not pcm_in:
                break

            # Forward to processor
            proc.stdin.write(struct.pack('<I', frame_count))
            proc.stdin.write(pcm_in)
            proc.stdin.flush()

            # Read processed PCM from processor
            pcm_out = proc.stdout.read(pcm_bytes)
            if len(pcm_out) < pcm_bytes:
                log(f'Short read from processor: {len(pcm_out)}/{pcm_bytes}')
                break

            # Send to client
            sock.sendall(pcm_out)

            blocks += 1
    except (ConnectionResetError, BrokenPipeError, OSError) as e:
        log(f'Connection error: {e}')
    finally:
        log(f'Client {addr} disconnected after {blocks} blocks')
        # Shutdown processor
        try:
            proc.stdin.write(struct.pack('<I', CMD_SHUTDOWN))
            proc.stdin.flush()
            proc.wait(timeout=2)
        except:
            proc.kill()
        sock.close()

def main():
    log(f'DolbyX daemon starting on port {PORT}')
    log(f'Working directory: {ARM_DIR}')

    # Verify processor can start
    test = start_processor()
    if not test:
        log('ERROR: Cannot start DDP processor. Run setup_wsl.sh first.')
        sys.exit(1)
    test.stdin.write(struct.pack('<I', CMD_SHUTDOWN))
    test.stdin.flush()
    test.wait(timeout=5)
    log('Processor smoke test passed')

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('0.0.0.0', PORT))
    server.listen(4)

    log(f'Listening on 0.0.0.0:{PORT}')
    log(f'VST should connect to localhost:{PORT}')
    log('Press Ctrl+C to stop\n')

    try:
        while True:
            sock, addr = server.accept()
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            t = threading.Thread(target=handle_client, args=(sock, addr),
                               daemon=True)
            t.start()
    except KeyboardInterrupt:
        log('\nShutting down...')
    finally:
        server.close()

if __name__ == '__main__':
    main()

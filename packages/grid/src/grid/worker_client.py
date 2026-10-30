"""Run one per-tile job on the warm worker, and exit with its status. Standard library only,
so it starts in milliseconds under `python -S`.

    python -S worker_client.py SOCKET LOG STAGE RUN THREADS [KEY...]
"""

import json
import os
import socket
import sys


def main(argv):
    sock, log, *job = argv
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.connect(sock)
        request = {"cwd": os.getcwd(), "log": os.path.abspath(log), "argv": job}
        s.sendall((json.dumps(request) + "\n").encode())
        with s.makefile() as f:
            reply = f.readline().strip()
    # No reply: the job's child died before it could send one.
    return int(reply) if reply else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

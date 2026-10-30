"""A warm worker for the per-tile jobs: it imports the grid package once, then forks a child
per job, so a job pays a fork (about 30 ms) rather than a Python start and imports (about
1 s). Snakemake's shell command for a job is worker_client.py, which sends the job's
arguments and log path and exits with its status.

    python -m grid.worker SOCKET

It prints "ready" once it listens. A job's child runs in its own session with stderr in the
job's log; a client that goes away leaves its job running. Stopping the worker (SIGTERM)
stops every job and the tools they run, and waits for them, so no job outlives the run. It
stops itself within a second or two of its parent's end, a `grid tiles` killed outright
included.
"""

import contextlib
import json
import logging
import os
import signal
import socket
import sys
import traceback

from . import tiles

# The running jobs' children, each the leader of its own process group.
children = set()
# The signals held while a child is forked and registered.
HELD = {signal.SIGCHLD, signal.SIGTERM, signal.SIGINT}


def reap():
    """Collect finished children, so none is left a zombie."""
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if not pid:
            return
        children.discard(pid)


def stop(*_):
    """Stop every job and its tools, wait for them, then exit."""
    # A second signal waits: it would start this over before the jobs were waited for.
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
    # No reaping while this works through the jobs: the handler would change the set
    # under it, and a job reaped there can't be waited for here.
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGCHLD})
    running = list(children)
    for pid in running:
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            # Forked but not yet its own group's leader, or already gone.
            with contextlib.suppress(ProcessLookupError):
                os.kill(pid, signal.SIGTERM)
    for pid in running:
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
    os._exit(0)


def child(request) -> int:
    os.setsid()
    os.chdir(request["cwd"])
    fd = os.open(request["log"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    # Its output and errors, and the tools', go to the job's log: the worker's own stdout
    # is a pipe nobody reads once it's ready.
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    sys.stdout = os.fdopen(1, "w", buffering=1)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", force=True
    )
    try:
        tiles.job(request["argv"])
        return 0
    # Any failure, an exit included, goes to the job's log and its status.
    except BaseException:  # noqa: BLE001
        traceback.print_exc()
        return 1
    finally:
        sys.stderr.flush()


def serve(path: str):
    # Fork only from here, with no thread started and no DuckDB connection open.
    if os.path.exists(path):
        os.unlink(path)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen(256)
    # Each child is reaped as it ends.
    signal.signal(signal.SIGCHLD, lambda *_: reap())
    # Its own session, so a terminal's Ctrl-C reaches `grid tiles`, which stops it; either
    # signal stops its jobs.
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    # Its parent, `grid tiles`, checked every second: killed outright, it can't stop this,
    # and this in its own session gets no signal of its parent's end.
    parent = os.getppid()
    server.settimeout(1)
    print("ready", os.getpid(), flush=True)
    while True:
        # Checked before each job too: a steady stream of jobs never lets accept time out.
        if os.getppid() != parent:
            stop()
        try:
            conn, _ = server.accept()
        except TimeoutError:
            continue
        try:
            with conn.makefile() as f:
                request = json.loads(f.readline())
            if not isinstance(request, dict) or not {"cwd", "log", "argv"} <= request.keys():
                raise ValueError(request)
        except (OSError, ValueError):
            # A client gone before it sent its job, or not one of ours: it gets no reply.
            conn.close()
            continue
        # Held until the child is in `children`: a child that ends at once is reaped from
        # it, not left there for stop() to signal after its pid is reused, and a stop
        # signal waits until stop() will find the child.
        signal.pthread_sigmask(signal.SIG_BLOCK, HELD)
        pid = os.fork()
        if pid:
            children.add(pid)
            signal.pthread_sigmask(signal.SIG_UNBLOCK, HELD)
            conn.close()
            continue
        server.close()
        for sig in HELD:
            signal.signal(sig, signal.SIG_DFL)
        signal.pthread_sigmask(signal.SIG_UNBLOCK, HELD)
        code = child(request)
        try:
            conn.sendall(f"{code}\n".encode())
        except OSError:
            pass
        os._exit(code)


if __name__ == "__main__":
    serve(sys.argv[1])

"""Exercise terminal prompts without using a real portal or the caller's terminal."""

import errno
import json
import os
import pty
import select
import signal
import sys
import termios
import time


def run(request):
    pid, terminal = pty.fork()
    if pid == 0:
        if request.get("stdoutFile"):
            output_file = os.open(request["stdoutFile"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.dup2(output_file, 1)
            os.close(output_file)
        os.execvpe(request["argv"][0], request["argv"], os.environ)

    output = bytearray()
    turn = 0
    search_from = 0
    echo_during_input = []
    status = None
    error = None
    closed = False
    deadline = time.monotonic() + 20
    try:
        while time.monotonic() < deadline:
            if not closed and select.select([terminal], [], [], 0.05)[0]:
                try:
                    chunk = os.read(terminal, 65536)
                    if chunk:
                        output.extend(chunk)
                    else:
                        closed = True
                except OSError as failure:
                    if failure.errno != errno.EIO:
                        raise
                    closed = True

            if turn < len(request["responses"]) and not closed:
                response = request["responses"][turn]
                prompt = response["prompt"].encode()
                position = output.find(prompt, search_from)
                if position != -1:
                    echo = bool(termios.tcgetattr(terminal)[3] & termios.ECHO)
                    # Wait for read -s, not merely printf, before sending a password.
                    if not response.get("secret", False) or not echo:
                        os.write(terminal, response["input"].encode())
                        echo_during_input.append(echo)
                        search_from = position + len(prompt)
                        turn += 1

            if status is None:
                finished, child_status = os.waitpid(pid, os.WNOHANG)
                if finished:
                    status = child_status
            if status is not None and closed:
                break
        else:
            error = "Terminal interaction timed out."

        echo_restored = bool(termios.tcgetattr(terminal)[3] & termios.ECHO)
    finally:
        if status is None:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            _, status = os.waitpid(pid, 0)
        os.close(terminal)

    code = os.waitstatus_to_exitcode(status)
    return {
        "status": code if code >= 0 else 128 - code,
        "output": output.decode(errors="replace"),
        "responsesSent": turn,
        "echoDuringInput": echo_during_input,
        "echoRestored": echo_restored,
        "error": error,
    }


if len(sys.argv) > 1 and sys.argv[1] == "--no-terminal":
    # A fresh session cannot prompt on the developer's controlling terminal.
    os.setsid()
    os.execvpe("bash", ["bash", *sys.argv[2:]], os.environ)
else:
    print(json.dumps(run(json.load(sys.stdin))))

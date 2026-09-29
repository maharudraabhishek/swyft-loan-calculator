"""Start the Windows desktop, API, and PostgreSQL with one command.

``dev`` and ``production`` run a local API with development sign-in (a local consent
page stands in for Google, because Google only returns to the registered Cloud Run
callback) and in-memory logos; ``production`` compiles the API and desktop first.
``cloud`` builds the desktop against the deployed Cloud Run API from
``apps/desktop/.env.production`` and launches it: real Google sign-in in the normal
browser, Cloud SQL and Cloud Storage. It starts no local API or Docker services.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
CREDENTIALS = ROOT / ".local-stack.json"
DEFAULT_API_PORT = 8080
DEFAULT_RENDERER_PORT = 5173


DESKTOP_PRODUCTION_ENV = ROOT / "apps" / "desktop" / ".env.production"


def cloud_api_origin(env_file: Path = DESKTOP_PRODUCTION_ENV) -> str:
    """The deployed API origin the installer uses (a public value, never a secret)."""
    for line in env_file.read_text(encoding="utf-8").splitlines():
        name, _, value = line.strip().partition("=")
        if name == "MAIN_VITE_API_BASE_URL":
            origin = value.strip()
            if not origin.startswith("https://") or origin.rstrip("/") != origin:
                raise ValueError(f"{env_file}: MAIN_VITE_API_BASE_URL must be an https origin")
            return origin
    raise ValueError(f"{env_file}: MAIN_VITE_API_BASE_URL is not set")


def run_cloud(pnpm: str) -> int:
    """Desktop against the deployed API; closing the window ends the command."""
    origin = cloud_api_origin()
    env = os.environ.copy()
    for name in ("ELECTRON_RENDERER_URL", "SWYFT_RENDERER_PORT", "DB_PASSWORD", "DB_USER"):
        env.pop(name, None)
    env.update(NODE_ENV="production", MAIN_VITE_API_BASE_URL=origin)
    run([pnpm, "--filter", "@swyft/desktop", "build"], env)
    print(f"[local] Desktop uses the deployed API at {origin} (real Google sign-in).", flush=True)
    desktop = start([pnpm, "--filter", "@swyft/desktop", "exec", "electron", "."], env)
    try:
        return desktop.wait() or 0
    except KeyboardInterrupt:
        print("\n[local] Stopping the app", flush=True)
        return 0
    finally:
        stop(desktop)


def run(command: list[str], env: dict[str, str] | None = None) -> None:
    print(f"[local] {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=ROOT, env=env, check=True)


def local_credentials() -> dict[str, str]:
    if CREDENTIALS.exists():
        values = json.loads(CREDENTIALS.read_text(encoding="utf-8"))
        if not isinstance(values, dict) or not all(
            isinstance(values.get(key), str) and len(values[key]) >= 16
            for key in ("owner_password", "app_password")
        ):
            raise ValueError(f"Invalid local credentials file: {CREDENTIALS}")
        return values

    values = {
        "owner_password": secrets.token_hex(32),
        "app_password": secrets.token_hex(32),
    }
    # Exclusive creation prevents an existing local configuration being overwritten.
    with CREDENTIALS.open("x", encoding="utf-8") as file:
        json.dump(values, file)
        file.write("\n")
    return values


def local_environment(credentials: dict[str, str], api_port: int) -> dict[str, str]:
    env = os.environ.copy()
    api_origin = f"http://127.0.0.1:{api_port}"
    for name in (
        "ADMIN_DATABASE_URL",
        "MIGRATION_DATABASE_URL",
        "APP_DATABASE_URL",
        "ELECTRON_RENDERER_URL",
        "SWYFT_OWNER_PASSWORD",
        "SWYFT_APP_PASSWORD",
        "DB_ADMIN_PASSWORD",
        "GCIP_API_KEY",
        "GCIP_PROJECT_ID",
        "LOGO_BUCKET",
    ):
        env.pop(name, None)
    env.update(
        NODE_ENV="development",
        HOST="127.0.0.1",
        PORT=str(api_port),
        PUBLIC_BASE_URL=api_origin,
        DB_HOST="127.0.0.1",
        DB_PORT="55432",
        DB_NAME="swyft",
        DB_USER="swyft_app",
        DB_PASSWORD=credentials["app_password"],
        DB_SSL="false",
        IDENTITY_PROVIDER="dev",
        LOGO_STORAGE="memory",
        TRUST_PROXY_HOPS="0",
        MAIN_VITE_API_BASE_URL=api_origin,
    )
    return env


def desktop_environment(runtime: dict[str, str]) -> dict[str, str]:
    env = runtime.copy()
    for name in ("DB_PASSWORD", "DB_USER", "DB_HOST", "DB_PORT", "DB_NAME"):
        env.pop(name, None)
    return env


def port_in_use(port: int) -> bool:
    for family, address in (
        (socket.AF_INET, ("127.0.0.1", port)),
        (socket.AF_INET6, ("::1", port)),
    ):
        try:
            with socket.socket(family) as connection:
                connection.settimeout(0.5)
                if connection.connect_ex(address) == 0:
                    return True
        except OSError:
            # IPv6 may be unavailable on a Windows machine.
            continue
    return False


def listening_pids(port: int) -> set[int]:
    result = subprocess.run(
        ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, check=True
    )
    pids: set[int] = set()
    for line in result.stdout.splitlines():
        fields = line.split()
        if (
            len(fields) == 5
            and fields[0] == "TCP"
            and fields[3] == "LISTENING"
            and fields[1].rsplit(":", 1)[-1] == str(port)
            and fields[4].isdigit()
        ):
            pids.add(int(fields[4]))
    return pids


def process_details(pid: int) -> tuple[int, str] | None:
    # CIM exposes the command line and parent PID without adding a Python package.
    command = (
        f"Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}' | "
        "Select-Object ParentProcessId,CommandLine | ConvertTo-Json -Compress"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", command],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return None
    try:
        data = json.loads(result.stdout)
        return int(data["ParentProcessId"]), str(data["CommandLine"] or "")
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def workspace_process(pid: int, port: int) -> int | None:
    """Return a launcher-related process to stop; never stop an unrelated listener."""
    root = str(ROOT).lower().replace("/", "\\")
    chain: list[tuple[int, str]] = []
    seen: set[int] = set()
    while pid > 0 and pid not in seen and len(chain) < 6:
        seen.add(pid)
        details = process_details(pid)
        if details is None:
            break
        parent, command = details
        chain.append((pid, command.lower().replace("/", "\\")))
        pid = parent
    marker = (
        (lambda cmd: "src\\server.ts" in cmd or "dist\\server.js" in cmd)
        if port == DEFAULT_API_PORT
        else (lambda cmd: "electron-vite" in cmd)
    )
    if not any(root in command and marker(command) for _, command in chain):
        return None
    # Stop the watcher itself so it cannot immediately respawn the port owner.
    for candidate, command in chain:
        if root in command and (
            "tsx watch" in command or "electron-vite dev" in command
        ):
            return candidate
    return chain[0][0]


def clear_workspace_port(port: int) -> None:
    if not port_in_use(port):
        return
    for pid in listening_pids(port):
        target = workspace_process(pid, port)
        if target is None:
            print(f"[local] Port {port} belongs to another process; leaving it running.", flush=True)
            continue
        print(f"[local] Closing this workspace's process on port {port}.", flush=True)
        subprocess.run(
            ["taskkill", "/PID", str(target), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    for _ in range(10):
        if not port_in_use(port):
            return
        time.sleep(0.2)


def free_port(preferred: int) -> int:
    for port in range(preferred, preferred + 20):
        if not port_in_use(port):
            return port
    raise RuntimeError(f"No free local port between {preferred} and {preferred + 19}")


def wait_for_api(
    process: subprocess.Popen[bytes], api_origin: str, timeout: int = 45
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"API exited during startup ({process.returncode})")
        try:
            with urlopen(f"{api_origin}/ready", timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, URLError):
            pass
        time.sleep(0.5)
    raise RuntimeError("API did not become ready within 45 seconds")


def start(command: list[str], env: dict[str, str]) -> subprocess.Popen[bytes]:
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    print(f"[local] Starting {' '.join(command)}", flush=True)
    return subprocess.Popen(command, cwd=ROOT, env=env, creationflags=flags)


def stop(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        # pnpm.cmd starts a Node/Electron child tree; stopping only cmd leaves it alive.
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "mode",
        nargs="?",
        choices=("dev", "production", "cloud"),
        default="dev",
        help=(
            "dev uses file watchers; production runs compiled local builds; "
            "cloud runs the compiled desktop against the deployed Cloud Run API"
        ),
    )
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("This launcher is for the Windows desktop app")
    pnpm = shutil.which("pnpm.cmd")
    if args.mode == "cloud":
        if not pnpm:
            parser.error("Node/pnpm.cmd must be installed and on PATH")
        if not (ROOT / "node_modules" / ".pnpm").is_dir():
            run([pnpm, "install", "--frozen-lockfile"])
        return run_cloud(pnpm)
    docker = shutil.which("docker.exe") or shutil.which("docker")
    if not pnpm or not docker:
        parser.error("Node/pnpm.cmd and Docker Desktop must be installed and on PATH")
    clear_workspace_port(DEFAULT_API_PORT)
    if args.mode == "dev":
        clear_workspace_port(DEFAULT_RENDERER_PORT)
    api_port = free_port(DEFAULT_API_PORT)
    renderer_port = free_port(DEFAULT_RENDERER_PORT)
    if api_port != DEFAULT_API_PORT:
        print(f"[local] Port 8080 is still occupied; using API port {api_port}.", flush=True)
    if args.mode == "dev" and renderer_port != DEFAULT_RENDERER_PORT:
        print(f"[local] Port 5173 is still occupied; using renderer port {renderer_port}.", flush=True)

    if not (ROOT / "node_modules" / ".pnpm").is_dir():
        run([pnpm, "install", "--frozen-lockfile"])
    run([docker, "compose", "up", "-d", "--wait", "postgres"])
    credentials = local_credentials()
    env = local_environment(credentials, api_port)
    # The database is persistent. Reusing the saved credentials makes bootstrap
    # idempotent and preserves the existing deals across launcher runs.
    bootstrap_env = env | {
        "SWYFT_DB_NAME": "swyft",
        "SWYFT_OWNER_PASSWORD": credentials["owner_password"],
        "SWYFT_APP_PASSWORD": credentials["app_password"],
        "DB_ADMIN_PASSWORD": "local-dev-only",
    }
    run([pnpm, "--filter", "@swyft/api", "db:bootstrap"], bootstrap_env)
    migrate_env = env | {"SWYFT_OWNER_PASSWORD": credentials["owner_password"]}
    run([pnpm, "--filter", "@swyft/api", "db:migrate"], migrate_env)

    if args.mode == "production":
        build_env = desktop_environment(env)
        build_env["NODE_ENV"] = "production"
        run([pnpm, "--filter", "@swyft/api", "build"], build_env)
        run([pnpm, "--filter", "@swyft/desktop", "build"], build_env)
        api_command = [pnpm, "api:start"]
        desktop_command = [pnpm, "--filter", "@swyft/desktop", "exec", "electron", "."]
    else:
        api_command = [pnpm, "api:dev"]
        desktop_command = [pnpm, "desktop:dev"]

    api_origin = f"http://127.0.0.1:{api_port}"
    api = start(api_command, env)
    desktop: subprocess.Popen[bytes] | None = None
    try:
        try:
            wait_for_api(api, api_origin)
        except RuntimeError:
            if api.poll() is None or not port_in_use(api_port):
                raise
            # Another process won the race for this port after our first check.
            stop(api)
            api_port = free_port(api_port + 1)
            env = local_environment(credentials, api_port)
            api_origin = f"http://127.0.0.1:{api_port}"
            print(f"[local] Retrying API on {api_origin}.", flush=True)
            api = start(api_command, env)
            wait_for_api(api, api_origin)
        print(f"[local] API ready at {api_origin}; opening desktop", flush=True)
        if args.mode == "production" and api_port != int(build_env["PORT"]):
            build_env = desktop_environment(env)
            build_env["NODE_ENV"] = "production"
            run([pnpm, "--filter", "@swyft/desktop", "build"], build_env)
        desktop_env = desktop_environment(env)
        desktop_env["SWYFT_RENDERER_PORT"] = str(renderer_port)
        desktop = start(desktop_command, desktop_env)
        print("[local] Close the desktop window or press Ctrl+C to stop the app and API.", flush=True)
        while True:
            if api.poll() is not None:
                raise RuntimeError(f"API exited ({api.returncode})")
            if desktop.poll() is not None:
                return desktop.returncode or 0
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n[local] Stopping app and API", flush=True)
        return 0
    finally:
        if desktop is not None:
            stop(desktop)
        stop(api)
        print("[local] PostgreSQL data remains available in Docker.", flush=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"[local] {error}", file=sys.stderr)
        sys.exit(1)

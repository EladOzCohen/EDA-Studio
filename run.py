"""EDA Studio launcher.

    python run.py              desktop window (pywebview)
    python run.py --browser    serve only and open the default browser
    python run.py --no-open    serve only (dev / preview)
"""
from __future__ import annotations

import argparse
import socket
import sys
import threading
import time
import webbrowser

FILE_TYPES = ("Data files (*.csv;*.tsv;*.txt;*.json;*.jsonl;*.ndjson;*.parquet;*.xlsx;*.xlsm;*.xls)", "All files (*.*)")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--browser", action="store_true", help="open in the default browser instead of a desktop window")
    ap.add_argument("--no-open", action="store_true", help="just serve")
    args = ap.parse_args()

    import uvicorn
    from app import main as backend

    port = args.port or free_port()
    cfg = uvicorn.Config(backend.app, host="127.0.0.1", port=port, log_level="warning",
                         log_config=None if getattr(sys, "frozen", False) else uvicorn.config.LOGGING_CONFIG)
    server = uvicorn.Server(cfg)
    threading.Thread(target=server.run, daemon=True).start()
    while not server.started:
        time.sleep(0.05)
    url = f"http://127.0.0.1:{port}/"
    print(f"EDA Studio running at {url}", flush=True)

    if args.no_open:
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return
    if not args.browser:
        try:
            import webview
            window = webview.create_window("EDA Studio", url, width=1440, height=900, min_size=(1000, 650))

            def pick():
                res = window.create_file_dialog(webview.OPEN_DIALOG, file_types=FILE_TYPES)
                return res[0] if res else None

            backend.native_file_picker = pick
            webview.start()
            server.should_exit = True
            return
        except Exception as e:  # noqa: BLE001  (no WebView2 etc.) -> fall back to the browser
            print(f"Desktop window unavailable ({e}); opening the browser instead.", flush=True)
    webbrowser.open(url)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception:  # windowed exe has no console: leave a log next to it
        import traceback
        from pathlib import Path
        log = Path(sys.executable).parent / "EDAStudio_error.log" if getattr(sys, "frozen", False) else Path("EDAStudio_error.log")
        log.write_text(traceback.format_exc(), encoding="utf-8")
        raise

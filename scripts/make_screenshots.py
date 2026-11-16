"""Regenerate the README screenshots in docs/screenshots/ (headless Edge/Chrome driven over the DevTools protocol).

    .venv\\Scripts\\python.exe scripts\\make_screenshots.py

Needs: websocket-client (pip install websocket-client) and Microsoft Edge or Chrome.
"""
from __future__ import annotations

import base64
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

import uvicorn
import websocket

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
OUT = ROOT / "docs" / "screenshots"
PORT, CDP = 8770, 9333
BROWSERS = [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe"]

HELPERS = r"""
window.sleep = ms => new Promise(r => setTimeout(r, ms));
window.dndField = (name, target) => {
  const src = [...document.querySelectorAll('#fieldList .field')].find(f => f.querySelector('.fname').textContent === name);
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent('dragstart', {dataTransfer: dt, bubbles: true}));
  target.dispatchEvent(new DragEvent('dragover', {dataTransfer: dt, bubbles: true, cancelable: true}));
  target.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true}));
  src.dispatchEvent(new DragEvent('dragend', {dataTransfer: dt, bubbles: true}));
};
window.dropTile = mark => {
  const tile = [...document.querySelectorAll('#palette .tile')].find(t => t.textContent.trim().startsWith(mark));
  const dt = new DataTransfer(); const cv = document.querySelector('#canvas');
  tile.dispatchEvent(new DragEvent('dragstart', {dataTransfer: dt, bubbles: true}));
  cv.dispatchEvent(new DragEvent('dragover', {dataTransfer: dt, bubbles: true, cancelable: true}));
  cv.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true}));
};
window.Z = s => document.querySelector(`.shelf-zone[data-shelf=${s}]`);
window.slotZone = i => document.querySelectorAll('.slot-zone')[i];
"""

DASHBOARD = r"""
(async () => {
  const core = await import('/js/core.js'), canvas = await import('/js/canvas.js'), filters = await import('/js/filters.js');
  const S = core.S;
  const nth = i => S.charts[i];
  // 1 bar (the empty chart created on load)
  dndField('category', Z('x')); dndField('revenue', Z('y')); dndField('channel', Z('color')); await sleep(400);
  nth(0).title = 'Revenue by category'; nth(0).footnote = 'Source: sales_sample.csv (synthetic data), 2023–2024.';
  nth(0).options.sort = 'none';
  dropTile('Line'); await sleep(300);
  dndField('order_date', Z('x')); dndField('revenue', Z('y')); dndField('region', Z('color')); await sleep(300);
  S.shelves.x.trunc = 'month'; core.emit('shelves-changed'); await sleep(300);
  nth(1).title = 'Monthly revenue by region'; nth(1).footnote = 'Revenue summed per calendar month.';
  dropTile('Box'); await sleep(300);
  dndField('channel', Z('x')); dndField('satisfaction', Z('y')); dndField('category', Z('color')); await sleep(300);
  nth(2).title = 'Satisfaction by channel and category'; nth(2).footnote = 'Box = Q1–Q3, line = median, whiskers = 1.5×IQR.';
  dropTile('Heatmap'); await sleep(300);
  dndField('region', Z('x')); dndField('category', Z('y')); dndField('revenue', Z('color')); await sleep(300);
  nth(3).title = 'Where the revenue comes from'; nth(3).footnote = 'Color scale = summed revenue.';
  S.charts.forEach(c => { c.w = 640; c.h = 370; });
  S.filters.push({ field: 'order_date', kind: 'range', min: '2023-01-01', max: null });
  filters.renderFilters();
  S.activeId = nth(1).id;
  canvas.renderCanvas(); canvas.selectChart(nth(1).id);
  await sleep(3500);
  return S.charts.map(c => c.title);
})()
"""

TTEST = r"""
(async () => {
  document.querySelector('.tab[data-tab=stats]').click(); await sleep(300);
  const sel = document.querySelector('.analysis-select'); sel.value = 'ttest_ind'; sel.dispatchEvent(new Event('change')); await sleep(300);
  dndField('satisfaction', slotZone(0)); await sleep(200);
  dndField('channel', slotZone(1)); await sleep(3500);
  return document.querySelector('#statsResults').innerText.length;
})()
"""

REGRESSION = r"""
(async () => {
  const sel = document.querySelector('.analysis-select'); sel.value = 'regression'; sel.dispatchEvent(new Event('change')); await sleep(300);
  dndField('satisfaction', slotZone(0)); await sleep(150);
  dndField('discount', slotZone(1)); await sleep(150);
  dndField('customer_age', slotZone(1)); await sleep(150);
  dndField('channel', slotZone(2)); await sleep(4000);
  return document.querySelector('#statsResults').innerText.length;
})()
"""


class Browser:
    def __init__(self):
        exe = next((b for b in BROWSERS if Path(b).exists()), None)
        if not exe:
            sys.exit("No Edge/Chrome found")
        self.tmp = tempfile.mkdtemp(prefix="eda_shots_")
        self.proc = subprocess.Popen([exe, "--headless=new", f"--remote-debugging-port={CDP}", f"--user-data-dir={self.tmp}", "--hide-scrollbars",
                                      "--no-first-run", "--disable-gpu", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{CDP}/json"))
                page = next(t for t in tabs if t["type"] == "page")
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.5)
        else:
            sys.exit("Browser did not start")
        self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], max_size=None)
        self.n = 0

    def call(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.n:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg["result"]

    def js(self, code):
        r = self.call("Runtime.evaluate", expression=code, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r:
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:600])
        return r["result"].get("value")

    def shot(self, name, w, h, scale, scheme):
        self.call("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=scale, mobile=False)
        self.call("Emulation.setEmulatedMedia", features=[{"name": "prefers-color-scheme", "value": scheme}])
        time.sleep(2.5)   # charts redraw on theme / size change
        data = self.call("Page.captureScreenshot", format="png")["data"]
        (OUT / name).write_bytes(base64.b64decode(data))
        print("wrote", name, round((OUT / name).stat().st_size / 1024), "KB")

    def close(self):
        try:
            self.ws.close()
        finally:
            self.proc.terminate()
            shutil.rmtree(self.tmp, ignore_errors=True)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    from app import main as backend
    server = uvicorn.Server(uvicorn.Config(backend.app, host="127.0.0.1", port=PORT, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    while not server.started:
        time.sleep(0.1)
    b = Browser()
    try:
        b.call("Page.enable")
        b.call("Emulation.setDeviceMetricsOverride", width=1600, height=1070, deviceScaleFactor=1.5, mobile=False)
        b.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/")
        time.sleep(3)
        b.js(HELPERS)
        b.js("(async()=>{[...document.querySelectorAll('#samples button')].find(x=>x.textContent==='sales_sample.csv').click(); await sleep(2500);})()")
        print("dashboard:", b.js(DASHBOARD))
        b.shot("dashboard-dark.png", 1600, 1070, 1.5, "dark")
        b.shot("dashboard-light.png", 1600, 1070, 1.5, "light")
        b.call("Emulation.setEmulatedMedia", features=[{"name": "prefers-color-scheme", "value": "light"}])
        print("t-test:", b.js(TTEST))
        b.shot("stats-ttest.png", 1500, 1260, 1.4, "light")
        print("regression:", b.js(REGRESSION))
        b.shot("stats-regression.png", 1500, 1010, 1.4, "light")
    finally:
        b.close()
        server.should_exit = True


if __name__ == "__main__":
    main()

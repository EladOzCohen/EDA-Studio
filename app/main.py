"""FastAPI application: JSON API + static frontend."""
from __future__ import annotations

import mimetypes
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import stats
from .charts import build_chart
from .datastore import jsonable, store

mimetypes.add_type("application/javascript", ".js")  # Windows registry sometimes says text/plain
mimetypes.add_type("text/css", ".css")

BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).parent.parent))  # PyInstaller-aware
STATIC = BASE / "app" / "static"
UPLOAD_DIR = Path(tempfile.gettempdir()) / "eda_studio_uploads"

# Set by the desktop launcher to use a native file dialog inside the app window.
native_file_picker: Callable[[], str | None] | None = None

app = FastAPI(title="EDA Studio")


@app.exception_handler(ValueError)
async def value_error_handler(_: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


def ok(payload: Any) -> JSONResponse:
    return JSONResponse(jsonable(payload))


class LoadReq(BaseModel):
    path: str
    sheet: str | None = None


class FilterReq(BaseModel):
    filters: list[dict] = Field(default_factory=list)


class ChartReq(FilterReq):
    mark: str = "bar"
    shelves: dict[str, dict | None] = Field(default_factory=dict)
    options: dict = Field(default_factory=dict)


class DistinctReq(FilterReq):
    field: str
    search: str | None = None


class AnalyzeReq(FilterReq):
    id: str
    slots: dict = Field(default_factory=dict)
    options: dict = Field(default_factory=dict)


@app.get("/api/state")
def get_state():
    return ok(store.meta)


@app.post("/api/load")
def load(req: LoadReq):
    return ok(store.load(req.path, req.sheet))


@app.post("/api/upload")
def upload(file: UploadFile = File(...)):
    UPLOAD_DIR.mkdir(exist_ok=True)
    dest = UPLOAD_DIR / Path(file.filename or "upload").name
    with open(dest, "wb") as fh:
        shutil.copyfileobj(file.file, fh)
    return ok(store.load(str(dest)))


@app.get("/api/samples")
def samples():
    d = BASE / "sample_data"
    files = sorted(d.glob("*")) if d.is_dir() else []
    return ok([dict(name=f.name, path=str(f)) for f in files if f.suffix.lower() in (".csv", ".json", ".ndjson", ".xlsx", ".parquet")])


@app.post("/api/pick_file")
def pick_file():
    """Open a native 'Open file' dialog on this machine and return the chosen path."""
    path = None
    if native_file_picker:
        path = native_file_picker()
    else:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        try:
            path = filedialog.askopenfilename(filetypes=[
                ("Data files", "*.csv *.tsv *.txt *.json *.jsonl *.ndjson *.parquet *.xlsx *.xlsm *.xls"), ("All files", "*.*")])
        finally:
            root.destroy()
    return ok(dict(path=path or None))


@app.post("/api/preview")
def preview(req: FilterReq, limit: int = 200, offset: int = 0):
    return ok(store.preview(min(limit, 1000), offset, req.filters))


@app.post("/api/distinct")
def distinct(req: DistinctReq):
    return ok(store.distinct(req.field, req.search, req.filters))


@app.post("/api/chart")
def chart(req: ChartReq):
    return ok(build_chart(store, req.model_dump()))


@app.get("/api/analyses")
def analyses():
    return ok([a.describe() for a in stats.ANALYSES])


@app.post("/api/analyze")
def analyze(req: AnalyzeReq):
    a = stats.BY_ID.get(req.id)
    if not a:
        raise ValueError(f"Unknown analysis: {req.id}")
    if not store.meta:
        raise ValueError("Open a dataset first")
    return ok(dict(blocks=a.run(store, req.slots, req.options, req.filters)))


# Static frontend last, so /api/* routes win.
app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")

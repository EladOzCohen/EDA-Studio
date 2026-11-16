"""Data loading, profiling and filtering on top of an in-memory DuckDB table."""
from __future__ import annotations

import datetime as dt
import decimal
import math
import threading
from pathlib import Path

import duckdb
import pandas as pd

TABLE = "data"
RECORDS = "__records__"  # pseudo-field: "Number of Records"

NUMERIC_TYPES = ("TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT",
                 "UINTEGER", "UBIGINT", "UHUGEINT", "FLOAT", "DOUBLE", "DECIMAL", "REAL")


def qident(name: str) -> str:
    """Quote an identifier for DuckDB."""
    return '"' + str(name).replace('"', '""') + '"'


def qstr(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def kind_of(dtype: str) -> str:
    d = dtype.upper()
    if d.startswith(("STRUCT", "LIST", "MAP", "UNION", "BLOB", "BIT", "INTERVAL", "TIME ")) or d.endswith("[]") or d == "TIME":
        return "other"
    if d.startswith("DECIMAL") or d.split("(")[0] in NUMERIC_TYPES:
        return "numeric"
    if d.startswith(("DATE", "TIMESTAMP")):
        return "temporal"
    return "categorical"  # VARCHAR, BOOLEAN, UUID, ENUM


def jsonable(v):
    """Convert a DuckDB/pandas/numpy value into something json can encode."""
    if v is None:
        return None
    if isinstance(v, float):
        return None if (math.isnan(v) or math.isinf(v)) else v
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items()}
    try:  # numpy scalars
        import numpy as np
        if isinstance(v, np.generic):
            return jsonable(v.item())
        if isinstance(v, np.ndarray):
            return [jsonable(x) for x in v.tolist()]
    except ImportError:  # pragma: no cover
        pass
    if isinstance(v, pd.Timestamp):
        return v.isoformat()
    return str(v)


class Store:
    """Holds a single active dataset. All DuckDB access goes through the lock."""

    def __init__(self):
        self.con = duckdb.connect(":memory:")
        self.lock = threading.RLock()
        self.meta: dict | None = None

    # ------------------------------------------------------------------ loading
    def load(self, path: str, sheet: str | None = None) -> dict:
        p = Path(path).expanduser()
        if not p.is_file():
            raise ValueError(f"File not found: {p}")
        ext = p.suffix.lower()
        sheets = None
        with self.lock:
            self.con.execute(f"DROP TABLE IF EXISTS {TABLE}")
            if ext in (".csv", ".tsv", ".txt"):
                self._load_csv(p)
            elif ext in (".json", ".jsonl", ".ndjson"):
                big = p.stat().st_size > 200 * 1024 * 1024
                self.con.execute(
                    f"CREATE TABLE {TABLE} AS SELECT * FROM read_json_auto({qstr(p)}, "
                    f"sample_size={200000 if big else -1})")
            elif ext == ".parquet":
                self.con.execute(f"CREATE TABLE {TABLE} AS SELECT * FROM read_parquet({qstr(p)})")
            elif ext in (".xlsx", ".xlsm", ".xls"):
                xl = pd.ExcelFile(p)
                sheets = xl.sheet_names
                sheet = sheet if sheet in sheets else sheets[0]
                self._register_df(xl.parse(sheet))
            else:
                raise ValueError(f"Unsupported file type: {ext or '(none)'}. "
                                 "Supported: csv, tsv, json, jsonl, parquet, xlsx")
            self.meta = self._profile()
            self.meta.update(name=p.name, path=str(p), sheets=sheets, sheet=sheet)
            return self.meta

    def _load_csv(self, p: Path):
        try:
            self.con.execute(f"CREATE TABLE {TABLE} AS SELECT * FROM read_csv_auto({qstr(p)}, sample_size=-1)")
            return
        except duckdb.Error:
            pass
        # Fallback: legacy encodings (e.g. Hebrew Windows-1255) or ragged files, via pandas.
        with open(p, "rb") as fh:
            head = fh.read(65536).decode("latin-1")
        sep = "\t" if (p.suffix.lower() == ".tsv" or head.count("\t") > head.count(",")) else (
            ";" if head.count(";") > head.count(",") else ",")
        last = None
        for enc in ("utf-8-sig", "cp1255", "cp1252"):
            try:
                self._register_df(pd.read_csv(p, sep=sep, encoding=enc, low_memory=False))
                return
            except Exception as e:  # noqa: BLE001
                last = e
        raise ValueError(f"Could not parse CSV: {last}")

    def _register_df(self, df: pd.DataFrame):
        df = df.copy()
        df.columns = [str(c) for c in df.columns]
        for c in df.columns:
            if df[c].dtype == object:
                nn = df[c].dropna()
                if len(nn) and not nn.map(lambda v: isinstance(v, str)).all():
                    kinds = {type(v) for v in nn}
                    if not kinds <= {dt.datetime, pd.Timestamp, dt.date}:
                        df[c] = df[c].where(df[c].isna(), df[c].astype(str))
        self.con.register("_df", df)
        self.con.execute(f"CREATE TABLE {TABLE} AS SELECT * FROM _df")
        self.con.unregister("_df")

    # ---------------------------------------------------------------- profiling
    def _profile(self) -> dict:
        desc = self.con.execute(f"DESCRIBE {TABLE}").fetchall()
        n_rows = self.con.execute(f"SELECT count(*) FROM {TABLE}").fetchone()[0]
        parts = []
        for name, dtype, *_rest in desc:
            k = kind_of(dtype)
            q = qident(name)
            parts.append(f"count({q})")
            if k == "other":
                parts += ["NULL", "NULL", "NULL", "NULL", "NULL"]
                continue
            parts.append(f"approx_count_distinct({q})")
            if k in ("numeric", "temporal"):
                parts += [f"min({q})::VARCHAR", f"max({q})::VARCHAR"]
            else:
                parts += ["NULL", "NULL"]
            if k == "numeric":
                parts += [f"avg({q})::DOUBLE", f"stddev_samp({q})::DOUBLE"]
            else:
                parts += ["NULL", "NULL"]
        row = self.con.execute(f"SELECT {', '.join(parts)} FROM {TABLE}").fetchone() if parts else ()
        out, pos = [], 0
        for name, dtype, *_ in desc:
            k = kind_of(dtype)
            cnt, nd, mn, mx, avg, sd = row[pos:pos + 6] if k != "other" else (row[pos], None, None, None, None, None)
            pos += 6
            out.append(dict(name=name, dtype=dtype, kind=k, n=cnt, nulls=n_rows - cnt,
                            nunique=nd, min=jsonable(mn), max=jsonable(mx),
                            mean=jsonable(avg), sd=jsonable(sd)))
        return dict(n_rows=n_rows, columns=out)

    # ----------------------------------------------------------------- helpers
    def column(self, name: str) -> dict:
        if not self.meta:
            raise ValueError("No dataset loaded")
        for c in self.meta["columns"]:
            if c["name"] == name:
                return c
        raise ValueError(f"Unknown column: {name}")

    def where(self, filters: list[dict] | None) -> tuple[str, list]:
        """Build a parameterised WHERE clause (starting with ' WHERE ') from UI filters."""
        parts, params = [], []
        for f in filters or []:
            col = self.column(f["field"])
            q = qident(col["name"])
            kind = f.get("kind")
            if kind == "in":
                vals = [str(v) for v in (f.get("values") or [])]
                sub = f"CAST({q} AS VARCHAR) IN ({','.join('?' * len(vals))})" if vals else "FALSE"
                params += vals
                if f.get("include_null"):
                    sub = f"({sub} OR {q} IS NULL)"
                if f.get("exclude"):
                    sub = f"NOT COALESCE({sub}, FALSE)"
                parts.append(sub)
            elif kind == "range":
                for op, key in ((">=", "min"), ("<=", "max")):
                    if f.get(key) not in (None, ""):
                        parts.append(f"{q} {op} CAST(? AS {col['dtype']})")
                        params.append(f[key])
            else:
                raise ValueError(f"Unknown filter kind: {kind}")
        return (" WHERE " + " AND ".join(parts)) if parts else "", params

    def query(self, sql: str, params: list | None = None):
        with self.lock:
            cur = self.con.execute(sql, params or [])
            cols = [d[0] for d in cur.description]
            return cols, cur.fetchall()

    def rows(self, sql: str, params: list | None = None) -> list[dict]:
        cols, data = self.query(sql, params)
        return [{c: jsonable(v) for c, v in zip(cols, r)} for r in data]

    def frame(self, columns: list[str], filters: list[dict] | None = None) -> pd.DataFrame:
        """Fetch columns (with filters applied) as a pandas DataFrame."""
        for c in columns:
            self.column(c)
        where, params = self.where(filters)
        sel = ", ".join(qident(c) for c in dict.fromkeys(columns))
        with self.lock:
            return self.con.execute(f"SELECT {sel} FROM {TABLE}{where}", params).df()

    def preview(self, limit: int, offset: int, filters: list[dict] | None = None) -> dict:
        where, params = self.where(filters)
        total = self.query(f"SELECT count(*) FROM {TABLE}{where}", params)[1][0][0]
        rows = self.rows(f"SELECT * FROM {TABLE}{where} LIMIT {int(limit)} OFFSET {int(offset)}", params)
        return dict(total=total, rows=rows)

    def distinct(self, field: str, search: str | None, filters: list[dict] | None, limit: int = 300) -> dict:
        col = self.column(field)
        q = qident(field)
        if col["kind"] in ("numeric", "temporal"):
            return dict(kind=col["kind"], min=col["min"], max=col["max"], dtype=col["dtype"])
        where, params = self.where([f for f in (filters or []) if f["field"] != field])
        cond = f"CAST({q} AS VARCHAR) ILIKE ?" if search else None
        if cond:
            where = (where + " AND " if where else " WHERE ") + cond
            params = params + [f"%{search}%"]
        rows = self.rows(
            f"SELECT CAST({q} AS VARCHAR) AS value, count(*) AS n FROM {TABLE}{where} "
            f"GROUP BY 1 ORDER BY n DESC NULLS LAST LIMIT {int(limit)}", params)
        return dict(kind="categorical", values=rows, nunique=col["nunique"], nulls=col["nulls"])


store = Store()

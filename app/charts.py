"""Turn the UI's shelf spec (Tableau-style pills) into DuckDB queries.

The frontend sends which field sits on which shelf (x, y, color, size, col, row) plus
per-pill settings (aggregation, date part, bins). We aggregate in DuckDB so that
millions of rows never reach the browser; the frontend only draws the result.
"""
from __future__ import annotations

from .datastore import RECORDS, TABLE, Store, qident

MAX_GROUPS = 50_000
AGG_SQL = {
    "sum": "sum({x})", "avg": "avg({x})", "median": "median({x})", "min": "min({x})",
    "max": "max({x})", "std": "stddev_samp({x})", "count": "count({x})",
    "countd": "count(DISTINCT {x})",
}
NUMERIC_ONLY_AGGS = {"sum", "avg", "median", "std"}
TRUNC = {"year", "quarter", "month", "week", "day", "hour", "minute"}
DATE_PART = {"moy": "month({x})", "dow": "isodow({x})", "hod": "hour({x})", "year_part": "year({x})"}
SHELF_KEYS = ("x", "y", "color", "size", "col", "row")


def pill_expr(store: Store, pill: dict) -> tuple[str, bool]:
    """Return (sql expression, is_aggregate) for one pill."""
    field = pill["field"]
    if field == RECORDS:
        return "count(*)", True
    col = store.column(field)
    q = qident(field)
    agg = pill.get("agg") or "none"
    if pill.get("role") == "measure" and agg != "none":
        if agg not in AGG_SQL:
            raise ValueError(f"Unknown aggregation: {agg}")
        if agg in NUMERIC_ONLY_AGGS and col["kind"] != "numeric":
            raise ValueError(f"'{field}' is not numeric, so {agg.upper()} is not available (use Count / Count distinct)")
        if agg in ("min", "max") and col["kind"] not in ("numeric", "temporal"):
            q = f"CAST({q} AS VARCHAR)"
        return AGG_SQL[agg].format(x=q), True
    trunc = pill.get("trunc")
    if col["kind"] == "temporal" and trunc:
        if trunc in TRUNC:
            return f"date_trunc('{trunc}', {q})", False
        if trunc in DATE_PART:
            return DATE_PART[trunc].format(x=q), False
        raise ValueError(f"Unknown date part: {trunc}")
    if col["kind"] == "numeric" and pill.get("bin"):
        w = float(pill["bin"])
        if w <= 0:
            raise ValueError("Bin size must be positive")
        return f"(floor({q} / {w!r}) * {w!r})", False
    if col["kind"] == "other":
        raise ValueError(f"'{field}' has a nested type ({col['dtype']}) and cannot be plotted")
    return q, False


def build_chart(store: Store, spec: dict) -> dict:
    mark = spec.get("mark", "bar")
    shelves = {k: v for k, v in (spec.get("shelves") or {}).items() if v and k in SHELF_KEYS}
    if not shelves:
        raise ValueError("Drag a field onto a shelf to start")
    where, params = store.where(spec.get("filters"))
    opts = spec.get("options") or {}
    if mark == "hist":
        return _histogram(store, shelves, where, params, opts)
    if mark == "box":
        return _boxplot(store, shelves, where, params)
    return _generic(store, mark, shelves, where, params, opts)


def _generic(store, mark, shelves, where, params, opts) -> dict:
    sels, groups, has_agg = [], [], False
    for i, (key, pill) in enumerate(shelves.items(), start=1):
        expr, is_agg = pill_expr(store, pill)
        sels.append(f'{expr} AS "{key}"')
        has_agg |= is_agg
        if not is_agg:
            groups.append(i)
    if has_agg:
        sql = f"SELECT {', '.join(sels)} FROM {TABLE}{where}"
        if groups:
            sql += " GROUP BY " + ", ".join(map(str, groups))
        sql += f" LIMIT {MAX_GROUPS + 1}"
        rows = store.rows(sql, params)
        truncated = len(rows) > MAX_GROUPS
        return dict(rows=rows[:MAX_GROUPS], info=dict(aggregated=True, truncated=truncated))
    # Raw (disaggregated) rows: sample so the browser stays responsive.
    limit = int(opts.get("max_points") or 5000)
    total = store.query(f"SELECT count(*) FROM {TABLE}{where}", params)[1][0][0]
    sql = (f"SELECT * FROM (SELECT {', '.join(sels)} FROM {TABLE}{where}) "
           f"USING SAMPLE reservoir({limit} ROWS) REPEATABLE (42)")
    rows = store.rows(sql, params)
    return dict(rows=rows, info=dict(aggregated=False, sampled=total > limit, total=total, shown=len(rows)))


def _split_dims(store, shelves, drop: tuple[str, ...]):
    """Group-by expressions for all shelves except those in `drop`."""
    dims = []
    for key, pill in shelves.items():
        if key in drop:
            continue
        expr, is_agg = pill_expr(store, pill)
        if is_agg:
            raise ValueError("Histogram/box plots can't mix in aggregated measures — set them to 'None' (raw) or move them off")
        dims.append((key, expr))
    return dims


def _histogram(store, shelves, where, params, opts) -> dict:
    vkey = next((k for k in ("x", "y") if k in shelves and store.column(shelves[k]["field"])["kind"] == "numeric"
                 and shelves[k]["field"] != RECORDS), None)
    if not vkey:
        raise ValueError("Histogram needs a numeric field on X (or Y)")
    q = qident(shelves[vkey]["field"])
    nb = max(2, min(200, int(opts.get("bins") or 30)))
    mn, mx = store.query(f"SELECT min({q}), max({q}) FROM {TABLE}{where}", params)[1][0]
    if mn is None:
        return dict(rows=[], info=dict(aggregated=True, empty=True))
    mn, mx = float(mn), float(mx)
    w = (mx - mn) / nb if mx > mn else 1.0
    dims = _split_dims(store, shelves, drop=("x", "y", "size"))
    sels = [f"least(floor(({q} - {mn!r}) / {w!r}), {nb - 1})::INTEGER AS b"] + [f'{e} AS "{k}"' for k, e in dims]
    grp = ", ".join(str(i) for i in range(1, len(sels) + 1))
    cond = (where + " AND " if where else " WHERE ") + f"{q} IS NOT NULL"
    rows = store.rows(f"SELECT {', '.join(sels)}, count(*) AS count FROM {TABLE}{cond} GROUP BY {grp}", params)
    for r in rows:
        r["bin_start"] = mn + r.pop("b") * w
        r["bin_end"] = r["bin_start"] + w
    return dict(rows=rows, info=dict(aggregated=True, value_field=shelves[vkey]["field"], bin_width=w))


def _boxplot(store, shelves, where, params) -> dict:
    vkey = next((k for k in ("y", "x") if k in shelves and shelves[k].get("role") == "measure"
                 and shelves[k]["field"] != RECORDS and store.column(shelves[k]["field"])["kind"] == "numeric"), None)
    if not vkey:
        raise ValueError("Box plot needs a numeric measure on Y (or X) with aggregation set to 'None' (raw)")
    vpill = dict(shelves[vkey], agg="none")
    q = qident(vpill["field"])
    dims = _split_dims(store, shelves, drop=(vkey, "size"))
    dsel = "".join(f'{e} AS "{k}", ' for k, e in dims)
    dnames = [f'"{k}"' for k, _ in dims]
    part = f"PARTITION BY {', '.join(dnames)}" if dnames else ""
    cond = (where + " AND " if where else " WHERE ") + f"{q} IS NOT NULL"
    cte = (f"WITH base AS (SELECT {dsel}{q} AS v FROM {TABLE}{cond}), "
           f"w AS (SELECT *, quantile_cont(v, 0.25) OVER ({part}) AS q1, "
           f"quantile_cont(v, 0.75) OVER ({part}) AS q3 FROM base)")
    gsel = ", ".join(dnames)
    stats = store.rows(
        f"{cte} SELECT {gsel + ', ' if gsel else ''}any_value(q1) AS q1, median(v) AS median, any_value(q3) AS q3, "
        f"min(v) FILTER (WHERE v >= q1 - 1.5 * (q3 - q1)) AS lo, max(v) FILTER (WHERE v <= q3 + 1.5 * (q3 - q1)) AS hi, "
        f"count(*) AS n, avg(v) AS mean FROM w{' GROUP BY ' + gsel if gsel else ''}", params)
    if len(stats) > 500:
        raise ValueError(f"Too many groups for a box plot ({len(stats)}). Use a lower-cardinality field or a filter.")
    limit = 3000
    outl = store.rows(
        f"{cte} SELECT {gsel + ', ' if gsel else ''}v AS value FROM w "
        f"WHERE v < q1 - 1.5 * (q3 - q1) OR v > q3 + 1.5 * (q3 - q1) LIMIT {limit + 1}", params)
    return dict(rows=stats, outliers=outl[:limit],
                info=dict(aggregated=True, orient="v" if vkey == "y" else "h", value_key=vkey,
                          value_field=vpill["field"], outliers_truncated=len(outl) > limit))

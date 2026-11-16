from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

SAMPLE = str(Path(__file__).parent.parent / "sample_data" / "sales_sample.csv")
NDJSON = str(Path(__file__).parent.parent / "sample_data" / "sales_sample.ndjson")


@pytest.fixture(scope="module")
def c():
    client = TestClient(app)
    r = client.post("/api/load", json={"path": SAMPLE})
    assert r.status_code == 200, r.text
    return client


def chart(c, mark, shelves, **kw):
    r = c.post("/api/chart", json=dict(mark=mark, shelves=shelves, **kw))
    assert r.status_code == 200, r.text
    return r.json()


def test_schema(c):
    meta = c.get("/api/state").json()
    assert meta["n_rows"] == 6000
    kinds = {x["name"]: x["kind"] for x in meta["columns"]}
    assert kinds["revenue"] == "numeric" and kinds["region"] == "categorical" and kinds["order_date"] == "temporal"


def test_json_loading(c):
    r = c.post("/api/load", json={"path": NDJSON})
    assert r.status_code == 200 and r.json()["n_rows"] == 500
    c.post("/api/load", json={"path": SAMPLE})


def test_bar_aggregation(c):
    d = chart(c, "bar", {"x": dict(field="region", role="dim"), "y": dict(field="revenue", role="measure", agg="sum")})
    assert len(d["rows"]) == 4 and {"x", "y"} <= set(d["rows"][0])


def test_records_count_and_filter(c):
    f = [dict(field="region", kind="in", values=["North"])]
    d = chart(c, "bar", {"x": dict(field="channel", role="dim"), "y": dict(field="__records__", role="measure", agg="count")}, filters=f)
    assert 0 < sum(r["y"] for r in d["rows"]) < 6000


def test_date_trunc_line(c):
    d = chart(c, "line", {"x": dict(field="order_date", role="dim", trunc="month"), "y": dict(field="revenue", role="measure", agg="avg"),
                          "color": dict(field="region", role="dim")})
    assert len(d["rows"]) > 24


def test_scatter_sampling(c):
    d = chart(c, "point", {"x": dict(field="unit_price", role="measure", agg="none"), "y": dict(field="revenue", role="measure", agg="none")},
              options=dict(max_points=1000))
    assert len(d["rows"]) == 1000 and d["info"]["sampled"] and d["info"]["total"] == 6000


def test_histogram(c):
    d = chart(c, "hist", {"x": dict(field="revenue", role="measure", agg="none")}, options=dict(bins=20))
    assert len(d["rows"]) <= 20 and sum(r["count"] for r in d["rows"]) == 6000


def test_boxplot(c):
    d = chart(c, "box", {"x": dict(field="category", role="dim"), "y": dict(field="revenue", role="measure", agg="none")})
    assert len(d["rows"]) == 5 and {"q1", "median", "q3", "lo", "hi"} <= set(d["rows"][0])
    assert d["info"]["orient"] == "v"


def test_sum_on_text_rejected(c):
    r = c.post("/api/chart", json=dict(mark="bar", shelves={"y": dict(field="region", role="measure", agg="sum")}))
    assert r.status_code == 400 and "not numeric" in r.json()["detail"]


def test_injection_safe(c):
    r = c.post("/api/chart", json=dict(mark="bar", shelves={"x": dict(field='region"; DROP TABLE data; --', role="dim")}))
    assert r.status_code == 400
    assert c.get("/api/state").json()["n_rows"] == 6000


def test_distinct(c):
    d = c.post("/api/distinct", json=dict(field="region")).json()
    assert {v["value"] for v in d["values"]} == {"North", "South", "East", "West"}


def test_analyses_registry(c):
    ids = {a["id"] for a in c.get("/api/analyses").json()}
    assert {"descriptives", "ttest_ind", "ttest_paired", "ttest_one", "anova", "correlation", "regression"} <= ids


def analyze(c, id, slots, options=None):
    r = c.post("/api/analyze", json=dict(id=id, slots=slots, options=options or {}))
    assert r.status_code == 200, r.text
    return r.json()["blocks"]


def test_ttest_matches_scipy(c):
    import pandas as pd
    from scipy import stats as ss
    df = pd.read_csv(SAMPLE).dropna(subset=["satisfaction"])
    a = df[df.channel == "Online"].satisfaction
    b = df[df.channel == "Store"].satisfaction
    blocks = analyze(c, "ttest_ind", {"dvs": ["satisfaction"], "group": ["channel"]})
    rows = {r["test"]: r for r in blocks[0]["rows"]}
    ref = ss.ttest_ind(a, b, equal_var=True)
    assert rows["Student's t"]["stat"] == pytest.approx(ref.statistic, rel=1e-6)
    assert rows["Student's t"]["p"] == pytest.approx(ref.pvalue, rel=1e-6)
    ref = ss.ttest_ind(a, b, equal_var=False)
    assert rows["Welch's t"]["stat"] == pytest.approx(ref.statistic, rel=1e-6)
    assert rows["Welch's t"]["df"] == pytest.approx(ref.df, rel=1e-6)
    assert rows["Welch's t"]["p"] == pytest.approx(ref.pvalue, rel=1e-6)


def test_ttest_needs_two_levels(c):
    r = c.post("/api/analyze", json=dict(id="ttest_ind", slots={"dvs": ["revenue"], "group": ["region"]}))
    assert r.status_code == 400 and "exactly 2" in r.json()["detail"]


def test_paired_and_one_sample(c):
    assert analyze(c, "ttest_paired", {"v1": ["unit_price"], "v2": ["revenue"]})[0]["rows"]
    assert analyze(c, "ttest_one", {"vars": ["satisfaction"]}, {"test_value": 3})[0]["rows"]


def test_anova(c):
    import pandas as pd
    from scipy import stats as ss
    df = pd.read_csv(SAMPLE)
    ref = ss.f_oneway(*[g.revenue.values for _, g in df.groupby("region")])
    blocks = analyze(c, "anova", {"dvs": ["revenue"], "group": ["region"]})
    fisher = next(r for r in blocks[0]["rows"] if r["test"] == "Fisher's F")
    assert fisher["stat"] == pytest.approx(ref.statistic, rel=1e-6)
    welch = next(r for r in blocks[0]["rows"] if r["test"] == "Welch's F")
    assert welch["p"] is not None and welch["df2"] is not None
    assert any(b["title"].startswith("Post Hoc") for b in blocks)


def test_correlation(c):
    blocks = analyze(c, "correlation", {"vars": ["unit_price", "revenue", "units"]})
    assert blocks[0]["rows"][0]["unit_price"] == "—"


def test_regression_matches_statsmodels(c):
    import pandas as pd
    import statsmodels.api as sm
    import statsmodels.formula.api as smf
    df = pd.read_csv(SAMPLE).dropna(subset=["satisfaction"])
    ref = smf.ols("satisfaction ~ discount + customer_age + C(channel)", df).fit()
    blocks = analyze(c, "regression", {"dv": ["satisfaction"], "covs": ["discount", "customer_age"], "factors": ["channel"]})
    fit = blocks[0]["rows"][0]
    assert fit["r2"] == pytest.approx(ref.rsquared, rel=1e-6)
    coefs = {r["term"]: r for r in blocks[1]["rows"]}
    assert coefs["discount"]["est"] == pytest.approx(ref.params["discount"], rel=1e-6)
    assert coefs["channel [Store − Online]"]["est"] == pytest.approx(ref.params["C(channel)[T.Store]"], rel=1e-6)
    assert any(b["type"] == "chart" for b in blocks)
    # VIF must agree with statsmodels' reference implementation
    import numpy as np
    from statsmodels.stats.outliers_influence import variance_inflation_factor
    X = pd.get_dummies(df[["discount", "customer_age", "channel"]], columns=["channel"], drop_first=True, dtype=float)
    X = sm.add_constant(X)
    ref_vif = {c: variance_inflation_factor(X.values, i) for i, c in enumerate(X.columns) if c != "const"}
    assert coefs["discount"]["vif"] == pytest.approx(ref_vif["discount"], rel=1e-6)
    assert coefs["channel [Store − Online]"]["vif"] == pytest.approx(ref_vif["channel_Store"], rel=1e-6)


def test_descriptives_split(c):
    blocks = analyze(c, "descriptives", {"vars": ["revenue", "satisfaction"], "split": ["channel"]}, {"hist": True})
    assert len(blocks[0]["rows"]) == 4 and len(blocks) == 3

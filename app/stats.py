"""Jamovi-style statistical analyses.

Each analysis declares its variable *slots* and *options* (so the frontend can build the
form generically) and returns a list of result *blocks*: tables, Vega-Lite charts and notes.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy import stats as ss
from statsmodels.stats.diagnostic import het_breuschpagan
from statsmodels.stats.stattools import durbin_watson

from .datastore import Store

# --------------------------------------------------------------------------- block helpers


def table(title: str, columns: list[tuple], rows: list[dict], note: str | None = None) -> dict:
    """columns: (key, label, fmt) with fmt in text|int|num|p."""
    return dict(type="table", title=title, note=note, rows=rows,
                columns=[dict(key=k, label=l, fmt=f) for k, l, f in columns])


def chart(title: str, spec: dict) -> dict:
    return dict(type="chart", title=title, spec=spec)


def note(text: str, level: str = "info") -> dict:
    return dict(type="note", text=text, level=level)


def _f(v):
    return None if v is None or (isinstance(v, float) and not math.isfinite(v)) else float(v)


# --------------------------------------------------------------------------- shared maths


def _t_result(diff, se, df, alt, level):
    """t statistic, p-value and CI for an estimate `diff` with std error `se`."""
    t = diff / se if se > 0 else float("nan")
    if alt == "greater":
        p, tc = ss.t.sf(t, df), ss.t.ppf(level, df)
        lo, hi = diff - tc * se, float("inf")
    elif alt == "less":
        p, tc = ss.t.cdf(t, df), ss.t.ppf(level, df)
        lo, hi = float("-inf"), diff + tc * se
    else:
        p, tc = 2 * ss.t.sf(abs(t), df), ss.t.ppf(1 - (1 - level) / 2, df)
        lo, hi = diff - tc * se, diff + tc * se
    return t, p, lo, hi


def _d_ci(d, n1, n2, level):
    """Approximate CI for Cohen's d (normal approximation of its sampling distribution)."""
    se = math.sqrt((n1 + n2) / (n1 * n2) + d * d / (2 * (n1 + n2))) if n1 and n2 else float("nan")
    z = ss.norm.ppf(1 - (1 - level) / 2)
    return d - z * se, d + z * se


def _desc(x: pd.Series) -> dict:
    n = int(x.count())
    sd = x.std(ddof=1) if n > 1 else float("nan")
    return dict(n=n, mean=_f(x.mean()), median=_f(x.median()), sd=_f(sd),
                se=_f(sd / math.sqrt(n)) if n > 1 else None, min=_f(x.min()), max=_f(x.max()))


def _shapiro(x: np.ndarray):
    if len(x) < 3:
        return None, None
    if len(x) > 5000:
        x = np.random.default_rng(1).choice(x, 5000, replace=False)
    if np.ptp(x) == 0:
        return None, None
    w, p = ss.shapiro(x)
    return _f(w), _f(p)


def _alt(opts):
    return opts.get("alt") or "two-sided"


def _level(opts):
    return float(opts.get("ci_level") or 0.95)


def _one(slot):
    if isinstance(slot, list):
        return slot[0] if slot else None
    return slot


def _need(cond, msg):
    if not cond:
        raise ValueError(msg)


ALT_CHOICES = [("two-sided", "Group 1 ≠ Group 2"), ("greater", "Group 1 > Group 2"), ("less", "Group 1 < Group 2")]


@dataclass
class Analysis:
    id: str
    label: str
    group: str
    slots: list[dict]
    options: list[dict]
    run: Callable[[Store, dict, dict, list], list[dict]] = field(repr=False)

    def describe(self):
        return dict(id=self.id, label=self.label, group=self.group, slots=self.slots, options=self.options)


def slot(key, label, kinds=("numeric",), multiple=False, required=True):
    return dict(key=key, label=label, kinds=list(kinds), multiple=multiple, required=required)


def opt(key, label, type="checkbox", default=None, choices=None, step=None):
    d = dict(key=key, label=label, type=type, default=default)
    if choices:
        d["choices"] = [dict(value=v, label=l) for v, l in choices]
    if step:
        d["step"] = step
    return d


CI_OPT = opt("ci_level", "Confidence level", "number", 0.95, step=0.01)

# --------------------------------------------------------------------------- descriptives


def run_descriptives(store, slots, o, filters):
    vars_, split = slots.get("vars") or [], _one(slots.get("split"))
    _need(vars_, "Drag at least one numeric variable into 'Variables'")
    df = store.frame(vars_ + ([split] if split else []), filters)
    rows = []
    for v in vars_:
        x = pd.to_numeric(df[v], errors="coerce")
        groups = [(None, x)] if not split else [(str(g), x[df[split] == g]) for g in sorted(df[split].dropna().unique(), key=str)]
        for g, xs in groups:
            xv = xs.dropna()
            d = _desc(xs)
            d.update(var=v, group=g, missing=int(len(xs) - len(xv)),
                     q1=_f(xv.quantile(.25)) if len(xv) else None, q3=_f(xv.quantile(.75)) if len(xv) else None,
                     skew=_f(ss.skew(xv, bias=False)) if len(xv) > 2 else None,
                     kurt=_f(ss.kurtosis(xv, bias=False)) if len(xv) > 3 else None)
            rows.append(d)
    cols = [("var", "Variable", "text")] + ([("group", split, "text")] if split else []) + [
        ("n", "N", "int"), ("missing", "Missing", "int"), ("mean", "Mean", "num"), ("median", "Median", "num"),
        ("sd", "SD", "num"), ("se", "SE", "num"), ("min", "Min", "num"), ("q1", "Q1", "num"), ("q3", "Q3", "num"),
        ("max", "Max", "num"), ("skew", "Skewness", "num"), ("kurt", "Kurtosis", "num")]
    blocks = [table("Descriptives", cols, rows)]
    if o.get("hist"):
        for v in vars_:
            x = pd.to_numeric(df[v], errors="coerce")
            ok = x.notna()
            if not ok.any():
                continue
            edges = np.histogram_bin_edges(x[ok], 30)
            vals = []
            for g, mask in ([(None, ok)] if not split else [(str(k), ok & (df[split] == k)) for k in sorted(df[split].dropna().unique(), key=str)]):
                cnt, _ = np.histogram(x[mask], edges)
                vals += [dict(start=float(edges[i]), end=float(edges[i + 1]), count=int(c), group=g or v)
                         for i, c in enumerate(cnt)]
            blocks.append(chart(f"Histogram — {v}", dict(
                data=dict(values=vals), mark=dict(type="bar", opacity=0.75 if split else 1),
                encoding=dict(x=dict(field="start", type="quantitative", bin="binned", title=v),
                              x2=dict(field="end"), y=dict(field="count", type="quantitative", title="Count"),
                              **(dict(color=dict(field="group", type="nominal", title=split)) if split else {})))))
    return blocks


# --------------------------------------------------------------------------- t-tests


def _means_plot(rows, title_y, group_title):
    return dict(data=dict(values=rows), encoding=dict(x=dict(field="group", type="nominal", title=group_title, axis=dict(labelAngle=0))),
                layer=[dict(mark=dict(type="errorbar", ticks=dict(size=12)), encoding=dict(
                    y=dict(field="lo", type="quantitative", title=title_y, scale=dict(zero=False)), y2=dict(field="hi"))),
                    dict(mark=dict(type="point", filled=True, size=70), encoding=dict(
                        y=dict(field="mean", type="quantitative", scale=dict(zero=False)), color=dict(field="group", type="nominal", legend=None)))])


def run_ttest_ind(store, slots, o, filters):
    dvs, g = slots.get("dvs") or [], _one(slots.get("group"))
    _need(dvs and g, "Pick at least one dependent variable and a grouping variable")
    df = store.frame(dvs + [g], filters)
    levels = sorted(df[g].dropna().unique(), key=str)
    _need(len(levels) == 2, f"Grouping variable '{g}' has {len(levels)} levels; an independent t-test needs exactly 2. "
                            "Filter it down (Filters bar) or use ANOVA.")
    alt, lv = _alt(o), _level(o)
    rows, drows, arows, srows, plots = [], [], [], [], []
    for dv in dvs:
        x = pd.to_numeric(df[dv], errors="coerce")
        a, b = x[df[g] == levels[0]].dropna(), x[df[g] == levels[1]].dropna()
        _need(len(a) > 1 and len(b) > 1, f"Each group of '{dv}' needs at least 2 observations")
        n1, n2, m1, m2, v1, v2 = len(a), len(b), a.mean(), b.mean(), a.var(ddof=1), b.var(ddof=1)
        diff = m1 - m2
        sp = math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2))
        d = diff / sp if sp > 0 else float("nan")
        if o.get("student", True):
            se, df_ = sp * math.sqrt(1 / n1 + 1 / n2), n1 + n2 - 2
            t, p, lo, hi = _t_result(diff, se, df_, alt, lv)
            dl, dh = _d_ci(d, n1, n2, lv)
            rows.append(dict(dv=dv, test="Student's t", stat=_f(t), df=_f(df_), p=_f(p), diff=_f(diff), se=_f(se), lo=_f(lo), hi=_f(hi),
                             es_name="Cohen's d", es=_f(d), es_lo=_f(dl), es_hi=_f(dh)))
        if o.get("welch", True):
            se = math.sqrt(v1 / n1 + v2 / n2)
            df_ = se ** 4 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1)) if se > 0 else float("nan")
            t, p, lo, hi = _t_result(diff, se, df_, alt, lv)
            dl, dh = _d_ci(d, n1, n2, lv)
            rows.append(dict(dv=dv, test="Welch's t", stat=_f(t), df=_f(df_), p=_f(p), diff=_f(diff), se=_f(se), lo=_f(lo), hi=_f(hi),
                             es_name="Cohen's d", es=_f(d), es_lo=_f(dl), es_hi=_f(dh)))
        if o.get("mannwhitney"):
            u, p = ss.mannwhitneyu(a, b, alternative=alt)
            rows.append(dict(dv=dv, test="Mann-Whitney U", stat=_f(u), df=None, p=_f(p), diff=None, se=None, lo=None, hi=None,
                             es_name="Rank-biserial r", es=_f(2 * u / (n1 * n2) - 1), es_lo=None, es_hi=None))
        for lvl, s in zip(levels, (a, b)):
            drows.append(dict(dv=dv, group=str(lvl), **_desc(s)))
        if o.get("levene", True):
            f_, p = ss.levene(a, b, center="median")
            arows.append(dict(dv=dv, test="Levene's (equality of variances)", stat=_f(f_), df1=1, df2=n1 + n2 - 2, p=_f(p)))
        if o.get("shapiro", True):
            for lvl, s in zip(levels, (a, b)):
                w, p = _shapiro(s.to_numpy())
                srows.append(dict(dv=dv, group=str(lvl), stat=w, p=p))
        if o.get("plot", True):
            pr = []
            for lvl, s in zip(levels, (a, b)):
                dd = _desc(s)
                half = ss.t.ppf(1 - (1 - lv) / 2, dd["n"] - 1) * dd["se"]
                pr.append(dict(group=str(lvl), mean=dd["mean"], lo=dd["mean"] - half, hi=dd["mean"] + half))
            plots.append(chart(f"Group means with {int(lv * 100)}% CI — {dv}", _means_plot(pr, dv, g)))
    ci = f"{int(lv * 100)}% CI"
    out = [table("Independent Samples T-Test", [
        ("dv", "Dependent variable", "text"), ("test", "Test", "text"), ("stat", "Statistic", "num"), ("df", "df", "num"),
        ("p", "p", "p"), ("diff", "Mean difference", "num"), ("se", "SE difference", "num"), ("lo", f"{ci} lower", "num"),
        ("hi", f"{ci} upper", "num"), ("es_name", "Effect size", "text"), ("es", "Value", "num")], rows,
        note=f"Group 1 = {levels[0]}, Group 2 = {levels[1]}. Mean difference = Group 1 − Group 2. "
             "Cohen's d uses the pooled SD."), ]
    if o.get("desc", True):
        out.append(table("Group Descriptives", [("dv", "Variable", "text"), ("group", g, "text"), ("n", "N", "int"),
                                                ("mean", "Mean", "num"), ("median", "Median", "num"), ("sd", "SD", "num"), ("se", "SE", "num")], drows))
    if arows:
        out.append(table("Assumption: Homogeneity of Variances", [("dv", "Variable", "text"), ("test", "Test", "text"), ("stat", "F", "num"),
                                                                  ("df1", "df1", "int"), ("df2", "df2", "int"), ("p", "p", "p")], arows,
                         note="A significant result suggests unequal variances — prefer Welch's t."))
    if srows:
        out.append(table("Assumption: Normality (Shapiro-Wilk)", [("dv", "Variable", "text"), ("group", g, "text"), ("stat", "W", "num"), ("p", "p", "p")], srows,
                         note="A significant result suggests non-normality — consider Mann-Whitney U."))
    return out + plots


def run_ttest_paired(store, slots, o, filters):
    v1, v2 = _one(slots.get("v1")), _one(slots.get("v2"))
    _need(v1 and v2, "Pick two numeric variables")
    df = store.frame([v1, v2], filters).apply(pd.to_numeric, errors="coerce").dropna()
    n = len(df)
    _need(n > 1, "Need at least 2 complete pairs")
    alt, lv = _alt(o), _level(o)
    dd = df[v1] - df[v2]
    diff, sd = dd.mean(), dd.std(ddof=1)
    se = sd / math.sqrt(n)
    rows = []
    if o.get("student", True):
        t, p, lo, hi = _t_result(diff, se, n - 1, alt, lv)
        rows.append(dict(test="Paired Student's t", stat=_f(t), df=n - 1, p=_f(p), diff=_f(diff), se=_f(se), lo=_f(lo), hi=_f(hi),
                         es_name="Cohen's d (dz)", es=_f(diff / sd) if sd > 0 else None))
    if o.get("wilcoxon"):
        w, p = ss.wilcoxon(df[v1], df[v2], alternative=alt)
        rows.append(dict(test="Wilcoxon signed-rank", stat=_f(w), df=None, p=_f(p), diff=None, se=None, lo=None, hi=None, es_name="", es=None))
    ci = f"{int(lv * 100)}% CI"
    out = [table("Paired Samples T-Test", [("test", "Test", "text"), ("stat", "Statistic", "num"), ("df", "df", "num"), ("p", "p", "p"),
                                           ("diff", "Mean difference", "num"), ("se", "SE difference", "num"), ("lo", f"{ci} lower", "num"),
                                           ("hi", f"{ci} upper", "num"), ("es_name", "Effect size", "text"), ("es", "Value", "num")], rows,
                 note=f"{v1} − {v2}; N = {n} complete pairs.")]
    if o.get("desc", True):
        out.append(table("Descriptives", [("var", "Variable", "text"), ("n", "N", "int"), ("mean", "Mean", "num"), ("median", "Median", "num"),
                                          ("sd", "SD", "num"), ("se", "SE", "num")],
                         [dict(var=v, **_desc(df[v])) for v in (v1, v2)] + [dict(var=f"{v1} − {v2}", **_desc(dd))]))
    if o.get("shapiro", True):
        w, p = _shapiro(dd.to_numpy())
        out.append(table("Assumption: Normality of differences (Shapiro-Wilk)", [("stat", "W", "num"), ("p", "p", "p")], [dict(stat=w, p=p)]))
    if o.get("plot", True):
        s = df.sample(min(n, 3000), random_state=1)
        lim = [float(min(df.min())), float(max(df.max()))]
        out.append(chart("Paired observations (points above the line: first > second)", dict(
            data=dict(values=s.rename(columns={v1: "a", v2: "b"}).to_dict("records")), layer=[
                dict(mark=dict(type="point", opacity=0.5), encoding=dict(x=dict(field="b", type="quantitative", title=v2, scale=dict(zero=False)),
                                                                         y=dict(field="a", type="quantitative", title=v1, scale=dict(zero=False)))),
                dict(data=dict(values=[dict(a=lim[0], b=lim[0]), dict(a=lim[1], b=lim[1])]), mark=dict(type="line", strokeDash=[4, 4], color="#898781"),
                     encoding=dict(x=dict(field="b", type="quantitative"), y=dict(field="a", type="quantitative")))])))
    return out


def run_ttest_one(store, slots, o, filters):
    vars_ = slots.get("vars") or []
    _need(vars_, "Pick at least one numeric variable")
    mu, alt, lv = float(o.get("test_value") or 0), o.get("alt") or "two-sided", _level(o)
    df = store.frame(vars_, filters)
    rows, srows = [], []
    for v in vars_:
        x = pd.to_numeric(df[v], errors="coerce").dropna()
        n = len(x)
        _need(n > 1, f"'{v}' needs at least 2 observations")
        sd = x.std(ddof=1)
        se = sd / math.sqrt(n)
        if o.get("student", True):
            t, p, lo, hi = _t_result(x.mean() - mu, se, n - 1, alt, lv)
            rows.append(dict(var=v, test="Student's t", stat=_f(t), df=n - 1, p=_f(p), diff=_f(x.mean() - mu), lo=_f(lo + mu), hi=_f(hi + mu),
                             es=_f((x.mean() - mu) / sd) if sd > 0 else None, **{k: _f(val) for k, val in dict(mean=x.mean()).items()}))
        if o.get("wilcoxon"):
            w, p = ss.wilcoxon(x - mu, alternative=alt)
            rows.append(dict(var=v, test="Wilcoxon", stat=_f(w), df=None, p=_f(p), diff=None, lo=None, hi=None, es=None, mean=_f(x.mean())))
        if o.get("shapiro", True):
            w, p = _shapiro(x.to_numpy())
            srows.append(dict(var=v, stat=w, p=p))
    ci = f"{int(lv * 100)}% CI (mean)"
    out = [table("One Sample T-Test", [("var", "Variable", "text"), ("test", "Test", "text"), ("stat", "Statistic", "num"), ("df", "df", "num"),
                                       ("p", "p", "p"), ("mean", "Mean", "num"), ("diff", "Mean − test value", "num"), ("lo", f"{ci} lower", "num"),
                                       ("hi", f"{ci} upper", "num"), ("es", "Cohen's d", "num")], rows, note=f"Test value = {mu:g}.")]
    if srows:
        out.append(table("Assumption: Normality (Shapiro-Wilk)", [("var", "Variable", "text"), ("stat", "W", "num"), ("p", "p", "p")], srows))
    return out


# --------------------------------------------------------------------------- ANOVA


def run_anova(store, slots, o, filters):
    dvs, g = slots.get("dvs") or [], _one(slots.get("group"))
    _need(dvs and g, "Pick at least one dependent variable and a grouping variable")
    df = store.frame(dvs + [g], filters)
    lv = _level(o)
    arows, drows, lrows, srows, prows, plots = [], [], [], [], [], []
    for dv in dvs:
        d = pd.DataFrame({"y": pd.to_numeric(df[dv], errors="coerce"), "g": df[g]}).dropna()
        groups = {str(k): v["y"].to_numpy() for k, v in d.groupby("g", sort=True)}
        groups = {k: v for k, v in groups.items() if len(v) > 1}
        _need(len(groups) >= 2, f"'{g}' needs at least 2 groups with 2+ observations (after filters)")
        arrs, names = list(groups.values()), list(groups)
        k, N = len(arrs), sum(len(a) for a in arrs)
        grand = np.concatenate(arrs).mean()
        ssb = sum(len(a) * (a.mean() - grand) ** 2 for a in arrs)
        ssw = sum(((a - a.mean()) ** 2).sum() for a in arrs)
        msw = ssw / (N - k)
        if o.get("fisher", True):
            f_, p = ss.f_oneway(*arrs)
            arows.append(dict(dv=dv, test="Fisher's F", stat=_f(f_), df1=k - 1, df2=N - k, p=_f(p),
                              eta2=_f(ssb / (ssb + ssw)), omega2=_f(max(0.0, (ssb - (k - 1) * msw) / (ssb + ssw + msw)))))
        if o.get("welch", True):
            from statsmodels.stats.oneway import anova_oneway
            r = anova_oneway(arrs, use_var="unequal", welch_correction=True)
            dfn, dfd = r.df if hasattr(r, "df") else (k - 1, None)
            arows.append(dict(dv=dv, test="Welch's F", stat=_f(r.statistic), df1=_f(dfn), df2=_f(dfd), p=_f(r.pvalue), eta2=None, omega2=None))
        for name, a in zip(names, arrs):
            drows.append(dict(dv=dv, group=name, **_desc(pd.Series(a))))
        if o.get("levene", True):
            f_, p = ss.levene(*arrs, center="median")
            lrows.append(dict(dv=dv, stat=_f(f_), df1=k - 1, df2=N - k, p=_f(p)))
        if o.get("shapiro", True):
            resid = np.concatenate([a - a.mean() for a in arrs])
            w, p = _shapiro(resid)
            srows.append(dict(dv=dv, stat=w, p=p))
        if o.get("posthoc", "tukey") == "tukey":
            res = ss.tukey_hsd(*arrs)
            ci = res.confidence_interval(lv)
            for i in range(k):
                for j in range(i + 1, k):
                    prows.append(dict(dv=dv, comp=f"{names[i]} − {names[j]}", diff=_f(res.statistic[i, j]), lo=_f(ci.low[i, j]),
                                      hi=_f(ci.high[i, j]), p=_f(res.pvalue[i, j])))
        if o.get("plot", True):
            pr = []
            for name, a in zip(names, arrs):
                s = _desc(pd.Series(a))
                half = ss.t.ppf(1 - (1 - lv) / 2, s["n"] - 1) * s["se"]
                pr.append(dict(group=name, mean=s["mean"], lo=s["mean"] - half, hi=s["mean"] + half))
            plots.append(chart(f"Group means with {int(lv * 100)}% CI — {dv}", _means_plot(pr, dv, g)))
    out = [table("One-Way ANOVA", [("dv", "Dependent variable", "text"), ("test", "Test", "text"), ("stat", "F", "num"), ("df1", "df1", "num"),
                                   ("df2", "df2", "num"), ("p", "p", "p"), ("eta2", "η²", "num"), ("omega2", "ω²", "num")], arows)]
    if o.get("desc", True):
        out.append(table("Group Descriptives", [("dv", "Variable", "text"), ("group", g, "text"), ("n", "N", "int"), ("mean", "Mean", "num"),
                                                ("median", "Median", "num"), ("sd", "SD", "num"), ("se", "SE", "num")], drows))
    if prows:
        out.append(table("Post Hoc: Tukey HSD", [("dv", "Variable", "text"), ("comp", "Comparison", "text"), ("diff", "Mean difference", "num"),
                                                 ("lo", f"{int(lv * 100)}% CI lower", "num"), ("hi", f"{int(lv * 100)}% CI upper", "num"), ("p", "p (adj.)", "p")], prows))
    if lrows:
        out.append(table("Assumption: Homogeneity of Variances (Levene)", [("dv", "Variable", "text"), ("stat", "F", "num"), ("df1", "df1", "int"),
                                                                           ("df2", "df2", "int"), ("p", "p", "p")], lrows))
    if srows:
        out.append(table("Assumption: Normality of residuals (Shapiro-Wilk)", [("dv", "Variable", "text"), ("stat", "W", "num"), ("p", "p", "p")], srows))
    return out + plots


# --------------------------------------------------------------------------- correlation


def run_correlation(store, slots, o, filters):
    vars_ = slots.get("vars") or []
    _need(len(vars_) >= 2, "Pick at least two numeric variables")
    method = o.get("method") or "pearson"
    fn = dict(pearson=ss.pearsonr, spearman=ss.spearmanr, kendall=ss.kendalltau)[method]
    df = store.frame(vars_, filters).apply(pd.to_numeric, errors="coerce")
    long, mat = [], {v: {"var": v} for v in vars_}
    for i, a in enumerate(vars_):
        for j, b in enumerate(vars_):
            if j < i:
                continue
            if i == j:
                long.append(dict(a=a, b=b, r=1.0, p=None, n=int(df[a].count())))
                mat[a][b] = "—"
                continue
            ok = df[[a, b]].dropna()
            if len(ok) < 3 or ok[a].nunique() < 2 or ok[b].nunique() < 2:
                r, p = float("nan"), float("nan")
            else:
                res = fn(ok[a], ok[b])
                r, p = float(res[0]), float(res[1])
            long.append(dict(a=a, b=b, r=_f(r), p=_f(p), n=len(ok)))
            long.append(dict(a=b, b=a, r=_f(r), p=_f(p), n=len(ok)))
            star = "" if not math.isfinite(p) else "***" if p < .001 else "**" if p < .01 else "*" if p < .05 else ""
            mat[a][b] = mat[b][a] = f"{r:.3f}{star}" if math.isfinite(r) else "n/a"
    pairs = [x for x in long if x["a"] < x["b"] or (x["a"] != x["b"] and vars_.index(x["a"]) < vars_.index(x["b"]))]
    out = [table(f"Correlation Matrix ({method.capitalize()})", [("var", "", "text")] + [(v, v, "text") for v in vars_], list(mat.values()),
                 note="* p < .05, ** p < .01, *** p < .001 (pairwise deletion).")]
    out.append(table("Pairwise Results", [("a", "Variable 1", "text"), ("b", "Variable 2", "text"), ("r", {"pearson": "r", "spearman": "ρ", "kendall": "τ"}[method], "num"),
                                          ("p", "p", "p"), ("n", "N", "int")], pairs))
    if o.get("heatmap", True):
        out.append(chart("Correlation heatmap", dict(
            data=dict(values=long), layer=[
                dict(mark="rect", encoding=dict(x=dict(field="a", type="nominal", title=None, sort=vars_), y=dict(field="b", type="nominal", title=None, sort=vars_),
                                                color=dict(field="r", type="quantitative", scale=dict(domain=[-1, 0, 1], range=["#2a78d6", "#f0efec", "#e34948"]), title=method))),
                dict(mark="text", encoding=dict(x=dict(field="a", type="nominal", sort=vars_), y=dict(field="b", type="nominal", sort=vars_),
                                                text=dict(field="r", type="quantitative", format=".2f"), color=dict(value="#0b0b0b")))],
            width=max(220, 70 * len(vars_)), height=max(220, 70 * len(vars_)))))
    return out


# --------------------------------------------------------------------------- regression


def run_regression(store, slots, o, filters):
    dv = _one(slots.get("dv"))
    covs, facs = slots.get("covs") or [], slots.get("factors") or []
    _need(dv and (covs or facs), "Pick a dependent variable and at least one predictor")
    _need(dv not in covs + facs, "The dependent variable can't also be a predictor")
    df = store.frame([dv] + covs + facs, filters)
    y = pd.to_numeric(df[dv], errors="coerce")
    X = pd.DataFrame({c: pd.to_numeric(df[c], errors="coerce") for c in covs})
    refs = o.get("refs") or {}
    ref_notes = []
    for f_ in facs:
        s = df[f_].astype("string")
        levels = sorted(s.dropna().unique())
        _need(len(levels) >= 2, f"Factor '{f_}' needs at least 2 levels")
        _need(len(levels) <= 50, f"Factor '{f_}' has {len(levels)} levels — too many for a regression dummy coding")
        ref = refs.get(f_) if refs.get(f_) in levels else levels[0]
        ref_notes.append(f"{f_}: reference = {ref}")
        for lvl in levels:
            if lvl != ref:
                X[f"{f_} [{lvl} − {ref}]"] = (s == lvl).astype(float).where(s.notna())
    d = pd.concat([y.rename("__y"), X], axis=1)
    n_all = len(d)
    d = d.dropna()
    n, k = len(d), X.shape[1]
    _need(n > k + 1, f"Not enough complete rows ({n}) for {k} predictors")
    Xc = sm.add_constant(d[X.columns], has_constant="add")
    m = sm.OLS(d["__y"], Xc).fit()
    lv = _level(o)
    ci = m.conf_int(1 - lv)
    sd_y = d["__y"].std(ddof=1)
    vif = {}
    if o.get("vif", True) and k > 1:
        # VIF_j = j-th diagonal element of the inverse correlation matrix (one pass, fast on millions of rows)
        diag = np.diag(np.linalg.pinv(np.corrcoef(d[X.columns].to_numpy(), rowvar=False)))
        vif = {c: _f(v) for c, v in zip(X.columns, diag)}
    rows = []
    for c in Xc.columns:
        sdx = Xc[c].std(ddof=1) if c != "const" else None
        rows.append(dict(term="Intercept" if c == "const" else c, est=_f(m.params[c]), se=_f(m.bse[c]), lo=_f(ci.loc[c, 0]), hi=_f(ci.loc[c, 1]),
                         t=_f(m.tvalues[c]), p=_f(m.pvalues[c]),
                         beta=_f(m.params[c] * sdx / sd_y) if sdx is not None and sd_y > 0 else None, vif=vif.get(c)))
    fit = [dict(r=_f(math.sqrt(max(m.rsquared, 0))), r2=_f(m.rsquared), adj=_f(m.rsquared_adj), rmse=_f(math.sqrt(m.mse_resid)),
                f=_f(m.fvalue), df1=int(m.df_model), df2=int(m.df_resid), p=_f(m.f_pvalue), n=n, aic=_f(m.aic))]
    pct = f"{int(lv * 100)}% CI"
    out = [table("Model Fit", [("r", "R", "num"), ("r2", "R²", "num"), ("adj", "Adj. R²", "num"), ("rmse", "RMSE", "num"), ("aic", "AIC", "num"),
                               ("f", "F", "num"), ("df1", "df1", "int"), ("df2", "df2", "int"), ("p", "p", "p"), ("n", "N used", "int")], fit,
                 note=f"Dependent variable: {dv}. {n_all - n} of {n_all} rows dropped for missing values (listwise)."),
           table("Model Coefficients", [("term", "Predictor", "text"), ("est", "Estimate", "num"), ("se", "SE", "num"), ("lo", f"{pct} lower", "num"),
                                        ("hi", f"{pct} upper", "num"), ("t", "t", "num"), ("p", "p", "p"), ("beta", "Std. β", "num")]
                 + ([("vif", "VIF", "num")] if vif else []), rows,
                 note="; ".join(ref_notes) if ref_notes else None)]
    if o.get("assump", True):
        resid = m.resid.to_numpy()
        w, pw = _shapiro(resid)
        bp = het_breuschpagan(m.resid, Xc)
        out.append(table("Assumption Checks", [("test", "Test", "text"), ("stat", "Statistic", "num"), ("p", "p", "p")],
                         [dict(test="Shapiro-Wilk (normality of residuals)", stat=w, p=pw),
                          dict(test="Breusch-Pagan (homoscedasticity)", stat=_f(bp[0]), p=_f(bp[1])),
                          dict(test="Durbin-Watson (autocorrelation; ≈2 is fine)", stat=_f(durbin_watson(resid)), p=None)]))
    if o.get("plots", True):
        idx = np.random.default_rng(1).choice(n, min(n, 3000), replace=False)
        fitted, resid = m.fittedvalues.to_numpy()[idx], m.resid.to_numpy()[idx]
        obs = d["__y"].to_numpy()[idx]
        std = m.get_influence().resid_studentized_internal[idx] if n < 50000 else resid / resid.std()
        theo = ss.norm.ppf((ss.rankdata(std) - 0.5) / len(std))
        lim = [float(min(obs.min(), fitted.min())), float(max(obs.max(), fitted.max()))]
        out.append(chart("Observed vs. predicted", dict(
            data=dict(values=[dict(f=float(a), o=float(b)) for a, b in zip(fitted, obs)]), layer=[
                dict(mark=dict(type="point", opacity=0.5), encoding=dict(x=dict(field="f", type="quantitative", title="Predicted", scale=dict(zero=False)),
                                                                         y=dict(field="o", type="quantitative", title=dv, scale=dict(zero=False)))),
                dict(data=dict(values=[dict(f=lim[0], o=lim[0]), dict(f=lim[1], o=lim[1])]), mark=dict(type="line", strokeDash=[4, 4], color="#898781"),
                     encoding=dict(x=dict(field="f", type="quantitative"), y=dict(field="o", type="quantitative")))])))
        out.append(chart("Residuals vs. fitted", dict(
            data=dict(values=[dict(f=float(a), r=float(b)) for a, b in zip(fitted, resid)]), layer=[
                dict(mark=dict(type="point", opacity=0.5), encoding=dict(x=dict(field="f", type="quantitative", title="Fitted", scale=dict(zero=False)),
                                                                         y=dict(field="r", type="quantitative", title="Residual"))),
                dict(mark=dict(type="rule", strokeDash=[4, 4], color="#898781"), encoding=dict(y=dict(datum=0)))])))
        q = [float(min(theo.min(), std.min())), float(max(theo.max(), std.max()))]
        out.append(chart("Q-Q plot of standardized residuals", dict(
            data=dict(values=[dict(t=float(a), s=float(b)) for a, b in zip(theo, std)]), layer=[
                dict(mark=dict(type="point", opacity=0.5), encoding=dict(x=dict(field="t", type="quantitative", title="Theoretical quantiles"),
                                                                         y=dict(field="s", type="quantitative", title="Standardized residuals"))),
                dict(data=dict(values=[dict(t=q[0], s=q[0]), dict(t=q[1], s=q[1])]), mark=dict(type="line", strokeDash=[4, 4], color="#898781"),
                     encoding=dict(x=dict(field="t", type="quantitative"), y=dict(field="s", type="quantitative")))])))
    return out


# --------------------------------------------------------------------------- registry

_T_COMMON = [opt("alt", "Alternative hypothesis", "select", "two-sided", ALT_CHOICES), CI_OPT]

ANALYSES: list[Analysis] = [
    Analysis("descriptives", "Descriptives", "Exploration",
             [slot("vars", "Variables", ("numeric",), True), slot("split", "Split by", ("categorical",), False, False)],
             [opt("hist", "Histograms", default=False)], run_descriptives),
    Analysis("ttest_ind", "Independent Samples T-Test", "T-Tests",
             [slot("dvs", "Dependent variables", ("numeric",), True), slot("group", "Grouping variable (2 levels)", ("categorical",))],
             [opt("student", "Student's t", default=True), opt("welch", "Welch's t", default=True), opt("mannwhitney", "Mann-Whitney U", default=False),
              *_T_COMMON, opt("desc", "Group descriptives", default=True), opt("levene", "Equality of variances (Levene)", default=True),
              opt("shapiro", "Normality (Shapiro-Wilk)", default=True), opt("plot", "Means plot", default=True)], run_ttest_ind),
    Analysis("ttest_paired", "Paired Samples T-Test", "T-Tests",
             [slot("v1", "First measurement", ("numeric",)), slot("v2", "Second measurement", ("numeric",))],
             [opt("student", "Student's t", default=True), opt("wilcoxon", "Wilcoxon signed-rank", default=False),
              opt("alt", "Alternative hypothesis", "select", "two-sided", [("two-sided", "First ≠ Second"), ("greater", "First > Second"), ("less", "First < Second")]),
              CI_OPT, opt("desc", "Descriptives", default=True), opt("shapiro", "Normality of differences", default=True), opt("plot", "Scatter plot", default=True)],
             run_ttest_paired),
    Analysis("ttest_one", "One Sample T-Test", "T-Tests",
             [slot("vars", "Variables", ("numeric",), True)],
             [opt("test_value", "Test value", "number", 0), opt("student", "Student's t", default=True), opt("wilcoxon", "Wilcoxon", default=False),
              opt("alt", "Alternative hypothesis", "select", "two-sided", [("two-sided", "Mean ≠ test value"), ("greater", "Mean > test value"), ("less", "Mean < test value")]),
              CI_OPT, opt("shapiro", "Normality (Shapiro-Wilk)", default=True)], run_ttest_one),
    Analysis("anova", "One-Way ANOVA", "ANOVA",
             [slot("dvs", "Dependent variables", ("numeric",), True), slot("group", "Grouping variable", ("categorical",))],
             [opt("fisher", "Fisher's F (equal variances)", default=True), opt("welch", "Welch's F", default=True),
              opt("posthoc", "Post hoc", "select", "tukey", [("none", "None"), ("tukey", "Tukey HSD")]), CI_OPT,
              opt("desc", "Group descriptives", default=True), opt("levene", "Equality of variances (Levene)", default=True),
              opt("shapiro", "Normality of residuals", default=True), opt("plot", "Means plot", default=True)], run_anova),
    Analysis("correlation", "Correlation Matrix", "Regression",
             [slot("vars", "Variables (2 or more)", ("numeric",), True)],
             [opt("method", "Method", "select", "pearson", [("pearson", "Pearson"), ("spearman", "Spearman"), ("kendall", "Kendall")]),
              opt("heatmap", "Heatmap", default=True)], run_correlation),
    Analysis("regression", "Linear Regression", "Regression",
             [slot("dv", "Dependent variable", ("numeric",)), slot("covs", "Covariates (numeric)", ("numeric",), True, False),
              slot("factors", "Factors (categorical)", ("categorical",), True, False)],
             [CI_OPT, opt("vif", "Collinearity (VIF)", default=True), opt("assump", "Assumption checks", default=True),
              opt("plots", "Diagnostic plots", default=True)], run_regression),
]
BY_ID = {a.id: a for a in ANALYSES}

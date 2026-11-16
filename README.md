# EDA Studio

A local drag-and-drop tool for exploratory data analysis — a mix of **Tableau** (shelves, pills, filters) and **Jamovi** (t-tests, ANOVA, correlation, regression with APA-style tables).
Nothing is auto-charted: you drag fields onto shelves and choose the mark yourself.

## Run it

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe run.py            # desktop window
.\.venv\Scripts\python.exe run.py --browser  # or in your default browser
```

Tests: `.\.venv\Scripts\python.exe -m pytest tests`

Portable build (no install, no admin): `.\build_portable.ps1` → `dist\EDAStudio\EDAStudio.exe`.

## Data

CSV / TSV, JSON / NDJSON (e.g. BigQuery exports), Parquet, Excel (sheet picker). Loaded into an in-memory DuckDB table, so millions of rows are fine:
charts are aggregated in the database and only the result goes to the browser (scatter plots show a random sample, with a notice).
For very large files, paste the file path instead of dragging the file in (dragging uploads a copy).

## Explore tab

* Drag fields to **X, Y, Color, Size, Facet columns/rows**; pick the chart: bar, line, area, scatter, histogram, box plot, heatmap.
* Click a pill (▾) to change its role (Dimension/Measure), aggregation (sum, avg, median, …, none), date part (year … hour, month-of-year, weekday) or bin size.
* **Number of Records** is the row count. Drag any field to the **Filters** bar (applies to every tab).
* Chart menu (⋯) exports PNG / SVG.

## Statistics tab

Descriptives, independent / paired / one-sample t-tests (Student, Welch, Mann-Whitney, Wilcoxon, effect sizes, assumption checks),
one-way ANOVA (Fisher, Welch, Tukey post hoc), correlation matrix (Pearson / Spearman / Kendall + heatmap), linear regression (numeric + categorical predictors, std. β, VIF, diagnostics).
Drag variables into the boxes; results update live. "Copy" on a table puts it on the clipboard for Excel.
Results are checked against scipy / statsmodels in `tests/test_api.py`.

## Layout

```
run.py                 launcher (desktop window or browser)
app/main.py            FastAPI routes
app/datastore.py       file loading, profiling, filters (DuckDB)
app/charts.py          shelf spec → SQL (aggregation, histogram bins, box-plot quartiles)
app/stats.py           analyses (each declares slots/options; the UI form is generated from them)
app/static/            frontend (no build step): index.html, style.css, js/*.js, vendor/ (Vega-Lite, offline)
```

Adding an analysis = one function + one `Analysis(...)` entry in `app/stats.py`; the form and result rendering need no frontend changes.

## Backlog

* Logistic regression, chi-square, interaction terms, reference-level picker in the UI
* Save / load a workbook (shelves + filters + analyses); export a chart/analysis report
* Top-N for categories, reference lines, calculated fields, dual-dataset joins
* Flatten nested JSON (STRUCT/LIST columns are shown but not plottable yet)
* Dark/light toggle (currently follows the OS)

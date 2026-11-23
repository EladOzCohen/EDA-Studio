# Starts the built app in serve-only mode and checks that it really works (loads data, runs a regression).
# Used by the release workflow, and handy locally:  .\scripts\smoke_test_exe.ps1
param([string]$Exe = "portable\EDAStudio\EDAStudio.exe", [int]$Port = 8766)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
$p = Start-Process $Exe -ArgumentList "--no-open", "--port", $Port -PassThru
try {
    $base = "http://127.0.0.1:$Port"
    $up = $false
    for ($i = 0; $i -lt 60 -and -not $up; $i++) {
        Start-Sleep 3
        if ($p.HasExited) { throw "App exited early (exit code $($p.ExitCode))" }
        try { Invoke-WebRequest "$base/api/samples" -UseBasicParsing -TimeoutSec 5 | Out-Null; $up = $true } catch { }
    }
    if (-not $up) { throw "App did not start within 3 minutes" }
    Write-Host "App is up."
    $sample = (Resolve-Path "sample_data\sales_sample.csv").Path
    $body = @{ path = $sample } | ConvertTo-Json
    $meta = Invoke-RestMethod "$base/api/load" -Method Post -Body $body -ContentType "application/json"
    if ($meta.n_rows -ne 6000) { throw "Unexpected row count: $($meta.n_rows)" }
    $chart = @{ mark = "bar"; shelves = @{ x = @{ field = "region"; role = "dim" }; y = @{ field = "revenue"; role = "measure"; agg = "sum" } } } | ConvertTo-Json -Depth 5
    $c = Invoke-RestMethod "$base/api/chart" -Method Post -Body $chart -ContentType "application/json"
    if ($c.rows.Count -ne 4) { throw "Chart returned $($c.rows.Count) rows, expected 4" }
    $reg = @{ id = "regression"; slots = @{ dv = @("satisfaction"); covs = @("discount"); factors = @("channel") }; options = @{} } | ConvertTo-Json -Depth 5
    $r = Invoke-RestMethod "$base/api/analyze" -Method Post -Body $reg -ContentType "application/json"
    if (-not $r.blocks) { throw "Regression returned no result" }
    $page = Invoke-WebRequest "$base/js/canvas.js" -UseBasicParsing
    if ($page.StatusCode -ne 200) { throw "Frontend files are missing from the build" }
    Write-Host "Smoke test passed: data load, chart, regression and frontend all work."
}
finally {
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
}

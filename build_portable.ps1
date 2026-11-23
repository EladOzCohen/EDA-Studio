# Builds a portable folder (no installer / no admin rights needed): portable\EDAStudio\EDAStudio.exe
# Copy the whole portable\EDAStudio folder anywhere (USB stick, network share) and run the exe.
# Close any running EDAStudio.exe first, or Windows won't let the build replace its files.
Set-Location $PSScriptRoot
# PyInstaller writes progress to stderr; don't let PowerShell treat that as a failure.
$ErrorActionPreference = "Continue"
$py = if (Test-Path ".\.venv\Scripts\python.exe") { ".\.venv\Scripts\python.exe" } else { "python" }

# Anaconda keeps some DLLs the stdlib needs (libffi for ctypes, openssl, sqlite, ...) in Library\bin,
# and PyInstaller doesn't find them from a venv. Bundle them explicitly (no-op for a regular python.org install).
$base = (& $py -c "import sys; print(sys.base_prefix)").Trim()
$extra = @()
foreach ($pat in "ffi*.dll", "libssl*.dll", "libcrypto*.dll", "sqlite3.dll", "libbz2.dll", "liblzma.dll", "zlib.dll", "libexpat.dll") {
    Get-ChildItem "$base\Library\bin\$pat" -ErrorAction SilentlyContinue | ForEach-Object { $extra += "--add-binary"; $extra += "$($_.FullName);." }
}

& $py -m PyInstaller --noconfirm --clean --onedir --windowed --name EDAStudio --distpath portable `
    --icon "installer\EDAStudio.ico" `
    --add-data "app\static;app\static" --add-data "sample_data;sample_data" `
    --collect-submodules uvicorn --collect-submodules statsmodels --collect-all webview `
    --exclude-module matplotlib --exclude-module IPython --exclude-module notebook --exclude-module pytest `
    @extra run.py
if ($LASTEXITCODE -ne 0) { Write-Error "PyInstaller failed ($LASTEXITCODE)"; exit $LASTEXITCODE }
Write-Host "Done: portable\EDAStudio\EDAStudio.exe"

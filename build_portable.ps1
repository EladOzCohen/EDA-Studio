# Builds a portable folder (no installer / no admin rights needed): dist\EDAStudio\EDAStudio.exe
# Copy the whole dist\EDAStudio folder anywhere (USB stick, network share) and run the exe.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
.\.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --onedir --windowed --name EDAStudio `
    --add-data "app\static;app\static" --add-data "sample_data;sample_data" `
    --collect-submodules uvicorn --collect-submodules statsmodels --collect-all webview `
    --exclude-module matplotlib --exclude-module IPython --exclude-module notebook --exclude-module pytest `
    run.py
Write-Host "Done: dist\EDAStudio\EDAStudio.exe"

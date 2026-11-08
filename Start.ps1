param(
    [string]$Python = "",
    [int]$Port = 8766
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not $Python) {
    $Python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $Python)) {
        python -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw "Install Python 3.12 or newer before starting LENS." }
        & $Python -m pip install -r requirements-lock.txt
        if ($LASTEXITCODE -ne 0) { throw "The Python packages could not be installed; see the pip output above." }
    }
}
if (-not (Test-Path -LiteralPath "frontend\dist\index.html")) {
    throw "Build the frontend first: cd frontend; npm ci; npm run build. See RUNNING.txt."
}
Write-Host "LENS: http://127.0.0.1:$Port"
Write-Host "Portfolios are stored on this computer. Press Ctrl+C to stop the server."
& $Python -m uvicorn backend.app:app --host 127.0.0.1 --port $Port
if ($LASTEXITCODE -ne 0) { throw "The LENS server stopped with an error; see the output above." }

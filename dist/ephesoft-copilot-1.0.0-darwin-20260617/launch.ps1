# Start Ephesoft Copilot (Windows)
# Launches Electron directly. Electron owns the FastAPI backend lifecycle,
# so there is no npm/node subprocess detection and no double-backend conflict.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".\.venv\Scripts\python.exe")) {
    Write-Host "Virtual environment not found. Run .\install.ps1 first."
    exit 1
}

if (-not (Test-Path ".\config.json")) {
    Write-Host "config.json missing. Run .\install.ps1 first."
    exit 1
}

$electron = ".\node_modules\.bin\electron.cmd"
if (-not (Test-Path $electron)) {
    Write-Host "Electron not found in node_modules. Run .\install.ps1 first."
    exit 1
}

# Make sure the log folders exist before the backend writes to them.
New-Item -ItemType Directory -Force -Path ".\logs\actions" | Out-Null
New-Item -ItemType Directory -Force -Path ".\logs\screenshots" | Out-Null

Write-Host "Starting Ephesoft Copilot..."
& $electron .

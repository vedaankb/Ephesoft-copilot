# Start Ephesoft Copilot (Windows)
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

& .\.venv\Scripts\python.exe run.py

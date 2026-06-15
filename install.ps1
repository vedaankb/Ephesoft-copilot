# First-time setup for Ephesoft Copilot (Windows)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "=============================================="
Write-Host " Ephesoft Copilot — install"
Write-Host "=============================================="
Write-Host ""

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: python not found. Install Python 3.11+ from https://www.python.org/downloads/"
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js not found. Install from https://nodejs.org/"
    exit 1
}

Write-Host "-> Creating virtual environment..."
python -m venv .venv

Write-Host "-> Installing Python packages..."
& .\.venv\Scripts\pip.exe install --upgrade pip -q
& .\.venv\Scripts\pip.exe install -r requirements.txt -q

Write-Host "-> Installing Node packages..."
npm install --silent

Write-Host "-> Creating config.json..."
& .\.venv\Scripts\python.exe setup.py

Write-Host ""
Write-Host "=============================================="
Write-Host " Install complete"
Write-Host "=============================================="
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Chrome -> chrome://extensions -> Developer mode -> Load unpacked -> extension\"
Write-Host "  2. Run:  .\launch.ps1"
Write-Host "  3. Panel -> gear icon -> add Gemini API key"
Write-Host ""
Write-Host "See INSTALL.md for full instructions."

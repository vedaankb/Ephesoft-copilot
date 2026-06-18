# First-time setup for Ephesoft Copilot (Windows)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "=============================================="
Write-Host " Ephesoft Copilot - install"
Write-Host "=============================================="
Write-Host ""

# --- Sanity: warn about folders that block venv creation / writes ---
$here = (Get-Location).Path
if ($here -like "*\Program Files*" -or $here -like "*\Program Files (x86)*") {
    Write-Host "ERROR: This folder is under 'Program Files', which is not writable."
    Write-Host "Move the project to e.g. C:\Users\$env:USERNAME\Ephesoft-copilot and re-run."
    exit 1
}
if ($here -like "*OneDrive*") {
    Write-Host "WARNING: This folder is inside OneDrive. File-sync locks can break the"
    Write-Host "         virtual environment. If install fails, move it outside OneDrive."
    Write-Host ""
}

# --- Check tools (PATH-based; resolves python.exe / npm.cmd) ---
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: python not found. Install Python 3.11+ from https://www.python.org/downloads/"
    Write-Host "       During install, tick 'Add python.exe to PATH'."
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js not found. Install from https://nodejs.org/ (LTS)."
    exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: npm not found. Reinstall Node.js from https://nodejs.org/ (LTS)."
    exit 1
}

Write-Host "-> Creating virtual environment..."
python -m venv .venv
if (-not (Test-Path ".\.venv\Scripts\python.exe")) {
    Write-Host "ERROR: virtual environment was not created. Check write permissions for this folder."
    exit 1
}

# Use 'python -m pip' through the venv interpreter (avoids call-operator path issues).
Write-Host "-> Upgrading pip..."
.\.venv\Scripts\python.exe -m pip install --upgrade pip -q

Write-Host "-> Installing Python packages..."
.\.venv\Scripts\python.exe -m pip install -r requirements.txt -q

Write-Host "-> Installing Node packages..."
npm install

Write-Host "-> Creating config.json..."
.\.venv\Scripts\python.exe setup.py

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

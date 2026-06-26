# Ephesoft Copilot - 1-Click PowerShell Bootstrap Installer
#
# This script downloads, extracts, and installs the Ephesoft Copilot Chrome/Edge
# extension into the user's local app data directory (no admin rights required),
# then creates desktop shortcuts to launch Chrome and Edge with the extension preloaded.
#
# Usage:
#   irm -useb https://raw.githubusercontent.com/vedaankb/Ephesoft-copilot/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "          EPHESOFT COPILOT INSTALLER              " -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Installing Ephesoft Copilot (V2 Pure Extension)..." -ForegroundColor Yellow

# --- 1. Define Paths ---
$InstallDir = "$env:LOCALAPPDATA\EphesoftCopilot"
$TempZip = "$env:TEMP\ephesoft-copilot-temp.zip"
$TempExtract = "$env:TEMP\ephesoft-copilot-temp-extract"
$RepoZipUrl = "https://github.com/vedaankb/Ephesoft-copilot/archive/refs/heads/main.zip"

# --- 2. Clean Up Old Installs/Temps ---
if (Test-Path $InstallDir) {
    Write-Host "Removing existing installation at $InstallDir..." -ForegroundColor Gray
    Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
}
if (Test-Path $TempZip) { Remove-Item -Path $TempZip -Force -ErrorAction SilentlyContinue }
if (Test-Path $TempExtract) { Remove-Item -Path $TempExtract -Recurse -Force -ErrorAction SilentlyContinue }

# --- 3. Download the Repository Zip ---
Write-Host "Downloading latest version from GitHub..." -ForegroundColor Yellow
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $RepoZipUrl -OutFile $TempZip -UseBasicParsing
} catch {
    Write-Host "ERROR: Failed to download the extension zip. Check your internet connection or proxy settings." -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

# --- 4. Extract the Zip ---
Write-Host "Extracting files..." -ForegroundColor Yellow
try {
    New-Item -ItemType Directory -Force -Path $TempExtract | Out-Null
    Expand-Archive -Path $TempZip -DestinationPath $TempExtract -Force
} catch {
    Write-Host "ERROR: Failed to extract zip file." -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

# --- 5. Copy Extension to Install Directory ---
Write-Host "Installing extension files..." -ForegroundColor Yellow
try {
    $ExtSource = Join-Path $TempExtract "Ephesoft-copilot-main\extension"
    if (-not (Test-Path $ExtSource)) {
        throw "Could not find extension folder in the downloaded repository zip."
    }
    Copy-Item -Path $ExtSource -Destination $InstallDir -Recurse -Force
} catch {
    Write-Host "ERROR: Failed to copy extension files to $InstallDir." -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    # Clean up temp files
    Remove-Item -Path $TempZip -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $TempExtract -Recurse -Force -ErrorAction SilentlyContinue
}

# --- 6. Locate Browsers ---
$ChromePaths = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$EdgePaths = @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)

$ChromePath = $null
foreach ($p in $ChromePaths) {
    if (Test-Path $p) { $ChromePath = $p; break }
}

$EdgePath = $null
foreach ($p in $EdgePaths) {
    if (Test-Path $p) { $EdgePath = $p; break }
}

# --- 7. Generate Desktop Shortcuts via VBScript ---
$DesktopPath = [System.IO.Path]::Combine([System.Environment]::GetFolderPath('Desktop'), "")

function Create-Shortcut {
    param (
        [string]$ShortcutName,
        [string]$BrowserPath,
        [string]$Arguments
    )
    $ShortcutPath = Join-Path $DesktopPath "$ShortcutName.lnk"
    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = $BrowserPath
    $Shortcut.Arguments = $Arguments
    $Shortcut.WorkingDirectory = $env:USERPROFILE
    $Shortcut.Description = "Launch browser with Ephesoft Copilot extension preloaded"
    $Shortcut.IconLocation = "$BrowserPath,0"
    $Shortcut.Save()
}

$CreatedShortcuts = 0

if ($ChromePath) {
    Write-Host "Creating Google Chrome Desktop Shortcut..." -ForegroundColor Yellow
    Create-Shortcut -ShortcutName "Ephesoft Copilot (Chrome)" -BrowserPath $ChromePath -Arguments "--load-extension=""$InstallDir"" --no-first-run"
    $CreatedShortcuts++
} else {
    Write-Host "Google Chrome not found. Skipping Chrome shortcut." -ForegroundColor Gray
}

if ($EdgePath) {
    Write-Host "Creating Microsoft Edge Desktop Shortcut..." -ForegroundColor Yellow
    Create-Shortcut -ShortcutName "Ephesoft Copilot (Edge)" -BrowserPath $EdgePath -Arguments "--load-extension=""$InstallDir"" --no-first-run"
    $CreatedShortcuts++
} else {
    Write-Host "Microsoft Edge not found. Skipping Edge shortcut." -ForegroundColor Gray
}

# --- 8. Done ---
Write-Host "`n==================================================" -ForegroundColor Green
Write-Host "    SUCCESS: Ephesoft Copilot Installed!          " -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host "The extension has been installed to:" -ForegroundColor Gray
Write-Host "  $InstallDir" -ForegroundColor White

if ($CreatedShortcuts -gt 0) {
    Write-Host "`nDesktop shortcuts created:" -ForegroundColor Gray
    if ($ChromePath) { Write-Host "  - Ephesoft Copilot (Chrome)" -ForegroundColor Green }
    if ($EdgePath)   { Write-Host "  - Ephesoft Copilot (Edge)" -ForegroundColor Green }
    Write-Host "`nDouble-click a shortcut to launch the browser with the Copilot preloaded." -ForegroundColor White
} else {
    Write-Host "`nWARNING: No supported browser (Chrome or Edge) was found." -ForegroundColor Yellow
    Write-Host "Please load the extension folder manually in your browser:" -ForegroundColor White
    Write-Host "  $InstallDir" -ForegroundColor White
}
Write-Host "==================================================" -ForegroundColor Green

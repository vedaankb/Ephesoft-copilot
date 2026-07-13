# Ephesoft Copilot Updater
# Pulls the latest main branch and refreshes the installed extension without a full reinstall.
# Preserves the dedicated browser profile (license key, Gemini settings, cookies).
#
# Usage (existing install):
#   powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\EphesoftCopilot\update.ps1"
#
# Or one-liner from the web (same as install, but update endpoint):
#   $url = 'https://raw.githubusercontent.com/vedaankb/Ephesoft-copilot/main/update.ps1'
#   $file = "$env:TEMP\ephesoft-update.ps1"
#   Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing; & $file

$ErrorActionPreference = 'Stop'

Write-Output "=========================================="
Write-Output "Ephesoft Copilot Updater"
Write-Output "=========================================="

if (-not $env:USERPROFILE) {
    Write-Output "ERROR: USERPROFILE not set"
    exit 1
}

if (-not $env:LOCALAPPDATA) {
    $env:LOCALAPPDATA = Join-Path $env:USERPROFILE 'AppData\Local'
}

if (-not $env:TEMP) {
    $env:TEMP = [System.IO.Path]::GetTempPath().TrimEnd('\')
}

$InstallDir = Join-Path $env:LOCALAPPDATA 'EphesoftCopilot'
$ProfileDir = Join-Path $InstallDir 'profile'
$TempZip = Join-Path $env:TEMP 'ephesoft-update.zip'
$TempExtract = Join-Path $env:TEMP 'ephesoft-update-extract'
$RepoUrl = 'https://github.com/vedaankb/Ephesoft-copilot/archive/refs/heads/main.zip'

if (-not (Test-Path $InstallDir)) {
    Write-Output "No existing install found at:"
    Write-Output "  $InstallDir"
    Write-Output "Run install.ps1 first, then use update.ps1 for later upgrades."
    exit 1
}

# Warn if a Copilot browser profile is currently locked by a running process.
function Test-ProfileInUse {
    param([string]$ProfileDir)
    foreach ($name in @('chrome.exe', 'msedge.exe')) {
        try {
            $procs = Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue
            foreach ($proc in $procs) {
                if ($proc.CommandLine -and $proc.CommandLine -like "*$ProfileDir*") {
                    return $true
                }
            }
        } catch {
            # Best-effort only.
        }
    }
    return $false
}

if (Test-ProfileInUse -ProfileDir $ProfileDir) {
    Write-Output ""
    Write-Output "WARNING: Ephesoft Copilot browser appears to be running."
    Write-Output "Close Chrome/Edge windows started from the Copilot shortcut,"
    Write-Output "then re-run update.ps1 for a clean upgrade."
    Write-Output "Continuing with a versioned app folder (safe if files are locked)..."
    Write-Output ""
}

Write-Output "Downloading latest from GitHub..."
if (Test-Path $TempZip) { Remove-Item $TempZip -Force }
if (Test-Path $TempExtract) { Remove-Item $TempExtract -Recurse -Force }

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $RepoUrl -OutFile $TempZip -UseBasicParsing
} catch {
    Write-Output "ERROR: Download failed"
    Write-Output $_.Exception.Message
    exit 1
}

Write-Output "Extracting..."
Expand-Archive -Path $TempZip -DestinationPath $TempExtract -Force
$RepoRoot = Join-Path $TempExtract 'Ephesoft-copilot-main'

if (-not (Test-Path $RepoRoot)) {
    Write-Output "ERROR: Extraction failed"
    exit 1
}

$ExtSource = Join-Path $RepoRoot 'extension'
if (-not (Test-Path (Join-Path $ExtSource 'manifest.json'))) {
    Write-Output "ERROR: Extension files not found in download"
    exit 1
}

# Versioned-folder update: never delete the live folder a browser may have locked.
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$Stamp = Get-Date -Format 'yyyyMMddHHmmss'
$AppDir = Join-Path $InstallDir ("app-" + $Stamp)
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
Copy-Item -Path "$ExtSource\*" -Destination $AppDir -Recurse -Force

# Keep a local copy of this updater next to the install so pilots can re-run offline-ish.
try {
    $UpdaterSrc = Join-Path $RepoRoot 'update.ps1'
    if (Test-Path $UpdaterSrc) {
        Copy-Item -Path $UpdaterSrc -Destination (Join-Path $InstallDir 'update.ps1') -Force
    }
} catch {
    # Non-fatal.
}

# Write a tiny version stamp for support.
try {
    $Manifest = Get-Content (Join-Path $AppDir 'manifest.json') -Raw | ConvertFrom-Json
    $VersionInfo = @{
        updated_at = (Get-Date).ToString('o')
        extension_version = $Manifest.version
        app_dir = $AppDir
    }
    $VersionInfo | ConvertTo-Json | Set-Content -Path (Join-Path $InstallDir 'VERSION.json') -Encoding UTF8
} catch {
    # Non-fatal.
}

Remove-Item $TempZip -Force -ErrorAction SilentlyContinue
Remove-Item $TempExtract -Recurse -Force -ErrorAction SilentlyContinue

# Best-effort cleanup of older app-* folders (skip the new one).
Get-ChildItem -Path $InstallDir -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -ne $AppDir } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

$LaunchArgs = "--load-extension=`"$AppDir`" --user-data-dir=`"$ProfileDir`" --no-first-run --no-default-browser-check"

$ChromePaths = @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)

$EdgePaths = @(
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
)

$ChromePath = $null
foreach ($p in $ChromePaths) {
    if (Test-Path $p) { $ChromePath = $p; break }
}

$EdgePath = $null
foreach ($p in $EdgePaths) {
    if (Test-Path $p) { $EdgePath = $p; break }
}

$Desktop = [System.Environment]::GetFolderPath('Desktop')
$WshShell = New-Object -ComObject WScript.Shell
$Updated = 0

if ($ChromePath) {
    Write-Output "Updating Chrome shortcut..."
    $Shortcut = $WshShell.CreateShortcut((Join-Path $Desktop 'Ephesoft Copilot (Chrome).lnk'))
    $Shortcut.TargetPath = $ChromePath
    $Shortcut.Arguments = $LaunchArgs
    $Shortcut.WorkingDirectory = $env:USERPROFILE
    $Shortcut.IconLocation = "$ChromePath,0"
    $Shortcut.Save()
    $Updated++
}

if ($EdgePath) {
    Write-Output "Updating Edge shortcut..."
    $Shortcut = $WshShell.CreateShortcut((Join-Path $Desktop 'Ephesoft Copilot (Edge).lnk'))
    $Shortcut.TargetPath = $EdgePath
    $Shortcut.Arguments = $LaunchArgs
    $Shortcut.WorkingDirectory = $env:USERPROFILE
    $Shortcut.IconLocation = "$EdgePath,0"
    $Shortcut.Save()
    $Updated++
}

Write-Output ""
Write-Output "=========================================="
Write-Output "SUCCESS - Updated to:"
Write-Output $AppDir
Write-Output ""
Write-Output "Profile preserved at:"
Write-Output $ProfileDir
Write-Output "(license key + Gemini settings kept)"
Write-Output ""
Write-Output "Close any open Copilot browser windows,"
Write-Output "then use the desktop shortcut to launch."
Write-Output ""
if ($Updated -eq 0) {
    Write-Output "No browser found to refresh shortcuts."
    Write-Output "Load manually: chrome://extensions"
} else {
    Write-Output "Desktop shortcuts now point at the new build."
}
Write-Output "=========================================="

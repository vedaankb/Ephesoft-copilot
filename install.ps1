# Ephesoft Copilot Installer
# Download, install, and create shortcuts for Chrome/Edge

$ErrorActionPreference = 'Stop'

Write-Output "=========================================="
Write-Output "Ephesoft Copilot Installer"
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
$TempZip = Join-Path $env:TEMP 'ephesoft-temp.zip'
$TempExtract = Join-Path $env:TEMP 'ephesoft-extract'
$RepoUrl = 'https://github.com/vedaankb/Ephesoft-copilot/archive/refs/heads/main.zip'

Write-Output "Downloading from GitHub..."
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

Write-Output "Installing extension..."
$ExtSource = Join-Path $RepoRoot 'extension'
if (-not (Test-Path (Join-Path $ExtSource 'manifest.json'))) {
    Write-Output "ERROR: Extension files not found"
    exit 1
}

if (Test-Path $InstallDir) {
    Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path "$ExtSource\*" -Destination $InstallDir -Recurse -Force
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

Remove-Item $TempZip -Force -ErrorAction SilentlyContinue
Remove-Item $TempExtract -Recurse -Force -ErrorAction SilentlyContinue

$LaunchArgs = "--load-extension=`"$InstallDir`" --user-data-dir=`"$ProfileDir`" --no-first-run --no-default-browser-check"

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

$Created = 0

if ($ChromePath) {
    Write-Output "Creating Chrome shortcut..."
    $Shortcut = $WshShell.CreateShortcut((Join-Path $Desktop 'Ephesoft Copilot (Chrome).lnk'))
    $Shortcut.TargetPath = $ChromePath
    $Shortcut.Arguments = $LaunchArgs
    $Shortcut.WorkingDirectory = $env:USERPROFILE
    $Shortcut.IconLocation = "$ChromePath,0"
    $Shortcut.Save()
    $Created++
}

if ($EdgePath) {
    Write-Output "Creating Edge shortcut..."
    $Shortcut = $WshShell.CreateShortcut((Join-Path $Desktop 'Ephesoft Copilot (Edge).lnk'))
    $Shortcut.TargetPath = $EdgePath
    $Shortcut.Arguments = $LaunchArgs
    $Shortcut.WorkingDirectory = $env:USERPROFILE
    $Shortcut.IconLocation = "$EdgePath,0"
    $Shortcut.Save()
    $Created++
}

Write-Output ""
Write-Output "=========================================="
Write-Output "SUCCESS - Installed to:"
Write-Output $InstallDir
Write-Output ""
Write-Output "IMPORTANT:"
Write-Output "  Always use the desktop shortcut"
Write-Output "  (dedicated browser profile)"
Write-Output ""

if ($Created -eq 0) {
    Write-Output "No browser found"
    Write-Output "Load manually at chrome://extensions"
} else {
    Write-Output "Double-click the desktop shortcut to start"
}

Write-Output "=========================================="

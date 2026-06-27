# Ephesoft Copilot - 1-Click PowerShell Bootstrap Installer
#
# Downloads the repo, builds an obfuscated extension package when Node.js is
# available, installs to %LOCALAPPDATA%, and creates desktop shortcuts that
# launch Chrome/Edge with a dedicated profile so --load-extension is honored.
#
# Usage:
#   irm -useb https://raw.githubusercontent.com/vedaankb/Ephesoft-copilot/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "          EPHESOFT COPILOT INSTALLER              " -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Installing Ephesoft Copilot (V2 Pure Extension)..." -ForegroundColor Yellow

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HelpersPath = Join-Path $ScriptDir "scripts\install_helpers.ps1"
if (Test-Path $HelpersPath) {
    . $HelpersPath
} else {
    # When invoked via irm | iex the script has no local helpers — inline essentials.
    function Get-EphesoftInstallPaths {
        $InstallDir = Join-Path $env:LOCALAPPDATA 'EphesoftCopilot'
        $ProfileDir = Join-Path $InstallDir 'profile'
        return @{ InstallDir = $InstallDir; ProfileDir = $ProfileDir }
    }
    function Find-BrowserPath { param([string[]]$Candidates); foreach ($p in $Candidates) { if (Test-Path $p) { return $p } }; return $null }
    function Get-ChromePath {
        Find-BrowserPath @(
            'C:\Program Files\Google\Chrome\Application\chrome.exe',
            'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
            (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
        )
    }
    function Get-EdgePath {
        Find-BrowserPath @(
            'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
            'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
            (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
        )
    }
    function Get-ExtensionLaunchArgs {
        param([string]$InstallDir, [string]$ProfileDir)
        return "--load-extension=`"$InstallDir`" --user-data-dir=`"$ProfileDir`" --no-first-run --no-default-browser-check"
    }
    function New-EphesoftShortcut {
        param([string]$ShortcutName, [string]$BrowserPath, [string]$Arguments, [string]$DesktopPath)
        $sc = Join-Path $DesktopPath "$ShortcutName.lnk"
        $ws = New-Object -ComObject WScript.Shell
        $lnk = $ws.CreateShortcut($sc)
        $lnk.TargetPath = $BrowserPath
        $lnk.Arguments = $Arguments
        $lnk.WorkingDirectory = $env:USERPROFILE
        $lnk.Description = 'Launch browser with Ephesoft Copilot (dedicated profile)'
        $lnk.IconLocation = "$BrowserPath,0"
        $lnk.Save()
    }
}

$paths = Get-EphesoftInstallPaths
$InstallDir = $paths.InstallDir
$ProfileDir = $paths.ProfileDir
$TempZip = Join-Path $env:TEMP 'ephesoft-copilot-temp.zip'
$TempExtract = Join-Path $env:TEMP 'ephesoft-copilot-temp-extract'
$RepoZipUrl = 'https://github.com/vedaankb/Ephesoft-copilot/archive/refs/heads/main.zip'

if (Test-Path $TempZip) { Remove-Item $TempZip -Force -ErrorAction SilentlyContinue }
if (Test-Path $TempExtract) { Remove-Item $TempExtract -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host "Downloading latest version from GitHub..." -ForegroundColor Yellow
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $RepoZipUrl -OutFile $TempZip -UseBasicParsing
} catch {
    Write-Host "ERROR: Failed to download. Check internet/proxy settings." -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

Write-Host "Extracting repository..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $TempExtract | Out-Null
Expand-Archive -Path $TempZip -DestinationPath $TempExtract -Force
$RepoRoot = Join-Path $TempExtract 'Ephesoft-copilot-main'
if (-not (Test-Path $RepoRoot)) {
    Write-Host "ERROR: Unexpected zip layout — Ephesoft-copilot-main folder not found." -ForegroundColor Red
    exit 1
}

# Build obfuscated package when Node.js is available (recommended for IP protection).
$PackagedZip = $null
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($NodeCmd) {
    Write-Host "Building obfuscated extension package (Node.js detected)..." -ForegroundColor Yellow
    Push-Location $RepoRoot
    try {
        npm install --silent 2>$null
        node scripts/generate_icons.js 2>$null
        node scripts/package_extension.js
        $manifest = Get-Content (Join-Path $RepoRoot 'extension\manifest.json') -Raw | ConvertFrom-Json
        $ver = if ($manifest.version) { $manifest.version } else { '0.0.0' }
        $candidate = Join-Path $RepoRoot "dist\ephesoft-copilot-extension-v$ver.zip"
        if (Test-Path $candidate) { $PackagedZip = $candidate }
    } catch {
        Write-Host "WARNING: Obfuscated build failed — falling back to source extension." -ForegroundColor Yellow
    } finally {
        Pop-Location
    }
} else {
    Write-Host "Node.js not found — installing source extension (unobfuscated)." -ForegroundColor Yellow
    Write-Host "  For production pilots, install Node.js and re-run, or use a GitHub Release zip." -ForegroundColor Gray
}

Write-Host "Installing extension files..." -ForegroundColor Yellow
$StagingDir = Join-Path $env:TEMP 'ephesoft-copilot-staging'
if (Test-Path $StagingDir) { Remove-Item $StagingDir -Recurse -Force -ErrorAction SilentlyContinue }

if ($PackagedZip) {
    New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null
    Expand-Archive -Path $PackagedZip -DestinationPath $StagingDir -Force
} else {
    $ExtSource = Join-Path $RepoRoot 'extension'
    if (-not (Test-Path (Join-Path $ExtSource 'manifest.json'))) {
        Write-Host "ERROR: extension folder not found in downloaded repo." -ForegroundColor Red
        exit 1
    }
    Copy-Item -Path $ExtSource -Destination $StagingDir -Recurse -Force
}

if (Test-Path $InstallDir) {
    Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
}
Copy-Item -Path $StagingDir -Destination $InstallDir -Recurse -Force
Remove-Item -Path $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path $TempZip -Force -ErrorAction SilentlyContinue
Remove-Item -Path $TempExtract -Recurse -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$ChromePath = Get-ChromePath
$EdgePath = Get-EdgePath
$LaunchArgs = Get-ExtensionLaunchArgs -InstallDir $InstallDir -ProfileDir $ProfileDir
$DesktopPath = [System.IO.Path]::Combine([System.Environment]::GetFolderPath('Desktop'), '')

$CreatedShortcuts = 0
if ($ChromePath) {
    Write-Host "Creating Google Chrome desktop shortcut..." -ForegroundColor Yellow
    New-EphesoftShortcut -ShortcutName 'Ephesoft Copilot (Chrome)' -BrowserPath $ChromePath -Arguments $LaunchArgs -DesktopPath $DesktopPath
    $CreatedShortcuts++
} else {
    Write-Host "Google Chrome not found — skipping Chrome shortcut." -ForegroundColor Gray
}

if ($EdgePath) {
    Write-Host "Creating Microsoft Edge desktop shortcut..." -ForegroundColor Yellow
    New-EphesoftShortcut -ShortcutName 'Ephesoft Copilot (Edge)' -BrowserPath $EdgePath -Arguments $LaunchArgs -DesktopPath $DesktopPath
    $CreatedShortcuts++
} else {
    Write-Host "Microsoft Edge not found — skipping Edge shortcut." -ForegroundColor Gray
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "    SUCCESS: Ephesoft Copilot Installed!          " -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host "Extension:  $InstallDir" -ForegroundColor White
Write-Host "Profile:    $ProfileDir" -ForegroundColor White
Write-Host ""
Write-Host "IMPORTANT:" -ForegroundColor Yellow
Write-Host "  Always launch via the desktop shortcut (dedicated browser profile)." -ForegroundColor White
Write-Host "  Do NOT open your normal Chrome/Edge — the extension will not load there." -ForegroundColor White
Write-Host "  Log into Ephesoft inside this dedicated profile on first use." -ForegroundColor White
if ($PackagedZip) {
    Write-Host "  Installed: obfuscated production build." -ForegroundColor Green
} else {
    Write-Host "  Installed: source build (re-run with Node.js for obfuscated build)." -ForegroundColor Yellow
}
if ($CreatedShortcuts -gt 0) {
    Write-Host ""
    Write-Host "Double-click a desktop shortcut to start." -ForegroundColor White
} else {
    Write-Host ""
    Write-Host "No browser found — load manually: chrome://extensions > Load unpacked > $InstallDir" -ForegroundColor Yellow
}
Write-Host "==================================================" -ForegroundColor Green

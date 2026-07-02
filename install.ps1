# Ephesoft Copilot - 1-Click PowerShell Bootstrap Installer
#
# Downloads the repo, installs the extension to %LOCALAPPDATA%, and creates
# desktop shortcuts that launch Chrome/Edge with a dedicated profile.
#
# Recommended (avoids irm|iex quirks):
#   $u='https://raw.githubusercontent.com/vedaankb/Ephesoft-copilot/main/install.ps1'
#   $f="$env:TEMP\ephesoft-install.ps1"; iwr $u -OutFile $f -UseBasicParsing; & $f
#
# One-liner alternative:
#   iex (& ([Net.WebClient]::new()).DownloadString('https://raw.githubusercontent.com/vedaankb/Ephesoft-copilot/main/install.ps1'))

$ErrorActionPreference = 'Stop'

function Ensure-WindowsEnv {
    if (-not $env:USERPROFILE) {
        throw 'USERPROFILE is not set. Open a normal user PowerShell window and retry.'
    }
    if (-not $env:LOCALAPPDATA) {
        $env:LOCALAPPDATA = [System.IO.Path]::Combine($env:USERPROFILE, 'AppData', 'Local')
    }
    if (-not $env:TEMP) {
        $env:TEMP = [System.IO.Path]::GetTempPath().TrimEnd('\')
    }
}

function Get-EphesoftInstallPaths {
    Ensure-WindowsEnv
    $installDir = [System.IO.Path]::Combine($env:LOCALAPPDATA, 'EphesoftCopilot')
    $profileDir = [System.IO.Path]::Combine($installDir, 'profile')
    return @{ InstallDir = $installDir; ProfileDir = $profileDir }
}

function Find-BrowserPath {
    param([string[]]$Candidates)
    foreach ($p in $Candidates) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

function Get-ChromePath {
    Ensure-WindowsEnv
    return Find-BrowserPath @(
        'C:\Program Files\Google\Chrome\Application\chrome.exe',
        'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
        ([System.IO.Path]::Combine($env:LOCALAPPDATA, 'Google\Chrome\Application\chrome.exe'))
    )
}

function Get-EdgePath {
    Ensure-WindowsEnv
    return Find-BrowserPath @(
        'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
        ([System.IO.Path]::Combine($env:LOCALAPPDATA, 'Microsoft\Edge\Application\msedge.exe'))
    )
}

function Get-ExtensionLaunchArgs {
    param([string]$InstallDir, [string]$ProfileDir)
    return "--load-extension=`"$InstallDir`" --user-data-dir=`"$ProfileDir`" --no-first-run --no-default-browser-check"
}

function New-EphesoftShortcut {
    param(
        [string]$ShortcutName,
        [string]$BrowserPath,
        [string]$Arguments,
        [string]$DesktopPath
    )
    $shortcutPath = [System.IO.Path]::Combine($DesktopPath, "$ShortcutName.lnk")
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut($shortcutPath)
    $lnk.TargetPath = $BrowserPath
    $lnk.Arguments = $Arguments
    $lnk.WorkingDirectory = $env:USERPROFILE
    $lnk.Description = 'Launch browser with Ephesoft Copilot (dedicated profile)'
    $lnk.IconLocation = "$BrowserPath,0"
    $lnk.Save()
}

function Remove-IfExists {
    param([string]$Target)
    if ($Target -and (Test-Path -LiteralPath $Target)) {
        Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# --- main ---
Ensure-WindowsEnv

Write-Host '==================================================' -ForegroundColor Cyan
Write-Host '          EPHESOFT COPILOT INSTALLER              ' -ForegroundColor Cyan
Write-Host '==================================================' -ForegroundColor Cyan
Write-Host 'Installing Ephesoft Copilot (V2 Pure Extension)...' -ForegroundColor Yellow

$paths = Get-EphesoftInstallPaths
$InstallDir = $paths.InstallDir
$ProfileDir = $paths.ProfileDir
$TempZip = [System.IO.Path]::Combine($env:TEMP, 'ephesoft-copilot-temp.zip')
$TempExtract = [System.IO.Path]::Combine($env:TEMP, 'ephesoft-copilot-temp-extract')
$StagingDir = [System.IO.Path]::Combine($env:TEMP, 'ephesoft-copilot-staging')
$RepoZipUrl = 'https://github.com/vedaankb/Ephesoft-copilot/archive/refs/heads/main.zip'

Remove-IfExists $TempZip
Remove-IfExists $TempExtract
Remove-IfExists $StagingDir

Write-Host 'Downloading latest version from GitHub...' -ForegroundColor Yellow
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $RepoZipUrl -OutFile $TempZip -UseBasicParsing
} catch {
    Write-Host 'ERROR: Failed to download. Check internet/proxy settings.' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $TempZip)) {
    Write-Host 'ERROR: Download did not create a zip file.' -ForegroundColor Red
    exit 1
}

Write-Host 'Extracting repository...' -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $TempExtract | Out-Null
Expand-Archive -LiteralPath $TempZip -DestinationPath $TempExtract -Force

$RepoRoot = [System.IO.Path]::Combine($TempExtract, 'Ephesoft-copilot-main')
if (-not (Test-Path -LiteralPath $RepoRoot)) {
    Write-Host 'ERROR: Unexpected zip layout — Ephesoft-copilot-main folder not found.' -ForegroundColor Red
    exit 1
}

# Build obfuscated package when Node.js is available.
$PackagedZip = $null
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($NodeCmd) {
    Write-Host 'Building obfuscated extension package (Node.js detected)...' -ForegroundColor Yellow
    Push-Location -LiteralPath $RepoRoot
    try {
        npm install --silent 2>$null
        node scripts/generate_icons.js 2>$null
        node scripts/package_extension.js
        $manifestPath = [System.IO.Path]::Combine($RepoRoot, 'extension', 'manifest.json')
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $ver = if ($manifest.version) { $manifest.version } else { '0.0.0' }
        $candidate = [System.IO.Path]::Combine($RepoRoot, "dist\ephesoft-copilot-extension-v$ver.zip")
        if (Test-Path -LiteralPath $candidate) { $PackagedZip = $candidate }
    } catch {
        Write-Host 'WARNING: Obfuscated build failed — falling back to source extension.' -ForegroundColor Yellow
    } finally {
        Pop-Location
    }
} else {
    Write-Host 'Node.js not found — installing source extension (unobfuscated).' -ForegroundColor Yellow
}

Write-Host 'Installing extension files...' -ForegroundColor Yellow
Remove-IfExists $StagingDir
New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null

if ($PackagedZip) {
    Expand-Archive -LiteralPath $PackagedZip -DestinationPath $StagingDir -Force
} else {
    $ExtSource = [System.IO.Path]::Combine($RepoRoot, 'extension')
    $manifestCheck = [System.IO.Path]::Combine($ExtSource, 'manifest.json')
    if (-not (Test-Path -LiteralPath $manifestCheck)) {
        Write-Host 'ERROR: extension folder not found in downloaded repo.' -ForegroundColor Red
        exit 1
    }
    # Copy contents of extension/ into staging (not the folder itself).
    Get-ChildItem -LiteralPath $ExtSource | Copy-Item -Destination $StagingDir -Recurse -Force
}

Remove-IfExists $InstallDir
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Get-ChildItem -LiteralPath $StagingDir | Copy-Item -Destination $InstallDir -Recurse -Force

Remove-IfExists $StagingDir
Remove-IfExists $TempZip
Remove-IfExists $TempExtract
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$ChromePath = Get-ChromePath
$EdgePath = Get-EdgePath
$LaunchArgs = Get-ExtensionLaunchArgs -InstallDir $InstallDir -ProfileDir $ProfileDir
$DesktopPath = [System.Environment]::GetFolderPath('Desktop')

$CreatedShortcuts = 0
if ($ChromePath) {
    Write-Host 'Creating Google Chrome desktop shortcut...' -ForegroundColor Yellow
    New-EphesoftShortcut -ShortcutName 'Ephesoft Copilot (Chrome)' -BrowserPath $ChromePath -Arguments $LaunchArgs -DesktopPath $DesktopPath
    $CreatedShortcuts++
} else {
    Write-Host 'Google Chrome not found — skipping Chrome shortcut.' -ForegroundColor Gray
}

if ($EdgePath) {
    Write-Host 'Creating Microsoft Edge desktop shortcut...' -ForegroundColor Yellow
    New-EphesoftShortcut -ShortcutName 'Ephesoft Copilot (Edge)' -BrowserPath $EdgePath -Arguments $LaunchArgs -DesktopPath $DesktopPath
    $CreatedShortcuts++
} else {
    Write-Host 'Microsoft Edge not found — skipping Edge shortcut.' -ForegroundColor Gray
}

Write-Host ''
Write-Host '==================================================' -ForegroundColor Green
Write-Host '    SUCCESS: Ephesoft Copilot Installed!          ' -ForegroundColor Green
Write-Host '==================================================' -ForegroundColor Green
Write-Host "Extension:  $InstallDir" -ForegroundColor White
Write-Host "Profile:    $ProfileDir" -ForegroundColor White
Write-Host ''
Write-Host 'IMPORTANT:' -ForegroundColor Yellow
Write-Host '  Always launch via the desktop shortcut (dedicated browser profile).' -ForegroundColor White
Write-Host '  Log into Ephesoft inside this dedicated profile on first use.' -ForegroundColor White
if ($CreatedShortcuts -gt 0) {
    Write-Host ''
    Write-Host 'Double-click a desktop shortcut to start.' -ForegroundColor White
} else {
    Write-Host ''
    Write-Host "No browser found — load manually: chrome://extensions > Load unpacked > $InstallDir" -ForegroundColor Yellow
}
Write-Host '==================================================' -ForegroundColor Green

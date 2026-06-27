# Shared helpers for Ephesoft Copilot Windows installers.
# Dot-source from install.ps1 or copilot-launcher embedded blocks.

function Get-EphesoftInstallPaths {
    $InstallDir = Join-Path $env:LOCALAPPDATA 'EphesoftCopilot'
    $ProfileDir = Join-Path $InstallDir 'profile'
    return @{ InstallDir = $InstallDir; ProfileDir = $ProfileDir }
}

function Find-BrowserPath {
    param([string[]]$Candidates)
    foreach ($p in $Candidates) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Get-ChromePath {
    return Find-BrowserPath @(
        'C:\Program Files\Google\Chrome\Application\chrome.exe',
        'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
}

function Get-EdgePath {
    return Find-BrowserPath @(
        'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
    )
}

function Test-BrowserUsingProfile {
    param([string]$ProfileDir, [string]$ProcessName)
    $procs = Get-CimInstance Win32_Process -Filter "Name='$ProcessName'" -ErrorAction SilentlyContinue
    foreach ($proc in $procs) {
        if ($proc.CommandLine -and $proc.CommandLine -like "*$ProfileDir*") {
            return $true
        }
    }
    return $false
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
    $ShortcutPath = Join-Path $DesktopPath "$ShortcutName.lnk"
    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = $BrowserPath
    $Shortcut.Arguments = $Arguments
    $Shortcut.WorkingDirectory = $env:USERPROFILE
    $Shortcut.Description = 'Launch browser with Ephesoft Copilot (dedicated profile)'
    $Shortcut.IconLocation = "$BrowserPath,0"
    $Shortcut.Save()
}

function Expand-ZipToDirectory {
    param([string]$ZipPath, [string]$DestDir)
    if (Test-Path $DestDir) {
        Remove-Item -Path $DestDir -Recurse -Force -ErrorAction Stop
    }
    New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
    Expand-Archive -Path $ZipPath -DestinationPath $DestDir -Force
}

function Install-ExtensionFromFolder {
    param([string]$SourceDir, [string]$InstallDir)
    if (-not (Test-Path (Join-Path $SourceDir 'manifest.json'))) {
        throw "Source folder is missing manifest.json: $SourceDir"
    }
    if (Test-Path $InstallDir) {
        Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Copy-Item -Path $SourceDir -Destination $InstallDir -Recurse -Force
}

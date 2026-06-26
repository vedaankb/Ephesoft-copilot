@echo off
:: Ephesoft Copilot - 1-Click Offline Desktop Launcher
::
:: This script installs the extension locally from the offline folder to the
:: user's local app data directory, then creates desktop shortcuts for Chrome and Edge.

title Ephesoft Copilot Launcher
color 0B
cls

echo ==================================================
echo          EPHESOFT COPILOT LAUNCHER
echo ==================================================
echo Installing Ephesoft Copilot locally (offline)...
echo.

set "INSTALL_DIR=%LOCALAPPDATA%\EphesoftCopilot"
set "SRC_DIR=%~dp0"

:: Check if manifest.json exists in the current directory to verify we are in the extension folder
if not exist "%SRC_DIR%manifest.json" (
    color 0C
    echo ERROR: Launcher must be run from inside the "extension" folder.
    echo Please do not move this file out of the "extension" directory.
    echo.
    pause
    exit /b 1
)

:: Create install directory and copy files
echo Copying extension files to local AppData...
if exist "%INSTALL_DIR%" (
    rmdir /s /q "%INSTALL_DIR%" >nul 2>&1
)
mkdir "%INSTALL_DIR%" >nul 2>&1
xcopy /E /I /Y "%SRC_DIR%*" "%INSTALL_DIR%\" >nul

if errorlevel 1 (
    color 0C
    echo ERROR: Failed to copy extension files.
    echo.
    pause
    exit /b 1
)

:: Create Desktop Shortcuts via robust inline PowerShell
echo Creating Desktop Shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$InstallDir = '%INSTALL_DIR%'; ^
     $DesktopPath = [System.IO.Path]::Combine([System.Environment]::GetFolderPath('Desktop'), ''); ^
     $WshShell = New-Object -ComObject WScript.Shell; ^
     function Create-Shortcut($name, $browser, $args) { ^
         $ShortcutPath = Join-Path $DesktopPath ($name + '.lnk'); ^
         $Shortcut = $WshShell.CreateShortcut($ShortcutPath); ^
         $Shortcut.TargetPath = $browser; ^
         $Shortcut.Arguments = $args; ^
         $Shortcut.WorkingDirectory = $env:USERPROFILE; ^
         $Shortcut.IconLocation = ($browser + ',0'); ^
         $Shortcut.Save(); ^
     }; ^
     $ChromePaths = @( ^
         'C:\Program Files\Google\Chrome\Application\chrome.exe', ^
         'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe', ^
         '$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe' ^
     ); ^
     $EdgePaths = @( ^
         'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', ^
         'C:\Program Files\Microsoft\Edge\Application\msedge.exe', ^
         '$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe' ^
     ); ^
     $ChromePath = $null; foreach ($p in $ChromePaths) { if (Test-Path $p) { $ChromePath = $p; break } }; ^
     $EdgePath = $null; foreach ($p in $EdgePaths) { if (Test-Path $p) { $EdgePath = $p; break } }; ^
     $created = 0; ^
     if ($ChromePath) { ^
         Create-Shortcut 'Ephesoft Copilot (Chrome)' $ChromePath ('--load-extension=\"' + $InstallDir + '\" --no-first-run'); ^
         $created++; ^
     }; ^
     if ($EdgePath) { ^
         Create-Shortcut 'Ephesoft Copilot (Edge)' $EdgePath ('--load-extension=\"' + $InstallDir + '\" --no-first-run'); ^
         $created++; ^
     }; ^
     if ($created -eq 0) { ^
         Write-Warning 'No supported browser found.'; ^
     }"

echo.
color 0A
echo ==================================================
echo    SUCCESS: Ephesoft Copilot Installed!
echo ==================================================
echo The extension has been installed to:
echo   %INSTALL_DIR%
echo.
echo Desktop shortcuts have been created for available browsers.
echo Double-click a shortcut to launch with the Copilot preloaded.
echo ==================================================
echo.
pause

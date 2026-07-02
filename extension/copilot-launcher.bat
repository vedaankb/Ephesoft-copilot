@echo off
:: Ephesoft Copilot - 1-Click Offline Desktop Launcher
::
:: Copies the extension to AppData and creates desktop shortcuts that launch
:: Chrome/Edge with a dedicated profile so --load-extension is always honored.

title Ephesoft Copilot Launcher
color 0B
cls

echo ==================================================
echo          EPHESOFT COPILOT LAUNCHER
echo ==================================================
echo Installing Ephesoft Copilot locally (offline)...
echo.

set "INSTALL_DIR=%LOCALAPPDATA%\EphesoftCopilot"
set "PROFILE_DIR=%LOCALAPPDATA%\EphesoftCopilot\profile"
set "SRC_DIR=%~dp0"

if not exist "%SRC_DIR%manifest.json" (
    color 0C
    echo ERROR: Launcher must be run from inside the "extension" folder.
    echo.
    pause
    exit /b 1
)

:: Versioned-folder install: copy into a fresh app-<timestamp> folder so upgrades never
:: need to delete files a running browser has locked. The profile persists across upgrades.
set "STAMP=%DATE:~-4%%DATE:~4,2%%DATE:~7,2%%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%"
set "STAMP=%STAMP: =0%"
set "APP_DIR=%INSTALL_DIR%\app-%STAMP%"

echo Copying extension files to local AppData...
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%" >nul 2>&1
mkdir "%APP_DIR%" >nul 2>&1
xcopy /E /I /Y "%SRC_DIR%*" "%APP_DIR%\" >nul

if errorlevel 1 (
    color 0C
    echo ERROR: Failed to copy extension files.
    echo.
    pause
    exit /b 1
)

if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%" >nul 2>&1

:: Best-effort cleanup of older app-* folders (locked ones are skipped harmlessly).
for /d %%D in ("%INSTALL_DIR%\app-*") do (
    if /I not "%%~fD"=="%APP_DIR%" rmdir /s /q "%%~fD" >nul 2>&1
)

echo Creating Desktop Shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$InstallDir = '%APP_DIR%'; ^
     $ProfileDir = '%PROFILE_DIR%'; ^
     $LaunchArgs = '--load-extension=\"' + $InstallDir + '\" --user-data-dir=\"' + $ProfileDir + '\" --no-first-run --no-default-browser-check'; ^
     $DesktopPath = [System.IO.Path]::Combine([System.Environment]::GetFolderPath('Desktop'), ''); ^
     $WshShell = New-Object -ComObject WScript.Shell; ^
     function Create-Shortcut($name, $browser, $args) { ^
         $ShortcutPath = Join-Path $DesktopPath ($name + '.lnk'); ^
         $Shortcut = $WshShell.CreateShortcut($ShortcutPath); ^
         $Shortcut.TargetPath = $browser; ^
         $Shortcut.Arguments = $args; ^
         $Shortcut.WorkingDirectory = $env:USERPROFILE; ^
         $Shortcut.IconLocation = ($browser + ',0'); ^
         $Shortcut.Description = 'Launch browser with Ephesoft Copilot (dedicated profile)'; ^
         $Shortcut.Save(); ^
     }; ^
     $ChromePaths = @( ^
         'C:\Program Files\Google\Chrome\Application\chrome.exe', ^
         'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe', ^
         (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe') ^
     ); ^
     $EdgePaths = @( ^
         'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', ^
         'C:\Program Files\Microsoft\Edge\Application\msedge.exe', ^
         (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe') ^
     ); ^
     $ChromePath = $null; foreach ($p in $ChromePaths) { if (Test-Path $p) { $ChromePath = $p; break } }; ^
     $EdgePath = $null; foreach ($p in $EdgePaths) { if (Test-Path $p) { $EdgePath = $p; break } }; ^
     $created = 0; ^
     if ($ChromePath) { Create-Shortcut 'Ephesoft Copilot (Chrome)' $ChromePath $LaunchArgs; $created++ }; ^
     if ($EdgePath) { Create-Shortcut 'Ephesoft Copilot (Edge)' $EdgePath $LaunchArgs; $created++ }; ^
     if ($created -eq 0) { Write-Warning 'No supported browser found.' }"

echo.
color 0A
echo ==================================================
echo    SUCCESS: Ephesoft Copilot Installed!
echo ==================================================
echo Extension:  %APP_DIR%
echo Profile:    %PROFILE_DIR%
echo.
echo IMPORTANT:
echo   Always use the desktop shortcut (dedicated browser profile).
echo   Log into Ephesoft inside this profile on first use.
echo ==================================================
echo.
pause

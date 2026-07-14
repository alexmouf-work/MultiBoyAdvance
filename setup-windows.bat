@echo off
setlocal EnableExtensions
title MultiBoyAdvance setup
cd /d "%~dp0"

echo ============================================================
echo  MultiBoyAdvance - one-shot Windows setup  (script v3)
echo  Steps: admin check / self-update / Node.js / dependencies /
echo         tests / ROM build (optional, WSL2) / firewall / launch
echo ============================================================
echo.

:: ---------- [0/6] elevate if needed (winget, wsl, firewall) ----------
net session >nul 2>&1
if errorlevel 1 (
    echo [0/6] Requesting administrator rights...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b 0
)
echo [0/6] Running as administrator. OK.

:: ---------- [0.5/6] self-update so fixes land without manual git pull ----------
where git >nul 2>&1
if not errorlevel 1 (
    git pull --ff-only 2>nul | findstr /C:"Updating" >nul
    if not errorlevel 1 (
        echo [0.5/6] Repo updated from origin - restarting with the new script...
        echo.
        "%~f0"
        exit /b
    )
    echo [0.5/6] Repo is up to date. OK.
) else (
    echo [0.5/6] git not found - skipping self-update.
)

:: ---------- [1/6] Node.js ----------
where node >nul 2>&1
if not errorlevel 1 goto node_ok
echo [1/6] Node.js not found - installing LTS via winget...
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%PATH%"
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo   Node.js was installed but is not on PATH in this console yet.
    echo   Close this window and run setup-windows.bat again.
    pause
    exit /b 1
)
:node_ok
for /f "delims=" %%v in ('node --version') do echo [1/6] Node.js %%v. OK.

:: ---------- [2/6] install dependencies ----------
echo [2/6] Installing server dependencies...
pushd server
call npm install --no-audit --no-fund
if errorlevel 1 goto npm_fail
popd
echo [2/6] Installing web client dependencies (vendors the mGBA-WASM core)...
pushd web
call npm install --no-audit --no-fund
if errorlevel 1 goto npm_fail
popd
echo [2/6] Dependencies installed. OK.

:: ---------- [3/6] verify with the server test suite ----------
echo [3/6] Running server tests (normally ^<10 seconds)...
echo       NOTE: clicking inside this window pauses it (Windows QuickEdit).
echo       If it looks frozen and the title bar says "Select", press Esc.
pushd server
call npm test > "%TEMP%\mba-server-tests.log" 2>&1
if errorlevel 1 (
    popd
    echo   Server tests FAILED. Last 25 lines of %TEMP%\mba-server-tests.log:
    echo   ------------------------------------------------------------
    powershell -NoProfile -Command "Get-Content -Tail 25 \"$env:TEMP\mba-server-tests.log\""
    echo   ------------------------------------------------------------
    pause
    exit /b 1
)
popd
echo [3/6] Server tests green. OK.

:: ---------- [4/6] ROM build (optional; needs WSL2) ----------
if exist rom\build\mba.gba (
    echo [4/6] rom\build\mba.gba already exists - skipping ROM build.
    goto firewall
)
choice /C YN /M "[4/6] Build the game ROM now (needs WSL2 Ubuntu, ~10 min first run)"
if errorlevel 2 (
    echo       Skipped. Build later with scripts\build-rom.ps1 - demo mode works without it.
    goto firewall
)
:: Real readiness check: can a distro actually run a command? (wsl.exe exits
:: 0 even when the platform is installed but no distribution is.)
wsl -e /bin/true >nul 2>&1
if not errorlevel 1 goto wsl_ready

echo       No working WSL distribution found. Setting one up automatically:
echo       - updating the WSL platform...
wsl --update >nul 2>&1
echo       - distributions available online:
wsl --list --online 2>nul
echo.
echo       - installing Ubuntu (one time, ~2 GB download, no prompts)...
wsl --install -d Ubuntu --no-launch 2>nul
if errorlevel 1 (
    echo         --no-launch not supported by this wsl.exe; retrying plain install...
    wsl --install -d Ubuntu
)
:: Initialize headlessly (as root; no username prompt needed for building).
wsl -d Ubuntu -u root -- true >nul 2>&1
if not errorlevel 1 goto wsl_ready
:: Maybe the distro registered under a versioned name (e.g. Ubuntu-24.04):
:: fall back to whatever the default distro is now.
wsl -e /bin/true >nul 2>&1
if not errorlevel 1 goto wsl_ready
echo.
echo       Ubuntu is installed but not runnable yet - Windows usually needs a
echo       REBOOT to finish WSL setup. After rebooting, run setup-windows.bat
echo       again: it skips everything already done and continues from the ROM
echo       build. If it still fails after a reboot, run "wsl --install -d Ubuntu"
echo       by hand and see docs\SETUP-WINDOWS.md section 2.
pause
exit /b 0
:wsl_ready
echo       Installing build tools inside WSL (no password needed)...
wsl -u root -- bash -lc "apt-get update -qq && apt-get install -y -qq build-essential git libpng-dev gcc-arm-none-eabi binutils-arm-none-eabi"
if errorlevel 1 (
    echo       Failed to install WSL build tools. See docs\SETUP-WINDOWS.md section 2.
    pause
    exit /b 1
)
echo       Building the ROM (clones pokeemerald, applies hooks, compiles)...
wsl -- bash -lc "cd \"$(wslpath -a '%~dp0rom')\" && ./setup.sh"
if not exist rom\build\mba.gba (
    echo       ROM build did not produce rom\build\mba.gba. See rom\README.md.
    pause
    exit /b 1
)
echo [4/6] ROM built: rom\build\mba.gba. OK.

:firewall
:: ---------- [5/6] firewall ----------
echo [5/6] Allowing ports 8484 (web/ws) and 8485 (desktop mGBA bridge)...
powershell -NoProfile -Command "if (-not (Get-NetFirewallRule -DisplayName 'MultiBoyAdvance' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'MultiBoyAdvance' -Direction Inbound -Protocol TCP -LocalPort 8484,8485 -Action Allow | Out-Null; Write-Host '      Rule created.' } else { Write-Host '      Rule already exists.' }"

:: ---------- [6/6] launch ----------
echo [6/6] Starting the server (Ctrl+C to stop; run scripts\start-server.ps1 next time)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-server.ps1
pause
exit /b 0

:npm_fail
popd
echo   npm install failed - check your internet connection and retry.
pause
exit /b 1

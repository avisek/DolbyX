@echo off
setlocal
title DolbyX - Windows setup
echo.
echo   DolbyX - one-time WSL2 engine setup
echo   ===================================
echo.

rem The daemon runs natively on Windows and relays the ARM engine into
rem WSL2 (`wsl.exe --exec qemu-arm-static ...`, issue #20). This script
rem stages the engine at /opt/dolbyx/engine inside the default distro
rem and health-checks the exact invocation the daemon spawns. WSL2 is a
rem v2.0 requirement only - the v2.1 Unicorn backend drops it.
rem Layout + dev loop: docs/windows.md.

rem [1/4] a bootable default WSL distro
wsl.exe -e true >nul 2>nul
if errorlevel 1 (
    echo ERROR: WSL2 has no bootable default distro.
    echo   Install one first:  wsl --install -d Ubuntu   ^(then reboot^)
    goto :fail
)
echo   [1/4] WSL distro OK

rem [2/4] qemu-arm-static inside the distro
wsl.exe -e qemu-arm-static --version >nul 2>nul
if errorlevel 1 (
    echo   [2/4] installing qemu-user-static...
    wsl.exe -u root -e sh -c "apt-get update -qq && apt-get install -y -qq qemu-user-static"
    wsl.exe -e qemu-arm-static --version >nul 2>nul
    if errorlevel 1 (
        echo ERROR: could not install qemu-arm-static ^(non-apt distro?^).
        echo   Install it inside your distro, then re-run this script.
        goto :fail
    )
)
echo   [2/4] qemu-arm-static OK

rem [3/4] engine files -> /opt/dolbyx/engine. Source: engine\ beside
rem this script (release package), else the repo's `just windows-build`
rem staging (dev machine).
set "SRC=%~dp0engine"
if not exist "%SRC%\ddp-engine-arm" set "SRC=%~dp0..\target\windows\engine"
if not exist "%SRC%\ddp-engine-arm" (
    echo ERROR: no engine files found beside this script.
    echo   Dev machine: run `just windows-build` in WSL first.
    goto :fail
)
for /f "usebackq tokens=*" %%p in (`wsl.exe -e wslpath -u "%SRC%"`) do set "SRC_WSL=%%p"
if not defined SRC_WSL (
    echo ERROR: wslpath could not map "%SRC%" into WSL.
    goto :fail
)
wsl.exe -u root -e sh -c "mkdir -p /opt/dolbyx/engine && cp -f '%SRC_WSL%'/ddp-engine-arm '%SRC_WSL%'/*.so /opt/dolbyx/engine/ && chmod -R u=rwX,go=rX /opt/dolbyx"
if errorlevel 1 (
    echo ERROR: copy into /opt/dolbyx/engine failed.
    goto :fail
)
echo   [3/4] engine installed to /opt/dolbyx/engine ^(from %SRC%^)

rem [4/4] health check: the daemon's spawn verbatim; EOF on stdin makes
rem a healthy shim load libdseffect.so and exit 0.
wsl.exe -e sh -c "qemu-arm-static -E LD_LIBRARY_PATH=/opt/dolbyx/engine -L /usr/arm-linux-gnueabihf /opt/dolbyx/engine/ddp-engine-arm < /dev/null" 2>nul
if errorlevel 1 (
    echo ERROR: engine health check failed.
    echo   Debug inside WSL:
    echo   LD_LIBRARY_PATH=/opt/dolbyx/engine qemu-arm-static -L /usr/arm-linux-gnueabihf /opt/dolbyx/engine/ddp-engine-arm
    goto :fail
)
echo   [4/4] health check OK - libdseffect.so loads under qemu in WSL2

echo.
echo   Done. Start ddp-daemon.exe and open http://localhost:9876
echo   ^(state lands in %%PROGRAMDATA%%\DolbyX\config.toml^)
pause
exit /b 0

:fail
echo.
pause
exit /b 1

@echo off
title DolbyX
echo.
echo   DolbyX Launcher
echo   ================
echo.

for /f "tokens=*" %%u in ('wsl.exe whoami 2^>nul') do set WSL_USER=%%u
if "%WSL_USER%"=="" (
    echo ERROR: WSL2 not available.
    pause
    exit /b 1
)
echo   WSL user: %WSL_USER%
set DDP_PATH=/home/%WSL_USER%/DolbyX/arm
echo   DDP path: %DDP_PATH%
echo.

cd /d C:\
wsl.exe -- bash -c "cd /mnt/c && ~/DolbyX/daemon/dolbyx.exe %DDP_PATH%"
pause

@echo off
title DolbyX Bridge
echo.
echo   DolbyX Bridge Launcher
echo   ======================
echo.

:: Detect WSL username
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

:: Run bridge using wsl.exe to access the exe from WSL filesystem
cd /d C:\
wsl.exe -- bash -c "cd /mnt/c && ~/DolbyX/windows/dolbyx-bridge.exe %DDP_PATH%"
pause

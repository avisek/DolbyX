@echo off
REM ═══════════════════════════════════════════════════════════════════
REM build_vst.bat — Build DolbyDDP.dll VST plugin
REM
REM Option A: From WSL2 (using MinGW cross-compiler)
REM   wsl bash -c "cd windows && x86_64-w64-mingw32-gcc -shared -O2 -o DolbyDDP.dll ddp_vst.c -static"
REM
REM Option B: From MSVC Developer Command Prompt
REM   Run this batch file from x64 Native Tools Command Prompt
REM ═══════════════════════════════════════════════════════════════════

echo Building DolbyDDP.dll ...

where cl >nul 2>nul
if %errorlevel%==0 (
    echo Using MSVC...
    cl /LD /O2 /W3 ddp_vst.c /Fe:DolbyDDP.dll /link /DEF:ddp_vst.def
) else (
    echo MSVC not found. Please run from x64 Native Tools Command Prompt.
    echo.
    echo Alternative: build from WSL2 with MinGW:
    echo   sudo apt install gcc-mingw-w64-x86-64
    echo   x86_64-w64-mingw32-gcc -shared -O2 -o DolbyDDP.dll ddp_vst.c -static
    exit /b 1
)

echo.
echo Done! Copy DolbyDDP.dll to your EqualizerAPO VSTPlugins folder:
echo   C:\Program Files\EqualizerAPO\VSTPlugins\DolbyDDP.dll
echo.
echo And create ddp_config.ini next to it.

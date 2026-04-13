@echo off
echo Building DolbyDDP.dll (TCP mode)...
where cl >nul 2>nul
if %errorlevel%==0 (
    cl /LD /O2 ddp_vst.c /Fe:DolbyDDP.dll ws2_32.lib
) else (
    echo Use MinGW from WSL2:
    echo   x86_64-w64-mingw32-gcc -shared -O2 -o DolbyDDP.dll ddp_vst.c -lws2_32 -static
)

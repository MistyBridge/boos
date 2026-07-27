@echo off
setlocal
cd /d "%~dp0"

set BOOS_DEV=1
set BOOS_KEEP_ALIVE=1

echo === BOOS v1.1.0 ===
echo.

:: Kill old BOOS on port 7780
echo [1/2] Stopping old BOOS...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":7780 " ^| findstr "LISTENING"') do (
    echo   Killing PID %%a...
    taskkill /f /pid %%a 2>nul >nul
)

:: Remove stale lock file
if exist "%USERPROFILE%\.boos\port.lock" (
    del "%USERPROFILE%\.boos\port.lock" 2>nul
)

:: Brief wait
ping -n 3 127.0.0.1 >nul

:: Start server
echo [2/2] Starting server...
echo.
echo   http://localhost:7780/
echo   MCP: http://127.0.0.1:7780/mcp/sse
echo.

node server.js
pause

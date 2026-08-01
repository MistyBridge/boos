@echo off
setlocal
cd /d "%~dp0"

set BOOS_KEEP_ALIVE=1

echo === BOOS v1.1.0 ===
echo.

echo Starting server...
echo.

node server.js
pause

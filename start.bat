@echo off
title BOOS Dashboard
cd /d "%~dp0"

set "BOOS_DEV=1"
set "BOOS_KEEP_ALIVE=1"

echo BOOS Dashboard
echo http://localhost:7780/
echo.
echo Press Ctrl+C to stop.
echo.

node server.js
pause

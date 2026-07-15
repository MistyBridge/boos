@echo off
title BOOS Dashboard
cd /d "%~dp0"

set "BOOS_DEV=1"
set "BOOS_KEEP_ALIVE=1"

echo ==========================================
echo   BOOS Dashboard  v1.0.1
echo ==========================================
echo.
echo   Frontend : http://localhost:7780/
echo   API      : http://localhost:7780/api
echo   Data     : %USERPROFILE%\.boos\
echo.
echo.
echo Press Ctrl+C to stop.
echo.

node server.js
pause

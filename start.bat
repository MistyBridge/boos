@echo off
title BOOS Dashboard
cd /d "%~dp0"

REM Dev mode: serve frontend from public/, hot-reload enabled.
set "BOOS_DEV=1"
REM Keep the server alive even when no browser window is open.
set "BOOS_KEEP_ALIVE=1"

REM BOOS_HOME defaults to ~/.boos — do NOT override unless you
REM intentionally want a separate data directory for this project.
REM To isolate data: uncomment the next line.
REM set "BOOS_HOME=%~dp0.boos-data"

echo ==========================================
echo   BOOS Dashboard
echo   Project : %~dp0
echo   Data    : %BOOS_HOME% ^(default: ~/.boos^)
echo ==========================================
echo.
echo Starting server (dev mode, frontend + backend)...
echo The server will print the URL once started.
echo Press Ctrl+C to stop.
echo ==========================================
echo.

node server.js
pause

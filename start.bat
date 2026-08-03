@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo   BOOS v1.2.0 -- Port 7780
echo ========================================
echo.

:: ---- Kill any process on port 7780 ----
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7780" ^| findstr "LISTENING" 2^>nul') do (
    echo [clean] Killing PID %%a on port 7780...
    taskkill /PID %%a /F >nul 2>&1
    timeout /t 2 /nobreak >nul
    echo [clean] PID %%a terminated
    echo.
)

:: ---- Verify port 7780 is free ----
netstat -ano | findstr ":7780" | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [FAIL] Port 7780 still in use. Check manually:
    echo   netstat -ano ^| findstr ":7780"
    pause
    exit /b 1
)

set BOOS_PORT=7780
set BOOS_KEEP_ALIVE=1

echo [start] Launching BOOS on port 7780...
echo.

node server.js

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [FAIL] BOOS failed to start. Check log: %%USERPROFILE%%\.boos\server.log
    pause
    exit /b 1
)

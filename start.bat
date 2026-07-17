@echo off
title BOOS Dashboard
cd /d "%~dp0"

set "BOOS_DEV=1"
set "BOOS_KEEP_ALIVE=1"
set "BOOS_PORT=7780"
set "LOCK=%USERPROFILE%\.boos\port.lock"

echo ==========================================
echo   BOOS Dashboard  v1.0.1
echo ==========================================
echo.

:: ── 1. Kill old instance via port.lock ────────────────────────────
echo [1/3] Stopping old BOOS instance...

if exist "%LOCK%" (
    for /f "tokens=*" %%i in ('powershell -NoProfile -Command "try { (Get-Content '%LOCK%' ^| ConvertFrom-Json).pid } catch { }" 2^>nul') do set "OLD_PID=%%i"
    for /f "tokens=*" %%i in ('powershell -NoProfile -Command "try { (Get-Content '%LOCK%' ^| ConvertFrom-Json).port } catch { }" 2^>nul') do set "OLD_PORT=%%i"

    if not "%OLD_PID%"=="" (
        echo   Stopping PID=%OLD_PID% (was on port %OLD_PORT%)...
        powershell -NoProfile -Command "try { Stop-Process -Id %OLD_PID% -Force -ErrorAction Stop } catch { }" 2>nul
        echo   ^✓ Old process terminated
        timeout /t 2 /nobreak >nul
    ) else (
        echo   - Could not read PID from port.lock, removing stale file
    )
    del "%LOCK%" 2>nul
) else (
    echo   - No previous instance (no port.lock)
)

:: ── 2. Start server ──────────────────────────────────────────────
echo [2/3] Starting BOOS server...
echo.
echo   Frontend : http://localhost:7780/
echo   API      : http://localhost:7780/api
echo   MCP SSE  : http://127.0.0.1:7780/mcp/sse
echo   Lock     : %LOCK%
echo   Data     : %USERPROFILE%\.boos\
echo.
echo [3/3] Server running. Press Ctrl+C to stop.
echo.

node server.js
pause

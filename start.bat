@echo off
cd /d "%~dp0"

set "BOOS_DEV=1"
set "BOOS_KEEP_ALIVE=1"
set "BOOS_PORT=7780"
set "LOCK=%USERPROFILE%\.boos\port.lock"
set "SERVER=%~dp0server.js"

echo ==========================================
echo   BOOS Dashboard  v1.0.1
echo ==========================================

echo [1/2] Clean up...

:: Kill old instance via port.lock
if exist "%LOCK%" (
    for /f "tokens=*" %%a in ('powershell -NoProfile -Command ^
        "try { $j = Get-Content '%LOCK%' | ConvertFrom-Json; Write-Host $j.pid } catch {}" 2^>nul') do (
        if not "%%a"=="" (
            echo   Killing old instance PID %%a...
            powershell -NoProfile -Command ^
                "try { Invoke-RestMethod 'http://127.0.0.1:7780/api/shutdown' -Method Post -Body '{}' -TimeoutSec 3 } catch {}; Start-Sleep 2"
            taskkill /f /pid %%a 2>nul
        )
    )
    del "%LOCK%" 2>nul
)

:: Kill anything on port 7780
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "7780" ^| findstr "LISTENING" 2^>nul') do (
    echo   Force-freeing port 7780 ^(PID %%a^)...
    taskkill /f /pid %%a 2>nul
)

timeout /t 2 /nobreak >nul

echo [2/2] Starting server...
if not exist "%SERVER%" (
    echo   [ERROR] server.js not found: %SERVER%
    pause
    exit /b 1
)

echo.
echo   http://localhost:7780/
echo   Ctrl+C to stop
echo ==========================================

node "%SERVER%"
pause

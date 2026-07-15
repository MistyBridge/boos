@echo off
setlocal enabledelayedexpansion
title BOOS Dashboard (dev)
cd /d "%~dp0"

REM ── dev mode ──
set "BOOS_DEV=1"
set "BOOS_KEEP_ALIVE=1"

REM ── read port from config ──
set "BOOS_PORT=7780"
if exist "%~dp0.boos-data\config.json" (
  for /f %%a in ('powershell -NoProfile -Command "(Get-Content '%~dp0.boos-data\config.json' -Raw|ConvertFrom-Json).port" 2^>nul') do set "BOOS_PORT=%%a"
)
set "BOOS_PORT=%BOOS_PORT: =%"

echo ==========================================
echo   BOOS Dashboard  v1.0.1  (dev mode)
echo   http://localhost:%BOOS_PORT%/
echo ==========================================
echo.

REM ── graceful shutdown ──
echo [boot] Stopping old BOOS instances...
if exist "%~dp0scripts\stop-old.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-old.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=%BOOS_PORT%;try{$r=irm http://localhost:$p/api/health -TO 1 -UseBasicParsing -ea stop;if($r.StatusCode -eq 200){irm -Method POST http://localhost:$p/api/shutdown -TO 5 -UseBasicParsing|Out-Null;Start-Sleep 2;Write-Host '  Shutdown sent.'}}catch{Write-Host '  No running instance found.'}"
)
echo.

REM ── check node exists ──
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo [ERROR] Node.js not found in PATH.
  echo [ERROR] Please install Node.js or add it to your PATH.
  pause
  exit /b 1
)

echo [boot] Starting BOOS server on port %BOOS_PORT%...
echo [boot] Open http://localhost:%BOOS_PORT%/ in your browser.
echo [boot] Press Ctrl+C to stop.
echo ==========================================
echo.

REM ── background: wait for server ready, then open browser ──
start /min "" powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=%BOOS_PORT%;for($i=0;$i-lt30;$i++){try{$r=irm http://localhost:$p/api/health -TO 1 -UseBasicParsing -ea stop;if($r.StatusCode -eq 200){start http://localhost:$p/;exit}}catch{Start-Sleep 1}}"

REM ── foreground server ──
node server.js

echo.
echo [boot] Server stopped.
pause

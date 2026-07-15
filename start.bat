@echo off
setlocal enabledelayedexpansion
title BOOS Dashboard
cd /d "%~dp0"

REM ── Config ──────────────────────────────────────────────────
set "BOOS_DEV=1"
set "BOOS_KEEP_ALIVE=1"
REM Uncomment to isolate data from ~/.boos:
REM set "BOOS_HOME=%~dp0.boos-data"

echo ==========================================
echo   BOOS Dashboard
echo ==========================================
echo.

REM ── Find running BOOS port ──────────────────────────────────
set "RPORT="
for %%p in (7780 7777 7778 7779 7781 7782 7783 7784 7785 7786) do (
  if "!RPORT!"=="" (
    powershell -NoProfile -Command "try{$null=Invoke-WebRequest -Uri http://localhost:%%p/api/health -TimeoutSec 1 -UseBasicParsing;exit 0}catch{exit 1}" >nul 2>&1
    if !errorlevel! equ 0 set "RPORT=%%p"
  )
)

REM ── Graceful restart if running ─────────────────────────────
if not "!RPORT!"=="" (
  echo [boot] BOOS running on port !RPORT! — shutting down...
  powershell -NoProfile -Command "try{Invoke-WebRequest -Method POST -Uri http://localhost:!RPORT!/api/shutdown -TimeoutSec 10 -UseBasicParsing|Out-Null}catch{}" >nul 2>&1
  echo [boot] Waiting for exit...
  :wait
  timeout /t 2 /nobreak >nul
  powershell -NoProfile -Command "try{$null=Invoke-WebRequest -Uri http://localhost:!RPORT!/api/health -TimeoutSec 1 -UseBasicParsing;exit 1}catch{exit 0}" >nul 2>&1
  if !errorlevel! neq 0 goto :wait
  echo [boot] Old server stopped.
  timeout /t 1 /nobreak >nul
  echo.
)

echo [boot] Starting BOOS (dev mode)...
echo ==========================================
echo.
node server.js
pause

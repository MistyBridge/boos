@echo off
title BOOS Dashboard
cd /d "%~dp0"

REM Dev mode: serve frontend from public/, hot-reload enabled.
set "BOOS_DEV=1"
set "BOOS_KEEP_ALIVE=1"

echo ==========================================
echo   BOOS Dashboard
echo ==========================================
echo.

REM Graceful shutdown of existing BOOS instance (if running).
REM Uses netstat to find node process on known ports, then sends shutdown request.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports = @(7780,7777,7778,7779,7781,7782,7783,7784,7785,7786); "^
  "foreach($p in $ports) { "^
    "try { "^
      "$r = Invoke-WebRequest -Uri \"http://localhost:$p/api/health\" -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop; "^
      "if($r.StatusCode -eq 200) { "^
        "Write-Host \"[boot] Found BOOS on port $p — shutting down...\"; "^
        "Invoke-WebRequest -Method POST -Uri \"http://localhost:$p/api/shutdown\" -TimeoutSec 5 -UseBasicParsing | Out-Null; "^
        "Write-Host \"[boot] Waiting for old server to exit...\"; "^
        "Start-Sleep -Seconds 3; "^
        "$waited = 0; "^
        "while($waited -lt 15) { "^
          "try { Invoke-WebRequest -Uri \"http://localhost:$p/api/health\" -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop | Out-Null } "^
          "catch { break }; "^
          "Start-Sleep -Seconds 1; "^
          "$waited++; "^
        "} "^
        "Write-Host \"[boot] Old server stopped.\"; "^
        "break; "^
      "} "^
    "} "^
    "catch { continue } "^
  "}"

echo [boot] Starting BOOS (dev mode)...
echo ==========================================
echo.

node server.js
pause

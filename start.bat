@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ╔══════════════════════════════════════════╗
echo ║        BOOS v1.2.0 — 端口 7780           ║
echo ╚══════════════════════════════════════════╝
echo.

:: ── 强制释放端口 7780 ──────────────────────────────────
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7780" ^| findstr "LISTENING" 2^>nul') do (
    echo [清理] 发现占用 7780 的 PID %%a — 正在终止...
    taskkill /PID %%a /F >nul 2>&1
    timeout /t 2 /nobreak >nul
    echo [清理] PID %%a 已终止
    echo.
)

:: ── 确认端口 7780 已释放 ──────────────────────────────
netstat -ano | findstr ":7780" | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [失败] 无法释放端口 7780 — 请手动检查并重试
    echo   netstat -ano ^| findstr ":7780"
    pause
    exit /b 1
)

set BOOS_PORT=7780
set BOOS_KEEP_ALIVE=1

echo [启动] BOOS 服务器 (端口 7780)...
echo.

node server.js

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [失败] BOOS 启动失败。查看日志: %USERPROFILE%\.boos\server.log
    pause
    exit /b 1
)

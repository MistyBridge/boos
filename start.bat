@echo off
title BOOS - Project Dashboard

REM 把数据目录设到当前文件夹，实现每个项目独立存档
set BOOS_HOME=%CD%\.boos-data

REM 从当前项目目录启动，claude 会自动找到 CLAUDE.md 和 .claude/
cd /d %CD%

echo ========================================
echo   BOOS Dashboard
echo   Project: %CD%
echo   Data:    %BOOS_HOME%
echo   Port:    7777
echo ========================================
echo.

node "%~dp0server.js"
pause

@echo off
chcp 936 >nul
title 原神杀 - 联机桌游
cd /d "%~dp0"
echo ========================================
echo   原神杀 联机桌游正在启动...
echo ========================================
echo.
start "" "http://localhost:3000"
node server.js
pause
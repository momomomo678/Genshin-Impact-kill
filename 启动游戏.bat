@echo off
chcp 65001 >nul
title 原神杀服务器
cd /d "%~dp0"
echo ========================================
echo   原神杀 联机服务器启动中...
echo ========================================
echo.
echo 本机访问地址: http://localhost:3000
echo 局域网其他设备用本机IP:3000访问
echo.
echo 按 Ctrl+C 关闭服务器
echo ========================================
echo.
:: 延迟2秒后自动打开浏览器
start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"
node server.js
pause
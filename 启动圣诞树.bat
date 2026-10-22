@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动本地服务器...
start "" /min python -m http.server 8765
timeout /t 2 /nobreak >nul
start "" "http://localhost:8765/christmas-tree-gesture.html"

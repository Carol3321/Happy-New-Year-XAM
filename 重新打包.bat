@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   重新打包 main.js  --^>  assets\bundle.js
echo ============================================
echo.

rem three.js / mediapipe 依赖在 assets\lib\node_modules，这里用目录联接让 esbuild 能找到
if not exist "node_modules\three" (
  if exist "node_modules" rmdir "node_modules" >nul 2>nul
  mklink /J node_modules assets\lib\node_modules >nul
  if errorlevel 1 (
    echo [错误] 无法创建 node_modules 联接，请用管理员身份重试。
    pause
    exit /b 1
  )
)

if not exist "tools\esbuild.exe" (
  echo [错误] 找不到 tools\esbuild.exe
  pause
  exit /b 1
)

tools\esbuild.exe main.js --bundle --minify --format=esm --target=chrome100 --legal-comments=eof --outfile=assets\bundle.js
if errorlevel 1 (
  echo.
  echo [错误] 打包失败，请查看上面的提示。
  pause
  exit /b 1
)

echo.
echo 打包完成，刷新浏览器（Ctrl+F5）即可看到效果。
pause

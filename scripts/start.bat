@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [baize] 没找到 node。请先安装 Node.js 22 LTS：https://nodejs.org/
  pause
  exit /b 1
)

if not exist ".env" (
  echo [baize] 没找到 .env。
  echo         先执行：copy .env.example .env
  echo         再用记事本把 OPENCODE_GO_API_KEY 填上（步骤见 docs\windows.md）
  pause
  exit /b 1
)

echo [baize] 启动中…… 关闭此窗口即停止服务。
echo [baize] OCS 的题库配置直接粘贴 contract\answerer.json 的内容。
echo.
node src\server.mjs
echo.
echo [baize] 服务已退出（退出码 %errorlevel%）。
pause

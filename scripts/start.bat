@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

rem 优先用仓库自带的 runtime\node.exe（scripts\win-portable.ps1 下载），
rem 这样用户不需要在系统里装 Node。
set "NODE=%~dp0..\runtime\node.exe"
if not exist "%NODE%" set "NODE=node"

where "%NODE%" >nul 2>nul
if errorlevel 1 (
  echo [baize] 没找到 Node 运行时。
  echo         二选一：
  echo           1^) 在 PowerShell 里运行：powershell -ExecutionPolicy Bypass -File scripts\win-portable.ps1
  echo           2^) 安装 Node.js 22 LTS：https://nodejs.org/
  pause
  exit /b 1
)

if not exist ".env" (
  echo [baize] 没找到 .env。
  echo         先执行：copy .env.example .env
  echo         再把 OPENCODE_GO_API_KEY 填上（步骤见 docs\windows.md）
  pause
  exit /b 1
)

echo [baize] 启动中…… 关闭此窗口即停止服务。
echo [baize] 状态页 http://127.0.0.1:8787/   看板 /dashboard   配置 /settings
echo.
"%NODE%" src\server.mjs
echo.
echo [baize] 服务已退出（退出码 %errorlevel%）。
pause

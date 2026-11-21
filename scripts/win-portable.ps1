# 把 Node 运行时下载到仓库里，做到「不用安装、双击就跑」。
#
#   powershell -ExecutionPolicy Bypass -File scripts\win-portable.ps1
#
# 结果：<repo>\runtime\node.exe。之后 scripts\start.bat 会优先使用它，
# 系统里装没装 Node 都不影响。

$ErrorActionPreference = 'Stop'

$version = 'v22.20.0'
$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
$zipName = "node-$version-win-$arch.zip"
$url = "https://nodejs.org/dist/$version/$zipName"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$runtime = Join-Path $root 'runtime'
$zip = Join-Path $env:TEMP $zipName

if (Test-Path (Join-Path $runtime 'node.exe')) {
  Write-Host "[baize] runtime\node.exe 已存在，跳过下载。" -ForegroundColor Yellow
  exit 0
}

Write-Host "[baize] 下载 $url"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

Write-Host "[baize] 解压到 $runtime"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Expand-Archive -Path $zip -DestinationPath $env:TEMP -Force
$extracted = Join-Path $env:TEMP "node-$version-win-$arch"

# 只留运行时需要的两样，其余（npm 等）不要，省 40MB
Copy-Item (Join-Path $extracted 'node.exe') $runtime -Force
Copy-Item (Join-Path $extracted 'LICENSE') (Join-Path $runtime 'LICENSE.node') -Force -ErrorAction SilentlyContinue

Remove-Item $zip -Force -ErrorAction SilentlyContinue
Remove-Item $extracted -Recurse -Force -ErrorAction SilentlyContinue

& (Join-Path $runtime 'node.exe') --version
Write-Host "[baize] 完成。现在双击 scripts\start.bat 即可（不需要系统装 Node）。" -ForegroundColor Green

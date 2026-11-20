# QuickCut 安装脚本
# 在仓库根目录运行：
# powershell -ExecutionPolicy Bypass -File .\install.ps1
$ErrorActionPreference = 'Stop'

$src = $PSScriptRoot
$dst = Join-Path $env:APPDATA 'Eagle\Plugins\quickcut'

if (Get-Process Eagle -ErrorAction SilentlyContinue) {
    throw '请先完全退出 Eagle，再运行安装脚本。'
}

if (-not (Test-Path (Join-Path $src 'manifest.json'))) {
    throw "当前目录不是 QuickCut 插件根目录：$src"
}

if (Test-Path $dst) {
    Remove-Item $dst -Recurse -Force
}
New-Item -ItemType Directory -Path $dst -Force | Out-Null

foreach ($name in @('manifest.json', 'index.html', 'logo.png', 'css', 'js')) {
    Copy-Item (Join-Path $src $name) $dst -Recurse -Force
}

Write-Host "QuickCut 已安装到：$dst"
Write-Host '请启动 Eagle，并在插件面板中打开 QuickCut。'

# HotChasing 演示环境恢复脚本（在对方电脑上运行）
#
# 只依赖 Docker Desktop，不需要联网拉镜像、不需要源码、不需要 Node.js。
#
# 用法：在本文件夹里打开 PowerShell，执行
#   powershell -ExecutionPolicy Bypass -File .\demo-restore.ps1
#   powershell -ExecutionPolicy Bypass -File .\demo-restore.ps1 -Port 8090

[CmdletBinding()]
param(
    # 本机访问端口
    [int]$Port = 8080,

    # 跳过数据导入（只起空环境）
    [switch]$SkipData
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$BundleDir = $PSScriptRoot
$SeedContainer = 'hotchasing-seed'
$env:DEMO_PORT = "$Port"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn2($msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }

# docker 把进度写在 stderr，这里统一收敛成普通输出，只按退出码判断成败。
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string[]]$Command,
        [string]$FailMessage = '命令执行失败',
        [switch]$Quiet
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $exe = $Command[0]
        $rest = @($Command | Select-Object -Skip 1)
        if ($Quiet) {
            & $exe @rest 2>&1 | Out-Null
        } else {
            & $exe @rest 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        }
    }
    finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) { throw "$FailMessage (exit $LASTEXITCODE)" }
}

# 尽力而为的调用：忽略退出码与 stderr（例如删除可能不存在的容器）
function Invoke-NativeIgnore {
    param([Parameter(Mandatory = $true)][string[]]$Command)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $exe = $Command[0]
        $rest = @($Command | Select-Object -Skip 1)
        & $exe @rest 2>&1 | Out-Null
    }
    catch { }
    finally { $ErrorActionPreference = $prev }
    $global:LASTEXITCODE = 0
}

# 需要取回标准输出的调用
function Get-NativeOutput {
    param([Parameter(Mandatory = $true)][string[]]$Command)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = $null
    try {
        $exe = $Command[0]
        $rest = @($Command | Select-Object -Skip 1)
        $out = & $exe @rest 2>$null
    }
    catch { }
    finally { $ErrorActionPreference = $prev }
    return (($out -join "`n")).Trim()
}

# ---------------------------------------------------------------- 0. 前置检查
Write-Step '检查 Docker'
$dockerVersion = Get-NativeOutput @('docker', 'version', '--format', '{{.Server.Version}}')
if (-not $dockerVersion) {
    throw 'Docker 不可用。请先安装并启动 Docker Desktop（等右下角鲸鱼图标停止转动后重试）。'
}
Write-Host "    Docker Engine $dockerVersion" -ForegroundColor DarkGray

$ImagesTar = Join-Path $BundleDir 'images.tar'
$ComposeFile = Join-Path $BundleDir 'docker-compose.yml'
foreach ($f in @($ImagesTar, $ComposeFile)) {
    if (-not (Test-Path -LiteralPath $f)) { throw "演示包不完整，缺少：$f" }
}

# ---------------------------------------------------------------- 1. 导入镜像
Write-Step '导入离线镜像（约需一分钟）'
Invoke-Native @('docker', 'load', '-i', $ImagesTar) -FailMessage 'docker load 失败'

# ---------------------------------------------------------------- 2. 启动容器
Write-Step "启动容器（端口 $Port）"
Invoke-Native @('docker', 'compose', '-f', $ComposeFile, 'up', '-d') -FailMessage 'docker compose up 失败'

$backendId = Get-NativeOutput @('docker', 'compose', '-f', $ComposeFile, 'ps', '-q', 'backend')
if (-not $backendId) { throw '未能获取 backend 容器 ID' }

# ---------------------------------------------------------------- 3. 导入数据
$DbFile = Join-Path $BundleDir 'data\data.db'
$KeyFile = Join-Path $BundleDir 'data\.encryption-key'

if (-not $SkipData -and (Test-Path -LiteralPath $DbFile)) {
    # 注意：Go 模板里不要写双引号（PowerShell 5.1 传给原生命令时会被吃掉），
    # 这里改成输出 "挂载点:卷名" 列表再在 PowerShell 侧筛选。
    $mounts = Get-NativeOutput @('docker', 'inspect', '-f', '{{range .Mounts}}{{.Destination}}={{.Name}} {{end}}', $backendId)
    $volume = ($mounts -split '\s+' | Where-Object { $_ -like '/app/data=*' } | Select-Object -First 1) -replace '^/app/data=', ''
    if (-not $volume) { throw "未能定位 /app/data 数据卷（inspect 输出：$mounts）" }

    Write-Step "导入演示数据到数据卷 $volume"
    Invoke-Native @('docker', 'compose', '-f', $ComposeFile, 'stop', 'backend') -Quiet -FailMessage 'stop backend 失败'

    Invoke-NativeIgnore @('docker', 'rm', '-f', $SeedContainer)
    $backendImage = Get-NativeOutput @('docker', 'inspect', '-f', '{{.Config.Image}}', $backendId)
    if (-not $backendImage) { throw '未能获取 backend 镜像名' }
    Invoke-Native @('docker', 'create', '--name', $SeedContainer, '--user', 'root', '--entrypoint', 'sh',
        '-v', "${volume}:/app/data", $backendImage, '-c', 'sleep 300') -Quiet -FailMessage '创建数据导入容器失败'

    try {
        Invoke-Native @('docker', 'start', $SeedContainer) -Quiet -FailMessage '启动数据导入容器失败'
        Invoke-Native @('docker', 'exec', '-u', 'root', $SeedContainer, 'sh', '-c',
            'rm -f /app/data/data.db /app/data/data.db-wal /app/data/data.db-shm') -Quiet -FailMessage '清理旧数据库失败'
        Invoke-Native @('docker', 'cp', $DbFile, "${SeedContainer}:/app/data/data.db") -Quiet -FailMessage 'docker cp data.db 失败'

        if (Test-Path -LiteralPath $KeyFile) {
            Invoke-Native @('docker', 'cp', $KeyFile, "${SeedContainer}:/app/data/.encryption-key") -Quiet -FailMessage 'docker cp .encryption-key 失败'
        } else {
            Write-Warn2 '演示包未含 .encryption-key：AI 重排 / README 代理 / Star 将不可用，需在设置里自行录入 AI 配置。'
        }

        Invoke-Native @('docker', 'exec', '-u', 'root', $SeedContainer, 'sh', '-c',
            'chown -R node:node /app/data; chmod 600 /app/data/.encryption-key 2>/dev/null; ls -la /app/data') -FailMessage '修正数据目录权限失败'
    }
    finally {
        Invoke-NativeIgnore @('docker', 'rm', '-f', $SeedContainer)
    }

    Invoke-Native @('docker', 'compose', '-f', $ComposeFile, 'start', 'backend') -Quiet -FailMessage 'start backend 失败'
} elseif (-not $SkipData) {
    Write-Warn2 '演示包中没有 data\data.db，将使用空数据库（日报与 Top100 为空）。'
}

# ---------------------------------------------------------------- 4. 健康检查
Write-Step '等待后端就绪'
$ok = $false
foreach ($i in 1..30) {
    Start-Sleep -Seconds 2
    try {
        $resp = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 5
        if ($resp.status -eq 'ok') { $ok = $true; break }
    } catch { }
}

Write-Host ''
if (-not $ok) {
    Write-Warn2 '健康检查未通过。请执行下面命令查看日志：'
    Write-Host "    docker compose -f `"$ComposeFile`" logs --tail 100" -ForegroundColor Yellow
    exit 1
}

Write-Host '==> 演示环境就绪' -ForegroundColor Green
Write-Host "    浏览器访问：http://localhost:$Port" -ForegroundColor Green
Write-Host ''
Write-Host '首次打开会要求粘贴 GitHub Personal Access Token 登录（必须现场填，需能访问 GitHub）。' -ForegroundColor Yellow
Write-Host '不要执行 docker compose down -v —— 会删除演示数据。' -ForegroundColor Yellow

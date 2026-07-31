# HotChasing 演示包打包脚本（在你自己的机器上运行）
#
# 作用：把当前【正在运行的容器】的真实状态固化为镜像并导出为离线包，
#       连同后端 SQLite 数据一起打成一个可拷贝的文件夹。
#
# 为什么用 docker commit 而不是直接 docker save 现有镜像：
#   hotchasing/*:local 镜像里的前端 dist / 后端 dist 是旧的，
#   最新产物是用 docker cp 直接塞进运行中容器的（见 docker diff 输出）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\demo-pack.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\demo-pack.ps1 -IncludeSecrets
#   powershell -ExecutionPolicy Bypass -File scripts\demo-pack.ps1 -OutDir D:\hotchasing-demo -SkipData

[CmdletBinding()]
param(
    # 演示包输出目录
    [string]$OutDir = "$env:USERPROFILE\Desktop\hotchasing-demo",

    # 导出镜像的标签
    [string]$Tag = "demo",

    # 是否附带 data/.encryption-key
    #   带上  -> 对方机器可直接使用你的 AI key / GitHub token（AI 重排、README、Star 开箱可用）
    #   不带  -> 数据库里的密文无法解密，对方需自己录入 AI 配置
    [switch]$IncludeSecrets,

    # 只导出镜像，不导出数据库（对方将看到空数据，需自己采集）
    [switch]$SkipData,

    # 打包时不停止 backend 容器（有极小概率拷到不一致的 SQLite 快照）
    [switch]$NoStop
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$FrontendContainer = 'hotchasing-frontend-1'
$BackendContainer = 'hotchasing-backend-1'
$FrontendImage = "hotchasing/frontend:$Tag"
$BackendImage = "hotchasing/server:$Tag"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn2($msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }

# docker / docker compose 会把进度写到 stderr。在 $ErrorActionPreference='Stop' 下
# 直接调用会被当成终止性错误，这里统一收敛成普通输出并只按退出码判断成败。
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
    if ($LASTEXITCODE -ne 0) { throw "$FailMessage (exit $LASTEXITCODE): $($Command -join ' ')" }
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

function Assert-Container($name) {
    $state = Get-NativeOutput @('docker', 'inspect', '-f', '{{.State.Running}}', $name)
    if ($state -ne 'true') {
        throw "容器 $name 未在运行（当前状态：'$state'）。请先在项目根目录执行 docker compose up -d"
    }
}

# ---------------------------------------------------------------- 0. 前置检查
Write-Step '检查容器状态'
Assert-Container $FrontendContainer
Assert-Container $BackendContainer

if (Test-Path -LiteralPath $OutDir) {
    Write-Warn2 "输出目录已存在，将覆盖其中同名文件：$OutDir"
} else {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}
$DataDir = Join-Path $OutDir 'data'
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

# ---------------------------------------------------------------- 1. 固化镜像
Write-Step "固化运行中容器为镜像（$FrontendImage / $BackendImage）"
Invoke-Native @('docker', 'commit', $FrontendContainer, $FrontendImage) -Quiet -FailMessage 'docker commit frontend 失败'
Invoke-Native @('docker', 'commit', $BackendContainer, $BackendImage) -Quiet -FailMessage 'docker commit backend 失败'

# ---------------------------------------------------------------- 2. 导出数据
if (-not $SkipData) {
    if (-not $NoStop) {
        Write-Step '临时停止 backend 以获得一致的 SQLite 快照'
        Invoke-Native @('docker', 'compose', 'stop', 'backend') -Quiet -FailMessage 'docker compose stop backend 失败'
    }

    try {
        Write-Step '导出后端数据 (data.db)'
        Invoke-Native @('docker', 'cp', "${BackendContainer}:/app/data/data.db", (Join-Path $DataDir 'data.db')) -Quiet -FailMessage 'docker cp data.db 失败'

        if ($IncludeSecrets) {
            Write-Step '导出加密密钥 (.encryption-key)'
            Invoke-Native @('docker', 'cp', "${BackendContainer}:/app/data/.encryption-key", (Join-Path $DataDir '.encryption-key')) -Quiet -FailMessage 'docker cp .encryption-key 失败'
            Write-Warn2 '演示包内含可解密的 AI API Key 与 GitHub Token，只交给可信的人，用完让对方删除整个文件夹。'
        } else {
            Write-Warn2 '未附带 .encryption-key：对方机器上 AI 重排 / README 代理 / Star 会失效，需自行录入 AI 配置。'
        }
    }
    finally {
        if (-not $NoStop) {
            Write-Step '恢复 backend 运行'
            Invoke-Native @('docker', 'compose', 'start', 'backend') -Quiet -FailMessage 'docker compose start backend 失败'
        }
    }
} else {
    Write-Warn2 '已跳过数据导出，对方将看到空的日报与 Top100。'
}

# ---------------------------------------------------------------- 3. 导出镜像
$ImagesTar = Join-Path $OutDir 'images.tar'
Write-Step "导出镜像到 images.tar（压缩后约 100~150MB，需要一两分钟）"
Invoke-Native @('docker', 'save', '-o', $ImagesTar, $FrontendImage, $BackendImage) -Quiet -FailMessage 'docker save 失败'

# ---------------------------------------------------------------- 4. 生成运行文件
Write-Step '生成 docker-compose.yml 与说明文件'

# 独立 compose 文件：不含 build 段，避免对方机器触发联网构建
$compose = @"
# HotChasing 演示环境（离线镜像，不需要联网构建）
name: hotchasing-demo

services:
  frontend:
    image: $FrontendImage
    # 只绑定本机回环地址：后端未开启鉴权，不要暴露到局域网
    # 端口可用环境变量 DEMO_PORT 覆盖，默认 8080
    ports:
      - "127.0.0.1:`${DEMO_PORT:-8080}:80"
    depends_on:
      - backend
    environment:
      - BACKEND_HOST=backend:3000
    restart: unless-stopped

  backend:
    image: $BackendImage
    expose:
      - "3000"
    # 注意：这里刻意不设置 API_SECRET。
    # 前端的日报 / Top100 请求不带 Authorization 头，设了会全部 401。
    volumes:
      - backend-data:/app/data
    restart: unless-stopped

volumes:
  backend-data:
"@
Set-Content -LiteralPath (Join-Path $OutDir 'docker-compose.yml') -Value $compose -Encoding UTF8

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'demo-restore.ps1') -Destination $OutDir -Force

$secretsNote = if ($IncludeSecrets -and -not $SkipData) {
    '本包已含加密密钥，AI 语义重排 / README / Star 开箱可用，无需配置 AI。'
} else {
    '本包未含加密密钥，需要在「设置 - AI 配置」里自行录入可用的 AI Key，否则语义重排不可用。'
}

$readme = @"
HotChasing 演示环境 - 安装说明
==============================

前置条件
--------
Windows 10/11 + Docker Desktop（已启动，右下角鲸鱼图标不转圈）。
不需要联网拉镜像，不需要 Node.js，不需要源码。

安装
----
1. 把整个文件夹拷到本机任意位置（建议放在用户目录下，路径不要含空格）。
2. 在该文件夹里按住 Shift 右键 -> 「在此处打开 PowerShell 窗口」，执行：

     powershell -ExecutionPolicy Bypass -File .\demo-restore.ps1

   端口被占用时可以换端口：
     powershell -ExecutionPolicy Bypass -File .\demo-restore.ps1 -Port 8090

3. 看到「演示环境就绪」后，浏览器打开 http://localhost:8080

首次使用必做的一步
------------------
应用有 GitHub 登录门禁，新浏览器首屏会要求粘贴 GitHub Personal Access Token。
这一步无法预置，必须现场填一个（只读即可：public_repo，或者不勾任何 scope）。
生成地址：https://github.com/settings/tokens
登录时会直连 api.github.com 校验，所以这一步需要能访问 GitHub。

$secretsNote

可以演示什么
------------
- 热点 / 今日精选：历史归档日报、日期切换、分类筛选、README 弹窗
- 热点 / 实时趋势：GitHub Trending（需要网络）
- Top100：经典热门榜单与分类筛选
- 语义搜索 / AI 重排：只对已加载的条目重排，不改分数与排名

不建议在演示机上点的按钮
------------------------
- 「更新 Top100」：首次运行是同步长请求，可能要几分钟，并消耗 AI 配额
- 「采集并生成日报」：会打 GitHub Search，未授权时容易被限流

常用命令（在本文件夹内执行）
----------------------------
docker compose ps                    # 查看状态
docker compose logs -f backend       # 后端日志
docker compose stop                  # 停止
docker compose start                 # 再次启动
docker compose down                  # 删除容器，数据卷保留

千万不要执行 docker compose down -v —— 会删掉数据卷，演示数据全没。

卸载
----
docker compose down -v
docker rmi $FrontendImage $BackendImage
"@
Set-Content -LiteralPath (Join-Path $OutDir '使用说明.txt') -Value $readme -Encoding UTF8

# ---------------------------------------------------------------- 5. 汇总
$size = [math]::Round(((Get-ChildItem -LiteralPath $OutDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host ''
Write-Step "打包完成：$OutDir （合计 ${size} MB）"
Get-ChildItem -LiteralPath $OutDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($OutDir.Length + 1)
    Write-Host ("    {0,-24} {1,12:N1} KB" -f $rel, ($_.Length / 1KB))
}
Write-Host ''
Write-Host '把整个文件夹拷给对方，让对方运行 demo-restore.ps1 即可。' -ForegroundColor Green

[CmdletBinding()]
param(
    [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$AppUrl = 'http://localhost:8080'
$HealthUrl = "$AppUrl/api/health"
$DockerEngineWaitSeconds = 90

function Test-DockerEngineReady {
    # docker writes to stderr when the daemon is unavailable. Under
    # $ErrorActionPreference='Stop' that would terminate the script, so
    # tolerate the failure here and report readiness through the exit code.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    & docker info *>&1 | Out-Null
    $ready = $LASTEXITCODE -eq 0
    $ErrorActionPreference = $previousPreference
    return $ready
}

function Find-DockerDesktop {
    $candidates = @(
        "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
        "${env:ProgramFiles(x86)}\Docker\Docker\Docker Desktop.exe",
        "$env:LOCALAPPDATA\Docker\Docker Desktop.exe",
        "$env:ProgramFiles\Docker\Docker Desktop.exe"
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    $onPath = Get-Command 'Docker Desktop' -ErrorAction SilentlyContinue
    if ($onPath) {
        return $onPath.Source
    }

    return $null
}

function Start-DockerDesktop {
    $dockerDesktop = Find-DockerDesktop
    if ($dockerDesktop) {
        Write-Host "Launching $dockerDesktop" -ForegroundColor Cyan
        Start-Process -FilePath $dockerDesktop
        return $true
    }

    # Newer Docker Desktop releases ship a 'docker desktop' CLI fallback.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    & docker desktop start *>&1 | Out-Null
    $started = $LASTEXITCODE -eq 0
    $ErrorActionPreference = $previousPreference
    if ($started) { return $true }

    Write-Host 'Docker Desktop was not found and could not be started automatically.' -ForegroundColor Yellow
    Write-Host 'Please start Docker Desktop yourself (e.g. click the Docker Desktop shortcut), then wait for the engine to be ready.' -ForegroundColor Yellow
    return $false
}

function Test-UrlAvailable {
    param([Parameter(Mandatory = $true)][string]$Url)

    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
    }
    catch {
        return $false
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI was not found. Install Docker Desktop, then run this launcher again.'
}

if (-not (Test-DockerEngineReady)) {
    Write-Host 'Docker engine is not running. Attempting to start Docker Desktop...' -ForegroundColor Cyan
    $autoStarted = Start-DockerDesktop

    if (-not $autoStarted) {
        Write-Host "Waiting for you to start Docker Desktop. The launcher will keep waiting for up to $DockerEngineWaitSeconds seconds..." -ForegroundColor Yellow
    }

    $deadline = (Get-Date).AddSeconds($DockerEngineWaitSeconds)
    $engineReady = $false
    while ((Get-Date) -lt $deadline) {
        if (Test-DockerEngineReady) {
            $engineReady = $true
            break
        }
        Start-Sleep -Seconds 3
    }

    if (-not $engineReady) {
        throw "Docker engine did not become ready within $DockerEngineWaitSeconds seconds. Please start Docker Desktop, wait for the engine to be ready, then run this launcher again."
    }
    Write-Host 'Docker engine is ready.' -ForegroundColor Green
}

if (Test-UrlAvailable $HealthUrl) {
    Write-Host "HotChasing is already available at $AppUrl" -ForegroundColor Green
    Start-Process $AppUrl
    exit 0
}

Write-Host 'Starting HotChasing frontend and backend containers...' -ForegroundColor Cyan
$composeArgs = @('compose', 'up', '-d')
if ($Rebuild) {
    $composeArgs += '--build'
}

Push-Location $ProjectRoot
try {
    & docker @composeArgs
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker Compose could not start HotChasing.'
    }
}
finally {
    Pop-Location
}

$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    if (Test-UrlAvailable $HealthUrl) {
        Write-Host "HotChasing is ready at $AppUrl" -ForegroundColor Green
        Start-Process $AppUrl
        exit 0
    }

    Start-Sleep -Seconds 1
}

Write-Warning "The containers are still starting. Run 'docker compose ps' in $ProjectRoot, then open $AppUrl manually."

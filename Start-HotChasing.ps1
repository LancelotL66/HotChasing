[CmdletBinding()]
param(
    [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$AppUrl = 'http://localhost:8080'
$HealthUrl = "$AppUrl/api/health"

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
    throw 'Docker Desktop was not found. Install and start Docker Desktop, then run this launcher again.'
}

& docker info 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker Desktop is not running. Start it, wait for the engine to be ready, then run this launcher again.'
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

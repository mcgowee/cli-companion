#Requires -Version 7.0
<#
.SYNOPSIS
    Start the Pi companion server if it is not listening, then open its window.

.DESCRIPTION
    Idempotent: probes 127.0.0.1:<Port> first and never starts a second server.
    The server (server\server.mjs, Node built-ins only) runs detached with a
    hidden window and logs to logs\server.log. The window is a Chrome --app
    window with the companion's own profile (.chrome-profile), so it is a
    separate Chrome process from your normal browser.

.PARAMETER Port
    Companion port. Default 30143.

.PARAMETER NoOpen
    Start the server only; do not open a window.

.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File .\open-companion.ps1
#>
[CmdletBinding()]
param(
    [int]$Port = 30143,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
$ServerScript = Join-Path $Root 'server\server.mjs'
$LogDir = Join-Path $Root 'logs'
$Url = "http://127.0.0.1:$Port"
$MutexName = 'Local\PiCompanion-Open'

function Test-TcpPort([int]$P) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync('127.0.0.1', $P)
        return $task.Wait(600) -and $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Resolve-ChromePath {
    foreach ($p in @(
        (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

$mutex = [System.Threading.Mutex]::new($false, $MutexName)
$null = $mutex.WaitOne(30000)
try {
    if (-not (Test-TcpPort $Port)) {
        $node = (Get-Command node -ErrorAction Stop).Source
        New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
        $env:PI_COMPANION_PORT = "$Port"
        Start-Process -FilePath $node -ArgumentList "`"$ServerScript`"" -WorkingDirectory $Root `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $LogDir 'server.log') `
            -RedirectStandardError (Join-Path $LogDir 'server.err.log') | Out-Null
        $deadline = (Get-Date).AddSeconds(15)
        while (-not (Test-TcpPort $Port)) {
            if ((Get-Date) -gt $deadline) {
                throw "The companion server did not come up on $Url within 15 s. See $LogDir."
            }
            Start-Sleep -Milliseconds 250
        }
        Write-Host "[companion] Server started on $Url."
    } else {
        Write-Host "[companion] Server already running on $Url."
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}

if ($NoOpen) { return }

$chrome = Resolve-ChromePath
if (-not $chrome) {
    Start-Process $Url
    return
}
$profileDir = Join-Path $Root '.chrome-profile'
Start-Process -FilePath $chrome -ArgumentList @("--app=$Url", "--user-data-dir=`"$profileDir`"", '--window-size=1100,900') | Out-Null
Write-Host "[companion] Window opened."

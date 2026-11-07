#Requires -Version 7.0
<#
.SYNOPSIS
    Copy the bridge extension (extension\companion.ts) into ~/.pi/agent/extensions.

.DESCRIPTION
    Pi loads every file in that folder at session start. Running Pi sessions pick
    it up after /reload. An existing copy is backed up before it is replaced.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'extension\companion.ts'
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.pi\agent' }
$targetDir = Join-Path $agentDir 'extensions'
$target = Join-Path $targetDir 'companion.ts'

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
if (Test-Path -LiteralPath $target) {
    if ((Get-FileHash $source).Hash -eq (Get-FileHash $target).Hash) {
        Write-Host "[companion] Extension already up to date: $target"
        return
    }
    $backup = "$target.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item -LiteralPath $target -Destination $backup
    Write-Host "[companion] Backed up the old copy to $backup"
}
Copy-Item -LiteralPath $source -Destination $target
Write-Host "[companion] Installed $target. Run /reload in open Pi sessions."

param(
  [string]$ApiUrl = "https://roundtable-api.browsium.workers.dev",
  [string]$ServerName = "roundtable-local"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$mcpDir = Join-Path $repoRoot "mcp\\roundtable-mcp"
$mcpEntryPath = (Join-Path $mcpDir "dist\\index.js").Replace("\\", "/")

Write-Host "Building MCP server..." -ForegroundColor Cyan
Push-Location $mcpDir
try {
  npm install | Out-Null
  npm run build | Out-Null
} finally {
  Pop-Location
}

$claudeSettingsPath = Join-Path $env:USERPROFILE ".claude\\settings.json"
if (!(Test-Path $claudeSettingsPath)) {
  throw "Claude settings not found at $claudeSettingsPath"
}

Write-Host "Updating Claude Code MCP config..." -ForegroundColor Cyan
$settingsRaw = Get-Content $claudeSettingsPath -Raw
$settings = $settingsRaw | ConvertFrom-Json

if ($null -eq $settings.mcpServers) {
  $settings | Add-Member -MemberType NoteProperty -Name mcpServers -Value @{}
}

$envObj = @{}
$envObj.ROUNDTABLE_API_URL = $ApiUrl

if ($env:ROUNDTABLE_CF_ACCESS_CLIENT_ID) { $envObj.ROUNDTABLE_CF_ACCESS_CLIENT_ID = $env:ROUNDTABLE_CF_ACCESS_CLIENT_ID }
if ($env:ROUNDTABLE_CF_ACCESS_CLIENT_SECRET) { $envObj.ROUNDTABLE_CF_ACCESS_CLIENT_SECRET = $env:ROUNDTABLE_CF_ACCESS_CLIENT_SECRET }
if ($env:ROUNDTABLE_USER_EMAIL) { $envObj.ROUNDTABLE_USER_EMAIL = $env:ROUNDTABLE_USER_EMAIL }

$settings.mcpServers.$ServerName = @{
  command = "node"
  args = @($mcpEntryPath)
  env = $envObj
}

$settings | ConvertTo-Json -Depth 20 | Set-Content $claudeSettingsPath -Encoding UTF8

Write-Host "Installed MCP server '$ServerName' -> $mcpEntryPath" -ForegroundColor Green
Write-Host "Claude settings updated: $claudeSettingsPath" -ForegroundColor Green


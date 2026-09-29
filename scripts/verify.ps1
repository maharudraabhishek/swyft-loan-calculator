$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$required = @(
  'README.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'apps/api/package.json', 'apps/desktop/package.json',
  'packages/contracts/package.json', 'packages/finance/package.json',
  'packages/quoting/package.json', 'tests/fixtures/upstream/test-cases.json'
)
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
if ($missing.Count -gt 0) { throw "Missing required files: $($missing -join ', ')" }

$manifest = Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json
if ($manifest.private -ne $true) { throw 'The workspace must remain private.' }

# Every gate is fatal. The unit/fixture suite runs last so all other gates still produce
# evidence while the documented official finance fixture contradictions keep it red.
# test:db and test:integration need Docker (disposable postgres-test container on
# 127.0.0.1:55433); test:integration drives the real Renderer/Main code against the real API.
foreach ($check in @('format:check', 'lint', 'typecheck', 'build', 'test:db', 'test:integration', 'test')) {
  Write-Output "Running $check"
  & pnpm.cmd run $check
  if ($LASTEXITCODE -ne 0) { throw "$check failed with exit code $LASTEXITCODE" }
}

Write-Output 'Workspace checks: PASS'

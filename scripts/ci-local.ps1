$ErrorActionPreference = "Stop"
node (Join-Path $PSScriptRoot "ci-local.mjs") @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

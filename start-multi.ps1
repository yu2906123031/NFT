param([switch]$Live)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if ($Live) {
    node multi-mint.mjs run --live
} else {
    node multi-mint.mjs check
}
exit $LASTEXITCODE

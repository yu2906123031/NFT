$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$mintSecret = Read-Host 'Enter PRIVATE KEY locally (hidden; never send it in chat)' -AsSecureString
$mintPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($mintSecret)
try {
    $env:MINT_PRIVATE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($mintPtr)
    node mint.mjs run --live
} finally {
    Remove-Item Env:MINT_PRIVATE_KEY -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($mintPtr)
    $mintSecret.Dispose()
}

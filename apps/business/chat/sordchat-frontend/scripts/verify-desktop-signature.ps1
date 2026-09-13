param(
  [string]$InstallerPath = ""
)

$ErrorActionPreference = "Stop"
$frontendRoot = Split-Path -Parent $PSScriptRoot
if (-not $InstallerPath) {
  $InstallerPath = Get-ChildItem -LiteralPath (Join-Path $frontendRoot "dist-desktop") -Filter "VoltChat-Setup-*.exe" |
    Sort-Object -Property LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$signature = Get-AuthenticodeSignature -FilePath $resolvedInstaller

Write-Host "Arquivo: $resolvedInstaller"
Write-Host "Status: $($signature.Status)"
Write-Host "Assinante: $($signature.SignerCertificate.Subject)"
Write-Host "Thumbprint: $($signature.SignerCertificate.Thumbprint)"

if ($signature.Status -ne "Valid") {
  throw "A assinatura do instalador nao e valida: $($signature.StatusMessage)"
}

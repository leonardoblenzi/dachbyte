param(
  [string]$Output = "tmp/davantti-ml-cloner.zip"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "extensions/davantti-ml-cloner"
$target = Join-Path $root $Output
$targetDir = Split-Path -Parent $target

if (!(Test-Path $source)) {
  throw "Pasta da extensao nao encontrada: $source"
}

if (!(Test-Path $targetDir)) {
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
}

if (Test-Path $target) {
  Remove-Item -LiteralPath $target -Force
}

Compress-Archive -Path (Join-Path $source "*") -DestinationPath $target -Force
Write-Host "Extensao empacotada em $target"

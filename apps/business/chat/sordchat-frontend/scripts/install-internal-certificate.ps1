param(
  [string]$CertificatePath = ""
)

$ErrorActionPreference = "Stop"
$frontendRoot = Split-Path -Parent $PSScriptRoot
$certificateName = "VoltCorp-Internal-Code-Signing.cer"

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Add-CertificateToStoreIfMissing {
  param(
    [string]$ResolvedCertificatePath,
    [string]$StoreName,
    [string]$Thumbprint,
    [switch]$CurrentUser
  )

  $storeLocation = if ($CurrentUser) {
    [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
  } else {
    [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
  }
  $storePath = if ($CurrentUser) { "Cert:\CurrentUser\$StoreName" } else { "Cert:\LocalMachine\$StoreName" }
  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new($StoreName, $storeLocation)
  $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  try {
    $existingCertificate = $store.Certificates | Where-Object { $_.Thumbprint -eq $Thumbprint } | Select-Object -First 1
    if ($existingCertificate) {
      Write-Host "Ja confiado em $storePath"
      return
    }

    $certificateToTrust = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($ResolvedCertificatePath)
    $store.Add($certificateToTrust)
    Write-Host "Confiado em $storePath"
  } finally {
    $store.Close()
  }
}

if (-not $CertificatePath) {
  $candidates = @(
    (Join-Path $PSScriptRoot $certificateName),
    (Join-Path $frontendRoot "electron\certificates\$certificateName"),
    (Join-Path $frontendRoot "dist-desktop\certificates\$certificateName")
  )

  $CertificatePath = $candidates |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
}

if (-not $CertificatePath -or -not (Test-Path -LiteralPath $CertificatePath)) {
  throw "Certificado nao encontrado. Rode primeiro: npm run desktop:cert:setup"
}

$resolvedCertificatePath = (Resolve-Path -LiteralPath $CertificatePath).Path
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($resolvedCertificatePath)

if (Test-IsAdministrator) {
  $stores = @("Root", "TrustedPublisher")
  $useCurrentUserStore = $false
  Write-Host "Instalando certificado para todos os usuarios desta maquina."
} else {
  $stores = @("Root", "TrustedPublisher")
  $useCurrentUserStore = $true
  Write-Warning "Sem administrador: sera registrado em Root e TrustedPublisher do usuario atual."
  Write-Warning "Para confiar para todos os usuarios da maquina, rode este script como administrador."
}

foreach ($storeName in $stores) {
  Add-CertificateToStoreIfMissing `
    -ResolvedCertificatePath $resolvedCertificatePath `
    -StoreName $storeName `
    -Thumbprint $certificate.Thumbprint `
    -CurrentUser:$useCurrentUserStore
}

Write-Host "Certificado interno Volt Corp instalado."
Write-Host "Subject: $($certificate.Subject)"
Write-Host "Thumbprint: $($certificate.Thumbprint)"

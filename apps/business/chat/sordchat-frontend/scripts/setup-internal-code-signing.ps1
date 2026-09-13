param(
  [string]$Subject = "CN=Volt Corp Internal Code Signing",
  [int]$ValidYears = 3
)

$ErrorActionPreference = "Stop"
$frontendRoot = Split-Path -Parent $PSScriptRoot
$publicCertificateName = "VoltCorp-Internal-Code-Signing.cer"
$sourceCertificateDirectory = Join-Path $frontendRoot "electron\certificates"
$distributionCertificateDirectory = Join-Path $frontendRoot "dist-desktop\certificates"
$publicCertificatePath = Join-Path $sourceCertificateDirectory $publicCertificateName
$distributionCertificatePath = Join-Path $distributionCertificateDirectory $publicCertificateName
$minimumExpiration = (Get-Date).AddDays(30)

$certificate = Get-ChildItem -Path "Cert:\CurrentUser\My" |
  Where-Object {
    $_.Subject -eq $Subject -and
    $_.HasPrivateKey -and
    $_.NotAfter -gt $minimumExpiration
  } |
  Sort-Object -Property NotAfter -Descending |
  Select-Object -First 1

if (-not $certificate) {
  Write-Host "Criando certificado interno Volt Corp..."
  $rsa = [System.Security.Cryptography.RSA]::Create(3072)
  $distinguishedName = [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new($Subject)
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    $distinguishedName,
    $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
  $request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
  )
  $request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
      [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
      $true
    )
  )
  $codeSigningOid = [System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.3")
  $eku = [System.Security.Cryptography.OidCollection]::new()
  [void]$eku.Add($codeSigningOid)
  $request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $true)
  )

  $generatedCertificate = $request.CreateSelfSigned((Get-Date).AddMinutes(-5), (Get-Date).AddYears($ValidYears))
  $pfxPassword = [Guid]::NewGuid().ToString("N")
  $pfxBytes = $generatedCertificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $pfxPassword)
  $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
    $pfxBytes,
    $pfxPassword,
    [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable -bor
      [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet -bor
      [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::UserKeySet
  )

  $myStore = [System.Security.Cryptography.X509Certificates.X509Store]::new(
    "My",
    [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
  )
  $myStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  try {
    $myStore.Add($certificate)
  } finally {
    $myStore.Close()
  }
}

New-Item -ItemType Directory -Path $sourceCertificateDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $distributionCertificateDirectory -Force | Out-Null
Export-Certificate -Cert $certificate -FilePath $publicCertificatePath -Force | Out-Null
Copy-Item -LiteralPath $publicCertificatePath -Destination $distributionCertificatePath -Force
Write-Host "Certificado interno pronto."
Write-Host "Subject: $($certificate.Subject)"
Write-Host "Thumbprint: $($certificate.Thumbprint)"
Write-Host "Valido ate: $($certificate.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host "Certificado publico do projeto: $publicCertificatePath"
Write-Host "Certificado para distribuicao: $distributionCertificatePath"
Write-Host "A chave privada fica somente no store Cert:\CurrentUser\My desta maquina."
Write-Host "Para o Windows reconhecer como confiavel, instale o .cer em Root e TrustedPublisher com scripts\install-internal-certificate.ps1."

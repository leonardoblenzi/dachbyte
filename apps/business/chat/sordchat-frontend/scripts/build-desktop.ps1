param(
  [switch]$Directory
)

$ErrorActionPreference = "Stop"
$frontendRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = Split-Path -Parent $frontendRoot
$appVersion = ((Get-Content -LiteralPath (Join-Path $frontendRoot "package.json") -Raw | ConvertFrom-Json).version)

function Get-DotEnvValue {
  param([string]$Name)

  $processValue = [Environment]::GetEnvironmentVariable($Name)
  if (-not [string]::IsNullOrWhiteSpace($processValue)) {
    return $processValue.Trim()
  }

  $envFiles = @(
    (Join-Path $projectRoot ".env"),
    (Join-Path $frontendRoot ".env"),
    (Join-Path $projectRoot "backend\.env")
  )
  $escapedName = [regex]::Escape($Name)
  foreach ($envFile in $envFiles) {
    if (-not (Test-Path -LiteralPath $envFile)) { continue }
    foreach ($line in Get-Content -LiteralPath $envFile -ErrorAction SilentlyContinue) {
      if ($line -match "^\s*$escapedName\s*=\s*(.*)$") {
        return $Matches[1].Trim().Trim('"').Trim("'")
      }
    }
  }
  return ""
}

function Write-UpdaterConfig {
  $publicBaseUrl = Get-DotEnvValue -Name "R2_PUBLIC_BASE_URL"
  if ([string]::IsNullOrWhiteSpace($publicBaseUrl)) {
    $publicBaseUrl = Get-DotEnvValue -Name "CLOUDFLARE_R2_PUBLIC_BASE_URL"
  }
  if ([string]::IsNullOrWhiteSpace($publicBaseUrl)) {
    throw "R2_PUBLIC_BASE_URL nao configurada. Habilite um dominio publico do bucket R2 e adicione a URL ao .env antes de gerar o desktop."
  }
  if (-not $publicBaseUrl.StartsWith("https://")) {
    throw "R2_PUBLIC_BASE_URL precisa iniciar com https://"
  }

  $releasePrefix = Get-DotEnvValue -Name "R2_RELEASE_PREFIX"
  if ([string]::IsNullOrWhiteSpace($releasePrefix)) {
    $releasePrefix = "desktop/releases"
  }
  $releasePrefix = $releasePrefix.Trim('/')
  $publicBaseUrl = $publicBaseUrl.TrimEnd('/')
  $manifestUrl = "$publicBaseUrl/$releasePrefix/windows/latest.json"
  $configPath = Join-Path $frontendRoot "electron\updater-config.json"
  $configJson = [ordered]@{
    manifestUrl = $manifestUrl
    source = "cloudflare-r2"
  } | ConvertTo-Json
  # Windows PowerShell 5.1 usa BOM em Set-Content -Encoding UTF8.
  # O Electron le este JSON diretamente, entao grave UTF-8 sem BOM.
  [System.IO.File]::WriteAllText(
    $configPath,
    $configJson,
    (New-Object System.Text.UTF8Encoding($false))
  )
  Write-Host "Atualizador desktop configurado para Cloudflare: $manifestUrl"
}

function Invoke-Checked {
  param(
    [string]$Command,
    [string[]]$Arguments = @()
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Comando falhou: $Command $($Arguments -join ' ')"
  }
}


function Remove-OldDesktopArtifacts {
  param(
    [string]$OutputDirectory,
    [int]$KeepVersions = 2
  )

  if (-not (Test-Path -LiteralPath $OutputDirectory)) {
    return
  }

  $artifactPattern = '^VoltChat-Setup-(?<version>\d+\.\d+\.\d+)(?:-with-certificate)?\.(?:exe|zip|blockmap)$'
  $versionGroups = Get-ChildItem -LiteralPath $OutputDirectory -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $artifactPattern } |
    Group-Object { [regex]::Match($_.Name, $artifactPattern).Groups['version'].Value } |
    Sort-Object { [version]$_.Name } -Descending

  $versionsToRemove = $versionGroups | Select-Object -Skip $KeepVersions
  foreach ($group in $versionsToRemove) {
    foreach ($file in $group.Group) {
      Write-Host "Removendo artefato antigo: $($file.Name)"
      Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
    }

    $packageDirectory = Join-Path $OutputDirectory ("package-" + $group.Name)
    if (Test-Path -LiteralPath $packageDirectory) {
      Remove-Item -LiteralPath $packageDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Get-WindowsSignToolPath {
  $candidateRoots = @(
    "C:\Program Files (x86)\Windows Kits\10\bin",
    "C:\Program Files\Windows Kits\10\bin",
    "C:\Program Files (x86)\Windows Kits\10\App Certification Kit"
  )

  $candidates = foreach ($root in $candidateRoots) {
    if (Test-Path -LiteralPath $root) {
      Get-ChildItem -Path $root -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" -or $_.FullName -match "App Certification Kit\\signtool\.exe$" }
    }
  }

  return $candidates |
    Sort-Object -Property FullName -Descending |
    Select-Object -First 1
}

function Get-RceditPath {
  $bundledRceditPath = Join-Path $frontendRoot "electron\tools\rcedit-x64.exe"
  if (Test-Path -LiteralPath $bundledRceditPath) {
    return Get-Item -LiteralPath $bundledRceditPath
  }

  $candidateRoots = @(
    (Join-Path $env:LOCALAPPDATA "electron-builder\Cache\winCodeSign"),
    (Join-Path $frontendRoot ".electron-builder-cache\winCodeSign")
  )

  $candidates = foreach ($root in $candidateRoots) {
    if (Test-Path -LiteralPath $root) {
      Get-ChildItem -Path $root -Recurse -Filter "rcedit-x64.exe" -ErrorAction SilentlyContinue
    }
  }

  return $candidates |
    Sort-Object -Property LastWriteTime -Descending |
    Select-Object -First 1
}

function Invoke-EditExecutableResources {
  param(
    [string]$FilePath,
    [string]$RceditPath
  )

  if (-not (Test-Path -LiteralPath $FilePath)) {
    return
  }

  $iconPath = Join-Path $frontendRoot "electron\assets\icon.ico"
  Write-Host "Aplicando icone e metadados em $FilePath"

  $resourceArguments = @(
    $FilePath,
    "--set-icon", $iconPath,
    "--set-version-string", "FileDescription", "VoltChat web and desktop client",
    "--set-version-string", "ProductName", "VoltChat",
    "--set-version-string", "CompanyName", "Volt Corp",
    "--set-version-string", "InternalName", "VoltChat",
    "--set-version-string", "OriginalFilename", "VoltChat.exe",
    "--set-file-version", $appVersion,
    "--set-product-version", $appVersion
  )

  & $RceditPath @resourceArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Falha ao aplicar icone/metadados em $FilePath"
  }
}

function Invoke-SignFile {
  param(
    [string]$FilePath,
    [string]$SignToolPath,
    [string]$Thumbprint
  )

  if (-not (Test-Path -LiteralPath $FilePath)) {
    return
  }

  Write-Host "Assinando $FilePath"
  $signArguments = @(
    "sign",
    "/sha1", $Thumbprint,
    "/fd", "sha256",
    "/tr", "http://timestamp.digicert.com",
    "/td", "sha256",
    "/d", "VoltChat",
    "/debug",
    $FilePath
  )

  & $SignToolPath @signArguments
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Falha ao assinar com timestamp. Tentando assinatura local sem timestamp..."
    $fallbackArguments = @(
      "sign",
      "/sha1", $Thumbprint,
      "/fd", "sha256",
      "/d", "VoltChat",
      "/debug",
      $FilePath
    )

    & $SignToolPath @fallbackArguments
    if ($LASTEXITCODE -ne 0) {
      throw "Falha ao assinar $FilePath"
    }
  }
}

Set-Location $frontendRoot
Write-UpdaterConfig

& (Join-Path $PSScriptRoot "setup-internal-code-signing.ps1")
& (Join-Path $PSScriptRoot "generate-installer-assets.ps1")

$publicCertificatePath = Join-Path $frontendRoot "electron\certificates\VoltCorp-Internal-Code-Signing.cer"
$publicCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($publicCertificatePath)
$env:VOLTCORP_SIGN_CERT_SHA1 = $publicCertificate.Thumbprint
$env:VOLTCORP_SIGN_CERT_SUBJECT = "Volt Corp Internal Code Signing"
Write-Host "Usando certificado Volt Corp thumbprint=$($publicCertificate.Thumbprint)"

$npm = (Get-Command "npm.cmd" -ErrorAction Stop).Source
Invoke-Checked -Command $npm -Arguments @("run", "build")

$signTool = Get-WindowsSignToolPath
if ($signTool) {
  $env:SIGNTOOL_PATH = $signTool.FullName
  Write-Host "Usando SIGNTOOL_PATH=$($signTool.FullName)"
} else {
  throw "signtool.exe do Windows SDK nao foi encontrado. Instale o Windows SDK ou defina SIGNTOOL_PATH."
}

$rcedit = Get-RceditPath
if ($rcedit) {
  Write-Host "Usando RCEDIT=$($rcedit.FullName)"
} else {
  throw "rcedit-x64.exe nao foi encontrado no cache do electron-builder. Gere uma vez com electron-builder ou habilite Developer Mode para popular o cache."
}

$electronBuilder = Join-Path $frontendRoot "node_modules\.bin\electron-builder.cmd"
$winUnpackedDirectory = Join-Path $frontendRoot "dist-desktop\win-unpacked"

Invoke-Checked -Command $electronBuilder -Arguments @("--dir")

$mainExecutable = Join-Path $winUnpackedDirectory "VoltChat.exe"
Invoke-EditExecutableResources -FilePath $mainExecutable -RceditPath $rcedit.FullName

Get-ChildItem -Path $winUnpackedDirectory -Recurse -Filter "*.exe" -ErrorAction SilentlyContinue |
  ForEach-Object {
    Invoke-SignFile -FilePath $_.FullName -SignToolPath $env:SIGNTOOL_PATH -Thumbprint $env:VOLTCORP_SIGN_CERT_SHA1
  }

if ($Directory) {
  exit 0
}

Invoke-Checked -Command $electronBuilder -Arguments @("--prepackaged", $winUnpackedDirectory)

Get-ChildItem -Path (Join-Path $frontendRoot "dist-desktop") -Filter "VoltChat-Setup-*.exe" -ErrorAction SilentlyContinue |
  Sort-Object -Property LastWriteTime -Descending |
  Select-Object -First 1 |
  ForEach-Object {
    Invoke-SignFile -FilePath $_.FullName -SignToolPath $env:SIGNTOOL_PATH -Thumbprint $env:VOLTCORP_SIGN_CERT_SHA1

    $distributionDirectory = Join-Path $frontendRoot "dist-desktop\package-$appVersion"
    $packagePath = Join-Path $frontendRoot "dist-desktop\VoltChat-Setup-$appVersion-with-certificate.zip"
    if (Test-Path -LiteralPath $distributionDirectory) {
      Remove-Item -LiteralPath $distributionDirectory -Recurse -Force
    }
    New-Item -ItemType Directory -Path $distributionDirectory -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $distributionDirectory
    Copy-Item -LiteralPath $publicCertificatePath -Destination $distributionDirectory
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "install-internal-certificate.ps1") -Destination (Join-Path $distributionDirectory "Instalar-Certificado.ps1")
    Copy-Item -LiteralPath (Join-Path $frontendRoot "electron\distribution\LEIA-ME-INSTALACAO.txt") -Destination $distributionDirectory
    Compress-Archive -Path (Join-Path $distributionDirectory "*") -DestinationPath $packagePath -CompressionLevel Optimal -Force
    Remove-Item -LiteralPath $distributionDirectory -Recurse -Force
    Write-Host "Pacote de distribuicao criado: $packagePath"
  }

Remove-OldDesktopArtifacts -OutputDirectory (Join-Path $frontendRoot "dist-desktop") -KeepVersions 2

param(
  [ValidateSet("staging", "production")]
  [string]$Environment = "production",
  [switch]$Directory
)

$ErrorActionPreference = "Stop"
$frontendRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = Split-Path -Parent $frontendRoot
$appVersion = ((Get-Content -LiteralPath (Join-Path $frontendRoot "package.json") -Raw | ConvertFrom-Json).version)
$channel = $Environment.ToLowerInvariant()
$isStaging = $channel -eq "staging"
$outputDirectoryName = if ($isStaging) { "dist-desktop-staging" } else { "dist-desktop" }
$productName = if ($isStaging) { "VoltChat Staging" } else { "VoltChat" }
$appId = if ($isStaging) { "com.voltcorp.app.staging" } else { "com.voltcorp.app" }
$artifactPrefix = if ($isStaging) { "VoltChat-Staging-Setup" } else { "VoltChat-Setup" }
$outputDirectory = Join-Path $frontendRoot $outputDirectoryName
$generatedBuilderConfig = Join-Path $frontendRoot ".electron-builder.generated.json"

function Get-DotEnvValue {
  param([string]$Name)

  $processValue = [Environment]::GetEnvironmentVariable($Name)
  if (-not [string]::IsNullOrWhiteSpace($processValue)) {
    return $processValue.Trim()
  }

  $envFiles = @(
    (Join-Path $frontendRoot ".env.desktop"),
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

function Require-HttpsUrl {
  param(
    [string]$Value,
    [string]$Name
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "$Name nao configurada."
  }
  $uri = $null
  if (-not [System.Uri]::TryCreate($Value, [System.UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne "https") {
    throw "$Name precisa ser uma URL HTTPS absoluta. Recebido: $Value"
  }
  return $Value.Trim()
}

function Write-RuntimeConfig {
  if ($isStaging) {
    $webUrl = Get-DotEnvValue -Name "VOLTCHAT_STAGING_WEB_URL"
    if ([string]::IsNullOrWhiteSpace($webUrl)) {
      $webUrl = "https://staging.dachbyte.tech/business/chat/"
    }
    $apiUrl = Get-DotEnvValue -Name "VOLTCHAT_STAGING_API_URL"
    if ([string]::IsNullOrWhiteSpace($apiUrl)) {
      $apiUrl = "https://staging.dachbyte.tech/business/chat/api"
    }
  } else {
    $webUrl = Get-DotEnvValue -Name "VOLTCHAT_PRODUCTION_WEB_URL"
    $apiUrl = Get-DotEnvValue -Name "VOLTCHAT_PRODUCTION_API_URL"
    $webUrl = Require-HttpsUrl -Value $webUrl -Name "VOLTCHAT_PRODUCTION_WEB_URL"
    $apiUrl = Require-HttpsUrl -Value $apiUrl -Name "VOLTCHAT_PRODUCTION_API_URL"
  }

  $webUrl = Require-HttpsUrl -Value $webUrl -Name "VoltChat web URL"
  $apiUrl = Require-HttpsUrl -Value $apiUrl -Name "VoltChat API URL"
  if (-not $webUrl.EndsWith('/')) { $webUrl = "$webUrl/" }
  $apiUrl = $apiUrl.TrimEnd('/')

  $webUri = [System.Uri]$webUrl
  $apiUri = [System.Uri]$apiUrl
  if ($webUri.AbsolutePath.TrimEnd('/') -ne "/business/chat") {
    throw "VoltChat web URL precisa usar o caminho canonico /business/chat. Recebido: $webUrl"
  }
  if ($apiUri.AbsolutePath.TrimEnd('/') -ne "/business/chat/api") {
    throw "VoltChat API URL precisa usar o caminho canonico /business/chat/api. Recebido: $apiUrl"
  }
  if ($webUri.Host -ne $apiUri.Host) {
    throw "VoltChat web e API precisam usar o mesmo host no desktop."
  }

  $runtimeConfigPath = Join-Path $frontendRoot "electron\runtime-config.json"
  $runtimeJson = [ordered]@{
    channel = $channel
    webUrl = $webUrl
    apiUrl = $apiUrl
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText(
    $runtimeConfigPath,
    $runtimeJson,
    (New-Object System.Text.UTF8Encoding($false))
  )
  Write-Host "Runtime desktop: channel=$channel web=$webUrl api=$apiUrl"
}

function Write-UpdaterConfig {
  $publicBaseUrl = Get-DotEnvValue -Name "R2_PUBLIC_BASE_URL"
  if ([string]::IsNullOrWhiteSpace($publicBaseUrl)) {
    $publicBaseUrl = Get-DotEnvValue -Name "CLOUDFLARE_R2_PUBLIC_BASE_URL"
  }
  $publicBaseUrl = Require-HttpsUrl -Value $publicBaseUrl -Name "R2_PUBLIC_BASE_URL"

  if ($isStaging) {
    $releasePrefix = Get-DotEnvValue -Name "R2_STAGING_RELEASE_PREFIX"
    if ([string]::IsNullOrWhiteSpace($releasePrefix)) {
      $releasePrefix = "desktop/staging/releases"
    }
  } else {
    $releasePrefix = Get-DotEnvValue -Name "R2_RELEASE_PREFIX"
    if ([string]::IsNullOrWhiteSpace($releasePrefix)) {
      $releasePrefix = "desktop/releases"
    }
  }

  $releasePrefix = $releasePrefix.Trim('/')
  $publicBaseUrl = $publicBaseUrl.TrimEnd('/')
  $manifestUrl = "$publicBaseUrl/$releasePrefix/windows/latest.json"
  $configPath = Join-Path $frontendRoot "electron\updater-config.json"
  $configJson = [ordered]@{
    channel = $channel
    manifestUrl = $manifestUrl
    source = "cloudflare-r2"
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText(
    $configPath,
    $configJson,
    (New-Object System.Text.UTF8Encoding($false))
  )
  Write-Host "Atualizador desktop [$channel]: $manifestUrl"
}

function Write-ElectronBuilderConfig {
  $package = Get-Content -LiteralPath (Join-Path $frontendRoot "package.json") -Raw | ConvertFrom-Json
  $config = $package.build
  $config.appId = $appId
  $config.productName = $productName
  $config.directories.output = $outputDirectoryName
  $config.win.artifactName = "$artifactPrefix-`$`{version`}.`$`{ext`}" 
  $config.nsis.shortcutName = $productName

  $config | ConvertTo-Json -Depth 30 | ForEach-Object {
    [System.IO.File]::WriteAllText(
      $generatedBuilderConfig,
      $_,
      (New-Object System.Text.UTF8Encoding($false))
    )
  }
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
    [string]$Prefix,
    [int]$KeepVersions = 2
  )

  if (-not (Test-Path -LiteralPath $OutputDirectory)) { return }

  $escapedPrefix = [regex]::Escape($Prefix)
  $artifactPattern = "^$escapedPrefix-(?<version>\d+\.\d+\.\d+)(?:-with-certificate)?\.(?:exe|zip|blockmap)$"
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

  return $candidates | Sort-Object -Property FullName -Descending | Select-Object -First 1
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

  return $candidates | Sort-Object -Property LastWriteTime -Descending | Select-Object -First 1
}

function Invoke-EditExecutableResources {
  param(
    [string]$FilePath,
    [string]$RceditPath
  )

  if (-not (Test-Path -LiteralPath $FilePath)) { return }
  $iconPath = Join-Path $frontendRoot "electron\assets\icon.ico"
  $displayName = if ($isStaging) { "VoltChat Staging" } else { "VoltChat" }
  Write-Host "Aplicando icone e metadados em $FilePath"

  $resourceArguments = @(
    $FilePath,
    "--set-icon", $iconPath,
    "--set-version-string", "FileDescription", "$displayName web and desktop client",
    "--set-version-string", "ProductName", $displayName,
    "--set-version-string", "CompanyName", "Volt Corp",
    "--set-version-string", "InternalName", $displayName,
    "--set-version-string", "OriginalFilename", "$displayName.exe",
    "--set-file-version", $appVersion,
    "--set-product-version", $appVersion
  )

  & $RceditPath @resourceArguments
  if ($LASTEXITCODE -ne 0) { throw "Falha ao aplicar icone/metadados em $FilePath" }
}

function Invoke-SignFile {
  param(
    [string]$FilePath,
    [string]$SignToolPath,
    [string]$Thumbprint
  )

  if (-not (Test-Path -LiteralPath $FilePath)) { return }
  Write-Host "Assinando $FilePath"
  $signArguments = @(
    "sign", "/sha1", $Thumbprint, "/fd", "sha256",
    "/tr", "http://timestamp.digicert.com", "/td", "sha256",
    "/d", $productName, "/debug", $FilePath
  )

  & $SignToolPath @signArguments
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Falha ao assinar com timestamp. Tentando assinatura local sem timestamp..."
    $fallbackArguments = @(
      "sign", "/sha1", $Thumbprint, "/fd", "sha256",
      "/d", $productName, "/debug", $FilePath
    )
    & $SignToolPath @fallbackArguments
    if ($LASTEXITCODE -ne 0) { throw "Falha ao assinar $FilePath" }
  }
}

$runtimeConfigPathForRestore = Join-Path $frontendRoot "electron\runtime-config.json"
$updaterConfigPathForRestore = Join-Path $frontendRoot "electron\updater-config.json"
$hadRuntimeConfig = Test-Path -LiteralPath $runtimeConfigPathForRestore
$hadUpdaterConfig = Test-Path -LiteralPath $updaterConfigPathForRestore
$originalRuntimeConfig = if ($hadRuntimeConfig) { [System.IO.File]::ReadAllText($runtimeConfigPathForRestore) } else { $null }
$originalUpdaterConfig = if ($hadUpdaterConfig) { [System.IO.File]::ReadAllText($updaterConfigPathForRestore) } else { $null }

Set-Location $frontendRoot

try {
  Write-RuntimeConfig
  Write-UpdaterConfig
  Write-ElectronBuilderConfig

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
    throw "rcedit-x64.exe nao foi encontrado."
  }

  $electronBuilder = Join-Path $frontendRoot "node_modules\.bin\electron-builder.cmd"
  $winUnpackedDirectory = Join-Path $outputDirectory "win-unpacked"

  Invoke-Checked -Command $electronBuilder -Arguments @("--config", $generatedBuilderConfig, "--dir")

  $mainExecutable = Join-Path $winUnpackedDirectory "$productName.exe"
  Invoke-EditExecutableResources -FilePath $mainExecutable -RceditPath $rcedit.FullName

  Get-ChildItem -Path $winUnpackedDirectory -Recurse -Filter "*.exe" -ErrorAction SilentlyContinue |
    ForEach-Object {
      Invoke-SignFile -FilePath $_.FullName -SignToolPath $env:SIGNTOOL_PATH -Thumbprint $env:VOLTCORP_SIGN_CERT_SHA1
    }

  if (-not $Directory) {
    Invoke-Checked -Command $electronBuilder -Arguments @("--config", $generatedBuilderConfig, "--prepackaged", $winUnpackedDirectory)

    Get-ChildItem -Path $outputDirectory -Filter "$artifactPrefix-*.exe" -ErrorAction SilentlyContinue |
      Sort-Object -Property LastWriteTime -Descending |
      Select-Object -First 1 |
      ForEach-Object {
        Invoke-SignFile -FilePath $_.FullName -SignToolPath $env:SIGNTOOL_PATH -Thumbprint $env:VOLTCORP_SIGN_CERT_SHA1

        $distributionDirectory = Join-Path $outputDirectory "package-$channel-$appVersion"
        $packagePath = Join-Path $outputDirectory "$artifactPrefix-$appVersion-with-certificate.zip"
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
        Write-Host "Pacote de distribuicao [$channel] criado: $packagePath"
      }

    Remove-OldDesktopArtifacts -OutputDirectory $outputDirectory -Prefix $artifactPrefix -KeepVersions 2
  }
} finally {
  Remove-Item -LiteralPath $generatedBuilderConfig -Force -ErrorAction SilentlyContinue
  if ($hadRuntimeConfig) {
    [System.IO.File]::WriteAllText($runtimeConfigPathForRestore, $originalRuntimeConfig, (New-Object System.Text.UTF8Encoding($false)))
  } else {
    Remove-Item -LiteralPath $runtimeConfigPathForRestore -Force -ErrorAction SilentlyContinue
  }
  if ($hadUpdaterConfig) {
    [System.IO.File]::WriteAllText($updaterConfigPathForRestore, $originalUpdaterConfig, (New-Object System.Text.UTF8Encoding($false)))
  } else {
    Remove-Item -LiteralPath $updaterConfigPathForRestore -Force -ErrorAction SilentlyContinue
  }
}

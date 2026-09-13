$ErrorActionPreference = "Stop"

# ============================================================
# DavanttiSuite - Pacote Business para análise/codificação
# ============================================================

$Root = Get-Location
$Source = Join-Path $Root "business"

$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$WorkRoot = Join-Path $Root "_chatgpt_business_export_$Timestamp"
$Stage = Join-Path $WorkRoot "business"
$Output = Join-Path $Root "business_chatgpt_$Timestamp"

# Limite conservador por pacote:
# ~400 MB de arquivos antes da compressão.
# Isso deixa margem confortável abaixo de 500 MB.
$MaxChunkBytes = 400MB

if (!(Test-Path $Source)) {
    Write-Host ""
    Write-Host "ERRO: pasta business nao encontrada:" -ForegroundColor Red
    Write-Host $Source
    exit 1
}

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host " DAVANTTISUITE -> BUSINESS PARA CHATGPT" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

New-Item -ItemType Directory -Force -Path $Stage | Out-Null
New-Item -ItemType Directory -Force -Path $Output | Out-Null

# ============================================================
# DIRETORIOS A IGNORAR
# ============================================================

$ExcludedDirectories = @(
    "node_modules",
    ".next",
    "build",
    "dist",
    "dist-desktop",
    "coverage",
    ".cache",
    ".npm-cache",
    ".pytest_cache",
    "__pycache__",
    ".idea",
    ".vscode",
    ".git",
    ".turbo",
    ".parcel-cache",
    ".vite",
    ".vite-temp",
    ".vercel"
)

# ============================================================
# ARQUIVOS / EXTENSOES A IGNORAR
# ============================================================

$ExcludedExtensions = @(
    ".db",
    ".sqlite",
    ".sqlite3",
    ".exe",
    ".msi",
    ".blockmap",
    ".zip",
    ".7z",
    ".rar",
    ".gz",
    ".tar",
    ".log",
    ".pyc",
    ".pyo",
    ".pfx",
    ".p12",
    ".pem",
    ".key",
    ".crt"
)

$ExcludedNames = @(
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".env.test",
    ".DS_Store",
    "Thumbs.db"
)

# ============================================================
# FUNCAO DE FILTRO
# ============================================================

function Should-ExcludeFile {
    param(
        [System.IO.FileInfo]$File
    )

    # Arquivos de ambiente reais
    if ($ExcludedNames -contains $File.Name) {
        return $true
    }

    # .env.* mas preserva .env.example
    if (
        $File.Name -like ".env.*" -and
        $File.Name -ne ".env.example"
    ) {
        return $true
    }

    # Extensoes proibidas
    if ($ExcludedExtensions -contains $File.Extension.ToLower()) {
        return $true
    }

    # Temporarios
    if ($File.Name -like "tmp_*") {
        return $true
    }

    if ($File.Extension.ToLower() -eq ".tmp") {
        return $true
    }

    return $false
}

# ============================================================
# LOCALIZAR ARQUIVOS VALIDOS
# SEM ENTRAR EM DIRETORIOS EXCLUIDOS
# ============================================================

Write-Host "Analisando business..." -ForegroundColor Yellow

function Get-SafeBusinessFiles {
    param(
        [string]$RootPath
    )

    $Result = New-Object System.Collections.Generic.List[System.IO.FileInfo]
    $Stack = New-Object System.Collections.Generic.Stack[string]

    $Stack.Push($RootPath)

    while ($Stack.Count -gt 0) {

        $CurrentDirectory = $Stack.Pop()

        try {
            $Items = Get-ChildItem `
                -LiteralPath $CurrentDirectory `
                -Force `
                -ErrorAction Stop
        }
        catch {
            Write-Host (
                "Ignorando pasta sem acesso: {0}" -f $CurrentDirectory
            ) -ForegroundColor DarkYellow

            continue
        }

        foreach ($Item in $Items) {

            # ==================================================
            # DIRETORIOS
            # ==================================================

            if ($Item.PSIsContainer) {

                if ($ExcludedDirectories -contains $Item.Name) {

                    Write-Host (
                        "Ignorando diretorio: {0}" -f $Item.FullName
                    ) -ForegroundColor DarkGray

                    continue
                }

                $Stack.Push($Item.FullName)

                continue
            }

            # ==================================================
            # ARQUIVOS
            # ==================================================

            try {

                if (Should-ExcludeFile $Item) {
                    continue
                }

                $Result.Add($Item)

            }
            catch {

                Write-Host (
                    "Ignorando arquivo problematico: {0}" -f $Item.FullName
                ) -ForegroundColor DarkYellow

                continue
            }
        }
    }

    return $Result
}

$Files = @(Get-SafeBusinessFiles -RootPath $Source)

Write-Host ""
Write-Host (
    "Arquivos selecionados: {0}" -f $Files.Count
) -ForegroundColor Green

Write-Host ("Arquivos selecionados: {0}" -f $Files.Count) -ForegroundColor Green

# ============================================================
# COPIAR PARA STAGING
# ============================================================

Write-Host ""
Write-Host "Criando copia limpa..." -ForegroundColor Yellow

foreach ($File in $Files) {

    $RelativePath = $File.FullName.Substring($Source.Length).TrimStart("\")

    $Destination = Join-Path $Stage $RelativePath
    $DestinationDir = Split-Path $Destination -Parent

    if (!(Test-Path $DestinationDir)) {
        New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null
    }

    Copy-Item $File.FullName $Destination -Force
}

# ============================================================
# RELATORIO
# ============================================================

$ReportPath = Join-Path $WorkRoot "EXPORT_INFO.txt"

$TotalBytes = (
    Get-ChildItem $Stage -Recurse -File |
    Measure-Object Length -Sum
).Sum

$TotalMB = [Math]::Round($TotalBytes / 1MB, 2)

@"
DavanttiSuite Business Export
=============================

Gerado em:
$(Get-Date)

Origem:
$Source

Arquivos:
$($Files.Count)

Tamanho sem compressao:
$TotalMB MB

Foram removidos automaticamente:
- node_modules
- builds/dist/.next
- caches
- bancos SQLite
- executaveis
- arquivos compactados
- logs
- arquivos temporarios
- .env e variantes privadas
- chaves e certificados privados

.env.example foi mantido.

Objetivo:
Analise e desenvolvimento do modulo VoltPrice.
"@ | Out-File $ReportPath -Encoding UTF8

Copy-Item $ReportPath (Join-Path $Stage "_EXPORT_INFO.txt")

# ============================================================
# DIVIDIR EM LOTES DE NO MAXIMO ~400 MB
# ============================================================

Write-Host ""
Write-Host "Separando pacotes..." -ForegroundColor Yellow

$CleanFiles = Get-ChildItem $Stage -Recurse -File |
    Sort-Object FullName

$Chunks = @()
$CurrentChunk = @()
$CurrentSize = 0

foreach ($File in $CleanFiles) {

    # Se arquivo individual for enorme
    if ($File.Length -gt $MaxChunkBytes) {
        Write-Host ""
        Write-Host "ATENCAO: arquivo grande ignorado:" -ForegroundColor Red
        Write-Host $File.FullName
        Write-Host ("Tamanho: {0:N2} MB" -f ($File.Length / 1MB))
        continue
    }

    if (
        ($CurrentSize + $File.Length -gt $MaxChunkBytes) -and
        $CurrentChunk.Count -gt 0
    ) {
        $Chunks += ,@($CurrentChunk)
        $CurrentChunk = @()
        $CurrentSize = 0
    }

    $CurrentChunk += $File
    $CurrentSize += $File.Length
}

if ($CurrentChunk.Count -gt 0) {
    $Chunks += ,@($CurrentChunk)
}

# ============================================================
# GERAR ZIP INDIVIDUAL PARA CADA LOTE
# ============================================================

$ChunkNumber = 1

foreach ($Chunk in $Chunks) {

    $ChunkName = "business_chatgpt_part_{0:D2}" -f $ChunkNumber
    $ChunkStage = Join-Path $WorkRoot $ChunkName

    New-Item -ItemType Directory -Force -Path $ChunkStage | Out-Null

    foreach ($File in $Chunk) {

        $RelativePath = $File.FullName.Substring($Stage.Length).TrimStart("\")

        $Destination = Join-Path $ChunkStage $RelativePath
        $DestinationDir = Split-Path $Destination -Parent

        if (!(Test-Path $DestinationDir)) {
            New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null
        }

        Copy-Item $File.FullName $Destination -Force
    }

    $ZipPath = Join-Path $Output "$ChunkName.zip"

    Write-Host ("Compactando {0}..." -f $ChunkName) -ForegroundColor Cyan

    Compress-Archive `
        -Path "$ChunkStage\*" `
        -DestinationPath $ZipPath `
        -CompressionLevel Optimal

    $ZipSizeMB = [Math]::Round(
        (Get-Item $ZipPath).Length / 1MB,
        2
    )

    Write-Host (
        "  -> {0} MB" -f $ZipSizeMB
    ) -ForegroundColor Green

    # Segurança extra
    if ((Get-Item $ZipPath).Length -gt 500MB) {
        Write-Host ""
        Write-Host "ATENCAO: ZIP ultrapassou 500 MB!" -ForegroundColor Red
        Write-Host "Reduza MaxChunkBytes para 300MB e rode novamente."
    }

    Remove-Item $ChunkStage -Recurse -Force

    $ChunkNumber++
}

# ============================================================
# LIMPEZA
# ============================================================

Remove-Item $WorkRoot -Recurse -Force

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host " EXPORTACAO CONCLUIDA" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Pasta final:"
Write-Host $Output -ForegroundColor Cyan
Write-Host ""
Write-Host ("Pacotes criados: {0}" -f $Chunks.Count)
Write-Host ""
Write-Host "Pode enviar os ZIPs dessa pasta para o ChatGPT." -ForegroundColor Yellow
Write-Host ""
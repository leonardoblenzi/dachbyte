param(
  [string]$ApiBase = "https://www.voltcorporation.com.br/chat-api",
  [string]$Username = ""
)

$ErrorActionPreference = "Stop"
$ApiBase = $ApiBase.TrimEnd('/')

if ([string]::IsNullOrWhiteSpace($Username)) {
  $Username = Read-Host "Usuario ou e-mail de administrador"
}

$securePassword = Read-Host "Senha" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $Password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$loginBody = @{
  username = $Username
  password = $Password
  remember_me = $false
} | ConvertTo-Json

Write-Host "Autenticando no VoltChat..."
$login = Invoke-RestMethod `
  -Method Post `
  -Uri "$ApiBase/auth/login" `
  -ContentType "application/json" `
  -Body $loginBody

if ([string]::IsNullOrWhiteSpace($login.access_token)) {
  throw "O login nao retornou access_token."
}

$headers = @{ Authorization = "Bearer $($login.access_token)" }
Write-Host "Disparando verificacao forcada para TODOS os usuarios online de TODAS as empresas..."
$result = Invoke-RestMethod `
  -Method Post `
  -Uri "$ApiBase/admin/desktop-updates/force-check" `
  -Headers $headers

Write-Host ""
Write-Host "Disparo concluido." -ForegroundColor Green
Write-Host "Empresas online: $($result.companies_online)"
Write-Host "Usuarios online: $($result.online_users)"
Write-Host "Conexoes ativas: $($result.connections)"
if ($result.companies) {
  Write-Host ""
  Write-Host "Por empresa:" -ForegroundColor Cyan
  foreach ($company in $result.companies) {
    Write-Host "- $($company.company_id): $($company.online_users) usuarios / $($company.connections) conexoes"
  }
}

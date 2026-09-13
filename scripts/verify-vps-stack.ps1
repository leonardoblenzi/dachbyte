param([string]$BaseUrl = "http://localhost", [switch]$CheckContainers)
$ErrorActionPreference = "Stop"
$routes = @("/healthz", "/ml/health", "/shopee/health", "/madeiramadeira/health", "/avantracking/health", "/davanttilog/health", "/skuleader/health", "/business/healthz", "/core/healthz", "/voltstock/healthz", "/chat/healthz", "/volt-price/healthz", "/chat-api/health")
foreach ($route in $routes) {
  $response = Invoke-WebRequest -Uri "$($BaseUrl.TrimEnd('/'))$route" -UseBasicParsing -TimeoutSec 20
  if ($response.StatusCode -ne 200) { throw "$route HTTP $($response.StatusCode)" }
  $body = $response.Content | ConvertFrom-Json
  if ($body.ok -ne $true -and $body.status -notin @("ok", "healthy")) { throw "${route}: invalid health response" }
  Write-Host "OK $route"
}
if ($CheckContainers) {
  docker compose --env-file infra/env/compose.env -f infra/compose.vps.yml ps
  if ($LASTEXITCODE -ne 0) { throw "docker compose ps failed" }
}

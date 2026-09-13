param(
  [switch]$Machine
)

$ErrorActionPreference = "Stop"

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$processValue = [Environment]::GetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "Process")
$userValue = [Environment]::GetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "User")
$machineValue = [Environment]::GetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "Machine")

Write-Host "ELECTRON_RUN_AS_NODE atual:"
Write-Host "  Process: $processValue"
Write-Host "  User: $userValue"
Write-Host "  Machine: $machineValue"

if ($userValue) {
  [Environment]::SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", $null, "User")
  Write-Host "Removido do ambiente do usuario."
}

if ($Machine) {
  if (-not (Test-IsAdministrator)) {
    throw "Para remover do ambiente da maquina, execute como administrador."
  }

  if ($machineValue) {
    [Environment]::SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", $null, "Machine")
    Write-Host "Removido do ambiente da maquina."
  }
}

if (-not $userValue -and -not ($Machine -and $machineValue)) {
  Write-Host "Nada para remover."
}

Write-Host "Abra um novo terminal ou reinicie o Explorer para a mudanca refletir em novos processos."

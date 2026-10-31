# Agenda a cópia diária produção -> espelho local (anonimizada) às 18:50.
# Rodar UMA vez, no PowerShell, de dentro da pasta back:
#   powershell -ExecutionPolicy Bypass -File scripts\espelho\agendar-diario.ps1
# Opções: -Hora 19:30   |   -Cru (cópia sem anonimizar)   |   -Remover (apaga a tarefa)
param([string]$Hora = '18:50', [switch]$Cru, [switch]$Remover)
$nome = 'FonoInova-Espelho-Diario'
if ($Remover) { Unregister-ScheduledTask -TaskName $nome -Confirm:$false; Write-Host "Tarefa $nome removida."; exit 0 }
$back = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
New-Item -ItemType Directory -Force -Path (Join-Path $back '.local') | Out-Null
$extra = if ($Cru) { ' -- --cru' } else { '' }
$cmd = "/c cd /d `"$back`" && npm run espelho:diario$extra >> .local\espelho-diario.log 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmd
$trigger = New-ScheduledTaskTrigger -Daily -At $Hora
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName $nome -Action $action -Trigger $trigger -Settings $settings -Description 'Copia producao (so leitura) para o espelho local fono_espelho' -Force | Out-Null
Write-Host "OK: $nome agendada todo dia as $Hora. Log em $back\.local\espelho-diario.log"
Write-Host "Testar agora: Start-ScheduledTask -TaskName $nome"

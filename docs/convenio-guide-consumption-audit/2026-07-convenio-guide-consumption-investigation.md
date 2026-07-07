# Investigação: consumo de guia de convênio inconsistente

- **Data:** 2026-07-07
- **Disparado por:** card da guia #16306580 (paciente Nicolas Lucca) mostrando "6 concluídas" na UI quando o calendário tinha 8 sessões realmente realizadas.
- **Status:** PR1-PR4 concluídos e executados em produção. Causa raiz estrutural identificada, não corrigida (backlog).

## Contexto

O `PatientInsuranceTab.jsx` mostra `Progresso clínico: X/totalSessions`, onde X vem de `InsuranceGuide.usedSessions`. Esse contador é incrementado em dois lugares redundantes do backend (ver "Causa raiz estrutural" no README), nenhum dos dois com garantia forte de consistência.

## Linha do tempo da investigação

1. **Sintoma:** card mostrava 6/10, calendário mostrava 8 sessões `Realizado` + 1 `Agendado`.
2. **Primeira hipótese (descartada):** achávamos que era só um contador desatualizado — bastaria recalcular `usedSessions = COUNT(Session.guideConsumed=true)`.
3. **Contradição encontrada:** o reconciliador oficial do sistema (`stateMachineConvenioReconciliation.service.js`), que já faz exatamente esse recálculo, apontava o valor correto como **1**, não 8. Ou seja, recalcular ingenuamente pioraria o problema.
4. **Descoberta 1 (PR1):** o reconciliador tinha um bug de implementação — duas chaves `$or` no mesmo objeto de query JS, a segunda sobrescrevendo a primeira silenciosamente. O filtro de `billingType='convenio'` nunca era aplicado; a métrica contava TODAS as sessions completed do sistema (particular/liminar incluídos). Drift real: 2176 → 126 depois de corrigir.
5. **Descoberta 2 (PR2):** o mecanismo pelo qual uma Session de convênio poderia nascer já `completed` (bypassando o consumo) foi rastreado até `generateInsurancePlanSessions.js`, que espalhava o Appointment inteiro (`...a`, incluindo `status`/`operationalStatus`) na criação da Session via `buildInsuranceSession()`. Corrigido com DTO explícito + guard na Factory que agora lança erro se tentarem criar uma Session de convênio/liminar já `completed`.
6. **Descoberta 3 (PR3):** ao fortalecer o `AppointmentWriteGuard` para cobrir `Model.findByIdAndUpdate`/`findOneAndUpdate` (que delegam pro mesmo `collection.findOneAndUpdate` nativo — confirmado empiricamente), os testes revelaram que o `strict` mode do Mongoose descartava silenciosamente as flags de autorização (`_fromCancelService` etc.) nesse caminho. Sem a correção, **todo cancelamento de agendamento em produção** teria gerado warning falso-positivo. Corrigido declarando as flags nos schemas (Appointment/Session/Payment) com `select: false`.
7. **Descoberta 4 (causa raiz real, não corrigida):** investigando por que sessões com `correlationId` **real** (prova de que passaram pelo `completeSessionV2` ao vivo) ainda tinham `guideConsumed:false`, achamos que existem **dois caminhos redundantes de consumo de guia** — `ConvenioHandler` (dentro de transação) e um hook `post('findOneAndUpdate')` em `Session.js` (fallback fora de transação) — e os dois falham silenciosamente (`console.warn`, sem throw) se a guia não estiver `active` no momento exato da tentativa. Isso explica a maioria das 31 guias divergentes sem precisar de uma causa pontual — é estrutural e pode voltar a acontecer.
8. **PR4:** com a causa raiz entendida, aplicamos reconstrução de evidência (não "correção de número"): sessões com `correlationId` real tiveram `guideConsumed` restaurado; `usedSessions` recalculado só onde seguro (nunca diminuindo sem prova).

## Resultado final

Ver [`evidence/before-after.md`](./evidence/before-after.md) pros números completos.

- `guideUsedSessionsInconsistent`: 31 → 11 guias.
- 72 sessões com evidência de domínio reconstruída.
- 0 reduções perigosas de `usedSessions` aplicadas.
- 2 guias deliberadamente fora do escopo (ver `decisions-log.md`).

## O que NÃO foi feito (backlog)

- Corrigir a causa raiz estrutural (dois caminhos de consumo silenciosos).
- Resolver as 11 guias remanescentes (Lote C sem evidência + guia HOLD).
- Substituir as flags `_from...` por contexto de execução (`AsyncLocalStorage`/`WriteContext`) — code smell reconhecido, não resolvido.

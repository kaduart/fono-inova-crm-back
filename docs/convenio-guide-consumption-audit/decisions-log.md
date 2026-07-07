# Decisions log — Convenio guide consumption audit

## DEC-001 — Não recalcular `usedSessions` diretamente

**Decisão:** nunca fazer `usedSessions = COUNT(guideConsumed=true)` como correção primária.
**Motivo:** `guideConsumed=false` não significa "sessão não consumiu a guia" — significa
"não existe evidência persistida de consumo" (ver dois caminhos silenciosos no README).
Recalcular direto arrisca subestimar consumo real e liberar mais sessões do que autorizado.
**Regra adotada:** reconstruir evidência (`Session.guideConsumed`) primeiro, deixar o
recálculo ser consequência, não a correção em si.

## DEC-002 — Critério dos lotes (A/B/C)

- **Lote A** (aplicado): `correlationId` começando com `complete_` — prova de que passou
  pelo `completeSessionV2` real. Backfill automático seguro.
- **Lote B** (vazio neste ciclo): `correlationId` `backfill_confirmed_*` — remediação manual
  anterior (script órfão, não encontrado no código atual). As sessões que tinham esse padrão
  já estavam com `guideConsumed:true` corretamente — não fizeram parte do gap analisado.
- **Lote C** (não tocado): sem `correlationId` nenhum, ou `notes` genérica de criação em
  lote ("criada via factory", "Pacote Convênio - Guia #X"). Precisa verificação individual
  contra `Appointment.history`/calendário antes de qualquer ação.

## DEC-003 — Guia 15924845 em HOLD_MANUAL_REVIEW

**Cenário:** `totalSessions=16`, evidência real seria 12+5=17 (ultrapassa o autorizado).
**Investigado:** as 5 sessões do Lote A são legítimas (guia correta, datas dentro da
vigência, sem duplicata óbvia no appointmentId). Não é erro de vínculo.
**Decisão:** não aplicar backfill nesta guia. Pode ser `totalSessions` desatualizado,
sessão vinculada à guia errada por decisão clínica válida, ou atendimento excedente
realmente prestado. Requer decisão comercial/humana, não é uma correção técnica.

## DEC-004 — Guia 16306580 excluída da Etapa 2 (recálculo de usedSessions)

**Cenário:** seria a única guia, das 21 processadas, onde `usedSessions` **diminuiria**
(6→5) ao recalcular.
**Motivo:** sabemos, por evidência externa (calendário do paciente, confirmado no início
da investigação), que o valor real é mais alto (8 sessões realmente realizadas). As 3
sessões restantes estão em Lote C (sem `correlationId`). Recalcular agora pioraria a
acurácia, movendo o número pra mais longe da realidade, não mais perto.
**Decisão:** manter `usedSessions=6` (mais perto de 8 do que 5 estaria) até o Lote C
dessa guia ser resolvido individualmente.

## DEC-005 — Escopo do reconciliador na Etapa 2

**Decisão:** não rodar `StateMachineConvenioReconciler.runSafeCorrections()` completo em
modo `--execute`. Ele mexeria em TODAS as guias do sistema e em outras categorias
(payment pointers, session pointers, appointment links) fora do escopo revisado neste
ciclo.
**Alternativa adotada:** script isolado, recalculando `usedSessions` só nas 20 guias
aprovadas (21 da Etapa 1 menos a 16306580 — ver DEC-004).

## DEC-006 — Auditoria persistida por sessão, não só o booleano

Cada sessão corrigida na Etapa 1 recebeu:

```js
{
  guideConsumed: true,
  guideConsumedAt: <timestamp real, extraído de statusHistory ou fallback>,
  guideConsumptionAudit: {
    source: 'PR4_CONVENIO_RECONCILIATION',
    reason: 'completed_session_missing_consumption_flag',
    evidence: 'complete_correlation_id',
    correlationId: <correlationId original>,
    executedAt: <timestamp da execução do backfill>
  }
}
```

**Motivo:** daqui a meses, "por que essa sessão tem `guideConsumed=true`?" precisa ter
resposta no próprio dado, não só num log/relatório que pode se perder.

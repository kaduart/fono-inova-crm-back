# Finance Integrity Audit — Consumo de guias de convênio (InsuranceGuide)

> Auditoria disparada em 2026-07-07 pelo card da guia #16306580 (paciente Nicolas
> Lucca) mostrando "6 concluídas" quando 8 sessões realmente aconteceram. Guarda o
> raciocínio, os PRs aplicados e a evidência de execução, pra que uma auditoria
> futura não precise refazer a investigação do zero.
>
> Não confundir com [`../finance-integrity-audit/`](../finance-integrity-audit/README.md) —
> aquela é sobre **Package** (particular per-session/prepaid, caso Isis/Enthony).
> Esta é sobre **InsuranceGuide** (convênio) e o pipeline Appointment→Session→Payment→Guide.

## Onde procurar o quê

| Preciso saber... | Arquivo |
|---|---|
| O que foi investigado, por quê, e o resultado final (4 PRs) | [`2026-07-convenio-guide-consumption-investigation.md`](./2026-07-convenio-guide-consumption-investigation.md) |
| Por que uma decisão específica foi tomada (HOLD, exclusões, lotes) | [`decisions-log.md`](./decisions-log.md) |
| Números antes/depois de cada etapa | [`evidence/before-after.md`](./evidence/before-after.md) |

## Resumo de uma linha por PR

1. **PR1** — reconciliador tinha bug de `$or` duplicado (JS overwrite) que inflava drift de 2176 para ~126 real; corrigido e testado.
2. **PR2** — `SessionFactory` (`buildInsuranceSession`/`buildLiminarSession`) ganhou guard contra nascer `status:'completed'`; `generateInsurancePlanSessions.js` parou de espalhar o Appointment inteiro (`...a`) na criação da Session.
3. **PR3** — `AppointmentWriteGuard` passou a interceptar `collection.findOneAndUpdate` (cobre `findByIdAndUpdate`/`findOneAndUpdate`); achado bug real: `strict` mode do Mongoose descartava as flags de autorização (`_fromCancelService` etc.) nesse caminho — corrigido declarando as flags no schema.
4. **PR4** — 72 sessões com evidência real (`correlationId` de `completeSessionV2`) tiveram `guideConsumed` reconstruído; `usedSessions` recalculado em 20 guias (nunca na direção de diminuir sem prova). Guia 15924845 (ultrapassaria o total autorizado) e guia 16306580 (ainda tem sessões sem evidência) ficaram de fora, propositalmente.

## Causa raiz estrutural (não corrigida ainda — backlog)

Existem **dois caminhos redundantes** de consumo de guia, os dois com falha silenciosa por design:
- `ConvenioHandler.buildPayment()` (dentro de transação, `completeSessionV2`)
- `Session.js` `post('findOneAndUpdate')` hook (fora de transação, fallback)

Se nenhum dos dois conseguir consumir (guia com status transitório, corrida de concorrência, exceção engolida), a sessão vira `completed` com `guideConsumed:false` e só um `console.warn` — nada quebra, nada alerta. Isso explica a maioria das 31 guias divergentes encontradas, sem precisar de uma causa pontual por guia.

**Não corrigido neste ciclo.** Vira PR futuro: unificar num único command owner do consumo e transformar falha em erro observável, não silencioso.

## Pendências (fila de decisão humana)

- Guia **15924845**: 5 sessões com evidência real ultrapassariam `totalSessions` (17 > 16). Pode ser `totalSessions` desatualizado, sessão vinculada errada, ou atendimento excedente. Decisão comercial, não técnica.
- Guia **16306580** e demais guias com sessões "Lote C" (sem `correlationId`, criadas por fatores/import): precisam verificação individual contra `Appointment.history`/calendário antes de qualquer backfill.
- 11 guias no total ainda com `usedSessions` divergente do reconciliador (dry-run pós-PR4).

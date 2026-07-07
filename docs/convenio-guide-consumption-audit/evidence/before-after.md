# Evidência — números antes/depois

## PR1 — Correção do reconciliador (diagnóstico, sem alteração de dados)

| Categoria | Antes | Depois |
|---|---:|---:|
| `sessionCompletedNoPaymentId` → `sessionCompletedWithoutResolvablePayment` | 1385 | 2 |
| `sessionCompletedWithActivePaymentButNoPaymentId` | 667 | removida (unificada) |
| `guideUsedSessionsInconsistent` | 31 | 31 |
| `canceledPaymentWithCompletedSession` | 26 | 26 |
| `activePaymentNoAppointment` | 61 | 61 |
| `activePaymentNoSession` | 6 | 6 |
| **Total** | **2176** | **126** |

Causa: chave `$or` duplicada no objeto de query (JS overwrite silencioso) + falta de
escopo por `billingType` na segunda métrica.

## PR4 Etapa 1 — Backfill de `guideConsumed` (Lote A)

- Guias analisadas com divergência: 31
- Guias no lote (Lote A com ao menos 1 sessão elegível): 21
- Sessões corrigidas: **72**
- Guias em HOLD (fora do lote): 1 (`15924845`)
- Validação pós-execução:
  - 72 sessões com `guideConsumed:true` + `guideConsumptionAudit.source='PR4_CONVENIO_RECONCILIATION'` ✅
  - `usedSessions` das 21 guias permaneceu **inalterado** nesta etapa (por design — Etapa 2 é separada) ✅
  - Guia HOLD: 0 sessões tocadas ✅

## PR4 Etapa 2 — Recálculo de `usedSessions` (escopado, 20 guias)

Guias processadas: 20 (das 21 da Etapa 1, excluindo `16306580` — ver `decisions-log.md` DEC-004)

| Guia | usedSessions antes | usedSessions depois | Direção |
|---|---:|---:|---|
| 15940686 | 15 | 16 | ↑ |
| 2324 | 3 | 5 | ↑ |
| 2325 | 1 | 2 | ↑ |
| 2525 | 3 | 5 | ↑ |
| 16145509 | 9 | 10 | ↑ |
| 16189806 | 9 | 10 | ↑ |
| 15650187 | 5 | 6 | ↑ |
| (demais 13 guias) | — | — | sem alteração (já corretas) |

Nenhuma guia teve `usedSessions` reduzido nesta etapa.

## Reconciliador — drift final pós-PR4

```
guideUsedSessionsInconsistent: 31 → 11
```

As 11 restantes: guia HOLD (`15924845`) + `16306580` (excluída por DEC-004) + guias
que não tinham nenhuma sessão elegível no Lote A (só Lote C, não tocado).

## Comandos usados (para reprodutibilidade)

Todos os scripts de execução (`tmp-pr4-*.mjs`) foram temporários e removidos após uso —
o racional e os critérios exatos estão documentados aqui e em `decisions-log.md`. A lógica
de classificação de lotes (A/B/C) pode ser reconstruída a partir do critério em DEC-002.

Query base de diagnóstico (read-only, reutilizável):

```js
// sessions completed de convênio sem guideConsumed, agrupadas por evidência
db.sessions.aggregate([
  { $match: { status: 'completed', guideConsumed: { $ne: true }, insuranceGuide: { $exists: true } } },
  { $addFields: {
      lote: {
        $switch: {
          branches: [
            { case: { $regexMatch: { input: { $ifNull: ['$correlationId', ''] }, regex: /^complete_/ } }, then: 'A' },
            { case: { $regexMatch: { input: { $ifNull: ['$correlationId', ''] }, regex: /^backfill_confirmed_/ } }, then: 'B' }
          ],
          default: 'C'
        }
      }
  }},
  { $group: { _id: '$lote', count: { $sum: 1 } } }
])
```

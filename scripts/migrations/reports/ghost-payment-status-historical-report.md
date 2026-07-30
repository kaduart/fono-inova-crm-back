# PR E — Ghost Payment Status: Relatório de Casos Históricos

**Gerado em:** 2026-07-30
**Categoria:** `GHOST_PAYMENT_STATUS`
**Quantidade restante:** 30 appointments

## Evento histórico identificado

Em **24/07/2026, por volta das 18:42 UTC**, foram cancelados **106 pagamentos particulares** (`billingType = particular`, `kind = session_payment`) com o motivo `canceledReason = guide_cycle_closed`.

Características dos pagamentos cancelados:

- `billingType`: `particular` em 100% dos casos
- `kind`: predominantemente `session_payment`
- `session`: `null` na maioria
- `createdAt`: julho/2026
- `updatedAt`: 2026-07-24 ~18:42

## Por que isso não é o `closeGuideBillingPeriod` canônico

O serviço `closeGuideBillingPeriod` atual:

- Só atua em guias `billingMode = per_month`.
- Só cancela appointments com `operationalStatus` em `[scheduled, pre_agendado, confirmed]`.
- Cancela o **appointment**, não o Payment diretamente.
- Atualiza `appointment.paymentStatus` para `canceled`.

Os 30 casos restantes:

- Não têm `insuranceGuide`.
- Têm `billingType = particular`.
- Têm `operationalStatus = completed`.
- Têm o Payment cancelado, mas o Appointment continua como `paid` / `isPaid = true`.

Conclusão: a operação de 24/07/2026 foi provavelmente um **script ou ação manual de limpeza** que usou o motivo `guide_cycle_closed` inadequadamente e não sincronizou os appointments.

## Por que não corrigimos automaticamente os 30 restantes

Todos os 30 appointments restantes têm `operationalStatus = completed`. Nesse estado, não é seguro alterar `paymentStatus` automaticamente porque:

1. O paciente pode ter sido atendido.
2. O profissional pode ter produzido o serviço.
3. A clínica pode ter reconhecido receita por outro caminho (dinheiro, pix, reembolso, etc.).
4. Alterar o status pode distorcer indicadores históricos e relatórios financeiros.

## O que foi corrigido

Os 4 casos seguros foram corrigidos:

| `operationalStatus` | Ação | Quantidade |
|---|---|---|
| `scheduled` | `paymentStatus → pending`, `isPaid → false` | 2 |
| `canceled` | `paymentStatus → canceled`, `isPaid → false` | 2 |

## Risco de recorrência

A causa ativa foi eliminada:

- `PATCH /api/v2/payments/:id` agora dispara `syncAppointmentPaymentStatus` quando o status muda para `canceled`/`refunded`.
- Novos cancelamentos de Payment via API administrativa sincronizarão o Appointment automaticamente.

## Próximos passos recomendados

1. Revisar manualmente os 30 casos restantes (lista completa em `ghost-payment-status-historical-report.json`).
2. Para cada caso, decidir:
   - Se houve recebimento real: corrigir/reativar o Payment ou ajustar o Appointment.
   - Se foi erro histórico: marcar com auditoria adequada.
3. Considerar uma política de que Payment `completed` só pode ser cancelado junto com o Appointment (ou com justificativa de negócio documentada).

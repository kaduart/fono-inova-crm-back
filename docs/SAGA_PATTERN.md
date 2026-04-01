# Saga Pattern - Documentação

## Visão Geral

O Saga Pattern gerencia transações distribuídas através de múltiplos serviços/workers.

## Fluxos

### ✅ Sucesso (Happy Path)

```
APPOINTMENT_REQUESTED
        ↓
APPOINTMENT_CREATED (pending)
        ↓
PAYMENT_REQUESTED
        ↓
PAYMENT_CONFIRMED
        ↓
APPOINTMENT_CONFIRMED (scheduled)
        ↓
NOTIFICATION_SENT
```

### ❌ Falha (Compensação)

```
APPOINTMENT_REQUESTED
        ↓
APPOINTMENT_CREATED (pending)
        ↓
PAYMENT_REQUESTED
        ↓
PAYMENT_FAILED
        ↓
APPOINTMENT_CANCELLED (rejected)  ← COMPENSAÇÃO
        ↓
NOTIFICATION_SENT (falha)
```

## Estados do Saga

| Estado | Descrição |
|--------|-----------|
| `REQUESTED` | Início do fluxo |
| `PENDING` | Aguardando processamento |
| `CONFIRMED` | Sucesso completo |
| `FAILED` | Falha com compensação |
| `COMPENSATING` | Executando compensação |
| `COMPENSATED` | Compensação completa |

## Compensações Implementadas

| Falha | Compensação |
|-------|-------------|
| Pagamento recusado | Cancela agendamento |
| Pacote sem crédito | Cancela agendamento |
| Guia inválida | Cancela agendamento |
| Conflito de horário | Rejeita agendamento |

## Exemplo de Código

```javascript
// Sucesso
await confirmPaymentFlow(payment, appointment, correlationId);

// Falha + Compensação
await compensatePaymentFailure(payment, appointment, error, correlationId);
```

## Monitoramento

```bash
# Ver sagas em andamento
db.appointments.find({ operationalStatus: 'pending' })

# Ver falhas
db.appointments.find({ operationalStatus: 'rejected' })

# Ver compensações
db.payments.find({ status: 'failed' })
```

## Alertas

- **P0**: Falha na compensação (agendamento pendente + pagamento falho)
- **P1**: Saga travada (>5 min em pending)

# Inativar / reativar paciente

**O que é:** botão "Inativar paciente" no PatientDashboard, com motivo de uma lista fixa
(`domain/patient/inactivationReasons.js`, igual a `src/constants/patientInactivationReasons.ts` no front).
Os motivos alimentam campanhas de retorno (filtro `GET /v2/patients?patientStatus=inactive&inactiveReason=<chave>`).

**Rota:** `PATCH /api/v2/patients/:id/status` (só admin e secretária)

```json
{ "status": "inactive", "reason": "financeiro", "note": "opcional", "cancelFutureAppointments": true }
```

Resposta: `{ status, futureAppointments, canceledFutureAppointments, patientView }`.

**Agenda (11/11/2026, pedido do Kadu):** ao inativar, por padrão as sessões futuras do paciente
(`scheduled`, `confirmed`, `pre_agendado`, data a partir de agora) são canceladas na MESMA transação
da inativação, via `bulkCancelAppointmentsCommand` (pacote, guia e liminar tratados pelo cancelamento padrão).

- `cancelSource = 'patient_inactivated'` (entra em `SYSTEM_CANCEL_SOURCES`: não conta como desistência no relatório).
- Motivo gravado: `Paciente inativado: <rótulo do motivo>`.
- Se qualquer cancelamento falhar, nada é gravado (409 `PATIENT_INACTIVATION_CANCEL_FAILED`).
- `cancelFutureAppointments: false` inativa sem mexer na agenda (caixa "Cancelar as sessões futuras" desmarcada no modal).
- Reativar não recria agenda.

**Testes:** `tests/unit/patient-status-update.test.js`, `tests/unit/patient-inactivation-route.test.js`,
`tests/integration/patient-inactivation-cancels-agenda.test.js` (precisa de mongod local).

# Delete Cascade Contract

> **Regra de domínio:** nenhuma entidade raiz (`Patient`, `Appointment`, `Package`) deve ser deletada diretamente. Toda deleção deve passar por um command de domínio responsável por limpar ou tratar todas as referências dependentes.

`Patient` e `Appointment` não são entidades isoladas. São agregados com dependências financeiras e clínicas. A exclusão precisa respeitar o agregado inteiro.

---

## 1. Patient

### Entidades obrigatórias para tratar

Ao deletar um `Patient`, o command deve garantir o tratamento de:

1. `Payment`
2. `Appointment`
3. `Session`
4. `Package`
5. `PatientBalance`
6. Projeções/Views (`PatientsView`, `PaymentsView`, etc.)

> **Exceção:** `FinancialLedger` é imutável por design e **não** é deletado. Os registros contábeis permanecem mesmo após a exclusão do paciente.

### Fluxo de deleção

```text
Payment
  ↓
Appointment
  ↓
Session
  ↓
Package
  ↓
Balances/Ledgers
  ↓
Patient
  ↓
Views
```

### Implementação centralizada

```js
import { execute as deletePatientCommand } from '../domains/patient/commands/deletePatientCommand.js';

await deletePatientCommand(patientId, {
  user,
  reason: 'motivo_da_exclusao'
});
```

### Pontos de entrada obrigatórios

- `DELETE /api/patients/:id` → `back/routes/patient.js`
- `DELETE /api/v2/patients/:id` → `back/routes/patient.v2.js`
- `PATIENT_DELETE_REQUESTED` → `back/domains/clinical/workers/patientWorker.js`

### ❌ Nunca executar

```js
await Patient.findByIdAndDelete(id);
await PatientsView.findOneAndDelete({ patientId: id });
```

diretamente em controller, worker ou script.

---

## 2. Appointment

### Entidades obrigatórias para tratar

Ao deletar um `Appointment` isolado (sem pacote):

- `Session` vinculada
- `Payment` vinculado quando for exclusivo daquele atendimento

### Exceções financeiras

- `package_receipt`: não deve ser deletado junto com o appointment, pois representa a aquisição do pacote.
- Registros financeiros que representem aquisição de pacote seguem regra própria do pacote.

### Implementação centralizada

```js
import deleteAppointmentCommand from '../services/appointment/commands/deleteAppointmentCommand.js';

await deleteAppointmentCommand.execute(appointmentId, user);
```

> **Nota:** agendamentos vinculados a pacotes devem ser **cancelados**, não deletados, para preservar integridade financeira.

---

## 3. Package

Deve usar **somente** o comando centralizado:

```js
import deletePackageCommand from '../services/billing/commands/deletePackageCommand.js';
```

Nunca apagar `Package` manualmente.

---

## 4. Saneamento de legado e `integrityStatus`

Pagamentos criados antes da correção do cascade podem ter perdido o vínculo com `Patient`. Esses registros não são removidos automaticamente quando representam receita real. Em vez disso, são **marcados** para distinguir legado de problemas novos.

### Status possíveis

```js
integrityStatus: {
  null / 'healthy'        // Sem problema de integridade
  'relinked'              // Vínculo recuperado (ex: package_receipt corrigido)
  'legacy_patient_deleted' // Paciente deletado; payment mantido por registro financeiro
  'manual_review'         // Requer revisão humana antes de qualquer ação
}
```

### Metadados obrigatórios ao marcar

```js
integrityMetadata: {
  detectedAt,        // quando foi identificado
  originalPatientId, // patientId antes da correção
  originalPatientName,
  reason,            // motivo da quebra
  notes,             // detalhes da decisão
  treatedAt,         // quando foi tratado
  treatedBy          // script/operador
}
```

### Auditoria

```bash
# Verificar payments órfãos NÃO TRATADOS
node back/scripts/auditoria-payments-orfaos.mjs

# A auditoria ignora integrityStatus !== null, evitando reprocessar legado
```

---

## 5. Motivação / Histórico de incidentes

### Incidente 2026-07-29

- **119 payments órfãos** encontrados
- **R$ 18.811,57** relacionados
- **R$ 7.251,00** em payments `paid` afetando caixa

### Causa

A deleção de `Patient` removia somente:

- `Patient`
- `PatientsView`

mantendo:

- `Payment`
- `Appointment`
- `Session`
- `Package`

### Resultado

Dados financeiros permaneciam ativos sem a entidade principal, inflando dashboards e relatórios.

### Correção

- Criação do `deletePatientCommand` centralizado e transacional
- Aplicação nas rotas v1, v2 síncrono e no `patientWorker`
- Correção do `cleanup-duplicate-appointments.js` para também remover payments
- Documentação deste contrato

### Saneamento legado realizado em 2026-07-29

| Ação | Qtd | Valor | Destino |
|---|---|---|---|
| Deletados (massa de teste + ajuste técnico) | 14 | R$ 1.851,00 | `limpar-payments-legado.mjs` |
| Relinkados (`package_receipt`) | 2 | R$ 1.440,00 | `tratar-payments-orfaos-legado.mjs --op=fix-package-receipt` |
| Relinkados (`session_payment` mismatch) | 6 | R$ 1.500,00 | `tratar-payments-orfaos-legado.mjs --op=fix-session-mismatch` |
| Relinkados (`manual` mismatch) | 1 | R$ 150,00 | `tratar-payments-orfaos-legado.mjs --op=fix-manual-mismatch` |
| Marcados `legacy_patient_deleted` | 5 | R$ 1.030,00 | `tratar-payments-orfaos-legado.mjs --op=mark-legacy` |
| Marcados `healthy` | 8 | R$ 1.280,00 | `tratar-payments-orfaos-legado.mjs --op=mark-healthy` |
| **Total tratado** | **36** | **R$ 7.251,00** | — |

### Resultado

- Auditoria passou a reportar **R$ 0,00** em payments `paid` órfãos não tratados.
- Todos os pagamentos com `integrityStatus` definido são ignorados pela auditoria, evitando reprocessamento de legado.
- Novos órfãos só podem surgir por bypass do `deletePatientCommand`.

---

## 6. Teste de regressão sugerido

```text
1. Criar Patient
2. Criar Package
3. Criar Session
4. Criar Appointment
5. Criar Payment
6. Deletar Patient
7. Verificar:
   - payments = 0
   - appointments = 0
   - sessions = 0
   - packages = 0
   - patientBalances = 0
   - financialLedgers = 0
   - patientsViews = 0
   - patient = 0
```

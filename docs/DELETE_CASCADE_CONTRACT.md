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

## 4. Como auditar

```bash
# Verificar payments órfãos
node back/scripts/auditoria-payments-orfaos.mjs

# Analisar casos de investigação
node back/scripts/analise-investigar-payments.mjs
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

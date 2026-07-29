# Contrato de Integridade para Deleção de Entidades

> **Regra de ouro:** a deleção de `Patient` ou `Appointment` nunca pode deixar payments, sessions, appointments, packages, balances ou ledgers órfãos. Sempre use os commands centralizados e transacionais.

## 1. Deleção de Patient

### Comportamento obrigatório

Ao deletar um paciente, o sistema deve remover **em cascata** e dentro de uma única transação MongoDB:

1. `Payment` vinculados ao paciente (`patient: id`)
2. `Appointment` vinculados ao paciente (`patient: id`)
3. `Session` vinculadas ao paciente (`patient: id`)
4. `Package` vinculados ao paciente (`patient: id`)
5. `PatientBalance` vinculado ao paciente (`patient: id`)
6. `FinancialLedger` vinculados ao paciente (`patient: id`)
7. `PatientsView` do paciente (`patientId: id`)
8. Por fim, o próprio `Patient`

### Implementação centralizada

```js
import { execute as deletePatientCommand } from '../domains/patient/commands/deletePatientCommand.js';

await deletePatientCommand(patientId, {
  user,
  reason: 'motivo_da_exclusao'
});
```

### Pontos de entrada que devem usar o command

- `DELETE /api/patients/:id` → `back/routes/patient.js`
- `DELETE /api/v2/patients/:id` → `back/routes/patient.v2.js`
- `PATIENT_DELETE_REQUESTED` → `back/domains/clinical/workers/patientWorker.js`

## 2. Deleção de Appointment

### Comportamento obrigatório

Ao deletar um appointment isolado (sem pacote), o sistema deve:

1. Remover a referência do appointment na `Session` vinculada (`$unset: { appointmentId: 1 }`)
2. Deletar o `Payment` vinculado, **exceto** se `kind === 'package_receipt'`
3. Remover o appointment do array `appointments` do `Patient`
4. Deletar o próprio `Appointment`

### Implementação centralizada

```js
import deleteAppointmentCommand from '../services/appointment/commands/deleteAppointmentCommand.js';

await deleteAppointmentCommand.execute(appointmentId, user);
```

> **Nota:** agendamentos vinculados a pacotes devem ser cancelados, não deletados, para preservar integridade financeira.

## 3. Deleção de Pacote (Package)

Já existe comando centralizado:

```js
import deletePackageCommand from '../services/billing/commands/deletePackageCommand.js';
```

Esse command já deleta appointments, sessions e payments vinculados ao pacote.

## 4. Anti-padrões que causam órfãos

❌ Nunca faça isso:

```js
await Patient.findByIdAndDelete(id);
await PatientsView.findOneAndDelete({ patientId: id });
// esquece payments, appointments, sessions, packages, balances, ledgers
```

❌ Nunca deletar appointments duplicados sem deletar payments vinculados:

```js
await Session.deleteMany({ appointmentId: id });
await Appointment.deleteOne({ _id: id });
// esquece Payment
```

## 5. Como auditar

```bash
# Verificar payments órfãos
node back/scripts/auditoria-payments-orfaos.mjs

# Analisar casos de investigação
node back/scripts/analise-investigar-payments.mjs
```

## 6. Histórico de incidentes

- **2026-07-29:** auditoria identificou 119 payments órfãos, sendo R$ 7.251,00 em status `paid`, causados por deleção de pacientes sem cascade.
- **Correção:** criação do `deletePatientCommand` e aplicação nas rotas v1, v2 e worker.

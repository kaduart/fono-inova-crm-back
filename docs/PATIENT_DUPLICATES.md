# Pacientes duplicados — trava, relatório e mescla

Criado em 03/11/2026. Caso que motivou: "BENJAMIN MARCAL BALDEZ" (sem telefone, Particular) e "Benjamin Marçal Baldez" (com telefone, Unimed Campinas) — a mesma criança em dois cadastros.

## Por que nascia duplicado

- A trava antiga só rodava se o cadastro viesse **com telefone** e o número fosse igual. Sem telefone, passava.
- Cada caminho que cria paciente conferia de um jeito: agenda externa com paciente novo e lead → paciente não conferiam nada; pré-agendamento reaproveitava **qualquer** paciente com o mesmo telefone (irmãos caíam no cadastro errado).
- A agenda externa trata "nome digitado sem escolher da lista" como paciente novo.
- O campo `source` não existia no schema — a origem se perdia.

## Regra única (`utils/patientDuplicateCheck.js` → `findPossibleDuplicates`)

| Nível | Quando |
|---|---|
| `forte` | CPF igual, **ou** nome parecido + (mesmo nascimento **ou** mesmo telefone) |
| `nome` | só o nome parecido |

"Nome parecido" = igual depois de tirar acento, caixa e espaços extras, aceitando 1 letra de diferença. Telefone compara os últimos 8 dígitos. Mesmo telefone com nome diferente (irmãos) **não** é duplicado.

## Onde é aplicada

| Caminho | Comportamento |
|---|---|
| `POST /api/v2/patients` e `POST /api/patients` (cadastro do ERP) | 409 `POSSIBLE_DUPLICATE` com `candidates[]`. Reenviar com `confirmNotDuplicate: true` cria e registra `duplicateReview.confirmedDistinct`. CPF igual continua bloqueio sem exceção. |
| `createAppointmentCommand` (`isNewPatient`, agenda externa/ERP) | 1 match forte → reaproveita o cadastro. Senão cria e grava `possibleDuplicateOf`. `patientInfo.confirmNotDuplicate` pula o reaproveitamento. |
| `confirmPreAgendamentoCommand`, `importFromAgenda` (novo e pré) | Igual ao de cima. Sem nome, telefone só reaproveita se houver **um** cadastro com o número. |
| `leadController` (converter lead) | 1 match forte → vincula o lead ao paciente existente. |

Campos novos em `Patient`: `source`, `possibleDuplicateOf[]`, `duplicateReview { confirmedDistinct, confirmedBy, confirmedAt }`.

## Rotas (`routes/patients/duplicates.js`)

- `GET /api/patients/check-duplicate?fullName=&dateOfBirth=&phone=&cpf=&excludeId=` — para o aviso enquanto digita (admin/secretária).
- `GET /api/patients/duplicates/report` — grupos por mesmo nome, mesmo CPF ou marcados na criação; traz nº de agendamentos e `sugestaoPrincipal` (admin/secretária). Não quebra mais com data de nascimento inválida.
- `POST /api/patients/duplicates/confirm-distinct { ids }` — "são pessoas diferentes".
- `POST /api/patients/duplicates/merge { primaryId, duplicateId, dryRun }` — prévia por padrão. Execução real: `dryRun: false`, `confirm: "MESCLAR"` e `PATIENT_MERGE_ENABLED=true` no ambiente.

## Mesclar (`domains/patient/commands/mergePatientsCommand.js`)

Numa transação:
1. Todo campo que referencia paciente (descoberto pelos schemas: `ref: 'Patient'` ou campo `patient`/`patientId`, inclusive dentro de arrays) passa do duplicado para o principal — 36 campos em 34 coleções em 03/11.
2. `PatientBalance`: junta transações e soma os totais (um registro por paciente).
3. Campos vazios do principal são completados com os do duplicado; "Particular" dá lugar ao convênio real.
4. O duplicado sai pelo `deletePatientCommand` (cópia integral em `deletedpatientarchives`, reason `merged_into:<principal>`).
5. A view do principal é reconstruída.

`FinancialLedger` **não** é alterado (imutável); os lançamentos ficam com o id antigo, rastreável pelo arquivo.

### Produção

`PATIENT_MERGE_ENABLED` fica **desligado** no Render. Produção é só leitura: ensaiar no espelho local (`npm run espelho:mesclar -- <principal> <duplicado>`) e só ligar com autorização explícita do Kadu.

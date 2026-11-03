# Evolução: rascunho e finalização

Fase 1 da sprint do prontuário (03/11/2026). Antes de mexer neste fluxo, leia este arquivo.

## O que é

O terapeuta escreve a evolução enquanto o sistema salva sozinho. Até ele clicar em "Finalizar evolução", ela é um **rascunho**: só ele (e o admin) vê, e ela não conta em lugar nenhum.

## Por quê

- O terapeuta tem de 5 a 10 minutos entre pacientes. Antes, um clique fora do modal ou uma queda de internet apagava tudo.
- O relatório mensal para a família (fase 2) só pode usar evolução revisada. O status `finalized` é essa garantia.

## Regras

1. `Evolution.status`: `draft` | `finalized`. **Sem default.** Evolução antiga (sem o campo) conta como finalizada.
2. Toda leitura clínica (lista, gráfico, progresso, histórico, busca, pendências, protocolos, painel do terapeuta) usa `FINALIZED_FILTER` (`{ status: { $ne: 'draft' } }`), exportado de `models/Evolution.js`. Leitura nova também precisa usar.
3. Um rascunho por agendamento: o índice único `unique_evolution_per_appointment` (já existia) garante que salvar várias vezes nunca duplica.
4. Paciente, profissional e data vêm do **agendamento**, nunca do corpo da requisição.
5. Status só muda por `POST /:id/finalize` (ou pelo `POST /` antigo, que agora finaliza o rascunho do mesmo agendamento se ele existir). `PUT /:id` ignora `status`, `finalizedAt` e `lastAutosaveAt`.
6. Rascunho não publica evento. O `EVOLUTION_CREATED` sai uma vez só, na finalização.
7. Finalizar exige especialidade e conteúdo clínico (texto, observação, nota de área ou métrica).

## Rotas (`/api/v2/evolutions`)

| Rota | O que faz |
|---|---|
| `PUT /draft` | Upsert do rascunho. Corpo: `appointmentId` (obrigatório), campos clínicos e `baseAutosaveAt` (opcional). |
| `GET /drafts` | Rascunhos do profissional logado (admin: `?doctorId=`). |
| `GET /appointment/:appointmentId` | Evolução do agendamento (rascunho só para o dono e o admin). |
| `POST /:id/finalize` | Finaliza. É idempotente: o segundo clique devolve `meta.alreadyFinalized`. |
| `GET /patient/:id/last?specialty=` | Última evolução **finalizada**, para pré-preencher o modal. |
| `GET /pending` | Cada linha traz `lastAppointmentId`, `lastCompletedTime` e `draft` (`evolutionId`, `appointmentId`, `lastAutosaveAt`) quando há rascunho. |
| `GET /pending/by-doctor` | Só admin (403 para os demais). Pendências da clínica agrupadas por profissional ativo, mais atrasado primeiro: `pendingCount`, `draftCount`, `oldestDaysLate`, `phoneNumber` e `items` (mesma linha do `/pending` + `daysLate`). `meta` traz `total`, `doctors`, `drafts`, `oldestDaysLate`. Só leitura; alimenta "Evoluções em atraso" no Dashboard admin. |

Erros do `PUT /draft`:

- `409 EVOLUTION_ALREADY_FINALIZED`: a evolução já foi fechada. O front para o autosave.
- `409 DRAFT_CONFLICT`: outro aparelho salvou depois do `baseAutosaveAt` deste. O front avisa e recarrega.
- `403`: o atendimento é de outro profissional.

## Testes

`tests/unit/evolution-v2-draft.test.js`, contra um Mongo real em memória. Sem internet para baixar o binário, aponte `MONGOMS_SYSTEM_BINARY` para um `mongod` local.

## Checklist do DOMAIN_INVARIANTS

1. **Entidade:** Evolution. Não mexe em Appointment, Session, Payment nem Package.
2. **Impacto:** as leituras de evolução e as pendências do terapeuta.
3. **Invariantes:** nenhuma financeira. A pendência continua calculada no back (invariante 7).
4. **Migração:** nenhuma. Ausência de status = finalizada.
5. **Front:** rascunho some das listas e dos gráficos, e a pendência ganha "Continuar rascunho".
6. **Dados antigos:** compatíveis (há teste com documento legado sem status).

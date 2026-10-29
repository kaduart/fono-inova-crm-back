# Datas canceladas ausentes — Convênio

Entrada no modal Sessões da guia, no bloco Houve cancelamentos? Informar datas. Reutiliza CancellationEntryForm e GenerationCancellationFlow da liminar. A prévia e a confirmação combinam geração e cancelamentos na mesma transação.

POST `/api/v2/insurance-plans/:id/historical-cancellations`, autenticado (admin/superadmin/secretary). Corpo: `{dryRun: boolean, cancellations: [...]}`. De 1 a 50 linhas com especialidade, data, horário, profissional, valor informado, motivo e solicitante obrigatório: `clinic`, `patient` ou `professional` (Clínica, Paciente/responsável, Terapeuta). Solicitante nunca é inferido do usuário registrador.

`dryRun:true` não grava. A confirmação revalida em transação; aplicações concorrentes serializam pela versão do plano. Mesmo cancelado da mesma guia, profissional e especialidade é preservado. Atendimento ativo/concluído, outra guia, múltiplos registros ou sessão órfã no horário gera conflito, sem alterações no lote. Casos independentes podem ser aplicados removendo as linhas conflitantes.

Se ausente, o command dedicado registerCanceledInsuranceAppointments cria Appointment canceled e Session canceled pela sessionFactory, com referências originais da guia/plano/paciente, vínculo bidirecional e histórico de autor/data. A data do pedido permanece null quando não informada; canceledAt registra a entrada no sistema. Não move cancelados antigos, não completa sessões, não executa transição de um atendimento existente.

Não modifica InsuranceGuide.usedSessions/status/closedAt, Payment, créditos, BillingSubmission, InsuranceBatch ou ledger. Não chama billing, mensagens, notificações ou replay de eventos. O valor informado descreve o registro e não representa dívida nem receita. Consultas da guia leem os appointments canônicos; não é criado read-model financeiro.

Replan e geração pulam as datas com history.details.historicalCancellation e não restauram esses cancelados. O comportamento anterior para outros registros continua protegido pelas regras financeiras existentes.

Referências: docs/architecture/CANONICAL_FLOW.md e CANONICAL_FILES.md (command transacional de entrada manual), docs/architecture/ADR-002-BILLING-SUBMISSION.md, docs/fluxo-faturamento-convenios.md e back/docs/CANCEL_REQUESTER_INTEGRATION_CONTRACT.md. A entrada manual de registro já cancelado é distinta da criação de agendamento ativo pelo BillingOrchestrator e da completação pelo fluxo canônico. Não usa documentos marcados como históricos para recriar caminhos removidos.

## Geração combinada
POST /api/v2/insurance-plans/:id/generate-sessions recebe cancellations, startDate e dryRun. A prévia executa as validações e a geração dentro de uma transação abortada: nada é persistido. A confirmação revalida e faz commit único. Conflitos abortam cancelamentos e geração juntos. O equivalente liminar usa /v2/liminar-contracts/:id/plans/:planId/generate-sessions. O solicitante usa clinic, patient ou professional e fica separado de canceledBy. Cancelados não reduzem a quantidade ativa solicitada nem consomem guia; autorizações, validade e saldo continuam limitando a geração. Sem reativação automática de cancelados no fluxo novo.

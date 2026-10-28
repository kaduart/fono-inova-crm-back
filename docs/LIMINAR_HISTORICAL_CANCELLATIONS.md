# Cancelamentos ausentes da agenda — liminar

Entrada manual no modal Gerar sessões do ContractCard. A ação é separada da geração futura.

`POST /api/v2/liminar-contracts/:id/plans/:planId/historical-cancellations`

Autenticação obrigatória; admin, superadmin e secretary. Corpo: `dryRun` booleano obrigatório e `cancellations` (1–50 linhas). Cada linha contém `specialty`, `date` YYYY-MM-DD, `time` HH:mm, `doctorId`, `sessionValue` numérico confirmado pelo operador, `reason`, `cancelRequester` (patient/professional/clinic). `cancelRequestedAt` é opcional: desconhecido permanece null.

Prévia (`dryRun:true`) não escreve. Aplicação revalida os mesmos critérios dentro de transação. Datas futuras usam o cancelamento normal da agenda. O plano precisa pertencer ao contrato e ao mesmo paciente; especialidade precisa pertencer ao plano; profissional precisa existir.

- Mesmo paciente/dia/hora com cancelado do mesmo contrato, especialidade e profissional: preserva, sem sobrescrever motivo ou valores.
- Mesmo horário com ativo, concluído, outro contrato/profissional/especialidade ou múltiplos registros: conflito, sem alteração; o lote não é aplicado. Remova a linha conflitante para aplicar casos independentes.
- Ausente: cria Appointment canceled e Session canceled via sessionFactory, com vínculos bidirecionais e histórico de autoria. Não usa recorrência para afirmar realização. CanceledAt é a data do registro, não uma data histórica presumida do pedido.

Não cria Payment, não movimenta crédito, não envia notificações nem outbox. O valor informado é descritivo, não obrigação financeira ou receita. Não altera atendimento existente nem move cancelados automaticamente. Sessões canceladas não consomem o limite autorizado.

As aplicações concorrentes escrevem a versão do plano dentro da transação para serializar lotes, pois o índice de horários ativos não cobre cancelados. A reexecução preserva registros já existentes. Na geração futura os cancelados não são restaurados/reutilizados nem recriados no mesmo slot. `revived` permanece na resposta por compatibilidade, com valor zero. Reposições automáticas não fazem parte desta ação.

Não há nova coleção ou mudança global de schema. Origem manual histórica fica em Appointment.history.details.historicalCancellation. Todo código e validação desta issue são locais, sem publicação ou execução em produção.

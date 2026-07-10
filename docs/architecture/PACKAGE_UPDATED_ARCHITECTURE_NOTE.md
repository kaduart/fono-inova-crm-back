# PACKAGE_UPDATED — nota arquitetural

> Auditoria realizada em 2026-07-09, disparada pela dúvida sobre se `updatePackageCommand`
> ainda precisava ser criado. Resultado: já existia, já estava conectado, testado e idempotente.
> Esta nota existe para que uma auditoria futura não reabra a mesma investigação do zero.

## Estado confirmado

- **Producer real e único:** `services/billing/commands/updatePackageCommand.js`, chamado por
  `PUT /api/v2/packages/:id` (`routes/package.v2.js`). `packageController.v2.js` **não** publica
  `PACKAGE_UPDATED` — só publica `PACKAGE_CREATED` (fluxo de venda de pacote).
- **Consumidores reais:** `packageProjectionWorker.js` e `patientProjectionWorker.js`, ambos fazem
  *rebuild* completo a partir da fonte (`Package`), não dependem de campos específicos do payload.
  `packageValidationWorker.js` não tem handler para este evento, apesar de listado antes na
  documentação — corrigido.
- **Payload não é contrato de dados a ser mantido campo-a-campo** — é metadado de auditoria
  (`packageId, patientId, doctorId, updatedFields[], updatedBy`). Os consumidores ignoram
  `updatedFields` e sempre recarregam do banco.
- **Campos imutáveis já protegidos na origem** (`sanitizeUpdates` em `updatePackageCommand.js`):
  `_id, createdAt, patient, doctor, totalValue, payments, sessions, appointments, metadata` nunca
  entram no `$set`. **Payment continua SSOT financeiro** — este command não pode alterar valor
  nem pagamentos do pacote.
- **Idempotência:** herdada do `saveToOutbox` genérico (`eventId` único, índice único no Mongo,
  `jobId` do BullMQ com dedup) — não é um mecanismo próprio deste evento.

## O que NÃO fazer numa próxima auditoria

Não assumir que `PACKAGE_UPDATED`/`updatePackageCommand` precisam ser criados ou migrados — já
estão. Se a dúvida for sobre outro aspecto do fluxo de Package, começar por aqui.

## Pendência conhecida, não corrigida

`case 'PACKAGE_UPDATE_REQUESTED'` ainda existe em `packageProjectionWorker.js`, sem nenhum
publicador ativo no projeto (confirmado por grep em todo o `back/` e em `docs/`). Deixado
propositalmente intocado — remover código morto foi julgado fora do escopo da entrega atual.

# Comandos executados, em ordem

Todos rodados a partir de `back/`, contra `fono_inova_prod`, em 2026-07-07.

## Investigação (read-only)

```bash
node scripts/domain-health-check.js
node scripts/domain-health-check.js --patient=685b0cfaaec14c7163585b5b
node scripts/package-completion-integrity-inventory.js
node scripts/package-completion-integrity-report-v2.js
node scripts/inspect-package-patient-integrity.js --patient=69bbf5d42d22a57a538ed310
```

## Verificação de evidência de uso do fallback V1 (read-only, ad-hoc)

Reconstrução do fingerprint do fallback V1 via `history.action` + ausência de
`correlationId`, filtrando ruído de 2 backfills não versionados encontrados na base
(`backfill_operational_status_completed`, rodado em 2026-07-01 e 2026-07-03). Consulta
final usada (MongoDB shell, via script ad-hoc, não persistida em `back/scripts/` por ser
específica desta investigação):

```js
db.appointments.find({
  operationalStatus: 'completed',
  correlationId: { $exists: false },
  history: {
    $elemMatch: {
      action: { $in: ['confirmed', 'confirmed_with_balance'] },
      timestamp: { $gte: ISODate('2026-07-02T00:00:00.000Z') }
    }
  }
})
// Resultado: 0 documentos — nenhuma evidência de uso do V1 desde o fix de 02/07.
```

## Correção do classificador (código, commitado)

- `back/utils/packageFinancialModel.js` (novo)
- `back/scripts/package-completion-integrity-report-v2.js` (edit: exclui `model in [liminar, convenio]`)

## Instrumentação do fallback V1 (código, commitado)

- `back/services/completeFallbackMetrics.js` (edit: grava `AuditLog` CRITICAL a cada acionamento)
- `back/routes/appointment.v2.js` (edit: passa `correlationId: requestId` pro fallback)
- `back/routes/health.v2.js` (edit: `GET /complete-fallback?days=N` consulta `AuditLog`, não só memória)

## Execução do saneamento (escreve em produção)

```bash
# 1. Fila de auditoria primeiro — não toca domínio financeiro
DRY_RUN=false node scripts/freeze-audit-required-queue.js
# → 55 casos congelados em AuditLog (severity WARNING)

# 2. Sync de estado sombra — só depois de validar dry-run + adicionar before/after
#    e checagem otimista no script
DRY_RUN=false node scripts/sync-package-completion-shadow-state.js
# → 426 correções aplicadas, 0 conflitos, 426 AuditLog (severity INFO) com before/after
```

## Verificação pós-execução

```bash
node scripts/package-completion-integrity-report-v2.js
# → OK: 700 (274+426), APENAS_DESNORMALIZACAO: 0, demais categorias inalteradas
```

## Scripts de diagnóstico pontual (não persistidos)

Durante a investigação, vários scripts `.mjs` temporários foram usados pra inspecionar
appointments/payments específicos da Isis e depois removidos (`rm`) — não têm valor de
longo prazo isolados; o resultado deles está consolidado nos documentos desta pasta e no
histórico da conversa. Os únicos scripts mantidos em `back/scripts/` são os reutilizáveis,
listados no `README.md` desta pasta.

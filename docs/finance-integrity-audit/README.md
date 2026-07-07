# Finance Integrity Audit — Pacotes particulares (per-session/prepaid)

> Pacote de auditoria da investigação de 2026-07-07, disparada pelo caso da paciente
> Isis Caldas Rebelatto. Guarda o raciocínio, as regras de classificação e a evidência
> de execução, pra que uma auditoria futura não precise refazer a investigação do zero.

## Onde procurar o quê

| Preciso saber... | Arquivo |
|---|---|
| O que foi investigado, por quê, e o resultado final | [`2026-07-package-integrity-investigation.md`](./2026-07-package-integrity-investigation.md) |
| Como classificar um Package/Payment como saudável ou suspeito | [`classification-rules.md`](./classification-rules.md) |
| Por que uma decisão específica foi tomada | [`decisions-log.md`](./decisions-log.md) |
| Por que o caso do Enthony NÃO é duplicidade | [`evidence/enthony-case.md`](./evidence/enthony-case.md) |
| Números antes/depois da correção de 426 registros | [`evidence/report-v2-before-after.md`](./evidence/report-v2-before-after.md) |
| Comandos exatos rodados, em que ordem | [`evidence/queries-used.md`](./evidence/queries-used.md) |

## Scripts vivos (ficam em `back/scripts/`, não aqui)

- `domain-health-check.js` — auditoria geral de integridade de domínio (Appointment↔Session↔Payment↔Package↔Guide), read-only
- `package-completion-integrity-report-v2.js` — classificação por causa provável (usa `classification-rules.md`)
- `inspect-package-patient-integrity.js --patient=<id>` — investigação pontual de 1 paciente, pra distinguir duplicidade real de classificação errada
- `sync-package-completion-shadow-state.js` — corretor seguro (nunca cria/altera Payment, só sincroniza rótulo/referência já resolvidos pela fonte de verdade)
- `freeze-audit-required-queue.js` — grava a fila de casos que precisam de decisão humana em `AuditLog`
- `utils/packageFinancialModel.js` — classificador de modelo financeiro do Package (usar SEMPRE antes de qualquer heurística financeira sobre Package)

## Como consultar a fila de casos pendentes

```js
db.auditlogs.find({ action: 'package_completion_audit_required' }).sort({ createdAt: -1 })
```

55 casos congelados em 2026-07-07 (ver evidência). Nenhum foi corrigido — decisão humana pendente.

## Regra de ouro pra próxima vez

**Nunca** classifique o comportamento financeiro de um Package usando só `paymentType`.
Use `classifyPackageFinancialModel()` de `utils/packageFinancialModel.js`. O motivo está
documentado em `evidence/enthony-case.md` — ignorar isso já gerou 17 falsos positivos
de "cobrança duplicada" numa única investigação.

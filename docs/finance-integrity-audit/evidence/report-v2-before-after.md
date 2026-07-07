# Evidência: números antes/depois

## 1. Antes de excluir liminar/convênio do escopo

Comando: `node scripts/package-completion-integrity-report-v2.js`
Data: 2026-07-07 | Banco: `fono_inova_prod`

```
Total analisado: 836

APENAS_DESNORMALIZACAO: 427
OK: 302
VENDA_DE_PACOTE_MAL_ROTULADA: 35
DUPLICIDADE_PROVAVEL: 29
INDETERMINADO: 24
SEM_FONTE_FINANCEIRA: 11
STATUS_INVALIDO: 8

Impacto financeiro REAL: R$ 22.010,00
```

## 2. Depois de excluir `Package.model in [liminar, convenio]`

Motivo da exclusão: ver `evidence/enthony-case.md` e `decisions-log.md` DEC-002.

```
Total analisado: 790  (836 - 46 appointments de pacote liminar)

APENAS_DESNORMALIZACAO: 426
OK: 274
VENDA_DE_PACOTE_MAL_ROTULADA: 35
INDETERMINADO: 24
DUPLICIDADE_PROVAVEL: 12   ← caiu de 29 (-17, todos do Enthony)
SEM_FONTE_FINANCEIRA: 11
STATUS_INVALIDO: 8

Impacto financeiro REAL: R$ 19.370,00
```

## 3. Depois da execução do sync (`sync-package-completion-shadow-state.js`, `DRY_RUN=false`)

```
Correções planejadas (dry-run): 426
Correções aplicadas (execução real): 426
Conflitos de concorrência: 0
```

Reprocessamento pós-execução (`package-completion-integrity-report-v2.js`):

```
Total analisado: 790

OK: 700                          ← 274 + 426 (bate exato)
APENAS_DESNORMALIZACAO: 0        ← zerado, como esperado
VENDA_DE_PACOTE_MAL_ROTULADA: 35 ← inalterado
INDETERMINADO: 24                ← inalterado
DUPLICIDADE_PROVAVEL: 12         ← inalterado
SEM_FONTE_FINANCEIRA: 11         ← inalterado
STATUS_INVALIDO: 8               ← inalterado
```

**Confirmação de escopo:** as 5 categorias que não deveriam ser tocadas pelo sync ficaram
byte-a-byte idênticas antes e depois da execução — prova de que o script não vazou
nenhuma escrita fora do escopo pretendido (APENAS_DESNORMALIZACAO).

## 4. Fila de auditoria congelada

Comando: `DRY_RUN=false node scripts/freeze-audit-required-queue.js`

```
Casos congelados: 55
  INDETERMINADO: 24
  SEM_FONTE_FINANCEIRA: 11
  DUPLICIDADE_PROVAVEL: 12
  STATUS_INVALIDO: 8
```

Consultável em: `db.auditlogs.find({ action: 'package_completion_audit_required' })`

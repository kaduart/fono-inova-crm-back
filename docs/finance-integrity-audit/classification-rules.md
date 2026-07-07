# Financial Classification Rules — Package × Payment × Appointment

> Implementado em `utils/packageFinancialModel.js`. Qualquer script/heurística que analise
> saúde financeira de um `Package` DEVE passar por `classifyPackageFinancialModel()` antes
> de aplicar qualquer regra de duplicidade/cobertura. Ver `evidence/enthony-case.md` pra
> saber o que acontece quando isso não é feito.

## Por que isso existe

`Package.paymentType === 'full'` **não** significa "pacote pré-pago comum". Pacotes
`liminar` também usam `paymentType: 'full'`, mas seguem uma regra financeira totalmente
diferente. Confundir os dois gera falsos positivos de "cobrança duplicada" — foi
exatamente o que aconteceu nesta investigação.

## As quatro categorias

### 1. PREPAID (particular, pacote fechado)

**Critério:** `Package.model === 'prepaid'` ou (`paymentType === 'full'` e `model !== 'liminar'`)

**Comportamento esperado:**
```
Venda do pacote (1 Payment, valor = Package.totalValue)
        +
Sessões completed consomem o crédito — NÃO geram Payment novo
```

**Não deve existir:** um `Payment` avulso, com valor batendo com 1 sessão (não com o
pacote inteiro), vinculado a um appointment desse pacote, com `isFromPackage: false`.
Isso é sinal de `DUPLICIDADE_PROVAVEL` — dinheiro real cobrado em cima de algo que já
deveria estar coberto.

**Exceção documentada:** cobertura insuficiente (edge case) — `particularHandler.js` cria
um Payment real nesse caso, mas **sempre** com `isFromPackage: true` (safety net contra
poluir o caixa — ver comentário "Bug confirmado 2026-06-01" no próprio handler).

### 2. PER_SESSION (particular, paga por sessão)

**Critério:** `Package.model === 'per_session'` ou `paymentType === 'per-session'`

**Comportamento esperado:**
```
Cada sessão completed → 1 Payment (status: paid | pending)
```

**Não deve existir:**
- Sessão completed sem NENHUM Payment (`SEM_FONTE_FINANCEIRA`) — dinheiro sem fonte de
  verdade, precisa confirmação da clínica (pago no ato ou fiado).
- Payment com `status: consumed` — esse status é exclusivo do modelo prepaid/liminar,
  nunca válido pra per-session (`STATUS_INVALIDO`).

### 3. JUDICIAL_LIMINAR

**Critério:** `Package.model === 'liminar'` ou `Package.type === 'liminar'`

**Comportamento esperado — DOIS eventos financeiros legítimos e independentes:**
```
Processo judicial paga parcela periódica
        ↓
Payment kind='package_receipt' (entrada de caixa real)

Sessão acontece
        ↓
domain/liminar/recognizeRevenue.js
        ↓
Payment de reconhecimento de receita / consumo do crédito judicial (pode ter status
'consumed', 'paid' conforme o momento do reconhecimento)
```

**Isso NÃO é duplicidade.** Um pacote liminar com 1-2 `package_receipt` + N payments de
sessão é o padrão correto — pagamento recebido ≠ receita reconhecida. **Nunca** rodar a
heurística de duplicidade do PREPAID em cima de um pacote liminar.

### 4. CONVENIO

**Critério:** `Package.model === 'convenio'`, `Package.type === 'convenio'`, ou
`Appointment.billingType === 'convenio'`

**Comportamento esperado:** ligado a `InsuranceGuide` (autorização, `usedSessions`,
`totalSessions`), faturamento por lote (`InsuranceBatch`), não por Payment individual
imediato. Fora do escopo desta investigação — tem sua própria arquitetura documentada em
`back/docs/` (ver invariantes de convênio no `DOMAIN_INVARIANTS.md`).

## Tabela de decisão rápida

| Situação encontrada | Categoria | Ação |
|---|---|---|
| Prepaid sem Payment, `paymentStatus` != `package_paid` | Desnormalização | Sync automático seguro |
| Prepaid com Payment, `isFromPackage: true` | OK | Nada a fazer |
| Prepaid com Payment real, valor ≈ 1 sessão | 🚨 DUPLICIDADE_PROVAVEL | Fila de auditoria |
| Prepaid com Payment real, valor ≈ pacote inteiro | VENDA_DE_PACOTE_MAL_ROTULADA | Baixa prioridade, não é risco |
| Per-session completed sem Payment | 🚨 SEM_FONTE_FINANCEIRA | Fila de auditoria, confirmar com a clínica |
| Per-session com Payment, status inválido (`consumed`) | 🚨 STATUS_INVALIDO | Fila de auditoria |
| Per-session com Payment válido, só rótulo/ref desatualizado | Desnormalização | Sync automático seguro |
| Liminar com `package_receipt` + payments de sessão | OK (por desenho) | Nada a fazer — não aplicar heurística de duplicidade |
| Convênio | Fora de escopo | Usar análise específica de convênio |

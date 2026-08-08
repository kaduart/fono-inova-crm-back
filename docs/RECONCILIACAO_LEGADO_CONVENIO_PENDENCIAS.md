# Reconciliação legada de convênio — pendências

**Atualizado:** 2026-08-08 · **Escopo:** competências **anteriores a junho/2026**. Junho em diante é faturamento vigente e vai pelo fluxo novo (`BillingSubmission`, ADR-002) — não entra aqui.

**Ferramenta:** `back/services/insuranceGuide/reconcileLegacyInsuranceBatch.js` (`dryRun: true` por padrão).
**Inventário:** `back/logs-archive/conferencia-nf-legado.csv`
**Lotes criados, para preencher NF real:** `back/logs-archive/lotes-legado-para-preencher-nf.csv`

---

## 1. Concluído

| Paciente | Competência | Lote | Sessões | Bruto | Efeito |
|---|---|---|---|---|---|
| Nicolas Lucca | 2026-01 | `6a774219194d9ff2d8b98d85` | 18 | R$ 1.440,00 | 18 `received` preservados |
| Nicolas Lucca | 2026-02 | `6a77421a194d9ff2d8b98db1` | 18 | R$ 1.440,00 | 18 promovidos → `billed` |
| Davi Felipe Araújo | 2026-01 | `6a77495cd1b7e22b702d5f13` | 13 | R$ 1.820,00 | 13 `received` preservados |
| Davi Felipe Araújo | 2026-02 | `6a77495dd1b7e22b702d5f3f` | 14 | R$ 1.960,00 | 14 promovidos → `billed` |
| Gabriel Alves Leite | 2026-02 | `6a775cb0dfc9be02315805e0` | 5 | R$ 400,00 | 2 `billed` preservados + 3 promovidos → `billed` |

**Davi Felipe (Unimed Campinas), meses restantes:** março (15 sess/R$ 2.100), abril (9/R$ 1.260) e maio (12/R$ 1.680) **já estão em lote** — quantidades batem com a folha, mas os lotes não têm número de NF. Junho (R$ 1.400, com *"FALTA"* circulado na folha) tem **5 conflitos de Payment** e só metade das sessões; julho (2329+2328, 6 sess/R$ 840) **bate exato** e está sem lote.

⚠️ **Números de guia divergem folha × sistema** em março/abril/maio do Davi:

| Mês | Folha | Sistema |
|---|---|---|
| março | 6644, 5588, **23216** | 6644, 5588, **2321** |
| abril | **5564, 5565, 5563** | **564, 565, 566** |
| maio | 2324, 2325, **2326** | 2324, 2325, **2525** |

Não se sabe de que lado está o erro. Vincular sempre pelo número **conferido**, nunca pelo escrito.

Verificado: ledger inalterado (2418), nº de payments inalterado (720), soma financeira inalterada (R$ 42.650). Conferência `matched`, diferença R$ 0,00 nos dois.

---

## 1b. Regra por convênio (confirmada 2026-08-08)

| Convênio | billingMode | ISS | Observação |
|---|---|---|---|
| **Unimed Anápolis** | `per_guide` hoje | **2,01%** | **Mudou de `per_month` → `per_guide`** entre abril/maio. É o único com a virada — foco da reconciliação |
| **Unimed Campinas** | `per_month` sempre | não cadastrado | 27/27 guias do Davi Felipe em `per_month`. Totais fecham redondos por não ter retenção |
| Unimed Fesp | `per_guide` | 0 | — |
| Unimed Goiânia / Bradesco | `per_month` | não cadastrado | — |

---

## 1c. Folhas conferidas em 2026-08-08 — Unimed Anápolis

### Kauana Queiroz Gomes Naves — fevereiro/março de 2026 🟡 4 sessões presas em lote misto

| Guia | Folha | Sistema | |
|---|---|---|---|
| 2027 Fono | 8 sess · R$ 640,00 | 8 sess · R$ 640,00 | ✓ 6 em fevereiro + 2 em março |
| 2028 T.O | 9 sess · R$ 720,00 | 9 sess · R$ 720,00 | ✓ 7 em fevereiro + 2 em março |
| 2029 Psicologia | 3 sess · R$ 240,00 | 3 sess · R$ 240,00 | ✓ |
| **Total** | **20 sess · R$ 1.600,00** → NF **R$ 1.567,84** | **20 sess · R$ 1.600,00** | **R$ 0,00** |

Retenção confere: R$ 32,16 = **2,01%**. Zero conflitos de Payment.
A foto registra **"Fevereiro / Março"**: as 4 sessões antes consideradas ausentes são exatamente 2 Fono + 2 T.O realizadas em março.

As 4 sessões de março estão presas no lote genérico `6a70ec113263b7cb5e5f898d`, que mistura 25 sessões de Kauana, Nicolas, Joaquim e Benjamim, não possui NF e tem período invertido. As 16 de fevereiro estão sem lote. Para reconciliar a NF da Kauana é necessário extrair atomicamente essas 4 sessões do lote misto e criar um lote legado exclusivo com as 20; não duplicar nem simplesmente anexar a NF ao lote atual.

### Gabriel Alves Leite — 2026-02 ✅ reconciliado

| Guia | Folha | Sistema | |
|---|---|---|---|
| 15614089 T.O | 2 sess · R$ 160,00 | 2 sess · R$ 160,00 | ✓ |
| 15736718 Fono | 1 sess · R$ 80,00 | 1 sess · R$ 80,00 | ✓ |
| 15859841 Psicologia | 2 sess · R$ 160,00 | 2 sess · R$ 160,00 | ✓ |
| **Total** | **5 sess · R$ 400,00** → NF **R$ 391,96** | **5 sess · R$ 400,00** | **R$ 0,00** |

Retenção R$ 8,04 = **2,01%**. **Contagem e valores batem exatamente**, zero conflitos.
Lote criado: `6a775cb0dfc9be02315805e0` (`LEGACY-NF-SEM-NUMERO-2026-02-1786207408454`).
Os 2 Payments já `billed` foram preservados e os 3 `pending_billing` foram promovidos.
O número real e a data documental definitiva continuam pendentes na planilha de preenchimento; a data operacional histórica usada foi 05/03/2026, já presente nos dois Payments faturados.
A anotação *"Gabriel dias duplicados valores não bate"* refere-se a dias duplicados na folha de presença — **os valores batem**. A reconciliação foi autorizada pelo PO após a conferência da folha.

Dois pontos a observar:
- guia **15859841**: folha diz *Psicologia*, sistema diz **psicopedagogia**;
- guia **15614089**: as 2 sessões têm status diferentes (`billed` + `pending_billing`) — o comando promove só a pendente.

### Isabela Ferreira De Mendonca — abril 🟡 nota cobre 3 competências

Folha marcada **"OK"**: guia **16007195**, Fono, **NF R$ 857,21**, cobrindo **"abril, maio e junho"**.

Sistema: apenas **1 sessão em maio** (R$ 80, status ⚠️ `pending`) fora de lote.

**❓ A CONFERIR:** R$ 857,21 não decompõe em múltiplo de R$ 80 nem com ISS de 2,01% (bruto implícito ≈ R$ 874,79 → 10,93 sessões). A nota atravessa três meses — precisa saber quantas sessões de cada.

---

## 2. Pendente — precisa da folha física

### 2.1 Nicolas Lucca — março/2026 🔴 bloqueado

As 10 sessões concluídas **já estão num lote**, mas num lote inutilizável:

```
LOT-unimed-anapolis-1785785361964-135
  status=sent · origin=— · NF=— · invoiceDate=—
  período = 2026-04-10 → 2026-03-25   ← fim ANTES do início
  25 sessões · R$ 2.000,00
  Nicolas em março: 10 · OUTROS PACIENTES: 15
```

Causa conhecida: `buildBatchFromGuides` sem filtro de data arrastando sessões para lote genérico.

**Divergência com a folha:**

| Guia | Folha | Sistema |
|---|---|---|
| 15510345 | 1 sessão · R$ 80 | 1 · R$ 80 ✓ |
| 15655250 | **11 sessões · R$ 880** | **9 · R$ 720** |
| **Total** | **12 · R$ 960 → NF R$ 940,70** | **10 · R$ 800** |

**❓ A CONFERIR NA FOLHA:** faltam **2 sessões da guia 15655250**. Em março o Nicolas tem 9 canceladas e 3 agendadas além das 10 concluídas. Verificar se 2 das canceladas foram realizadas, ou se a NF pegou 2 sessões de outro mês.

**Decisão pendente** (3 caminhos):
1. deixar como está — as 10 estão `billed`, só sem NF nem agrupamento correto;
2. extrair do lote genérico e criar lote legado com a NF 940,70 (corrige também os outros 2 pacientes presos nele);
3. só anexar a NF ao lote existente — rápido, mas mantém 3 pacientes misturados e período invertido.

### 2.2 Nicolas Lucca — abril/maio (modelo **por guia**)

A partir de abril/maio o faturamento virou **por guia** (a folha marca "INÍCIO POR GUIA"). A NF de **R$ 1.168,92** cobre a guia 15650231, 15 sessões, faturada em junho.

Estado: a guia tem 13 sessões concluídas, **12 já em lote**. Sobra **1 sessão de maio (R$ 80)** fora.

**❓ A CONFERIR:** a NF de 1.168,92 não fecha por nenhuma combinação óbvia — 15 × R$ 100 = R$ 1.500; 15 × R$ 80 = R$ 1.200; com ISS 2,01% nenhum dos dois dá 1.168,92. É a linha onde a folha tem **"DQ N BATEU"** escrito à mão. Precisa da nota.

### 2.3 Demais pacientes — não iniciados

Fortes candidatos a NF em papel (já `billed`/`received` **sem lote**):

| Paciente | Comp. | Convênio | Guias | Sess | Bruto | Status |
|---|---|---|---|---|---|---|
| Davi Felipe Araújo | 2026-01 | unimed-campinas | 2124(6) + 9232(3) + 8855(4) | 13 | R$ 1.820,00 | 13 `received` |
| Davi Felipe Araújo | 2026-02 | unimed-campinas | 2026(5) + 2025(5) + 2024(4) | 14 | R$ 1.960,00 | 14 `pending_billing` |
| Kauana Q. G. Naves | 2026-02 | unimed-anapolis | 2028(7) + 2029(3) + 2027(6) | 16 | R$ 1.280,00 | 16 `billed` |

Sobras de maio (1 a 3 sessões — podem ser resto de nota emitida ou sessão que nunca entrou em nota):

| Paciente | Comp. | Convênio | Guias | Sess | Bruto | Status |
|---|---|---|---|---|---|---|
| Benjamim Rocha Simão | 2026-05 | unimed-anapolis | 15924845(1) | 1 | R$ 80,00 | `pending_billing` |
| Evandro M. Faustino | 2026-05 | bradesco-saude | 2026599(1) | 1 | R$ 150,00 | `pending_billing` |
| Isabela F. De Mendonca | 2026-05 | unimed-anapolis | 16007195(1) | 1 | R$ 80,00 | ⚠️ `pending` |
| Joaquim Rocha Simão | 2026-05 | unimed-anapolis | 15940686(1) + 16189806(2) | 3 | R$ 240,00 | `pending_billing` |
| Nicolas Lucca | 2026-05 | unimed-anapolis | 15650231(1) | 1 | R$ 80,00 | ⚠️ `pending` |

**Total pendente neste inventário: 8 competências · 7 pacientes · R$ 5.690,00**

---

## 3. Preencher nas folhas (segunda-feira)

Para cada competência acima, o sistema já sabe guias, sessões e bruto. Falta **só o que a nota tem**:

```
NF_NUMERO ; NF_DATA ; BRUTO_DOCUMENTADO ; ISS_PCT ; ISS_VALOR ; LIQUIDO_NF
```

O bruto é distintivo — casar foto com competência é quase automático. Referência: a NF de janeiro/fevereiro do Nicolas é R$ 1.440 bruto → R$ 1.411,06 líquido, com ISS de **2,01%** (alíquota já cadastrada em `Convenio` para Unimed Anápolis).

---

## 4. Débitos abertos

### 4.1 Números de nota provisórios
Os lotes de janeiro e fevereiro do Nicolas foram gravados com `SEM-NUMERO-2026-01` / `SEM-NUMERO-2026-02` e `documentReference: "folha manuscrita de NFs"`. Substituir pelos números reais via `lotes-legado-para-preencher-nf.csv`.

### 4.2 Data da NF de fevereiro é inferida
Janeiro usou a data real do sistema (`insurance.billedAt = 2026-03-05`). Fevereiro não tinha data nem no sistema nem na folha — foi usado **2026-04-05**, inferido do padrão de janeiro. Está marcado com ⚠️ no campo `notes` do lote.

### 4.3 ISS retroativo no ledger — decisão de negócio
Janeiro já tem 18 lançamentos `insurance_received` no `financial_ledger` somando **R$ 1.440,00** (bruto). A NF líquida foi R$ 1.411,06. O ledger é **imutável**. Duas saídas:
- lançamento de ajuste próprio (`insurance_iss_withheld`, R$ 28,94) — preserva imutabilidade e torna o líquido derivável;
- tratar a retenção só na leitura — o ledger segue divergindo do que entrou na conta.

Nenhum payment do sistema tem ISS aplicado hoje (698 com `issRate: null`, 22 com `0`, `issAmount` somando R$ 0,00).

### 4.4 Lote genérico contaminado
`LOT-unimed-anapolis-1785785361964-135` — 25 sessões, 3 pacientes, período invertido, sem NF. Afeta o Nicolas e mais 2 pacientes. Ver §2.1.

### 4.5 Especialidade divergente folha × sistema
Guias **15655250** e **15650231**: folha diz *Terapia Ocupacional*, sistema diz *fonoaudiologia*. Vincular sempre pelo **número da guia**, nunca pela especialidade escrita — e a folha também pode ter número trocado (a linha de agosto dizia 15650230 quando era 15650187).

### 4.6 Guia sintética no meio de dado real
`GUIA-NICOLAS-20260601-001` — número claramente de teste, 1 sessão de R$ 100 em junho. Verificar se é contaminação de teste.

### 4.7 Coleção órfã vazia
`financialledgers` (0 documentos) ainda existe ao lado da real `financial_ledger` (2418). O documento de teste de R$ 999 foi removido em 2026-08-08. Dropar a coleção elimina a ambiguidade — não feito por ser irreversível.

### 4.8 Davi Felipe — 5 conflitos em junho
Sessões sem exatamente um Payment ativo. **Junho é vigente**, fora do escopo desta reconciliação, mas vai bloquear o faturamento normal quando chegar a vez.

---

## 5. Regras que a ferramenta garante

- resolve o **Payment canônico** (exclui `canceled`/`cancelled`/`refunded`); 0 ou mais de 1 ativo = conflito bloqueante;
- **preserva** quem já está `received` — ter a nota não prova que o convênio pagou;
- só promove `pending_billing` → `billed`, com `insurance.billedAt` na **data da NF**, nunca hoje;
- **não escreve no FinancialLedger** e não emite eventos;
- não altera `billingMode`, `sessionValue` nem valor de Payment;
- bloqueia sessão já em outro lote, não concluída, de outro paciente, sem appointment ou sem valor resolvível;
- divergência de valor **não** bloqueia — vira `reconciliation.status: 'divergent'` com a diferença gravada;
- lote nasce com `origin: 'legacy_reconciliation'` e **sem** `billingSubmissionId` (corte da ADR-002).

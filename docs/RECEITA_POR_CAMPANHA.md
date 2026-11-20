# Receita recebida por campanha (Frente 2 — Attribution)

Somente leitura. Nenhuma rota ou função daqui grava no banco nem chama Meta, Google ou TikTok.

- Núcleo puro: `services/attribution/revenueAttribution.js` (`attributeReceivedRevenue`)
- Loader (só `find().select().lean()`): `loadRevenueAttribution` no mesmo arquivo
- Saúde da integração: `services/attribution/attributionHealth.js`
- Rotas: `routes/analytics/attribution.routes.js`, montadas em `/api/v2/analytics` com `flexibleAuth` (a mesma auth das rotas de ROI)
- Amostra fictícia: `services/attribution/fixtures/receitaFicticia.js`

## Contrato

### `GET /api/v2/analytics/roi/revenue-attribution?from=YYYY-MM-DD&to=YYYY-MM-DD`

| Parâmetro | Obrigatório | Regra |
|---|---|---|
| `from` (alias `startDate`) | não | início do dia em America/Sao_Paulo (-03:00). Sem ele: 30 dias atrás |
| `to` (alias `endDate`) | não | fim do dia em -03:00. Sem ele: agora |

Filtra `FinancialLedger.occurredAt`. Data inválida ou `from > to` → `400`. Sem token → `401`.

Resposta (amostra fictícia, novembro/2026):

```json
{
  "success": true,
  "meta": { "periodo": { "from": "2026-11-01", "to": "2026-11-30", "campo": "FinancialLedger.occurredAt" }, "moeda": "BRL", "somenteLeitura": true, "regras": ["..."] },
  "data": {
    "totalLiquidoLedger": 910,
    "porNivel": { "comprovada": 320, "provavel": 440, "sem_vinculo": 150 },
    "linhas": [
      { "nivel": "comprovada", "origem": "meta_ads", "campanha": null, "adId": "AD-FICTICIO-1", "recebido": 200, "estornos": 0, "liquido": 200, "pacientes": 1, "lancamentos": 1, "motivosPorLancamento": { "sinal_forte_telefone_exclusivo": 1 } },
      { "nivel": "comprovada", "origem": "google_ads", "campanha": "gg-fono-infantil", "recebido": 120, "estornos": 0, "liquido": 120, "pacientes": 1 },
      { "nivel": "comprovada", "origem": "tiktok_ads", "campanha": "tt-avaliacao", "recebido": 180, "estornos": 180, "liquido": 0, "pacientes": 1 },
      { "nivel": "provavel", "origem": "google_ads", "campanha": "gg-fono-infantil", "recebido": 340, "estornos": 0, "liquido": 340, "pacientes": 2, "motivosPorLancamento": { "sinal_forte_em_telefone_compartilhado": 2 } },
      { "nivel": "provavel", "origem": "instagram", "campanha": null, "recebido": 100, "estornos": 0, "liquido": 100, "pacientes": 1, "motivosPorLancamento": { "so_sinal_fraco": 1 } }
    ],
    "semVinculo": { "recebido": 150, "estornos": 0, "liquido": 150, "pacientes": 1, "lancamentos": 1, "motivos": { "sem_origem_capturada": 150 } },
    "invariante": { "somaNiveis": 910, "totalLiquidoLedger": 910, "fecha": true },
    "excluidos": {
      "revenue_recognition": { "lancamentos": 1, "valor": 120 },
      "reversal_sem_vinculo_de_caixa": { "lancamentos": 1, "valor": 80 },
      "package_consumed": { "lancamentos": 1, "valor": 150 },
      "insurance_billed": { "lancamentos": 1, "valor": 200 }
    }
  }
}
```

A resposta não traz nome nem telefone de paciente: só contagens.

### `GET /api/v2/analytics/attribution-health?from=&to=`

Lê só `AdConversion` (filtro por `eventTime`). Por destino (`meta`, `google_api`, `tiktok`):
`enviadoComProva`, `enviadoSemProvaHistorico`, `ignorado` + `ignoradoPorMotivo`, `falha` + `falhaPorMotivo`,
`pendente`, `pendenteEmRegistroFinalizado`, `pendentesEmQualquerData`, `pendenteMaisAntigoHoras`, `ultimoEnvio`.
As contagens reaproveitam `summarizeDelivery` (`routes/analytics/funnel.logic.js`).
`google_csv`: `noFeedSemProvaDeImportacao` (gclid nos últimos 60 dias, como em `routes/adsFeed.js`),
`foraDaJanelaDoFeed`, `naoAquisicaoComGclidNoFeed` e `ignoradoPorMotivo`. Também `origemNaoIdentificada` por `unknownReason`.

## Regras

1. **Dinheiro vem do ledger** (`FinancialLedger`), nunca de `AdConversion.value` nem de `sessionValue`.
2. **Conta caixa recebido, líquido de estornos.** É a mesma definição de caixa de `workers/reconciliationWorker.js`:
   - entra: `payment_received`, `package_purchase`, `insurance_received`;
   - sai: `refund`, `reversal`, `write_off` **só** quando têm `payment` ou `reversalOfEntryId`;
   - o sinal vem de `direction`.
3. **Fica fora:** `revenue_recognition` e `package_consumed` (reconhecimento contábil), `payment_pending` e
   `insurance_billed` (a receber), `adjustment`, `transfer` e a reversão de cancelamento de sessão sem `payment`
   (`recordSessionCancellationReversal`, que desfaz reconhecimento e não devolve dinheiro). Aparecem em `excluidos`.
4. **`package_purchase` é dinheiro recebido, não o valor do pacote.** `recordPackagePurchase` grava
   `amount: payment.amount`, e é chamado para cada Payment do pacote criado com `status: 'paid'`
   (`createPrepaidPayments` em `controllers/packageController.v2.js`; `domains/billing/workers/packageProcessingWorker.js`).
   Um pacote de R$ 600 com R$ 200 pagos gera um lançamento de R$ 200.
5. **`insurance_received` é o repasse do convênio** (valor líquido depois de ISS/glosa; `services/billing/insuranceBilling.js`,
   `services/insuranceBatchService.js`, `services/autoInsuranceSettlementService.js`). `insurance_billed` (faturado) não entra.
6. **Origem por paciente (first-touch):** a `AdConversion` com `isAcquisition: true`. Se ela não existe ou tem
   `source: 'unknown'`, usa a `LeadAttribution` mais antiga do telefone do paciente (com e sem o 9). Se nada, vai para "sem vínculo" com o motivo.
7. **Nível de evidência:**
   - `comprovada`: click id (`gclid`/`fbc`/`ttclid`/`ctwaClid`) ou método `ctwa`/`site_signature`/`token`, num telefone de **um só** paciente;
   - `provavel`: sinal forte num telefone usado por mais de um paciente, ou só palavra-chave, manual, lead ou método desconhecido;
   - `sem_vinculo`: nenhuma origem.
8. **Invariante:** `comprovada + provavel + sem_vinculo = totalLiquidoLedger`. Cálculo em centavos inteiros.
9. **Período por caixa:** um estorno conta no período em que aconteceu (`occurredAt` do estorno), mesmo que o pagamento seja de outro mês.

## Demonstração (5 passos, só dados fictícios)

1. Instale as dependências na pasta `back`: `npm ci`.
2. Veja a tabela da amostra fictícia, sem banco: `node scripts/demo-receita-por-campanha.mjs`
   (sai com código 0 e a linha `OK: bate com a auditoria (910 = 320 + 440 + 150).`). Com `--json` imprime a resposta inteira.
3. Rode os testes do núcleo e das rotas (models falsos em memória):
   `npx vitest run tests/unit/revenueAttribution.test.js tests/unit/attribution.routes.test.js`
4. Rode o teste do loader contra um MongoDB descartável (mongodb-memory-server baixa o binário na primeira vez):
   `npx vitest run tests/unit/revenueAttribution.mongo.test.js`
5. Abra `services/attribution/fixtures/receitaFicticia.js`, mude um valor (ex.: o pagamento da Eva de 140 para 90)
   e rode o passo 2 de novo: o total e o nível "provável" mudam juntos, e o invariante continua fechando.

## Limitações conhecidas

- Compartilhamento de telefone: procura outros pacientes pelo telefone nos formatos `55DD9…`, `+55DD9…` e `DD9…`
  (com e sem o 9) e pelos telefones de `AdConversion`. Um cadastro com máscara (`(62) 9…`) de **outro** paciente
  não é achado pela consulta; o paciente que pagou é sempre lido pelo `_id`, com qualquer formato.
- A `LeadAttribution` usada como fallback não é comparada com a data do primeiro agendamento: uma origem capturada
  depois do pagamento ainda é aceita (sempre como `provavel`, a menos que traga click id em telefone exclusivo).

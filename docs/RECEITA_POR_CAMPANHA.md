# Receita recebida por campanha (Frente 2 — Attribution)

Somente leitura. Nenhuma rota ou função daqui grava no banco nem chama Meta, Google ou TikTok.

- Núcleo puro: `services/attribution/revenueAttribution.js` (`attributeReceivedRevenue`)
- Loader (só `find().select().lean()`): `loadRevenueAttribution` no mesmo arquivo
- Saúde da integração: `services/attribution/attributionHealth.js`
- Rotas: `routes/analytics/attribution.routes.js`, montadas em `/api/v2/analytics`, **só admin** (ver Acesso)
- Amostra fictícia: `services/attribution/fixtures/receitaFicticia.js`

## Contrato

### `GET /api/v2/analytics/roi/revenue-attribution?from=YYYY-MM-DD&to=YYYY-MM-DD`

| Parâmetro | Obrigatório | Regra |
|---|---|---|
| `from` (alias `startDate`) | não | início do dia em America/Sao_Paulo (-03:00). Sem ele: 30 dias atrás |
| `to` (alias `endDate`) | não | fim do dia em -03:00. Sem ele: agora |

Filtra `FinancialLedger.occurredAt`. Data inválida ou `from > to` → `400`. Sem token → `401`. Usuário que não é admin → `403`.

Resposta (amostra fictícia, novembro/2026; trecho):

```json
{
  "success": true,
  "meta": { "periodo": { "from": "2026-11-01", "to": "2026-11-30", "campo": "FinancialLedger.occurredAt" }, "moeda": "BRL", "somenteLeitura": true, "regras": ["..."] },
  "data": {
    "totalLiquidoLedger": 1290,
    "porNivel": { "comprovada": 480, "provavel": 570, "sem_vinculo": 240 },
    "linhas": [
      { "nivel": "comprovada", "origem": "meta_ads", "campanha": null, "adId": "AD-FICTICIO-1", "recebido": 200, "estornos": 0, "liquido": 200, "pacientes": 1, "lancamentos": 1, "motivosPorLancamento": { "sinal_forte_telefone_exclusivo": 1 } },
      { "nivel": "comprovada", "origem": "meta_ads", "campanha": null, "adId": "AD-FICTICIO-2", "recebido": 160, "estornos": 0, "liquido": 160, "pacientes": 1 },
      { "nivel": "comprovada", "origem": "google_ads", "campanha": "gg-fono-infantil", "recebido": 120, "estornos": 0, "liquido": 120, "pacientes": 1 },
      { "nivel": "comprovada", "origem": "tiktok_ads", "campanha": "tt-avaliacao", "recebido": 180, "estornos": 180, "liquido": 0, "pacientes": 1 },
      { "nivel": "provavel", "origem": "google_ads", "campanha": "gg-fono-infantil", "recebido": 470, "estornos": 0, "liquido": 470, "pacientes": 3, "motivosPorLancamento": { "sinal_forte_em_telefone_compartilhado": 3 } },
      { "nivel": "provavel", "origem": "instagram", "campanha": null, "recebido": 100, "estornos": 0, "liquido": 100, "pacientes": 1, "motivosPorLancamento": { "so_sinal_fraco": 1 } }
    ],
    "semVinculo": { "recebido": 240, "estornos": 0, "liquido": 240, "pacientes": 2, "lancamentos": 2, "motivos": { "sem_origem_capturada": 150, "contato_da_campanha_depois_do_recebimento": 90 } },
    "invariante": { "somaNiveis": 1290, "totalLiquidoLedger": 1290, "fecha": true },
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

Motivos possíveis em `semVinculo.motivos`: `sem_origem_capturada` (ou outro `unknownReason` da AdConversion),
`sem_telefone`, `sem_aquisicao_e_sem_origem_no_telefone`, `lancamento_sem_paciente`,
`contato_da_campanha_depois_do_recebimento`, `origem_sem_data_de_contato`, `recebimento_sem_data` e
`estorno_sem_recebimento_original`.

### `GET /api/v2/analytics/attribution-health?from=&to=`

Lê só `AdConversion` (filtro por `eventTime`). Por destino (`meta`, `google_api`, `tiktok`):
`enviadoComProva`, `enviadoSemProvaHistorico`, `ignorado` + `ignoradoPorMotivo`, `falha` + `falhaPorMotivo`,
`pendente`, `pendenteEmRegistroFinalizado`, `pendentesEmQualquerData`, `pendenteMaisAntigoHoras`, `ultimoEnvio`.
As contagens reaproveitam `summarizeDelivery` (`routes/analytics/funnel.logic.js`).
`google_csv`: `noFeedSemProvaDeImportacao` (gclid nos últimos 60 dias, como em `routes/adsFeed.js`),
`foraDaJanelaDoFeed`, `naoAquisicaoComGclidNoFeed` e `ignoradoPorMotivo`. Também `origemNaoIdentificada` por `unknownReason`.

## Acesso

As duas rotas são **só admin**: `auth` (JWT de usuário; confere que o usuário existe e está ativo) +
`authorize(['admin'])`, o mesmo padrão das rotas financeiras restritas (ex.: `GET /reconciliation` em
`routes/financial/dashboard.routes.js`, `routes/admin/financialMetrics.routes.js`).
Sem token → `401`; secretária ou profissional → `403`. Tokens de serviço (Amanda/Agenda) não têm acesso.

**Quem pode ver a receita da clínica é decisão do dono.** Admin-only é o padrão; para abrir a outro perfil,
basta trocar a lista de `ADMIN_ONLY` em `routes/analytics/attribution.routes.js` (e o teste de acesso).

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
6. **Origem por recebimento (first-touch com data):** cada recebimento só vai para uma campanha se houver
   prova de que o contato pela campanha aconteceu **até a data do recebimento** (`occurredAt`).
   - Candidatas, nesta ordem: a `AdConversion` do paciente com `isAcquisition: true` (se `source` não for `unknown`);
     depois as `LeadAttribution` do telefone do paciente (com e sem o 9), da mais antiga para a mais nova.
   - Data do contato: `AdConversion.eventTime` (momento do agendamento, que vem depois do contato) ou, se for
     anterior, o `firstMessageAt` da `LeadAttribution` do mesmo telefone que seja do **mesmo contato
     publicitário** (mesmo canal **e** mesmo click id, anúncio ou campanha); para a `LeadAttribution`, o
     `firstMessageAt`. **Coincidência só de canal não antecipa a data** (Kadu, 20/11): com duas campanhas
     Google A e B e um pagamento entre os dois contatos, o pagamento fica com A (ou sem vínculo, se não houver
     evidência de A), B recebe zero dele, e o estorno posterior desfaz a atribuição de A.
   - Vale a primeira candidata com contato até o recebimento. Exemplo: pagou em outubro, chegou pela campanha
     em novembro e pagou de novo → só o pagamento de novembro vai para a campanha; o de outubro vai para uma
     origem anterior, se houver, ou para "sem vínculo" com `contato_da_campanha_depois_do_recebimento`.
   - Candidata sem data de contato não prova nada (`origem_sem_data_de_contato`).
7. **Estorno/reversão desfaz o recebimento original.** O recebimento original é achado por `reversalOfEntryId`
   ou pelo crédito de caixa do mesmo `payment` (o loader busca no ledger mesmo fora do período). O débito vai
   para a campanha e o nível **daquele recebimento, na data dele**, nunca para a origem atual do paciente.
   Sem recebimento original encontrado: "sem vínculo" com `estorno_sem_recebimento_original`.
8. **Nível de evidência:**
   - `comprovada`: click id (`gclid`/`fbc`/`ttclid`/`ctwaClid`) ou método `ctwa`/`site_signature`/`token`, num telefone de **um só** paciente;
   - `provavel`: sinal forte num telefone usado por mais de um paciente, ou só palavra-chave, manual, lead ou método desconhecido;
   - `sem_vinculo`: nenhuma origem com contato até a data do recebimento.

   **Telefone compartilhado é sempre `provavel`.** Não existe, nos dados que o CRM grava, prova individual de
   qual irmão veio pela campanha: a `AdConversion` é ligada ao paciente pelo agendamento, mas `source` e click
   ids vêm do **telefone** (`getAttributionByPhone` em `crons/adsConversion.cron.js`) ou do Lead do agendamento;
   e o Lead é ligado ao paciente também pelo telefone (`ensureLeadForAppointment` procura `contact.phone` e só
   preenche `convertedToPatient` se estiver vazio). Por isso nada aqui promove um telefone compartilhado a
   `comprovada`.
9. **Invariante:** `comprovada + provavel + sem_vinculo = totalLiquidoLedger`. Cálculo em centavos inteiros.
10. **Período por caixa:** um estorno conta no período em que aconteceu (`occurredAt` do estorno), mesmo que o pagamento seja de outro mês.

## Consultas do loader (todas por índice)

| Coleção | Filtro | Índice |
|---|---|---|
| `FinancialLedger` | `occurredAt` no período | `occurredAt` |
| `FinancialLedger` | recebimento original: `_id $in` / `{ payment $in, type $in }` | `_id` / `{ payment, type }` |
| `Patient` | `_id $in` (quem pagou) e `phone $in` (grafias do mesmo número) | `_id` / `{ phone }` |
| `AdConversion` | `{ patient: { $in, $type: 'objectId' }, isAcquisition: true }` | parcial `uniq_acquisition_per_patient` |
| `LeadAttribution` | `phone $in` (variantes normalizadas) | `phone` (único) |

Nenhuma consulta usa regex nem varre a coleção. `Patient.phone` é texto livre, então a busca de irmãos gera as
grafias comuns do mesmo número e procura todas com `$in` (pontos no índice): só dígitos, com `55` e `+55`,
com DDD entre parênteses ou não, com espaço ou hífen, cada uma com e sem o 9 — por exemplo `(62) 99999-0000`,
`62999990000`, `+55 62 99999-0000`, `+55 (62) 99999-0000` e `(62) 9999-0000`. Depois, tudo é normalizado para
dígitos (`normalizeE164BR` + chave sem o 9) antes de comparar.

## Demonstração (5 passos, só dados fictícios)

1. Instale as dependências na pasta `back`: `npm ci`.
2. Veja a tabela da amostra fictícia, sem banco: `node scripts/demo-receita-por-campanha.mjs`
   (sai com código 0 e a linha `OK: bate com a amostra (1290 = 480 + 570 + 240).`). Com `--json` imprime a resposta inteira.
   A amostra é a da auditoria (910 = 320 + 440 + 150) mais dois casos da revisão: Hugo (pagou 90 antes de chegar
   pelo anúncio e 160 depois) e Iris (Google, 130) com o irmão João cadastrado com outra grafia do mesmo número.
3. Rode os testes do núcleo e das rotas (models falsos em memória):
   `npx vitest run tests/unit/revenueAttribution.test.js tests/unit/attribution.routes.test.js`
4. Rode o teste do loader contra um MongoDB descartável (mongodb-memory-server baixa o binário na primeira vez):
   `npx vitest run tests/unit/revenueAttribution.mongo.test.js`
5. Abra `services/attribution/fixtures/receitaFicticia.js`, mude um valor (ex.: o pagamento da Eva de 140 para 90)
   e rode o passo 2 de novo: o total e o nível "provável" mudam juntos, e o invariante continua fechando.

## Limitações conhecidas

- Grafias de telefone fora da lista (ex.: `62.99999.0000`, `0xx62…`, número com ramal ou texto) não são achadas
  na busca de irmãos. Achar qualquer grafia exigiria regex sem âncora em `Patient.phone`, que percorre o índice
  inteiro a cada consulta; preferimos a lista fechada de grafias por `$in`. O paciente que pagou é sempre lido
  pelo `_id`, com qualquer grafia. Um campo de telefone normalizado no `Patient` resolveria de vez, mas exige
  mudança de model e migração (fora deste PR).
- `AdConversion.phone` não tem índice: o loader **não** procura irmãos pelo telefone da `AdConversion`, só pelo
  `Patient.phone` (incluindo o telefone da aquisição de quem pagou). Um irmão cujo cadastro tem outro número,
  mas cujo agendamento usou o telefone da mãe, não é visto como compartilhamento.
- A data do contato é a melhor prova que o CRM grava (`eventTime` do agendamento ou `firstMessageAt` da conversa).
  Um contato real anterior que não foi registrado não conta.

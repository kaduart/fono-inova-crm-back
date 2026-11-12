# Vendas & Marketing (V2)

## O que é

São as KPIs das abas de Vendas & Marketing do admin: Leads & Follow-up, Interesse em Convênios, Social Media, Analytics do Site e ROI & Atribuição. O redesign foi aprovado pelo Kadu em 30/10/2026. O front só desenha; todo número é calculado aqui no back.

| Endpoint | Onde aparece |
|---|---|
| `GET /api/v2/commercial/leads-summary?start=YYYY-MM-DD&end=YYYY-MM-DD` | Leads: KPIs do topo e funil |
| `GET /api/v2/commercial/roi-summary?start=&end=` | ROI (tela única), cards de Social e Site |
| `GET /api/convenio-waitlist/summary` → campo `insights` | Interesse em Convênios |
| `GET /api/followups/stats` | Métricas do Funil (follow-ups automáticos) |
| `GET /api/v2/commercial/idle-slots` | Social Media, "Sugestões da semana" |

O acesso é só para `admin` e `secretary`.

## Regras

- **Período:** o dia inteiro em São Paulo. Sem datas, vale o mês corrente. O "período anterior" tem o mesmo tamanho e serve para comparar os leads novos.
- **Funil**, para leads criados no período (menos `parceria_profissional` e as visitas anônimas do site, `NOT_ANONYMOUS_VISIT`):
  - **Conversou:** tem mensagem inbound e outbound no WhatsApp.
  - **Agendou:** o paciente convertido tem um agendamento que não foi cancelado (`pre_agendado` conta), ou o status do lead é `agendado`, `virou_paciente` ou `convertido`.
  - **Compareceu:** o paciente tem agendamento `completed`.
  - **Fechou pacote:** o paciente tem um Package que não é `convenio` nem `liminar` e não está cancelado.
- **Receita = CAIXA**, com o mesmo filtro do Financeiro (`buildCashMatch` em `unifiedFinancialService.v2.js`), restrita aos pacientes que vieram desses leads e ao período. Nunca reimplementar o filtro de caixa.
- **Canal:** vem da `LeadAttribution`, que é confiável, e só na falta dela do `Lead.origin`, que é texto livre. `channelOf()` normaliza. A cobertura é o percentual de leads com algum canal.
- **Investimento:** soma do `AdSpend` no período. O `adKey` é ligado ao canal pelo `adId`/`campaign` da atribuição. O que não for ligado vira "Anúncios (sem canal)".
- **Paciente no ROI** é quem fechou pacote. O custo por paciente só aparece quando há investimento.
- **Convênios:** ativos são `aguardando` e `contatado`. "30+ dias" conta desde `createdAt`. O potencial mensal é ativos × R$ 720, que é o pacote 1x/semana a R$ 180.
- **Vaga ociosa:** usa o mesmo conceito de "buraco" da Grade (`retention.v2 /slots`). É o slot (profissional × dia da semana × horário) que teve sessão concluída entre 30 e 90 dias atrás e nenhuma sessão ativa nos últimos 30 dias nem marcada para a frente. O resultado é agrupado por especialidade e mostra o período (manhã/tarde) e o dia que mais se repetem.
- **Somente leitura:** nenhum desses endpoints grava nada. O cache em memória dura 60s.

## Para mexer sem quebrar

- As regras puras ficam em `services/commercial/salesRules.js`, com teste em `tests/unit/salesRules.test.js`. As consultas ficam em `services/commercial/salesSummary.js`.
- Se mudar o critério de caixa, mude só no `buildCashMatch`.
- O front consome isso em `src/services/salesMarketingService.ts`.


## Pacientes e receita do lead (12/11/2026)

- O ROI e o funil zeravam pacientes/receita porque o lead da "Agenda Direta" nunca ganhava `convertedToPatient`. Agora o paciente do lead vem de `convertedToPatient` OU do agendamento ligado ao lead (`Appointment.lead → patient`), em `resolveLeadPatients` (`services/commercial/salesSummary.js`).
- Paciente antigo que agenda de novo (paciente criado mais de 1 dia antes do lead, `isReturningPatient` em `salesRules.js`) não conta como lead novo: fica fora do funil, do "Leads novos" (inclusive o do período anterior) e do ROI. No espelho, de 28 leads "Agenda Direta" de nov/2026, 16 eram pacientes antigos.
- **Conversas do WhatsApp entram no ROI (12/11/2026):** a maioria dos leads reais chega pelo WhatsApp e só vira `LeadAttribution` (anúncio Instagram/Meta via CTWA, assinatura do site), sem documento `Lead`. Cada atribuição com `firstMessageAt` no período conta como lead do canal dela, se o telefone ainda não estiver entre os leads do período. O paciente vem pelo telefone (8 últimos dígitos, `patientsByPhoneTail`). Essas linhas contam como "conversou". No espelho, nov/2026 tinha 45 conversas atribuídas que não apareciam (Instagram Ads 20, Meta 13, Google 6...).

## Analytics do site (12/11/2026)

- "Leads do site" e os contadores de leads do `/api/analytics/dashboard` ignoram visitas anônimas (`NOT_ANONYMOUS_VISIT`); antes mostravam ~400 "leads" que eram visitas.
- Views das LPs no GA4: busca por prefixo `/lp/` e casa o caminho normalizado (sem barra final/query, minúsculo), em vez da lista exata.
- Rastreio de jornada (`services/leadJourneyService.js`): usa o `journeyId` que o site manda no corpo (o cookie da API não volta entre domínios, então cada chamada criava uma jornada nova) e grava a página do site (corpo ou Referer), nunca `/api/journey/track`.

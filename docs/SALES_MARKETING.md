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
- **Funil**, para leads criados no período (menos `parceria_profissional`):
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

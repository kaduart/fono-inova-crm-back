# Filas comerciais (V2)

## O que é

São quatro filas que ajudam a secretária a vender e a reter pacientes. Elas aparecem no Dashboard do admin ("Precisa de você") e na Agenda. Foram aprovadas pelo Kadu em 30/10/2026.

| Fila | Endpoint | Onde aparece |
|---|---|---|
| Encaixe inteligente | `GET /api/v2/commercial/fit-candidates?specialty=` | Horário livre na Agenda (dia por profissional) e na Recorrência |
| Pacote acabando | `GET /api/v2/commercial/package-ending?threshold=2` | Dashboard, "Precisa de você" |
| Reativação | `GET /api/v2/commercial/reactivation?minDays=7` | Dashboard e Acompanhamento |
| Lead sem resposta | `GET /api/v2/commercial/leads-waiting?hours=2` | Topo do Dashboard, com cronômetro |
| Registro do contato | `POST /api/v2/commercial/contacts` | Botão "Marcar como contatado" das filas |

O acesso é só para `admin` e `secretary`.

## Por quê

- Um horário vago é receita perdida. Quem pode ocupar a vaga é quem já procura a especialidade: um lead aberto ou um paciente sem próxima sessão.
- Quando o pacote acaba sem renovação, o paciente costuma sumir.
- Um lead novo que espera mais de 2h esfria.

## Regras

- **Somente leitura em entidades canônicas.** As filas só leem Appointment, Patient, Package, Lead e Message. A única escrita vai para a coleção `commercialcontacts` (model `CommercialContact`), e nenhum outro fluxo depende dela.
- **Próxima sessão:** usa `scheduled`, `confirmed` e `pre_agendado`, igual à Retenção V2 (DOMAIN_INVARIANTS: `pre_agendado` entra em todo filtro ativo).
- **Sem próxima sessão:** paciente com sessão `completed` nos últimos 120 dias e nenhuma sessão futura. No encaixe, a regra vale dentro da especialidade do horário.
- **Pacote acabando:**
  - entram pacotes `active` que não são `convenio`/`liminar`, porque esses tipos são legado e não renovam;
  - as sessões restantes são calculadas como `totalSessions − sessionsDone`, já que `remainingSessions` é virtual (ADR-003) e nunca é gravado;
  - se o paciente já tem outro pacote ativo na mesma especialidade, vale o pacote com mais sessões, então quem já renovou sai da fila.
- **Lead esperando:**
  - entram leads abertos que chegaram nos últimos 3 dias;
  - a espera começa na última mensagem do WhatsApp do próprio lead (inbound);
  - se a clínica falou por último (Amanda ou humano), o lead não está esperando;
  - sem mensagens, vale a última interação; sem interação, vale `createdAt`.
- **Área do lead:** `Lead.therapyArea` é texto livre, então `normalizeArea()` converte para a especialidade do Doctor (por exemplo, "fono" vira `fonoaudiologia` e "Terapia Ocupacional" vira `terapia_ocupacional`).
- **Contato registrado:**
  - um contato registrado nos últimos 7 dias manda o item para o fim da fila sem escondê-lo;
  - um duplo clique (mesmo alvo, tipo e usuário em até 5 min) não duplica o registro.
- **Mensagens:** o WhatsApp é aberto pelo front com um texto pronto, e o back não envia mensagem nenhuma. A Amanda não é acionada.

## Para mexer sem quebrar

- As regras puras ficam em `services/commercial/commercialRules.js`, com teste em `tests/unit/commercialRules.test.js`.
- Se mudar o critério de "próxima sessão", mude também em `routes/retention.v2.js`, para a Agenda e o Dashboard mostrarem os mesmos números.
- O front consome isso em `src/services/commercialService.ts`.

# Decisões Fiscais da Clínica — Módulo NFS-e

> **Status: 10/10 itens respondidos em 2026-07-28.** Este documento deixa de ser o gargalo do go-live — a partir de agora, o que falta é técnico (ver `go_live_nfse.md`).

> Este documento não é técnico. É um formulário de decisões de negócio que o contador/financeiro da clínica precisa responder. Nenhum destes itens é resolvido escrevendo código — o `back/docs/nfse-fiscal-module/compliance_checklist.md` já mapeou onde cada resposta impacta o sistema; aqui só ficam a pergunta, quem responde e o status.
>
> **Regra de uso**: um item marcado "Não necessário" pode ser riscado do backlog técnico imediatamente (não precisa virar tarefa "só por garantia"). Um item marcado "Necessário" vira tarefa no checklist, na categoria já mapeada lá. Datar cada resposta ao preencher, para rastrear quando a decisão foi tomada. Os itens 1-3 (Sprint 1) bloqueiam diretamente o Bloco 1 de [`go_live_nfse.md`](./go_live_nfse.md) — resolver esses três primeiro.

## Visão geral — o que bloqueia o quê

| # | Decisão | Sprint que trava sem resposta | Responsável | Status |
|---|---|---|---|---|
| 1 | Regime tributário real da clínica | Sprint 1 (go-live) | Contador | ✅ Respondido 2026-07-28 — **Simples Nacional** |
| 2 | Certificado digital (A1/A3/HSM) | Sprint 1 (go-live) | Contador/TI | ✅ Respondido 2026-07-28 — **A1, já possui** |
| 3 | Emissor técnico (Sefin Nacional × NotaControl/Anápolis) | Sprint 1 (go-live) — decorre da #1 | Contador | ⚠️ Decorre de #1 = Sefin Nacional, **mas só a partir de 01/09/2026** — antes disso o `FiscalProviderResolver` ainda roteia para NotaControl (ver nota abaixo) |
| 4 | Tomador Pessoa Jurídica | Sprint 2 — escala para Sprint 1 se a resposta for "sim" | Recepção/Contabilidade | ✅ Respondido 2026-07-28 — **Ambos** (CPF e CNPJ ocorrem) — escala para Sprint 1 |
| 5 | Retenção de ISS na fonte | **Sprint 1** (escalado — resposta confirmada "sim") | Contador | ✅ Respondido 2026-07-28 — **Sim, com evidência real** (nota da Isabela F. Mendonça, Unimed Anápolis) |
| 6 | Liminar — qual mecanismo fiscal se aplica | Sprint 2 | Contador/Jurídico | ✅ Respondido 2026-07-28 — **nenhum dos dois mecanismos; ISS cobrado normalmente** |
| 7 | Profissional Autônomo (regime especial) | Sprint 3 | Contador | ✅ Respondido 2026-07-28 — **Não** (clínica é CNPJ; profissionais terceiros são PJ próprios, que faturam a clínica — não é regime da clínica) |
| 8 | Sociedade de Profissionais (regime especial) | Sprint 3 | Contador | ✅ Respondido 2026-07-28 — **Não**, recolhe ISS pelo Simples Nacional normal |
| 9 | Intermediário | Sprint 3 | Contabilidade | ✅ Respondido 2026-07-28 — **Não** |
| 10 | Substituição de NFS-e — frequência esperada | Sprint 3 | Financeiro/Contador | ✅ Respondido 2026-07-28 — **Ocasional** ("às vezes sim, precisaremos") |

---

## 1. Regime Tributário

**Pergunta**: Qual é o regime tributário atual da clínica perante a Receita Federal?

- [x] Simples Nacional
- [ ] Lucro Presumido
- [ ] Lucro Real

**Responsável**: Contador · **Status**: ✅ Respondido · **Data da resposta**: 2026-07-28

**Ação decorrente**: atualizar `FiscalProfile.regimeTributario` para `SIMPLES_NACIONAL` (hoje o default de formulário é `LUCRO_PRESUMIDO`, precisa ser trocado de propósito, não só confiar no default).

**Contexto**: `ConfiguracaoFiscal.regimeTributario` está vazio em produção (0 documentos); a tela `FiscalConfiguration.tsx` hoje usa `LUCRO_PRESUMIDO` só como valor padrão de formulário, não como dado confirmado. Essa não é uma decisão a "tomar" — é um fato que já existe na contabilidade da clínica e só precisa ser transcrito para o sistema.

**Por que importa**: se **Simples Nacional**, a partir de 01/09/2026 (Resolução CGSN nº 189/2026) a emissão passa a ser obrigatória pelo Emissor Nacional (Sefin Nacional) — o `FiscalProviderResolver.js` já tem essa regra pronta. Se **Lucro Presumido/Real**, a emissão continua pelo webservice municipal de Anápolis (NotaControl), sem data de migração prevista.

---

## 2. Certificado Digital

**Pergunta**: Que tipo de certificado digital a clínica já possui ou vai adquirir para assinar as notas fiscais?

- [x] A1 (arquivo digital, permite assinatura automática pelo servidor) — **já possui**
- [ ] A3 (token/cartão físico)
- [ ] HSM (hardware de assinatura, uso corporativo)
- [ ] Ainda não possui — a adquirir

**Responsável**: Contador/TI · **Status**: ✅ Respondido · **Data da resposta**: 2026-07-28

**Ação decorrente**: A1 permite assinatura 100% no backend Node.js — não precisa de hardware/serviço externo. Falta: (a) obter o arquivo `.pfx`/`.p12` e a senha, (b) implementar `CertificateManager.sign()` real (hoje só `MockCertificateManager`), (c) armazenar a senha em secret manager (nunca texto puro, já é a decisão registrada na Fase 2 do módulo).

**Contexto**: `CertificateManager.js` hoje só tem uma implementação Mock — não assina digitalmente de verdade. A escolha muda a arquitetura: A1 permite assinar 100% no backend Node.js do CRM; A3/HSM normalmente exige hardware ou serviço externo de assinatura, o que é uma peça de infraestrutura adicional, não só código.

---

## 3. Emissor Técnico

**Pergunta**: Confirmado o regime tributário (#1), qual sistema a clínica vai efetivamente usar para emitir?

- [x] Sefin Nacional / Emissor Nacional (`SefinNacionalAdapter`, já implementado, falta certificado) — decorre de #1 = Simples Nacional
- [ ] Webservice municipal de Anápolis via NotaControl (`AnapolisMunicipalAdapter`, hoje stub — falta desbloquear acesso ao WSDL)

**Responsável**: Contador · **Status**: ⚠️ Resolvido em princípio, mas com uma pegadinha de calendário · **Data da resposta**: 2026-07-28

**Achado crítico (2026-07-28)**: `FiscalProviderResolver.js` só roteia para Sefin Nacional quando `asOfDate >= 2026-09-01` — a regra de migração tem uma data de corte, não é "a partir de agora que o regime está confirmado". **Hoje (2026-07-28) o sistema ainda routaria qualquer emissão para o `AnapolisMunicipalAdapter`** (NotaControl), que segue bloqueado (403) e é stub. Duas opções:
1. **Esperar até 01/09/2026** para emitir a primeira nota — evita depender do NotaControl inteiramente, foco 100% em certificado A1 + mTLS no `SefinNacionalAdapter`. **Recomendado**, dado que faltam ~5 semanas e o certificado A1 já existe.
2. Perseguir o desbloqueio do NotaControl em paralelo, só se houver necessidade de emitir nota real antes de 01/09/2026.

Isso não muda a resposta da pergunta (o emissor final é Sefin Nacional), só a data em que o sistema realmente usa esse caminho.

---

## 4. Tomador Pessoa Jurídica

**Pergunta**: Alguma nota fiscal vai sair em nome de uma empresa/convênio (CNPJ), em vez do paciente (CPF)?

- [x] Sim — **ambos os casos ocorrem** (paciente pessoa física e convênio/empresa)
- [ ] Não

**Responsável**: Recepção/Contabilidade · **Status**: ✅ Respondido · **Data da resposta**: 2026-07-28

**Contexto**: `Patient.js` hoje só tem campo `cpf`, sem `cnpj`. O Anexo I suporta CNPJ como alternativa técnica ao CPF no grupo `toma`.

**Ação decorrente**: como a resposta é "Sim", **este item sobe para Sprint 1** — sem o campo `cnpj` no `Patient` (ou em quem for o tomador registrado), as notas para convênio/empresa não podem ser emitidas. Precisa de uma decisão de modelagem adicional: o CNPJ do convênio fica no próprio `Patient`, ou existe uma entidade "Tomador" separada quando o pagador não é o paciente? (Não decidido ainda — próximo passo técnico.)

---

## 5. Retenção de ISS na Fonte

**Pergunta**: Algum tomador (convênio, empresa) retém o ISS na fonte ao pagar a clínica hoje?

- [x] Sim — confirmado com evidência real (ver abaixo)
- [ ] Não

**Responsável**: Contador · **Status**: ✅ Respondido, com evidência documental · **Data da resposta**: 2026-07-28

**Evidência**: nota real da paciente Isabela Ferreira de Mendonça (guia 16007195, Unimed Anápolis) mostra `ISS Retido: Sim`, Retenções R$22,79 (= 2,59% de R$880,00, a alíquota do serviço), `Valor ISS: R$0,00` (porque quem recolhe é o tomador, não a clínica) e Valor Líquido R$857,21. Não é caso hipotético — está acontecendo hoje pelo menos com Unimed Anápolis.

**Contexto técnico**: `DpsBuilder.js:83` hoje fixa `tpRetISSQN=1` ("Não Retido") para **toda** nota, sem exceção — inclusive para tomadores que retêm de verdade. Emitir "não retido" quando na prática houve retenção gera divergência contábil real.

**Ação decorrente**: **este item sobe para Sprint 1** (regra já estava registrada, confirmada agora). Precisa: (1) tornar `tpRetISSQN` configurável por tomador/convênio (não mais constante fixa), (2) decidir onde essa configuração mora — por convênio (`Package.type='convenio'`, nível insurance) ou por tomador individual — provável que seja por convênio, já que a retenção normalmente é regra do pagador, não do paciente; confirmar com o contador se todos os convênios retêm ou só alguns.

---

## 6. Liminar — Mecanismo Fiscal Aplicável

**Pergunta**: Para os pacientes com decisão judicial (liminar) hoje ativos, qual é o teor da decisão do ponto de vista fiscal?

- [ ] Suspende a exigibilidade do ISS (mecanismo `exigSusp/tpSusp` — fluxo regular de DPS)
- [ ] Dispensa toda a validação padrão da nota (mecanismo de bypass `POST /decisao-judicial/nfse`, exige autorização municipal prévia cadastrada)
- [x] **Nenhum dos dois** — a nota é emitida normalmente, com ISS cobrado

**Responsável**: Contador/Jurídico · **Status**: ✅ Respondido · **Data da resposta**: 2026-07-28

**Contexto**: `FiscalInvoice.liminarFlow` já existe no schema (enum pronto).

**Ação decorrente**: **simplifica o módulo** — não é preciso implementar `exigSusp/tpSusp` nem o fluxo de bypass judicial no `DpsBuilder` para o caso comum. `FiscalInvoice.liminarFlow` deve permanecer/ser gravado como `NONE` para esses pacientes — o campo `liminar` no CRM (Package.type/TherapeuticPlan) segue existindo para fins clínicos/financeiros internos, mas fiscalmente essas notas seguem o fluxo regular igual a qualquer outro paciente particular. Este item pode ser reclassificado de 🟡B para 🟢C (ou removido) no `compliance_checklist.md`.

---

## 7. Profissional Autônomo

**Pergunta**: Algum profissional da clínica emite como autônomo (regime especial de tributação `regEspTrib=5`), fora do CNPJ da clínica?

- [ ] Sim
- [x] Não

**Responsável**: Contador · **Status**: ✅ Respondido · **Data da resposta**: 2026-07-28

**Resposta do usuário**: "profissionais são PJ, a clínica paga o serviço prestado deles". A clínica (CNPJ) contrata profissionais que faturam como PJ próprio — isso é uma relação de despesa/fornecedor da clínica (esses profissionais emitem NFS-e **para** a clínica, é o fluxo fiscal inverso, fora do escopo deste módulo). Não afeta o `regEspTrib` da clínica como prestadora nas notas emitidas a pacientes.

## 8. Sociedade de Profissionais

**Pergunta**: A clínica se enquadra ou tem algum profissional enquadrado como "Sociedade de Profissionais" (`regEspTrib=6`)?

- [ ] Sim
- [x] Não — confirmado

**Responsável**: Contador · **Status**: ✅ Respondido e confirmado · **Data da resposta**: 2026-07-28

### Decisão — ISS Fixo / Sociedade Profissional

**Decisão**: A Clínica Fono Inova não se enquadra como Sociedade Profissional Pura.

**Motivo**: a sociedade possui profissionais de classes distintas (fonoaudiologia e TI), portanto não atende o requisito de sociedade formada exclusivamente por profissionais da mesma categoria. Reforçado pelo contador: ISS fixo em Anápolis é restrito a sociedade profissional pura enquadrada em Lucro Real/Presumido, ou a Sociedade Contábil — a clínica não se enquadra em nenhum dos dois (é Simples Nacional, e a sociedade não é pura).

**Consequência**: não aplica ISS fixo. Aplica ISS sobre faturamento conforme o regime tributário (Simples Nacional). `regEspTrib` permanece `0` ("Nenhum"), como já está hardcoded no `DpsBuilder.js:66` — não precisa ficar configurável.

**Fonte**: confirmação do contador Samuel em 28/07/2026 (mensagens 17:54–18:00).

> **Nota de escopo**: este item é só sobre ISS Fixo/Sociedade Profissional (regEspTrib). Não confundir com o item #5 (Retenção de ISS pelo tomador/convênio) — são dois mecanismos fiscais diferentes. O item #5 permanece **Sim, existe retenção**, confirmado pela nota fiscal real da paciente Isabela Ferreira de Mendonça (evidência operacional, ver seção 5 acima) — a fala do contador sobre "não haveria retenção" nesta seção se referia especificamente ao enquadramento de ISS Fixo, não à retenção feita pelos convênios ao pagar a clínica.

**Contexto (itens 7 e 8)**: `DpsBuilder.js:66` hoje fixa `regEspTrib=0` ("Nenhum") sempre.

---

## 9. Intermediário

**Pergunta**: Alguma nota é emitida com um intermediário no meio (ex.: plataforma de agendamento que cobra e repassa)?

- [ ] Sim — quem: _____________________
- [x] Não

**Responsável**: Contabilidade · **Status**: ✅ Respondido · **Data da resposta**: 2026-07-28

**Ação decorrente**: item riscado do backlog técnico — o grupo `interm` não precisa ser implementado.

---

## 10. Substituição de NFS-e

**Pergunta**: Com que frequência a clínica espera precisar corrigir uma nota já emitida (dado errado, valor errado)?

- [ ] Frequente — é parte normal da operação
- [x] Ocasional — "às vezes sim, precisaremos" (entre raro e frequente)
- [ ] Não sabemos ainda (natural antes do go-live)

**Responsável**: Financeiro/Contador · **Status**: ✅ Respondido · **Data da resposta**: 2026-07-28

**Ação decorrente**: o domínio já sabe fazer isso (`FiscalInvoiceService.substitute()`), mas o `DpsBuilder` não monta o grupo `subst`/`chSubstda` no XML ainda. Como a resposta confirma uso real (não hipotético), **este item sobe de Sprint 3 para Sprint 2** — não é urgente para a primeira nota, mas não pode ficar esquecido por muito tempo depois do go-live.

---

## Dado adicional capturado — CNPJ do Prestador

Fornecido pelo usuário em 2026-07-28: **60.359.243/0001-42**.

**Achado**: `FiscalConfiguration.tsx` hoje tem um CNPJ **placeholder/de teste** hardcoded no estado inicial da tela (`useState('12345678000199')`), usado como fallback quando o perfil ainda não foi salvo. Não é o CNPJ real da clínica — precisa ser substituído por este ao implementar, ou removido em favor de deixar o campo vazio até o usuário preencher.

## Dado adicional capturado — Endereço do Prestador

Fornecido pelo usuário em 2026-07-28, resolve o gap de endereço do prestador mapeado em `compliance_checklist.md` Bloco 1 e `go_live_nfse.md` Bloco 2:

- Logradouro: Avenida Minas Gerais
- Número: 405
- Bairro: Jundiaí
- Município: Anápolis
- UF: GO
- CEP: 75110-770

**Ação decorrente**: adicionar esses campos ao schema `FiscalProfile` (hoje não existem) e preencher. Falta ainda o código IBGE do bairro/logradouro não é necessário — o `cMun` (código IBGE do **município**) já existe (`municipioIBGE: '5201108'`), só os campos de rua/número/bairro/CEP estão faltando.

## Como este documento se conecta ao restante do projeto

- Toda resposta "Sim" aqui deve ser refletida como uma linha específica em [`compliance_checklist.md`](./compliance_checklist.md) (a coluna Fonte já aponta "Decisão Contábil"/"Regra Clínica" nos itens correspondentes).
- Toda resposta "Não" permite remover o item correspondente do backlog técnico sem implementar nada.
- Quando os itens 1-3 (Sprint 1) estiverem respondidos, o próximo passo natural é action externa (contatar NotaControl **ou** decidir/adquirir certificado), não código.

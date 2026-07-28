# Decisões Fiscais da Clínica — Módulo NFS-e

> Este documento não é técnico. É um formulário de decisões de negócio que o contador/financeiro da clínica precisa responder. Nenhum destes itens é resolvido escrevendo código — o `back/docs/nfse-fiscal-module/compliance_checklist.md` já mapeou onde cada resposta impacta o sistema; aqui só ficam a pergunta, quem responde e o status.
>
> **Regra de uso**: um item marcado "Não necessário" pode ser riscado do backlog técnico imediatamente (não precisa virar tarefa "só por garantia"). Um item marcado "Necessário" vira tarefa no checklist, na categoria já mapeada lá. Datar cada resposta ao preencher, para rastrear quando a decisão foi tomada. Os itens 1-3 (Sprint 1) bloqueiam diretamente o Bloco 1 de [`go_live_nfse.md`](./go_live_nfse.md) — resolver esses três primeiro.

## Visão geral — o que bloqueia o quê

| # | Decisão | Sprint que trava sem resposta | Responsável | Status |
|---|---|---|---|---|
| 1 | Regime tributário real da clínica | Sprint 1 (go-live) | Contador | ⏳ Pendente |
| 2 | Certificado digital (A1/A3/HSM) | Sprint 1 (go-live) | Contador/TI | ⏳ Pendente |
| 3 | Emissor técnico (Sefin Nacional × NotaControl/Anápolis) | Sprint 1 (go-live) — decorre da #1 | Contador | ⏳ Pendente |
| 4 | Tomador Pessoa Jurídica | Sprint 2 — escala para Sprint 1 se a resposta for "sim" | Recepção/Contabilidade | ⏳ Pendente |
| 5 | Retenção de ISS na fonte | Sprint 2 — escala para Sprint 1 se a resposta for "sim" | Contador | ⏳ Pendente |
| 6 | Liminar — qual mecanismo fiscal se aplica | Sprint 2 | Contador/Jurídico | ⏳ Pendente |
| 7 | Profissional Autônomo (regime especial) | Sprint 3 | Contador | ⏳ Pendente |
| 8 | Sociedade de Profissionais (regime especial) | Sprint 3 | Contador | ⏳ Pendente |
| 9 | Intermediário | Sprint 3 | Contabilidade | ⏳ Pendente |
| 10 | Substituição de NFS-e — frequência esperada | Sprint 3 | Financeiro/Contador | ⏳ Pendente |

---

## 1. Regime Tributário

**Pergunta**: Qual é o regime tributário atual da clínica perante a Receita Federal?

- [ ] Simples Nacional
- [ ] Lucro Presumido
- [ ] Lucro Real

**Responsável**: Contador · **Status**: Pendente · **Data da resposta**: —

**Contexto**: `ConfiguracaoFiscal.regimeTributario` está vazio em produção (0 documentos); a tela `FiscalConfiguration.tsx` hoje usa `LUCRO_PRESUMIDO` só como valor padrão de formulário, não como dado confirmado. Essa não é uma decisão a "tomar" — é um fato que já existe na contabilidade da clínica e só precisa ser transcrito para o sistema.

**Por que importa**: se **Simples Nacional**, a partir de 01/09/2026 (Resolução CGSN nº 189/2026) a emissão passa a ser obrigatória pelo Emissor Nacional (Sefin Nacional) — o `FiscalProviderResolver.js` já tem essa regra pronta. Se **Lucro Presumido/Real**, a emissão continua pelo webservice municipal de Anápolis (NotaControl), sem data de migração prevista.

---

## 2. Certificado Digital

**Pergunta**: Que tipo de certificado digital a clínica já possui ou vai adquirir para assinar as notas fiscais?

- [ ] A1 (arquivo digital, permite assinatura automática pelo servidor)
- [ ] A3 (token/cartão físico)
- [ ] HSM (hardware de assinatura, uso corporativo)
- [ ] Ainda não possui — a adquirir

**Responsável**: Contador/TI · **Status**: Pendente · **Data da resposta**: —

**Contexto**: `CertificateManager.js` hoje só tem uma implementação Mock — não assina digitalmente de verdade. A escolha muda a arquitetura: A1 permite assinar 100% no backend Node.js do CRM; A3/HSM normalmente exige hardware ou serviço externo de assinatura, o que é uma peça de infraestrutura adicional, não só código.

---

## 3. Emissor Técnico

**Pergunta**: Confirmado o regime tributário (#1), qual sistema a clínica vai efetivamente usar para emitir?

- [ ] Sefin Nacional / Emissor Nacional (`SefinNacionalAdapter`, já implementado, falta certificado)
- [ ] Webservice municipal de Anápolis via NotaControl (`AnapolisMunicipalAdapter`, hoje stub — falta desbloquear acesso ao WSDL)

**Responsável**: Contador · **Status**: Pendente (decorre de #1) · **Data da resposta**: —

**Contexto**: se a resposta apontar para NotaControl, a ação imediata é contatar `suporte.anapolis@notacontrol.com.br` pedindo liberação de IP e o manual técnico — isso ainda não foi feito.

---

## 4. Tomador Pessoa Jurídica

**Pergunta**: Alguma nota fiscal vai sair em nome de uma empresa/convênio (CNPJ), em vez do paciente (CPF)?

- [ ] Sim — quais casos: _____________________
- [ ] Não — a nota sempre sai em nome do paciente, mesmo quando o pagamento vem de convênio

**Responsável**: Recepção/Contabilidade · **Status**: Pendente · **Data da resposta**: —

**Contexto**: `Patient.js` hoje só tem campo `cpf`, sem `cnpj`. O Anexo I suporta CNPJ como alternativa técnica ao CPF no grupo `toma`, mas isso não significa que a clínica precise disso — é caso de uso, não exigência do leiaute.

**Se "Sim"**: entra no Sprint 1 (bloqueante), não no Sprint 2 — sem o campo, essas notas específicas não podem ser emitidas de jeito nenhum.

---

## 5. Retenção de ISS na Fonte

**Pergunta**: Algum tomador (convênio, empresa) retém o ISS na fonte ao pagar a clínica hoje?

- [ ] Sim — quais: _____________________
- [ ] Não

**Responsável**: Contador · **Status**: Pendente · **Data da resposta**: —

**Contexto**: `DpsBuilder.js:83` hoje fixa `tpRetISSQN=1` ("Não Retido") para toda nota, sem exceção.

**Se "Sim"**: entra no Sprint 1 para os tomadores afetados — emitir uma nota que diz "não retido" quando na prática houve retenção gera divergência contábil real, não é só um campo cosmético.

---

## 6. Liminar — Mecanismo Fiscal Aplicável

**Pergunta**: Para os pacientes com decisão judicial (liminar) hoje ativos, qual é o teor da decisão do ponto de vista fiscal?

- [ ] Suspende a exigibilidade do ISS (mecanismo `exigSusp/tpSusp` — fluxo regular de DPS)
- [ ] Dispensa toda a validação padrão da nota (mecanismo de bypass `POST /decisao-judicial/nfse`, exige autorização municipal prévia cadastrada)
- [ ] Varia caso a caso — não é uma regra única

**Responsável**: Contador/Jurídico · **Status**: Pendente · **Data da resposta**: —

**Contexto**: `FiscalInvoice.liminarFlow` já existe no schema (enum pronto), mas não está ligado a nenhum dos dois mecanismos no `DpsBuilder`. A clínica já opera com pacientes liminar — isso não é hipotético.

---

## 7. Profissional Autônomo

**Pergunta**: Algum profissional da clínica emite como autônomo (regime especial de tributação `regEspTrib=5`), fora do CNPJ da clínica?

- [ ] Sim
- [ ] Não

**Responsável**: Contador · **Status**: Pendente · **Data da resposta**: —

## 8. Sociedade de Profissionais

**Pergunta**: A clínica se enquadra ou tem algum profissional enquadrado como "Sociedade de Profissionais" (`regEspTrib=6`)?

- [ ] Sim
- [ ] Não

**Responsável**: Contador · **Status**: Pendente · **Data da resposta**: —

**Contexto (itens 7 e 8)**: `DpsBuilder.js:66` hoje fixa `regEspTrib=0` ("Nenhum") sempre. Só vale tornar configurável se a resposta a qualquer um dos dois for "Sim".

---

## 9. Intermediário

**Pergunta**: Alguma nota é emitida com um intermediário no meio (ex.: plataforma de agendamento que cobra e repassa)?

- [ ] Sim — quem: _____________________
- [ ] Não

**Responsável**: Contabilidade · **Status**: Pendente · **Data da resposta**: —

**Contexto**: o grupo `interm` não existe em nenhuma camada do sistema hoje. Resposta esperada é "Não", mas precisa ser formalizada antes de riscar o item do backlog em definitivo.

---

## 10. Substituição de NFS-e

**Pergunta**: Com que frequência a clínica espera precisar corrigir uma nota já emitida (dado errado, valor errado)?

- [ ] Frequente — é parte normal da operação
- [ ] Raro — só em erro pontual
- [ ] Não sabemos ainda (natural antes do go-live)

**Responsável**: Financeiro/Contador · **Status**: Pendente · **Data da resposta**: —

**Contexto**: o domínio já sabe fazer isso (`FiscalInvoiceService.substitute()`), mas o `DpsBuilder` não monta o grupo `subst`/`chSubstda` no XML ainda. Se a expectativa for "frequente", isso sobe de Sprint 3 para Sprint 2.

---

## Como este documento se conecta ao restante do projeto

- Toda resposta "Sim" aqui deve ser refletida como uma linha específica em [`compliance_checklist.md`](./compliance_checklist.md) (a coluna Fonte já aponta "Decisão Contábil"/"Regra Clínica" nos itens correspondentes).
- Toda resposta "Não" permite remover o item correspondente do backlog técnico sem implementar nada.
- Quando os itens 1-3 (Sprint 1) estiverem respondidos, o próximo passo natural é action externa (contatar NotaControl **ou** decidir/adquirir certificado), não código.

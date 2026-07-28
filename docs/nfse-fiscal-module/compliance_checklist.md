# Checklist de Conformidade — Módulo Fiscal NFS-e (Padrão Nacional)

> Documento produzido a partir da auditoria funcional de 2026-07-28 (código real + Anexo I oficial `dps_field_matrix.md`, v1.01-09/02/2026). É a fonte da verdade do que falta para o módulo fiscal ser aderente ao Padrão Nacional — não o XML nem o schema isoladamente, e sim o processo completo do Emissor Nacional (Prestador → Tomador → Serviço → Tributação → Valores → Observações → Intermediário).
>
> **Como usar**: cada linha responde 3 perguntas técnicas (onde o dado existe hoje / chega na DPS / existe na interface) + 1 **Fonte** (o que exige o campo — ver legenda) + 1 categoria de prioridade + 1 ação. Ao implementar um item, marcar `[x]` na coluna Status.
>
> **Enquanto o go-live não acontece, este NÃO é o documento principal de execução** — é o documento de compliance (responde "estamos 100% aderentes ao Padrão Nacional?"). Para "o que falta emitir a primeira nota", usar [`go_live_nfse.md`](./go_live_nfse.md). Para as perguntas de negócio que alimentam as duas coisas, usar [`decisoes_fiscais_clinica.md`](./decisoes_fiscais_clinica.md) — mais da metade dos itens em aberto aqui não são gap de código, são pergunta sem resposta do contador/operação da clínica. Sempre que a coluna Fonte diz "Decisão Contábil" ou "Regra Clínica", a ação real não é programar — é resolver lá primeiro.

## Legenda de prioridade

| Categoria | Significado | Quando entra |
|---|---|---|
| 🔴 A — Bloqueante | Sem isso não é possível emitir uma NFS-e válida para o fluxo real da clínica | Sprint 1 (pré-requisito de go-live) |
| 🟡 B — Comum | Situação que a clínica encontra com frequência (não hipotética) | Sprint 2 |
| 🟢 C — Específico | Caso raro/excepcional; não impede o go-live | Backlog, sob demanda |
| 🔵 D — Reforma Tributária | Prioridade definida por prazo regulatório (IBS/CBS), não por frequência de uso | Antes do prazo vigente (hoje 03/08/2026, sujeito a novo adiamento; Simples Nacional só entra em 2027) |

## Legenda de fonte

Cada campo é exigido por uma origem diferente — misturar as origens foi o que gerou classificações imprecisas na primeira versão deste documento (ex.: Nome Fantasia havia sido marcado como "adicionar campo" sem checar se o leiaute realmente exige).

| Fonte | O que significa |
|---|---|
| **Anexo I** | Leiaute oficial da DPS/NFS-e (`dps_field_matrix.md`) — obrigatoriedade técnica confirmada por leitura direta da planilha `gov.br/nfse` |
| **NT009** | Nota Técnica da Reforma Tributária (grupos IBS/CBS) — prazo regulatório, não frequência de uso |
| **Manual Emissor** | Manuais em prosa do Emissor Público Nacional (`project_nfse_phase1_official_spec.md`) — processo/API, não o leiaute XML em si |
| **Município** | Regra específica de Anápolis (via NotaControl) ou da migração para Sefin Nacional — não está no Anexo I nacional |
| **Decisão Contábil** | Depende de resposta do contador — ver `decisoes_fiscais_clinica.md` |
| **Regra Clínica** | Depende de como a clínica opera na prática (não é regulatório) — ver `decisoes_fiscais_clinica.md` |

---

## Matriz de aderência funcional (visão executiva)

| Etapa oficial | CRM hoje | Aderência |
|---|---|---|
| Cadastro do Prestador | ⚠️ Parcial | Dados fiscais (CNPJ/IM/razão social/regime) ok; falta endereço (confirmado obrigatório pelo Anexo I); nome fantasia é opcional (Anexo I) — não é gap real |
| Cadastro do Tomador | ❌ Baixa | `Patient` tem quase tudo, mas o `DpsBuilder` só envia CPF+nome — endereço nunca chega na DPS (Anexo I confirma que é obrigatório); PJ como tomador é decisão de negócio em aberto |
| Serviço | ⚠️ Parcial | Código LC116, descrição, local e valor ok; sem desconto, sem código municipal (`cTribMun`) |
| Tributação | ❌ Baixa | `tribISSQN` e `tpRetISSQN` hardcoded para o cenário mais simples; suspensão judicial (liminar) não implementada |
| Intermediário | ❌ Ausente | Não existe em nenhuma camada (schema, builder, UI) — não há caso de uso confirmado |
| Emissão (UX) | ⚠️ MVP | 2 campos editáveis, sem estrutura Prestador→Tomador→Serviço→Tributos |
| Consulta | ⚠️ Não testada | Endpoints existem (`SefinNacionalAdapter`), nunca validados contra ambiente real (falta certificado) |
| Eventos | ✅ Boa (domínio) | Máquina de estados completa e testada (21 testes); transporte real ainda não exercitado |
| Cancelamento/Substituição | ⚠️ Parcial | Domínio pronto; `DpsBuilder` não monta o grupo `subst`/`chSubstda` para substituição |
| Reforma Tributária (IBS/CBS) | ❌ Ausente | Seção própria (9) — ver aviso de escopo lá |

---

## 1. Cadastro do Prestador (`FiscalProfile`)

| Campo oficial | Onde existe hoje | Chega na DPS? | Existe na interface? | Fonte | Categoria | Ação necessária | Status |
|---|---|---|---|---|---|---|---|
| CNPJ | `FiscalProfile.cnpj` | ✅ (`DpsBuilder.js:63`) | ✅ (`FiscalConfiguration.tsx` campo CNPJ) | Anexo I §2.5 | 🔴 A | Sem ação | [x] |
| Inscrição Municipal (IM) | `FiscalProfile.inscricaoMunicipal` | ✅ | ✅ | Anexo I §2.5 (opcional no leiaute, mas Anápolis normalmente exige na prática) | 🔴 A | Sem ação | [x] |
| Razão Social (`xNome`) | `FiscalProfile.razaoSocial` | ✅ | ✅ | Anexo I §2.1 (`emit/xNome`, obrigatório na NFS-e gerada; o campo `prest/xNome` da DPS em si é opcional, provavelmente derivado do CNPJ pela plataforma) | 🔴 A | Sem ação — manter preenchido é a prática segura, independente da nuance do leiaute | [x] |
| Regime tributário (`regTrib/opSimpNac`) | `FiscalProfile.regimeTributario` | ✅ mapeado (`DpsBuilder.js:33-40`) | ✅ (Select) | Anexo I §2.5 (campo obrigatório) + Decisão Contábil (qual valor é o real) | 🔴 A | **Confirmar regime real da clínica junto ao contador** — ver `decisoes_fiscais_clinica.md` #1 | [ ] |
| Nome Fantasia (`xFant`) | ❌ não existe | ❌ | ❌ | Anexo I §2.1 (`emit/xFant`) — **confirmado Opcional** | 🟢 C ~~🟡 B~~ | Reclassificado nesta revisão: o leiaute não exige. Só adicionar se a clínica quiser o nome comercial no DANFSe por preferência própria (Regra Clínica), não por obrigação | [ ] |
| Endereço do prestador (`xLgr/nro/xCpl/xBairro/CEP/cMun`) | ❌ não existe | ❌ | ❌ | Anexo I §2.5, linha `end/{xLgr,nro,xCpl,xBairro}` — **confirmado Obrigatório** (só `xCpl`/complemento é opcional) | 🔴 A | Responde a dúvida "rejeita ou aceita em branco?": o Anexo I classifica como Obrigatório, não Condicional — a expectativa é rejeição, não campo vazio aceito. Coletar dado, adicionar ao `FiscalProfile`, montar no `DpsBuilder` (`prestXml`), expor na tela | [ ] |
| Telefone / Email do prestador | ❌ não existe | ❌ | ❌ | Anexo I §2.5 — confirmado Opcional | 🟢 C | Baixa prioridade, confirmado pelo leiaute (não é achismo) | [ ] |
| Regime especial (`regTrib/regEspTrib`) | ❌ não existe | ⚠️ hardcoded `0`="Nenhum" (`DpsBuilder.js:66`) | ❌ | Anexo I §2.5 (campo obrigatório, mas o **valor** aplicável é 100% Decisão Contábil) | 🟢 C | Ver `decisoes_fiscais_clinica.md` #4 e #5 (Profissional Autônomo / Sociedade de Profissionais) — só programar depois da resposta | [ ] |
| Certificado digital (assinatura) | `Certificate`/`FiscalProfile.certificateRef` | ❌ não assina de verdade (`CertificateManager.js` só Mock) | ✅ tela de upload existe | Manual Emissor §4 (autenticação obrigatória por certificado) + Decisão Contábil (tipo A1/A3) | 🔴 A | Ver `decisoes_fiscais_clinica.md` #8 | [ ] |

## 2. Cadastro do Tomador (`Patient`)

| Campo oficial | Onde existe hoje | Chega na DPS? | Existe na interface? | Fonte | Categoria | Ação necessária | Status |
|---|---|---|---|---|---|---|---|
| CPF | `Patient.cpf` | ✅ (`DpsBuilder.js:70`) | implícito (via `payment`) | Anexo I §2.5 (choice CNPJ×CPF) | 🔴 A | Sem ação | [x] |
| Nome (`xNome`) | `Patient.fullName` | ✅ | implícito | Anexo I §2.5 — confirmado Obrigatório para `toma` (diferente de `prest`, o leiaute diferencia explicitamente) | 🔴 A | Sem ação | [x] |
| Endereço (`xLgr/nro/xBairro/cMun/CEP`) | ⚠️ `Patient.address` existe, mas `city` é texto livre (sem código IBGE) | ❌ **não é lido pelo `DpsBuilder`** (`tomaXml` só usa `cpf`+`nome`, `DpsBuilder.js:69-72`) | ❌ | Anexo I §2.5 — mesma linha `end/{...}` do prestador, **confirmado Obrigatório**, sem distinção por ator nessa linha específica | 🔴 A | Alterar `DpsBuilder`/`FiscalSnapshotBuilder` para incluir endereço do tomador; adicionar código IBGE ao `Patient.address` (hoje só texto) | [ ] |
| Telefone / Email do tomador | `Patient.phone`/`Patient.email` | ❌ não usado pelo builder | ❌ | Anexo I §2.5 — confirmado Opcional | 🟢 C | Baixa prioridade | [ ] |
| CNPJ (tomador pessoa jurídica) | ❌ `Patient` só tem `cpf` | ❌ | ❌ | Anexo I §2.5: o leiaute **suporta** CNPJ como alternativa ao CPF (é uma escolha técnica válida, não uma exigência de ter os dois) + Regra Clínica (se isso acontece na prática) | 🟡 B | **Não implementar por hipótese** — ver `decisoes_fiscais_clinica.md` #2. Se a resposta for "não usamos", este item sai do backlog | [ ] |
| IE / "Consumidor final" | — | — | — | Anexo I — checado linha a linha: **não existem esses campos** em `prest`/`toma` (a hipótese inicial estava adiantada em relação ao leiaute real; existe `indFinal`, mas em outro grupo — ver Seção 9) | — | Sem ação — falsa lacuna, não perseguir | [x] |

## 3. Serviço (`FiscalInvoiceItem` + `DpsBuilder`)

| Campo oficial | Onde existe hoje | Chega na DPS? | Existe na interface? | Fonte | Categoria | Ação necessária | Status |
|---|---|---|---|---|---|---|---|
| Código do serviço (`cTribNac`/LC116) | `FiscalProfile.codigoServicoLC116` / campo na tela de emissão | ✅ | ✅ | Anexo I §2.6 — Obrigatório | 🔴 A | Sem ação | [x] |
| Descrição do serviço (`xDescServ`) | `EmitFiscalInvoiceModal` (campo livre) | ✅ | ✅ | Anexo I §2.6 — Obrigatório | 🔴 A | Sem ação | [x] |
| Local da prestação (`cLocPrestacao`) | `FiscalProfile.municipioIBGE` (via snapshot) | ✅ | implícito | Anexo I §2.6 — Condicional (choice com `cPaisPrestacao`, N/A para clínica no Brasil) | 🔴 A | Sem ação | [x] |
| Valor do serviço (`vServ`) | vem do `Payment` | ✅ | implícito | Anexo I §2.7 — Obrigatório | 🔴 A | Sem ação | [x] |
| Desconto (`vDescIncond`/`vDescCond`) | ❌ não existe | ❌ | ❌ | Anexo I §2.7 — Condicional (grupo opcional no leiaute, só entra se houver desconto real) + Regra Clínica | 🟡 B | Confirmar se a clínica dá desconto na prática antes de programar | [ ] |
| Código de tributação municipal (`cTribMun`) | ❌ não existe | ❌ | ❌ | Anexo I §2.6 — Condicional + Município (Anápolis pode ou não exigir código próprio além do nacional) | 🟢 C | Confirmar com NotaControl/SEMEC se Anápolis exige | [ ] |
| Código NBS (`cNBS`) | ❌ não existe | ❌ | ❌ | Anexo I §2.6 — Condicional | 🟢 C | Sem ação por ora | [ ] |

## 4. Tributação regular (`valores/trib`, exceto IBS/CBS — ver Seção 9)

| Campo oficial | Onde existe hoje | Chega na DPS? | Existe na interface? | Fonte | Categoria | Ação necessária | Status |
|---|---|---|---|---|---|---|---|
| `tribISSQN` (operação tributável) | ⚠️ hardcoded `1` (`DpsBuilder.js:83`) | ✅ mas fixo | ❌ | Anexo I §2.7 — Obrigatório (o campo em si); o valor `1` cobre o cenário comum da clínica | 🔴 A (resolvido para o caso comum) | Documentar a limitação; só alterar se surgir caso real de imunidade/exportação/não incidência | [ ] |
| `tpRetISSQN` (retenção de ISS) | ⚠️ hardcoded `1`="Não Retido" (`DpsBuilder.js:83`) | ✅ mas fixo | ❌ | Anexo I §2.7 — Obrigatório (o campo); o **valor** é Decisão Contábil | 🟡 B | Ver `decisoes_fiscais_clinica.md` #3 — se algum tomador retiver ISS hoje, isso é bloqueante disfarçado de comum | [ ] |
| `exigSusp/tpSusp` (suspensão por decisão judicial — domínio `liminar`) | `FiscalInvoice.liminarFlow` existe no schema, mas não ligado ao XML | ❌ | ❌ | Anexo I §2.7 — Condicional + Regra Clínica/Jurídica (qual mecanismo — `exigSusp` ou o bypass `POST /decisao-judicial/nfse` — depende do teor de cada decisão judicial) | 🟡 B | A clínica tem pacientes `liminar` ativos hoje (não é hipótese) — ligar `liminarFlow` ao grupo `exigSusp` no `DpsBuilder`, mas antes confirmar com o jurídico/contador qual mecanismo se aplica caso a caso | [ ] |

## 5. Intermediário (`interm`)

| Campo oficial | Onde existe hoje | Chega na DPS? | Existe na interface? | Fonte | Categoria | Ação necessária | Status |
|---|---|---|---|---|---|---|---|
| Grupo `interm` inteiro (mesma estrutura de `prest`/`toma`) | ❌ não existe em nenhuma camada | ❌ | ❌ | Anexo I §2.4/2.5 (o leiaute prevê o grupo) + Regra Clínica (a clínica não opera com intermediário conhecido hoje) | 🟢 C | Ver `decisoes_fiscais_clinica.md` #6 — provável "Não necessário", mas formalizar antes de riscar de vez | [ ] |

## 6. Emissão (UX)

| Item | Situação hoje | Fonte | Categoria | Ação necessária | Status |
|---|---|---|---|---|---|
| Estrutura Prestador→Tomador→Serviço→Tributos→Valores→Observações→Intermediário | `EmitFiscalInvoiceModal.tsx` expõe só 2 campos (descrição + código do serviço), auto-declarado MVP no comentário do arquivo | Manual Emissor (Guia do Emissor Público Nacional Web reflete essa estrutura) | 🟡 B | **Não redesenhar a tela antes de resolver os gaps de dado** (Blocos 1-4) — redesenhar cedo demais só exporia campos vazios | [ ] |
| Conceito "pagamento" vs. "prestação de serviço" | Tela parte do `Payment` (paciente/valor/método/data); Emissor Nacional pensa em prest→toma→serv | Manual Emissor | 🟡 B | Revisitar quando os blocos 1-4 estiverem fechados — é uma decisão de produto, não só de tela | [ ] |

## 7. Consulta / Eventos / Cancelamento

| Item | Situação hoje | Fonte | Categoria | Ação necessária | Status |
|---|---|---|---|---|---|
| Consulta por chave de acesso (`GET /nfse/{chave}`) | Implementada em `SefinNacionalAdapter.js`, nunca testada contra ambiente real (falta certificado/mTLS) | Manual Emissor §3.2 | 🔴 A | Depende do certificado digital (Bloco 1) | [ ] |
| Listagem/histórico de eventos | `OfficialFiscalEvent` + `FiscalStateMachineService` — domínio robusto, 21 testes unitários | Anexo II (`event_matrix.md`) | ✅ | Sem ação até haver transporte real para validar ponta a ponta | [x] (domínio) / [ ] (transporte real) |
| Substituição (grupo `subst`/`chSubstda`) | Domínio (`FiscalInvoiceService.substitute()`) existe; `DpsBuilder.js` **não monta** o grupo `subst` no XML | Anexo I §2.4 (`subst/chSubstda`, `subst/cMotivo`) + Regra Clínica (com que frequência isso vai acontecer) | 🟡 B | Ver `decisoes_fiscais_clinica.md` #7 antes de decidir a prioridade real | [ ] |
| Cancelamento via Adapter real | `registerEvent()` implementado no `SefinNacionalAdapter`; stub no `AnapolisMunicipalAdapter` | Município (depende de qual adapter a clínica vai realmente usar) | 🔴 A (se regime não migrar) / 🟡 B (se migrar para Sefin Nacional) | Depende de `decisoes_fiscais_clinica.md` #1 e #9 | [ ] |

## 8. Pré-requisitos de negócio transversais (bloqueantes, não são código)

| Item | Situação hoje | Fonte | Categoria | Ação necessária | Status |
|---|---|---|---|---|---|
| Regime tributário real da clínica | `ConfiguracaoFiscal.regimeTributario` vazio em produção; `FiscalConfiguration.tsx` usa default `LUCRO_PRESUMIDO` | Decisão Contábil | 🔴 A | Ver `decisoes_fiscais_clinica.md` #1 | [ ] |
| Tipo de certificado digital (A1 vs A3/HSM) | Não decidido; `CertificateManager` só tem Mock | Decisão Contábil | 🔴 A | Ver `decisoes_fiscais_clinica.md` #8 | [ ] |
| Endpoint técnico do webservice de Anápolis (NotaControl) | URL do `.asmx` conhecida, mas 403/whitelist bloqueia acesso ao WSDL | Município | 🔴 A (se regime não for Simples Nacional pós-01/09/2026) | Contatar `suporte.anapolis@notacontrol.com.br` | [ ] |
| Ligação `FiscalProfile.ambiente` → host do `SefinNacionalAdapter` | Hoje sempre hardcoded para Produção Restrita (`_attemptSubmission.js:27`), ignora o campo configurado | Achado técnico (não é regra externa) | 🟡 B | Ajuste pequeno no `resolveAdapter()` — só faz sentido corrigir quando houver certificado real para testar | [ ] |

---

## 9. Reforma Tributária (IBS/CBS) — seção isolada de propósito

> ⚠️ **Ainda não obrigatório para a clínica.** Prazo geral do leiaute: 03/08/2026 (sujeito a novo adiamento, conforme a própria página oficial já registrou histórico de prorrogação). **Simples Nacional só entra na obrigatoriedade a partir de 2027.** Esta seção existe **reservada, não para implementar agora** — o objetivo de listá-la à parte é impedir que alguém implemente esses campos pela metade dentro do Bloco 4 (Tributação) sem perceber que é um regime jurídico diferente, com prazo próprio.

Campos confirmados no Anexo I (`dps_field_matrix.md` §2.3 — calculados pela plataforma — e §2.8 — declarados pelo emitente), Fonte = **NT009**:

| Grupo | Campos | Observação |
|---|---|---|
| Localização/redutor | `cLocalidadeIncid`, `xLocalidadeIncid`, `pRedutor` | Pode divergir do local de incidência do ISSQN |
| Base de cálculo | `valores/vBC` | Fórmula muda de 2026→2032 (com/sem PIS/COFINS) |
| Alíquotas UF/Município/Federal | `valores/uf/{pIBSUF,pRedAliqUF,pAliqEfetUF}`, `valores/mun/{pIBSMun,pRedAliqMun,pAliqEfetMun}`, `valores/fed/{pCBS,pRedAliqCBS,pAliqEfetCBS}` | 3 grupos paralelos |
| Totalizadores | `totCIBS/vTotNF`, `totCIBS/gIBS/*`, `totCIBS/gCBS/*`, `totCIBS/gTribRegular/*`, `totCIBS/gTribCompraGov/*` | Calculados pela plataforma, não pelo CRM |
| Declarados pelo emitente | `finNFSe`, `indFinal` (a ser descontinuado pela NT005), `cIndOp`, `tpOper`, `gRefNFSe/refNFSe`, `tpEnteGov`, `indDest`, `dest/*`, `imovel/*` | `indDest`+`dest/*` só quando destinatário ≠ tomador |
| Tributação IBS/CBS por item | `valores/trib/gIBSCBS/{CST,cClassTrib,cCredPres,gTribRegular,gDif}` | Obrigatórios dentro do grupo quando o grupo existir |

**Ação recomendada agora**: reservar espaço no schema (`FiscalInvoice`/`FiscalProfile`), sem popular. **Não** montar esses campos no `DpsBuilder` nem expor na UI até o prazo se aproximar de verdade ou até o regime tributário confirmado (`decisoes_fiscais_clinica.md` #1) indicar que 2027 já é relevante.

---

## Fontes / rastreabilidade

Este documento consolida evidência já levantada em três sessões de auditoria (2026-07-28), lendo diretamente:
- Código: `FiscalProfile.js`, `Patient.js`, `FiscalInvoice.js`, `DpsBuilder.js`, `FiscalProviderResolver.js`, `MunicipioProviderRegistry.js`, `SefinNacionalAdapter.js`, `AnapolisMunicipalAdapter.js`, `CertificateManager.js`, `IssueFiscalInvoiceService.js`, `_attemptSubmission.js`, `FiscalConfiguration.tsx`, `EmitFiscalInvoiceModal.tsx`.
- Documentação oficial já obtida: `dps_field_matrix.md` (Anexo I, v1.01-09/02/2026, leitura direta da planilha `gov.br/nfse`), `project_nfse_phase1_official_spec.md` (Fase 1, manuais do Emissor Público Nacional), `event_matrix.md` (Anexo II).
- Memória do projeto: `project_nfse_fiscal_module_architecture.md` (histórico completo de decisões desde 2026-07-15).
- Registro de decisões de negócio: [`decisoes_fiscais_clinica.md`](./decisoes_fiscais_clinica.md).

Nenhum campo desta checklist foi preenchido por suposição de leiaute municipal antigo (ABRASF) — mesma disciplina das pesquisas anteriores do módulo. Nenhuma obrigatoriedade foi reclassificada sem citar a linha exata do Anexo I que sustenta a mudança.

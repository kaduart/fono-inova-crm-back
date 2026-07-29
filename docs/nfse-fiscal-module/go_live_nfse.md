# GO-LIVE — NFS-e (Sprint 1)

> Documento de execução, não de compliance. Pergunta única: **o que falta para a clínica emitir a primeira nota fiscal real, no caso comum, conforme a regra que entra em 01/09/2026?** Tudo que não está aqui foi deliberadamente adiado — ver `compliance_checklist.md` (o que falta para 100% de aderência ao Padrão Nacional) e `decisoes_fiscais_clinica.md` (perguntas de negócio, algumas das quais alimentam este checklist diretamente).
>
> Regra de escopo: um item só entra aqui se a ausência dele impede emitir **qualquer** nota no caso comum (paciente pessoa física, sem retenção, sem liminar, sem intermediário, sem substituição). Regra específica de negócio (retenção, liminar, tomador PJ) fica em Sprint 2, mesmo que pareça urgente — só sobe para cá se a resposta em `decisoes_fiscais_clinica.md` confirmar que acontece hoje.

## Base já pronta (não recomeçar do zero)

Tudo isto foi implementado e testado na semana de 2026-07-16 (PR1-PR4) e continua valendo — a Sprint 1 é construída em cima disso, não substitui nada:

- **Persistência completa**: `FiscalInvoice`, `FiscalProfile`, `FiscalSubmission`, `FiscalSnapshot`, `Certificate`, `OfficialFiscalEvent`, `ProviderTransaction` + repositórios.
- **Domínio**: `FiscalStateMachineService` (máquina de estados oficial, cancelamento/substituição/análise fiscal), `FiscalInvoiceService`, `FiscalInvoicePaymentProjection`, policies/specifications/validators — 21 testes unitários passando.
- **Provider Layer**: `FiscalProviderResolver` (município + regime + data, incluindo a regra de migração 01/09/2026 já hardcoded), `DpsBuilder` (gera XML no leiaute nacional correto), `MockAdapter` — 18 testes unitários passando.
- **Application Layer**: `IssueFiscalInvoiceService` + `RetryFiscalSubmissionService` + `_attemptSubmission` orquestrando o fluxo completo — 5 testes de integração contra MongoDB real passando (42/42 no total do módulo).
- **Frontend**: `FiscalConfiguration.tsx` (perfil + certificado) e `EmitFiscalInvoiceModal.tsx` (emissão MVP) já em produção, funcionando contra `MockAdapter`.
- **Endpoints REST**: `POST /nfse/emit`, `/nfse/emit-from-payment`, `GET /nfse`, `GET /nfse/:id`, `/retry`, `/cancel`, download de XML/PDF — todos implementados no `fiscalController.js`.

O que falta abaixo é **só** o que impede esse fluxo já pronto de rodar contra o mundo real (certificado de verdade, mTLS, dados de endereço) — não é trabalho de arquitetura ou domínio novo.

## Bloqueadores atuais

*Atualizado 2026-07-29 (fim de sessão) — transporte + certificado + API real confirmados com prova. Único bloqueador real que resta é a assinatura XML-DSig, isolada de propósito.*

**Resolvidos e PROVADOS contra o servidor oficial nesta sessão (2026-07-29):**
- ✅ Endereço do prestador e do tomador — implementado, dado real da clínica salvo.
- ✅ Tomador Pessoa Jurídica — `Patient.cnpj` implementado em toda a cadeia.
- ✅ Seleção de ambiente — `_attemptSubmission.js` lê `FiscalProfile.ambiente` de verdade.
- ✅ Upload + criptografia de certificado — `.pfx` real da clínica (emitido por AC SyngularID Múltipla, válido até 11/05/2027) sobe pela tela, validado (PKCS#12 real, senha confere), AES-256-GCM em repouso, validade extraída automaticamente.
- ✅ **mTLS confirmado com o certificado real**: `GET https://adn.producaorestrita.nfse.gov.br/` parou de dar 495 (SSL Certificate Error) assim que trocamos o certificado fake pelo real — rejeição de TLS sumiu.
- ✅ **basePath real da API descoberto e confirmado**: `https://sefin.producaorestrita.nfse.gov.br/SefinNacional` (não `/API/SefinNacional/` como a doc de topo sugeria — esse prefixo é só da página de docs). Confirmado lendo o Swagger real (`GET /SefinNacional/swagger/docs/v1`, só acessível com certificado válido).
- ✅ **Chamada real de teste**: `GET /SefinNacional/nfse/{chave-fake}` devolveu **HTTP 404 estruturado, no formato oficial exato** (`{"tipoAmbiente":2,"versaoAplicativo":"SefinNacional_1.6.0","erro":{"codigo":"E2401","descricao":"Chave de acesso não encontrada."}}`) — prova definitiva de autenticação mTLS aceita + basePath correto, não é mais suposição.
- ✅ **Formato real de `POST /nfse` e `/eventos` corrigido**: achado crítico — o corpo não é XML puro, é JSON com o XML assinado comprimido em gzip + base64 (`{"dpsXmlGZipB64": "..."}` / `{"pedidoRegistroEventoXmlGZipB64": "..."}`). `SefinNacionalAdapter.js` corrigido pra esse formato real (usando `zlib` nativo, sem dependência nova). Sem esse achado, a primeira emissão real teria falhado mesmo com assinatura XML perfeita.
- ✅ `/ParametrosMunicipais` e `/DANFSe` neste host: **descontinuados** (501, "movido para adn.../parametrizacao/" e "/danfse/") — confirmado no spec real, não é lacuna nossa.
- ⏸️ Assinatura digital real (XML-DSig) — implementada (`node-forge`+`xml-crypto`), **deliberadamente não testada ainda** — sequência escolhida pelo usuário: provar mTLS+API real isolado antes de somar a variável da assinatura. Próximo passo natural agora que mTLS está 100% provado.

**Ferramenta permanente adicionada**: `POST /api/v2/fiscal/test-connection` — diagnóstico de conectividade mTLS reutilizável (carrega certificado do perfil ativo, monta `https.Agent`, faz uma chamada GET real, devolve `{ok, tls, certificateAccepted, httpStatus, daysUntilExpiry, ...}`). Útil pra checar rapidamente se o certificado ainda funciona sem escrever script descartável — sobretudo quando o certificado for renovado no futuro. Respeita o `FiscalProviderResolver` de verdade (hoje resolve pra `anapolis_municipal` antes de 01/09/2026 — usar `FISCAL_SEFIN_NACIONAL_EFFECTIVE_FROM` pra testar Sefin Nacional antes da data real).

**Ainda em aberto:**
- 🟡 Testar `POST /nfse` de verdade (precisa da assinatura XML-DSig funcionando — próximo passo).
- 🟡 `GET /nfse/{chaveAcesso}` (consulta) e `/eventos` — resposta é JSON, formato exato (`NFSeGetResponseSucesso`) ainda não confirmado em detalhe (só o schema de erro foi validado nesta sessão).
- 🗓️ `FiscalProviderResolver` só roteia para Sefin Nacional a partir de 01/09/2026 em produção real — `FISCAL_SEFIN_NACIONAL_EFFECTIVE_FROM` no `.env` permite testar antes dessa data sem mexer em código.
- ⚠️ `FISCAL_CERT_ENCRYPTION_KEY` precisa ser adicionada nas variáveis de ambiente do Render (produção) — hoje só existe no `.env` local.

## Definition of Done por bloco

| Bloco | Done quando... |
|---|---|
| 1. Cenário | Regime tributário, emissor e certificado definidos pelo contador (as 3 respostas registradas em `decisoes_fiscais_clinica.md` #1-#3) |
| 2. Dados | Prestador e tomador têm todos os campos obrigatórios do bloco preenchidos — endereço incluído |
| 3. Fluxo | É possível emitir, consultar e cancelar uma NFS-e de teste sem erros, em Produção Restrita |
| 4. Transporte | Certificado real configurado, mTLS funcionando, emissão validada no ambiente correto (homologação, depois produção) |
| Go-live | Primeira NFS-e emitida em produção e validada pelo financeiro/contador |

## Sequência de execução recomendada

*Atualizada 2026-07-28 — itens 1-2 originais já resolvidos, meta de calendário adicionada.*

1. ~~Confirmar regime tributário~~ ✅ Simples Nacional (2026-07-28)
2. ~~Definir certificado~~ ✅ A1, já possui (2026-07-28)
3. Completar `FiscalProfile`: endereço do prestador (dado já em mãos, ver Bloco 2) + `regimeTributario=SIMPLES_NACIONAL`
4. Completar dados do tomador: endereço + código IBGE no `Patient`, e adicionar campo `cnpj` (Tomador PJ confirmado — `decisoes_fiscais_clinica.md` #4) — ligar tudo ao `DpsBuilder`
5. Obter o arquivo do certificado A1 (.pfx/.p12 + senha) e implementar assinatura real (substituir `MockCertificateManager`)
6. Configurar mTLS no `SefinNacionalAdapter`
7. Corrigir a seleção dinâmica de ambiente (`_attemptSubmission.js`)
8. Emitir uma NFS-e em homologação (Produção Restrita) e validar com o contador
9. **Aguardar 01/09/2026** (ou confirmar que o resolver já aponta para Sefin Nacional) e emitir a primeira NFS-e em produção

## 1. Cenário confirmado — decisão de negócio, zero código

*Done quando: regime tributário, emissor e certificado definidos pelo contador.* ✅ **Bloco concluído em 2026-07-28** (com uma ressalva de calendário, ver abaixo).

- [x] Regime tributário confirmado (`decisoes_fiscais_clinica.md` #1) — **Simples Nacional**
- [x] Certificado digital decidido — A1, **já possui** (`decisoes_fiscais_clinica.md` #2)
- [x] Emissor técnico definido — **Sefin Nacional**, decorrente do regime (`decisoes_fiscais_clinica.md` #3)
- [ ] ~~Se NotaControl: contato...~~ **Não se aplica** — emissor definido é Sefin Nacional, não NotaControl
- [ ] Ressalva registrada: mesmo com Sefin Nacional definido, o sistema só roteia para lá a partir de 01/09/2026 — meta de go-live ajustada para essa data

## 2. Dados mínimos obrigatórios (só o que bloqueia emissão)

*Done quando: prestador e tomador têm todos os campos obrigatórios do bloco preenchidos — endereço incluído.*

**Prestador** (`FiscalProfile`)
- [x] CNPJ, IM, Razão Social — já existem
- [x] Regime tributário — default da tela trocado para `SIMPLES_NACIONAL`
- [x] **Implementado 2026-07-28**: campo `endereco` (logradouro/número/complemento/bairro/CEP) adicionado ao schema `FiscalProfile`, montado no `prestXml` do `DpsBuilder` (grupo `end`/`endNac`), exposto na tela `FiscalConfiguration.tsx`
- [ ] Preencher com o dado real na tela (Av. Minas Gerais, 405, Bairro Jundiaí, Anápolis-GO, CEP 75110-770) e CNPJ real (60.359.243/0001-42) — schema pronto, falta só salvar pela UI

**Tomador** (`Patient`)
- [x] CPF, Nome — já existem
- [x] **Implementado 2026-07-28**: campo `cnpj` adicionado ao `Patient` (tomador PJ); `municipioIBGE` opcional no `address` (fallback documentado: assume o município da clínica se ausente — cobre o caso comum, paciente local)
- [x] `DpsBuilder`/`FiscalSnapshotBuilder` alterados: `tomaXml` agora monta `end` (endereço) e escolhe `CNPJ` ou `CPF` conforme o tomador
- [x] **Implementado 2026-07-28**: campo "CNPJ (tomador PJ, opcional)" adicionado à tela de cadastro/edição de paciente (`PatientForm.tsx`, seção "Documentos e Contato"). Achado durante a implementação: o backend (`patient.v2.js`) tinha **dois pontos de whitelist de campos** (`POST /` e o `allowedFields` do `PUT /:id`) que descartariam `cnpj` silenciosamente mesmo com o campo na tela — corrigidos os dois. A projeção de leitura (`patientProjectionService.js`, `PatientsView`) também não devolvia `cnpj` de volta para a tela — corrigido também. Sem essas 3 correções, o campo pareceria funcionar (salvaria sem erro) mas o dado se perderia silenciosamente.
- [ ] Testes automatizados (42/42) continuam verdes, mas nenhum teste novo cobre o `end`/`cnpj` do tomador especificamente — cobertura por enquanto é manual/leitura de código

**Serviço**
- [x] Código do serviço (LC116), valor, descrição — já existem e já chegam na DPS

## 3. Fluxo ponta a ponta funcionando

- [x] `Payment` → cria `FiscalInvoice` (draft) → abre `FiscalSubmission` — já implementado
- [ ] Monta XML da DPS com endereço de prestador e tomador incluídos (depende do Bloco 2)
- [ ] Assina XML com certificado **real** (hoje `CertificateManager` é só Mock)
- [ ] Envia para o adapter real definido no Bloco 1 (`SefinNacionalAdapter` ou `AnapolisMunicipalAdapter`, hoje ambos inutilizáveis em produção por motivos diferentes)
- [x] Consulta por chave de acesso — implementada, não testada contra ambiente real
- [x] Cancela — domínio pronto, não testado contra ambiente real

## 4. Adapter Nacional / transporte — o bloqueador técnico de verdade

- [ ] Assinatura digital real funcionando (substitui `MockCertificateManager`)
- [ ] mTLS configurado — `httpsAgent` real passado ao `SefinNacionalAdapter` (hoje sempre `undefined`) **ou** endpoint do NotaControl liberado e implementado (hoje `AnapolisMunicipalAdapter` é 100% stub)
- [ ] `FiscalProfile.ambiente` corretamente ligado ao host da chamada HTTP — bug conhecido: hoje `_attemptSubmission.js:27` sempre usa Produção Restrita, ignorando o campo configurado
- [ ] Testado em Produção Restrita (homologação) com um caso real
- [ ] Primeira nota emitida e **autorizada** em Produção

## Produção homologada

- [ ] Go-live confirmado — clínica emitindo NFS-e real pelo CRM

---

## Débito técnico registrado (não bloqueia go-live)

### Corrigir isolamento e limpeza da suíte `fiscalInvoiceFlow.integration.test.js`

**Achado 2026-07-28**: a suíte roda contra o MongoDB real (não um banco descartável). O teardown remove o `FiscalInvoice` criado no teste, mas não os documentos filhos (`FiscalSubmission`, `FiscalSnapshot`, `ProviderTransaction`) — cada execução deixa resíduo permanente no banco de produção. Descoberto ao comparar o estado do banco antes/depois de uma limpeza manual completa (ver `project_nfse_fiscal_module_architecture.md`, memória do projeto).

**Critérios de aceite**:
- A suíte não deixa nenhum documento em `fiscalinvoices`, `fiscalsubmissions`, `fiscalsnapshots`, `providertransactions`, `officialfiscalevents` depois de rodar.
- Rodar a suíte duas vezes consecutivas produz exatamente o mesmo estado do banco (idempotência de teardown).
- Preferencialmente: banco descartável de teste, ou teardown que cascateia a limpeza pelos IDs criados na própria execução.

**Prioridade**: 🟢 backlog — não impede nenhum item do checklist acima, mas deve ser resolvido antes de rodar essa suíte repetidamente contra produção (cada execução acumula lixo).

---

### Como os três documentos se relacionam

| Documento | Pergunta que responde |
|---|---|
| `decisoes_fiscais_clinica.md` | O que o contador/operação precisa decidir? |
| `go_live_nfse.md` (este) | O que falta para emitir a primeira nota no caso comum? |
| `compliance_checklist.md` | O sistema está 100% aderente ao Padrão Nacional? |

Este documento é o principal enquanto o go-live não acontece. Os outros dois viram material de apoio (o de decisões alimenta os itens do Bloco 1 aqui; o de compliance guarda tudo que foi conscientemente adiado para Sprint 2+).

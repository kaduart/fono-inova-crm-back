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

*Atualizado 2026-07-28 — regime, certificado e emissor já respondidos em `decisoes_fiscais_clinica.md`. O que resta é técnico + uma janela de calendário.*

- 🗓️ **`FiscalProviderResolver` só roteia para Sefin Nacional a partir de 01/09/2026** — mesmo com Simples Nacional confirmado, uma emissão hoje ainda cairia no `AnapolisMunicipalAdapter` (bloqueado por 403). Decisão: mirar go-live em/após 01/09/2026, não perseguir o desbloqueio do NotaControl.
- 🔴 Assinatura digital real não implementada — `CertificateManager` ainda é só Mock (certificado A1 já existe, falta integrar)
- 🔴 mTLS não implementado — `httpsAgent` do `SefinNacionalAdapter` sempre `undefined`
- 🔴 Seleção de ambiente (homologação/produção) incorreta — `_attemptSubmission.js:27` ignora `FiscalProfile.ambiente`
- 🔴 Endereço do prestador e do tomador — endereço da clínica já coletado (ver Bloco 2), mas ainda não está no schema/DPS; endereço do tomador (paciente) ainda falta juntar código IBGE
- 🟡 Tomador Pessoa Jurídica confirmado como caso real (`decisoes_fiscais_clinica.md` #4) — subiu de Sprint 2 para Sprint 1, `Patient` não tem campo `cnpj`
- 🟡 Retenção de ISS confirmada com evidência real (nota da Isabela F. Mendonça, Unimed Anápolis — `decisoes_fiscais_clinica.md` #5) — subiu de Sprint 2 para Sprint 1, `DpsBuilder.js:83` hoje fixa "não retido" sempre

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

### Como os três documentos se relacionam

| Documento | Pergunta que responde |
|---|---|
| `decisoes_fiscais_clinica.md` | O que o contador/operação precisa decidir? |
| `go_live_nfse.md` (este) | O que falta para emitir a primeira nota no caso comum? |
| `compliance_checklist.md` | O sistema está 100% aderente ao Padrão Nacional? |

Este documento é o principal enquanto o go-live não acontece. Os outros dois viram material de apoio (o de decisões alimenta os itens do Bloco 1 aqui; o de compliance guarda tudo que foi conscientemente adiado para Sprint 2+).

# NFS-e Padrão Nacional — Especificação de Referência (Fase 1: Pesquisa)

> Documento de pesquisa técnica, produzido a partir da documentação oficial do Portal Nacional da NFS-e (gov.br/nfse), como Fase 1 (de 5) do módulo fiscal de emissão de NFS-e do CRM Clínica. **Não contém desenho de domínio nem código** — isso é escopo da Fase 2.
>
> Convenção usada neste documento: blocos marcados **[LACUNA]** indicam que a documentação oficial não deixou algo claro, está incompleta, ou não pôde ser acessada (ex.: Swagger vivo protegido por certificado). Nesses casos, o documento registra a lacuna em vez de inferir com conhecimento genérico de NFS-e municipal antigo — decisão explícita do projeto de **não** se basear no layout ABRASF/municipal antigo de Goiânia.

**Fontes primárias consultadas** (todas em `gov.br/nfse`):
- `/biblioteca/documentacao-tecnica` (índice)
- `/biblioteca/documentacao-tecnica/documentacao-atual` (manuais e guias vigentes de Produção)
- `/biblioteca/documentacao-tecnica/apis-prod-restrita-e-producao` (URLs de Swagger/API)
- `/biblioteca/documentacao-tecnica/atualizacoes-e-implantacoes` (changelog de regras/erros)
- `/biblioteca/documentacao-tecnica/rtc` (Reforma Tributária do Consumo — grupos IBS/CBS)
- Manuais PDF baixados e lidos integralmente (ver lista completa na seção "Fontes e cobertura" ao final)

---

## 1. Visão Geral

O **Sistema Nacional NFS-e** (Padrão Nacional da Nota Fiscal de Serviço eletrônica) é uma plataforma federal que padroniza a emissão, o compartilhamento e a distribuição de documentos fiscais de serviço (NFS-e) entre municípios brasileiros, substituindo os múltiplos layouts municipais (ex.: ABRASF 2.04 usado por Goiânia até a migração) por um único leiaute nacional, um único ambiente de dados nacional (ADN) e uma Sefin Nacional que pode atuar como emissora para municípios que não mantêm sistema próprio.

O sistema é operado/governado por um **Comitê Gestor da NFS-e (CGNFS-e)**, cuja Secretaria-Executiva (SE/CGNFS-e) publica Notas Técnicas (NT) que alteram o leiaute e as regras de validação (ex.: NT007, NT009).

**Prazo de adoção obrigatória** — segundo fontes secundárias (associações municipais, consultorias fiscais, portal de notícias, e um instrumento normativo municipal de Goiânia indexado no LegisWeb; **não confirmado diretamente no texto das páginas oficiais do gov.br/nfse que foram acessadas nesta pesquisa** — registrado como **[LACUNA]** a validar contra o texto legal primário):
- Base legal citada: Emenda Constitucional nº 132/2023 e art. 62 da Lei Complementar Federal nº 214/2025.
- Obrigatoriedade nacional a partir de **01/01/2026** para os municípios (sob pena de perda de acesso a transferências voluntárias da União).
- Goiânia (base geográfica do CRM) começou a adotar o modelo nacional em **01/10/2025**, mantendo recepção paralela do layout antigo (ABRASF) até 31/01/2026 — Instrução Normativa SMF nº 2/2026 (Goiânia) citada como fonte municipal oficial, não lida diretamente nesta pesquisa.
- **[LACUNA]** Confirmar formalmente, junto à Prefeitura de Goiânia ou ao Painel Administrativo Municipal do Sistema Nacional NFS-e, que o convênio de Goiânia está ativo e operante hoje (2026-07-15), e se o município usa a Sefin Nacional (emissão delegada) ou Sefin própria transcrita para o padrão nacional — isso muda qual conjunto de APIs o CRM deve consumir (ver Seção 3).

Confirmado diretamente na documentação oficial (página inicial do portal, 2026-07-15): há uma **prorrogação de prazo do leiaute do DANFSe para 03/08/2026** ("DANFSE: novos ajustes de leiaute e prorrogação do prazo para adequação — novo prazo passa a ser 3 de agosto de 2026") e a mesma data (03/08/2026) é apontada na página RTC como marco de obrigatoriedade dos grupos IBS/CBS (Reforma Tributária do Consumo, NT009) — ver Seção 8.

**Por que existe**: eliminar a fragmentação de ~5.000 leiautes municipais de NFS-e, permitir emissão/consulta/compartilhamento nacional único (ADN), viabilizar integração com CNPJ, CPF, Simples Nacional e a futura Reforma Tributária do Consumo (IBS/CBS) em um único ponto técnico.

---

## 2. Arquitetura Nacional

Componentes identificados na documentação oficial:

- **DPS (Declaração de Prestação de Serviço)** — arquivo XML enviado pelo contribuinte (emitente) contendo os dados básicos da operação (tomador, valor, serviço, local). É o documento de **entrada** do fluxo regular de emissão.
- **NFS-e** — documento fiscal gerado pela Sefin (Nacional ou municipal) a partir da validação da DPS, já com os campos calculados (alíquota, local de incidência do ISSQN, tributos) preenchidos pela plataforma. É o documento de **saída**.
- **DANFSe (Documento Auxiliar da NFS-e)** — representação em PDF da NFS-e, gerada sob demanda a partir da chave de acesso, não é o documento fiscal em si (o XML é a fonte da verdade).
- **Eventos** — documentos fiscais eletrônicos (DF-e) que registram fatos posteriores à emissão vinculados a uma NFS-e por chave de acesso (cancelamento, manifestação do tomador, bloqueio administrativo, etc.). Também são XML assinados digitalmente.
- **ADN (Ambiente de Dados Nacional)** — repositório e hub de **compartilhamento/distribuição** de todos os DF-e (NFS-e, Eventos, Créditos, Débitos, Apuração) entre municípios conveniados, usando um modelo de sincronização por **NSU (Número Sequencial Único)**, com garantia de entrega e sem exigir alta disponibilidade dos sistemas municipais consumidores.
- **Sefin Nacional NFS-e** — a Sefin (Secretaria de Finanças) operada pelo governo federal, que atua como **emissor público** para municípios que não têm sistema autorizador próprio. É o ponto de emissão relevante para o CRM (contribuinte comum, sem sistema próprio de prefeitura).
- **CNC (Cadastro Nacional de Contribuintes)** — cadastro nacional de contribuintes NFS-e; existe API dedicada (`adn.nfse.gov.br/cnc/...`) mas seu conteúdo **não foi lido nesta pesquisa** — **[LACUNA]**.
- **Calculadora de Tributos / Calculadora RTC** — serviço de cálculo de tributos citado nos logs de correção de erros (ex.: regra E1000 "retornar erros da Calculadora RTC"), integrado internamente pela plataforma durante a validação da DPS. Não há endpoint público documentado nas fontes lidas — **[LACUNA]** sobre se o contribuinte pode consultá-la isoladamente (existe menção a uma API separada "NFS-e Via" para consulta de alíquotas de ISS por trecho/data, citada em notícia do portal, mas não documentada tecnicamente nas páginas de documentação técnica acessadas — **[LACUNA]**).

### Fluxo completo de emissão (fluxo regular, via Sefin Nacional)

1. Contribuinte consulta `GET /parametros_municipais/...` para obter alíquotas, regime de tributação e deduções vigentes no município de incidência (opcional, mas recomendado antes de montar a DPS).
2. Contribuinte monta o XML da DPS, assina digitalmente com certificado do emitente, e envia via `POST /nfse`.
3. Sefin Nacional valida a DPS contra as regras de negócio (ver Seção 7) e, se aprovada, gera a NFS-e (preenchendo os campos calculados) e devolve o XML da NFS-e autorizada. Se reprovada, devolve mensagem de erro com o código de rejeição.
4. A NFS-e gerada recebe uma **chave de acesso** única, usada em todas as consultas/eventos subsequentes.
5. NFS-e e eventos futuros são compartilhados automaticamente no **ADN**, ficando disponíveis para os atores interessados (prestador, tomador, intermediário, municípios de incidência/prestação) via o modelo de NSU.
6. Emissão do DANFSe (PDF) é sob demanda, via `GET /danfse/{chaveAcesso}` — não acontece automaticamente no passo 3.
7. Qualquer alteração de estado pós-emissão (cancelamento, confirmação do tomador, etc.) ocorre exclusivamente via **Eventos**, nunca por edição direta da NFS-e.

### Ciclo de vida da nota (estados observáveis via eventos, fonte: Manual dos Municípios — API Eventos)

`emitida` → (nenhum evento) **válida** → `Evento de Cancelamento de NFS-e` **cancelada**, OU → `Evento de Cancelamento por Substituição` **cancelada + substituída por nova NFS-e**, OU → `Solicitação de Análise Fiscal para Cancelamento` → `Deferido` (cancelada) | `Indeferido` (permanece válida), OU → `Cancelamento de NFS-e por Ofício` (cancelada pelo município, mesmo com manifestação de confirmação prévia). Em paralelo, existe uma trilha de **manifestação** do tomador/prestador/intermediário (`Confirmação` explícita ou `Confirmação Tácita`, `Rejeição`, `Anulação da Rejeição`) que não cancela a nota, apenas registra ciência/contestação. Existe ainda um mecanismo de **bloqueio/desbloqueio por ofício** que a administração tributária usa para impedir temporariamente que certos eventos (ex.: cancelamento) sejam aceitos sobre uma nota específica.

**[LACUNA]** A documentação lida não define um enum explícito de "status" da NFS-e (tipo `cStat`) além do valor `102` citado no contexto específico de decisão administrativa/judicial (ver Seção 5). Não foi possível confirmar a lista completa de valores de `cStat` para o fluxo regular — provavelmente documentada no Anexo I (leiaute DPS/NFSe), que não pôde ser baixado nesta pesquisa (ver Seção 5).

---

## 3. APIs

Todas as APIs abaixo foram extraídas diretamente dos manuais oficiais em PDF (não de swagger, que estava inacessível — ver Seção 4). Os manuais fonte estão identificados em cada bloco.

### 3.1 API Parâmetros Municipais (Sefin Nacional / Emissor Público) — fonte: *Manual de Contribuintes — Emissor Público*

| Endpoint | Método | Finalidade | Regra de negócio | Quando o CRM chama |
|---|---|---|---|---|
| `/parametros_municipais/{codigoMunicipio}/convenio` | GET | Consulta parâmetros do convênio de um município | — | Ao configurar a empresa/clínica no CRM (setup fiscal), para validar que o município está conveniado |
| `/parametros_municipais/{codigoMunicipio}/{codigoServico}` | GET | Consulta alíquotas, regimes especiais de tributação e deduções/reduções por subitem da lista de serviço | — | Ao configurar o(s) código(s) de serviço (LC 116/NBS) da clínica; cache local recomendado |
| `/parametros_municipais/{codigoMunicipio}/{CPF/CNPJ}` | GET | Consulta retenções que o contribuinte deve recolher no município | — | Configuração fiscal da empresa, não por emissão individual |
| `/parametros_municipais/{codigoMunicipio}/{CPF/CNPJ}` | GET | Consulta benefícios municipais do contribuinte | — | Idem acima |

**[LACUNA]** O manual lista as duas últimas rotas com a **mesma assinatura de URL** (`/parametros_municipais/{codigoMunicipio}/{CPF/CNPJ}`) para duas finalidades distintas (retenções vs. benefícios) sem diferenciar por verbo, query string ou sufixo. Isso é provavelmente um erro de edição do manual (path duplicado) — precisa ser confirmado no Swagger real antes de implementar (ver Seção 4 sobre inacessibilidade do Swagger nesta pesquisa).

### 3.2 API NFS-e e DPS (Sefin Nacional) — fonte: *Manual de Contribuintes — Emissor Público*

| Endpoint | Método | Finalidade | Payload entrada | Payload saída | Regras / quando chamar |
|---|---|---|---|---|---|
| `/nfse` | POST | **Emissão síncrona** da NFS-e a partir da DPS | XML da DPS assinado digitalmente | XML da NFS-e autorizada, ou mensagem de erro com motivo da rejeição | Chamado no momento da emissão fiscal (1 clique na tela de Recebimentos, por sessão/pacote concluído). Síncrono — sem necessidade de polling para o resultado da emissão em si |
| `/nfse` (mesmo endpoint) | POST | **Substituição** de NFS-e — quando a DPS enviada contém a chave de acesso de uma NFS-e já existente | Idem, com campo que referencia a chave de acesso a substituir (`chSubstda`, inferido do Manual dos Municípios, Seção 2) | XML da nova NFS-e + evento de Cancelamento por Substituição gerado automaticamente e vinculado à nota original | Usado para correção pós-emissão (não existe PATCH/PUT de NFS-e) |
| `/nfse/{chaveAcesso}` | GET | Consulta NFS-e pela chave de acesso | — | XML da NFS-e | Toda consulta de status/exibição de nota já emitida |
| `/dps/{id}` | GET | Recupera a chave de acesso de uma NFS-e a partir do identificador da DPS | id = Cód. IBGE Município Emissor(7) + Tipo Inscrição(1) + Inscrição Federal(14) + Série DPS(5) + Núm. DPS(15) | Chave de acesso da NFS-e correspondente | Só retorna dado se o certificado do solicitante corresponder a um ator da nota (sigilo fiscal) |
| `/dps/{id}` | HEAD | Verifica se uma NFS-e já foi gerada a partir de uma DPS, sem revelar a chave | Idem acima | Sem corpo — apenas HTTP status | Qualquer usuário com certificado válido pode chamar (não exige ser ator da nota) |

### 3.3 API Eventos (Sefin Nacional / Municípios) — fonte: *Manual de Contribuintes — Emissor Público* + *Manual dos Municípios*

| Endpoint | Método | Finalidade | Regras | Quando o CRM chama |
|---|---|---|---|---|
| `/nfse/{chaveAcesso}/eventos` | POST | Registro genérico de evento (modelo único para todos os tipos) | Corpo = envelope JSON genérico + XML específico do tipo de evento assinado digitalmente. Requer que a NFS-e já exista na Sefin geradora | Cancelamento solicitado pelo usuário do CRM (equivalente a "estornar" no financeiro) |
| `/nfse/{chaveAcesso}/eventos` | GET | Lista todos os eventos vinculados a uua chave de acesso | — | Exibir histórico fiscal de uma nota na UI |
| `/nfse/{chaveAcesso}/eventos/{tipoEvento}` | GET | Lista eventos de um tipo específico | — | Verificar, por exemplo, se já existe manifestação do tomador |
| `/nfse/{chaveAcesso}/eventos/{tipoEvento}/{numSeqEvento}` | GET | Consulta um evento específico (com sequencial) | Sequencial = 1 se o tipo não permitir múltiplas ocorrências | Auditoria pontual |

**Tipos de evento documentados** (fonte: Manual dos Municípios, lista exaustiva):
1. Cancelamento de NFS-e
2. Cancelamento por Substituição de NFS-e
3. Solicitação de Análise Fiscal para Cancelamento de NFS-e
4. Cancelamento de NFS-e Deferido por Análise Fiscal
5. Cancelamento de NFS-e Indeferido por Análise Fiscal
6. Manifestação de NFS-e — Confirmação do Prestador / do Tomador / do Intermediário / Confirmação Tácita / Rejeição do Prestador / do Tomador / do Intermediário / Anulação da Rejeição
7. Cancelamento de NFS-e por Ofício (só o município emissor pode emitir; funciona mesmo com confirmação prévia)
8. Bloqueio de NFS-e por Ofício (impede que um tipo específico de evento seja aceito enquanto não houver desbloqueio)
9. Desbloqueio de NFS-e por Ofício

**[LACUNA]** Os **códigos numéricos** (`tipoEvento`) de cada um desses eventos — necessários para montar as chamadas de consulta por tipo (`/eventos/{tipoEvento}`) e para interpretar o `id`/leiaute do evento — não constam nos manuais lidos; estão, segundo referência cruzada nos próprios manuais, no `AnexoII-LeiautesRN_Eventos-SNNFSe`, um anexo em planilha (xlsx) hiperlinkado dentro do PDF que **não foi baixado nesta pesquisa** (o link é um hyperlink interno de PDF, não uma URL de topo listada na página de documentação). Isso é bloqueante para implementar cancelamento/substituição corretamente e deve ser o primeiro item a resolver na Fase 2.

### 3.4 API NFS-e com Decisão Administrativa/Judicial ("bypass") — fonte: *Manual — Emissão por Decisão Administrativa ou Judicial*

| Endpoint | Método | Finalidade | Regras | Quando o CRM chama |
|---|---|---|---|---|
| `/decisao-judicial/nfse` | POST | Emissão síncrona de NFS-e **completa** (não uma DPS) quando há decisão administrativa/judicial que dispensa a validação padrão | Exige pré-cadastro da decisão pelo Município autorizando o contribuinte a usar esse fluxo. O contribuinte assume responsabilidade por **todos** os campos normalmente calculados pela plataforma (alíquota, local de incidência, etc.); validações mínimas (DV de CPF/CNPJ) continuam ativas | Relevante para o domínio **Liminar** do CRM (Package tipo `liminar`) — ver Seção 9 |

Consulta e cancelamento de uma NFS-e emitida por esse fluxo usam os **mesmos endpoints do fluxo regular** (Seção 3.2/3.3) — não há API de consulta/cancelamento dedicada.

### 3.5 API DF-e / ADN (compartilhamento e distribuição) — fonte: *Manual dos Municípios*

| Endpoint | Método | Finalidade | Regras | Relevância p/ CRM |
|---|---|---|---|---|
| `/DFe/` | POST | Recepção de lote de DF-e de sistemas autorizadores municipais | Máx. 50 documentos/lote, 1 MB/lote, ordem cronológica obrigatória (NFS-e antes do evento que a referencia) | Não aplicável — é API para **Sefins municipais**, não para contribuintes/CRM |
| `/DFe/{UltimoNSU}` | GET | Distribui até 50 DF-e a partir do último NSU conhecido pelo solicitante | Se não houver mais documentos, aguardar ≥ 1h antes de nova consulta | Não aplicável a contribuintes (é API de município) |
| `/DFe/{NSU}` | GET | Consulta pontual de um DF-e por NSU | — | Não aplicável a contribuintes |
| `/DFe/{NSU}` | GET (variante para **contribuintes**, fonte: *Manual — Guia ADN Contribuintes*) | Retorna o DF-e correspondente ao NSU informado | Consulta pode ser feita com certificado cujo CNPJ Raiz corresponda ao contribuinte consultado; parâmetro adicional permite CNPJ de consulta diferente do certificado (mesma raiz) | Sincronização/backup de documentos fiscais do próprio CNPJ da clínica |
| `/NFSe/{ChaveAcesso}/Eventos` | GET (contribuintes) | Retorna eventos do tipo "Documento Fiscal de Serviço — Evento" vinculados a uma chave de acesso | — | Equivalente, do lado do contribuinte via ADN, ao `/nfse/{chaveAcesso}/eventos` da Sefin |

### 3.6 API DANFSe — fonte: *Manual dos Municípios*

| Endpoint | Método | Finalidade | Regras | Quando o CRM chama |
|---|---|---|---|---|
| `/danfse/{chaveAcesso}` | GET | Gera/recupera o PDF (DANFSe) de uma NFS-e a partir da chave de acesso | Funciona para qualquer NFS-e presente no ADN, inclusive as emitidas por sistema próprio de município, desde que compartilhadas com o ADN | Ao clicar em "baixar/visualizar nota" na UI do CRM |

### 3.7 CNC (Cadastro Nacional de Contribuintes)

Existem 3 URLs de Swagger listadas (`/cnc/docs`, `/cnc/municipio/docs`, `/cnc/consulta/docs`) tanto em Produção Restrita quanto em Produção. **[LACUNA]** Conteúdo funcional não documentado em nenhum manual PDF lido — só a existência das URLs foi confirmada na página "APIs - Prod. Restrita e Produção". Relevância para o CRM não determinada; pode ser necessário caso a clínica precise validar o próprio cadastro de contribuinte nacional antes de emitir.

### 3.8 Acesso aos Swaggers ao vivo

Todas as tentativas de acessar as URLs de Swagger (`adn.nfse.gov.br/contribuintes/docs/index.html`, `adn.nfse.gov.br/danfse/docs/index.html`) retornaram **HTTP 496** nesta pesquisa (erro típico de handshake TLS ausente/certificado de cliente exigido antes mesmo de servir a página do Swagger). **[LACUNA]** Não foi possível confirmar os schemas JSON exatos de request/response, nem os nomes exatos de parâmetros de query, além do que os manuais em prosa descrevem. Isso deve ser resolvido na Fase 2/3 obtendo um certificado de teste e acessando o ambiente de Produção Restrita.

---

## 4. Autenticação e Segurança

Extraído da documentação oficial:

- **Certificado digital é obrigatório** para toda chamada às APIs — tanto para emitir (assinatura da DPS/NFS-e/Evento) quanto para consultar (autenticação da conexão). Confirmado por: (a) menção explícita e recorrente nos manuais ("desde que realize a consulta com um certificado digital válido"); (b) o próprio acesso aos Swaggers públicos falhou com erro de nível de transporte (HTTP 496), consistente com exigência de mTLS/certificado de cliente na camada de rede, não apenas na aplicação.
- **Validação por CNPJ Raiz**: a API de Distribuição para Contribuintes (`GET /DFe/{NSU}` variante contribuinte) permite consulta usando um certificado cujo CNPJ tenha a mesma **raiz** (8 primeiros dígitos) do contribuinte consultado — relevante para grupos econômicos/filiais.
- **Sigilo fiscal por ator**: `GET /dps/{id}` só retorna a chave de acesso se o certificado da conexão pertencer a um dos atores da nota (Prestador, Tomador, Intermediário); `HEAD /dps/{id}` é liberado para qualquer certificado válido (não exige ser ator).
- **Assinatura digital de XML**: DPS, NFS-e e Eventos são XML assinados digitalmente pelo emissor de cada documento (o evento é assinado por quem o emite: contribuinte, ou município). O modelo de mensagem de evento exige, no mínimo: identificação do autor, identificação do evento, identificação da NFS-e vinculada, informações específicas do evento, e a assinatura digital.
- **Erros específicos de certificado** (ver Seção 7): `E1634` — Certificado Digital fora do padrão estabelecido; `E1200` — Certificado Digital da transmissão inválido.
- **Ambientes**: dois ambientes com hosts distintos e independentes:
  - **Produção Restrita** (homologação/testes): `*.producaorestrita.nfse.gov.br` — ex. `adn.producaorestrita.nfse.gov.br`, `sefin.producaorestrita.nfse.gov.br`
  - **Produção**: `*.nfse.gov.br` — ex. `adn.nfse.gov.br`, `sefin.nfse.gov.br`
  - Mesma estrutura de rotas nos dois ambientes; presume-se necessidade de certificado válido também em Produção Restrita, mas **[LACUNA]**: não confirmado se o ambiente de testes aceita certificado de teste (ICP-Brasil "fake"/homologação) ou exige certificado real — não documentado nas fontes lidas.

**[LACUNA]** Tipo(s) de certificado aceito(s) — e-CNPJ A1 vs A3, formato de token/HSM, se há suporte a certificado de procurador/e-CPF do contador — **não confirmado** nos manuais lidos. Isso é crítico para decidir a arquitetura de `CertificateManager` na Fase 2 e deve ser resolvido antes de qualquer implementação (ex.: A3 físico/HSM implica não poder assinar em servidor Node.js sem hardware ou serviço de assinatura terceirizado; A1 em arquivo permite assinatura server-side).

---

## 5. Estruturas XML/XSD

A documentação oficial referencia consistentemente um conjunto de anexos técnicos que definem o leiaute completo, mas **os arquivos XSD/planilhas em si não puderam ser baixados nesta pesquisa** — são hiperlinks internos de PDF (não URLs de topo na árvore de páginas navegada) ou arquivos xlsx fora do escopo de leitura desta sessão:

- `ANEXO_I-SEFIN_ADN-DPS_NFSe-SNNFSe` (também citado como `AnexoI-LeiautesRN_DPS_NFSe-SNNFSe`) — leiaute + regras de negócio da DPS e da NFS-e. **[LACUNA — arquivo não obtido]**
- `AnexoII-LeiautesRN_Eventos-SNNFSe` — leiaute + regras de negócio de todos os tipos de evento, incluindo os códigos numéricos de `tipoEvento`. **[LACUNA — arquivo não obtido, bloqueante para Seção 3.3]**
- `AnexoIV-LeiautesRN_ADN-SNNFSe` — regras de processamento de recepção de lote de DF-e pelo ADN. **[LACUNA — arquivo não obtido]**
- `ANEXO_A-MUNICIPIO_IBGE-PAISES_ISO2-v1.00-SNNFSe-20251210` — tabela de códigos de município (IBGE, 7 dígitos) e países (ISO2), usada em `cLocIncid`, `cLocPrestacao`, `cLocEmi`. **[LACUNA — arquivo não obtido]**
- `ANEXO_B`, `ANEXO_C` (mencionados no contexto do fluxo de decisão administrativa/judicial, sem descrição de conteúdo nas páginas lidas) — **[LACUNA]**
- `AnexoVI-LeiautesRN_RTC_IBSCBS-V1.04.00 – NT009` e `AnexoVII-IndOp_IBSCBS_V1.02.00` (xlsx) — leiaute específico dos grupos IBS/CBS da Reforma Tributária. **[LACUNA — arquivo não obtido]**, mas a página RTC confirma textualmente que o layout-base atualmente exigido em Produção/Produção Restrita é **NT004 + `tpRetPisCofins` da NT007**, e que os grupos IBS/CBS entram em obrigatoriedade a partir de 03/08/2026.

### Campos individuais confirmados (via leitura integral do Manual de Decisão Administrativa/Judicial, que lista campos que "geram dúvida" e portanto documenta seu formato exato)

| Campo | Formato / valor | Observação |
|---|---|---|
| `cStat` | Numérico. `102` = decisão administrativa/judicial | Único valor de `cStat` confirmado nas fontes lidas; enum completo é **[LACUNA]** |
| `nNFSe` | Sequencial. Gerado pela plataforma no fluxo regular; **gerado e controlado pelo contribuinte** no fluxo de decisão judicial | Risco de colisão é responsabilidade do emitente no fluxo bypass |
| `ambGer` | `2` = emissão pela Sefin Nacional | Sugere existir valor `1` para emissão por Sefin municipal própria — **[LACUNA]** não confirmado |
| `tpEmis` | `1` = emissão direta no modelo NFS-e Nacional | Distingue de NFS-e emitida em leiaute próprio do município e depois transcrita — **[LACUNA]** valor para esse segundo caso não confirmado |
| `procEmi` | Opcional | — |
| `nDFSe` | `0` quando não há Documento Fiscal Eletrônico gerado por ambiente próprio do município | — |
| `dhProc` | Mesmo valor de `dhEmi` no fluxo de decisão judicial | No fluxo regular presumivelmente é preenchido pela plataforma no momento do processamento — **[LACUNA]** |
| `cLocIncid` | Código IBGE de 7 dígitos | Local de incidência do ISSQN; segue LC 116/2003, com exceção para imunidade, exportação de serviço, ou serviço sem ISSQN (`cTribNac = 990101`) |
| `xLocPrestacao`, `xLocEmi` | Texto (nome do município) | Derivados de `cLocPrestacao`/`cLocEmi` via tabela IBGE (Anexo A) |
| `pAliq` | Percentual | Opcional na DPS padrão (calculado pela plataforma); **obrigatório** no fluxo de decisão judicial |
| `xTribNac`, `xTribMun` | Texto | Descrição do código de tributação nacional/municipal do ISSQN |
| `verAplic` | Livre (à escolha do contribuinte) | Versão do software emissor |
| `versao` | Versão do leiaute/schema no elemento raiz `NFSe/` | Crítico para não ser rejeitado por schema desatualizado |
| `id` (elemento `NFSe/infNFSe/id`) | 53 posições, prefixado por `"NFS"`: Cód.Mun.(7) + AmbGer(1) + TipoInscrFederal(1) + InscrFederal(14, CPF completado com zeros à esquerda) + nNFSe(13) + AnoMesEmis(4) + Cód.Num.aleatório(9) + DV(1) | DV calculado por **módulo 11**. Estrutura análoga (mas não idêntica) ao padrão de chave de acesso da NF-e de mercadoria |

**Identificador da DPS** (usado em `GET /dps/{id}`, confirmado em dois manuais distintos): Código IBGE do Município Emissor (7) + Tipo de Inscrição (1) + Inscrição Federal (14, CPF completado com "000" à esquerda) + Série da DPS (5) + Número da DPS (15).

**[LACUNA GERAL]** Sem os Anexos I/II/A baixados, **não é possível** neste momento enumerar: a lista completa de campos obrigatórios vs. opcionais da DPS/NFS-e no fluxo regular; a árvore XML completa (elementos pai/filho); as versões de XSD vigentes (o portal indica leiautes "antigos" cobrem julho/2022 a 28/09/2025 — o leiaute atual, portanto, está em vigor desde 29/09/2025, mas o número de versão do XSD atual em si não foi capturado). Este é o item de maior prioridade para a Fase 2 antes de desenhar o `DpsBuilder`.

---

## 6. Fluxos operacionais

| Fluxo | Endpoint(s) | Síncrono/Assíncrono | Observações |
|---|---|---|---|
| **Emissão** | `POST /nfse` | Síncrono — retorna XML da NFS-e ou erro na mesma resposta | Não há fila/callback documentado; a validação de negócio acontece na chamada |
| **Emissão por decisão judicial/administrativa** | `POST /decisao-judicial/nfse` | Síncrono | Exige pré-autorização municipal cadastrada na plataforma; contribuinte informa todos os campos calculados |
| **Consulta por chave de acesso** | `GET /nfse/{chaveAcesso}` | Síncrono | — |
| **Consulta por identificador da DPS** | `GET /dps/{id}` (chave) / `HEAD /dps/{id}` (existência) | Síncrono | Sigilo fiscal restringe o `GET` a atores da nota |
| **Cancelamento** | `POST /nfse/{chaveAcesso}/eventos` com corpo do tipo "Cancelamento de NFS-e" | Síncrono | Efeito imediato, salvo se a nota estiver bloqueada por ofício |
| **Substituição** | `POST /nfse` reenviando DPS com referência à chave de acesso anterior (`chSubstda`, nome de campo inferido do texto do manual, não confirmado no XSD) | Síncrono | Gera automaticamente o Evento de Cancelamento por Substituição vinculado à nota original |
| **Solicitação de análise fiscal p/ cancelamento** | `POST /nfse/{chaveAcesso}/eventos` (tipo específico) | Síncrono no envio; o **deferimento é assíncrono** (evento futuro emitido pelo município) | Fluxo relevante quando o cancelamento simples não é aceito (ex.: prazo expirado) — **[LACUNA]** prazo/regra exata de quando cancelamento direto deixa de ser aceito e passa a exigir análise fiscal não encontrada nos manuais lidos |
| **Manifestação do tomador** | Evento (tipo "Manifestação") | Assíncrono por natureza (ação de terceiro, o tomador) | O CRM deve tratar como evento a ser **consultado periodicamente** (`GET /eventos`) ou descoberto via distribuição do ADN — não há webhook documentado (ver Seção 9) |
| **Download XML** | `GET /nfse/{chaveAcesso}` | Síncrono | Retorna o XML completo |
| **Download DANFSe (PDF)** | `GET /danfse/{chaveAcesso}` | Síncrono | Gerado sob demanda a partir do XML já existente no ADN |
| **Sincronização/backup de documentos do próprio CNPJ** | `GET /DFe/{NSU}` (variante contribuinte) | Síncrono, mas desenhado para **polling incremental** via NSU | Útil para reconciliação (detectar eventos gerados por terceiros, ex. bloqueio pelo município, sem que o CRM tenha iniciado a ação) |

**Não há webhook/push nativo documentado.** Toda descoberta de mudança de estado que não foi iniciada pelo próprio CRM (ex.: cancelamento de ofício pelo município, deferimento de análise fiscal, manifestação do tomador) depende de **polling** via `GET /nfse/{chaveAcesso}/eventos` ou via o mecanismo de NSU do ADN. Isso tem implicação direta de arquitetura (worker de reconciliação periódica) — ver Seção 9.

---

## 7. Tratamento de Erros

Códigos de erro confirmados diretamente no changelog oficial ("Atualizações e Implantações", entradas de 24/04/2026 e correlatas):

| Código atual | Código anterior (deprecado) | Descrição |
|---|---|---|
| `E1235` | `RNG6110` | Falha de Schema XML |
| `E1634` | `E6151` | Certificado Digital fora do padrão estabelecido |
| `E1200` | `E6152` | Certificado Digital da transmissão inválido |
| `E1229` | `E6154` | XML não está utilizando codificação UTF-8 |
| `E1228` | `E6155` | XML declarado com prefixo de namespace (não permitido) |
| `E1225` | `E6157` | Falha ao descompactar XML Zip Base64 |
| `E1000` | (novo) | Erros repassados pela Calculadora RTC (tributos) |
| `E1577`, `E1549`, `E1554` | — | Validação de campos do grupo IBSCBS (`pAliqEfetUF`, `pAliqEfetMun`, `pAliqEfetCBS` devem igualar `pIBSUF`/`pIBSMun`/`pCBS` quando não há redutores) — corrigidas em 01/07/2026 |
| `E0675` | — | Regra de retenção de tributos federais para prestador/fornecedor PF (CPF) — **desligada** em 13/03/2026 |
| `E1543`, `E1547`, `E1552` | — | Desligadas em 13/03/2026 por conflito com outras regras |

**Padrão observado**: os códigos migraram de uma nomenclatura antiga (`RNGxxxx`, `E6xxx`) para uma nova faixa `E1xxx` ao longo de 2026 — indicando que a plataforma está em evolução ativa de nomenclatura de erros. **Implicação prática**: o CRM não deve fazer match rígido em códigos de erro específicos sem uma camada de tradução central (`ErrorCodeMap`) que possa ser atualizada facilmente, já que a própria documentação mostra códigos sendo renomeados em produção.

**[LACUNA]** **Lista exaustiva de códigos de rejeição de negócio** (ex.: "tomador inválido", "alíquota incompatível", "data futura") — o changelog só documenta correções pontuais, não a tabela completa de regras de validação da DPS (`RN_DPS_NFS-e`), que está no Anexo I não obtido (Seção 5). Sem essa tabela, não é possível hoje mapear 1:1 os erros para mensagens amigáveis na UI do CRM.

**Idempotência**: não há endpoint de idempotência explícito (tipo idempotency-key) documentado. O controle de duplicidade é feito via:
- `nNFSe` sequencial (gerado pela plataforma no fluxo regular — portanto o CRM não controla nem precisa se preocupar com colisão nesse fluxo);
- a chave de acesso (`id`, 53 posições) inclui um componente aleatório de 9 dígitos + DV módulo 11, calculado pelo contribuinte apenas no fluxo de decisão judicial;
- a substituição de nota (reenvio de DPS referenciando `chSubstda`) é o mecanismo oficial de "correção", não uma nova tentativa idempotente da mesma operação.

**Estratégia de reprocessamento**: **[LACUNA]** não documentada explicitamente. Como a emissão é síncrona (`POST /nfse` retorna sucesso ou erro na mesma chamada), o "reprocessamento" na prática é simplesmente reenviar a DPS corrigida — não há fila de retry gerenciada pela plataforma nacional. Isso empurra a responsabilidade de retry/backoff em caso de timeout de rede inteiramente para o lado do consumidor (o CRM), reforçando a necessidade de um `AuditService`/log de tentativas no desenho da Fase 2.

---

## 8. Regras de Negócio

Confirmadas na documentação oficial:

- **ISS obedece a LC 116/2003**: o local de incidência do ISSQN (`cLocIncid`) segue as regras da Lei Complementar 116/2003, com exceções documentadas para: imunidade (sem incidência), exportação de serviços, e serviços sem ISSQN (`cTribNac = 990101`, sem destaque de imposto).
- **Alíquotas e regime de tributação são parametrizados por município**: obtidos via `GET /parametros_municipais/{codigoMunicipio}/{codigoServico}` — a plataforma calcula automaticamente no fluxo regular; o contribuinte só informa manualmente no fluxo de decisão judicial (bypass).
- **Integração com Simples Nacional, CNPJ e CPF**: citada explicitamente como pré-requisito de processamento da DPS/NFS-e ("Informações das integrações com os cadastros CNPJ, CPF e Simples Nacional"), mas as regras específicas de como o regime tributário do Simples Nacional afeta os campos calculados **não estão detalhadas** nas fontes lidas — **[LACUNA]**.
- **Reforma Tributária do Consumo (IBS/CBS)**: a partir de **03/08/2026** (data ainda sujeita a novo adiamento — a página RTC nota que "o cronograma de implantação desta Nota Técnica [009] será divulgado futuramente"), tornam-se obrigatórios os grupos `IBS`/`CBS` no leiaute, com validações cruzadas entre `pAliqEfetUF`/`pAliqEfetMun`/`pAliqEfetCBS` e `pIBSUF`/`pIBSMun`/`pCBS`. O layout-base já exigido hoje em Produção é **NT004 + `tpRetPisCofins`** (NT007). **Implicação direta para o CRM**: qualquer `DpsBuilder` desenhado na Fase 2 deve ser construído com esses campos como "futuros obrigatórios conhecidos", não como surpresa.
- **Emissão por decisão administrativa/judicial ("bypass")**: mecanismo formal para atender decisões que exigem desviar das regras padrão de validação. Requer autorização prévia do Município cadastrada na plataforma; desloca toda a responsabilidade pelos valores/tributos para o contribuinte, mantendo apenas validações mínimas de integridade (dígitos verificadores). **Este é o mecanismo que mais se aproxima, do lado da NFS-e, do domínio `Package` tipo `liminar` já existente no CRM** — ver Seção 9.
- **Substituição de NFS-e**: mecanismo formal e único de correção pós-emissão — não existe edição direta. A substituição gera automaticamente um evento de cancelamento vinculado à nota original.
- **Regime tributário da clínica** (Simples Nacional, Lucro Presumido, etc.) e **CNAE/código de serviço LC116** não têm sua interação com o cálculo de ISS detalhada nos manuais lidos além do que já foi dito acima — **[LACUNA]** a ser esclarecida na Fase 2 possivelmmente lendo o "Guia do Emissor Público Nacional Web" (104 páginas, baixado mas não lido integralmente nesta pesquisa por não ser uma API — é o manual de uso da interface web) ou os anexos de regras de negócio (RN_DPS_NFS-e).

---

## 9. Impacto no CRM

Esta seção conecta o que a API oficialmente exige (Seções 2–8) com a arquitetura real do CRM (Payment, Package, Appointment, Invoice) descrita no CLAUDE.md do projeto.

### 9.1 Por que a entidade fiscal não pode se chamar `Invoice`

O CRM já tem um domínio `Invoice` que representa **fatura de cobrança** (draft → open → partial → paid → overdue → canceled), vinculada a `Payment`, e serve para cobrar o paciente/convênio. A NFS-e é um **documento fiscal tributário** emitido perante o Fisco municipal — tem seu próprio ciclo de vida (emitida → cancelada/substituída, governado por Eventos do Sistema Nacional, não pelo CRM), sua própria chave de identidade (chave de acesso de 50 posições / `id` de 53 posições), e pode ou não existir 1:1 com uma `Invoice` (ex.: uma nota fiscal pode consolidar múltiplas cobranças, ou uma cobrança pode nunca gerar nota se o tomador for isento). **Nome proposto: `FiscalInvoice`** (ou `NFSe`, a decidir na Fase 2) — entidade nova, desacoplada de `Invoice`.

**Relação `Invoice` × `FiscalInvoice` (documento fiscal)**:
- `Invoice` = visão financeira/comercial do CRM (o que o paciente deve, já pago, em atraso). Não tem relação obrigatória com o Fisco.
- `FiscalInvoice`/`NFSe` = documento tributário, referenciando 1 ou mais `Payment`/`Invoice` como origem do valor a declarar, mas com seu próprio status (`emitida`, `cancelada`, `substituída`) que **não deve jamais sobrescrever** o status de `Invoice` ou `Payment` — assim como o CLAUDE.md já estabelece que `appointment.paymentStatus` é "shadow state a eliminar" (ver `project_payment_ssot_architecture.md` na memória do projeto), a Fase 2 deve evitar criar um novo shadow state cruzado entre `Invoice.status` e `FiscalInvoice.status`. Ambos avançam de forma independente, com `FiscalInvoice` apenas referenciando (nunca herdando automaticamente) o estado de `Payment`.

### 9.2 Ponto de disparo no fluxo Payment (provisioning/settlement)

O domínio `Payment` já separa **provisioning** (pending no agendamento) de **settlement** (paid no complete do Appointment). A emissão fiscal, segundo a documentação oficial (Seção 6), é **síncrona e sob demanda** — não há como "pré-emitir" e confirmar depois (ao contrário do provisioning financeiro do CRM). Isso implica que a emissão de NFS-e deve ser disparada **no settlement** (quando o `Payment` vira `paid`, refletindo serviço efetivamente prestado/cobrado), nunca no provisioning — emitir nota fiscal de algo ainda `pending` seria declarar ao Fisco um serviço que pode nunca se concretizar (ex.: cancelamento do agendamento libera o slot automaticamente, conforme invariante do domínio Appointment).

### 9.3 Package: `therapy`, `convenio`, `liminar`

- **`therapy` (particular)** e **`convenio`**: usam o fluxo regular (`POST /nfse` com DPS), pois o cálculo de alíquota/local de incidência pode ser feito pela plataforma nacional.
- **`liminar` (judicial)**: existe uma correspondência direta e não trivial com o fluxo oficial de **"Emissão por Decisão Administrativa ou Judicial"** (`POST /decisao-judicial/nfse`, Seção 3.4/8). Uma nota fiscal emitida para um paciente sob decisão judicial de tratamento pode, dependendo do teor da decisão (ex.: isenção de ISS, valor diferente do tabelado), precisar desse fluxo de bypass — que exige pré-autorização municipal cadastrada na plataforma nacional e desloca toda a responsabilidade de cálculo para o CRM. **Isso é uma descoberta relevante desta pesquisa**: o motor de sessão de `liminar` já é desacoplado dos demais (`project_convenio_liminar_architecture.md`), e a Fase 2 deve avaliar se `FiscalInvoiceService` precisa de um sub-fluxo espelhando essa separação, incluindo um passo manual/administrativo de "confirmar que o município autorizou o CNPJ da clínica a usar o bypass judicial" antes de permitir a emissão — não é algo que pode ser resolvido em 1 clique sem essa autorização prévia.

### 9.4 UX já decidida — compatibilidade com a spec oficial

- **"Tomador = Patient/Responsável Financeiro já cadastrado, sem cadastro fiscal paralelo"**: compatível com a API, que identifica o tomador por CPF/CNPJ dentro do próprio XML da DPS — não existe "cadastro prévio de tomador" nas APIs lidas. **Atenção**: os campos de endereço/CPF do tomador precisam estar completos e validados (dígito verificador) no cadastro do Patient/Responsável Financeiro do CRM *antes* da emissão, já que a validação de CPF/CNPJ é uma das poucas regras confirmadas como sempre ativa (inclusive no bypass judicial).
- **"Configuração fiscal (CNAE/LC116/ISS/certificado) em config da empresa, nunca bloqueia emissão individual"**: compatível — `GET /parametros_municipais/...` é uma consulta de configuração, não parte do payload de emissão por paciente; deve ser cacheada na config da clínica, com refresh periódico (não a cada emissão).
- **"Emissão em 1 clique a partir da tela de Recebimentos"**: viável tecnicamente, pois `POST /nfse` é síncrono. Mas depende inteiramente de o `DpsBuilder` já ter todos os campos obrigatórios resolvidos sem interação do usuário — o que por sua vez depende de fechar a **[LACUNA]** do Anexo I (lista completa de campos obrigatórios da DPS) antes de prometer "1 clique sem fricção" como meta de UX.
- **"Descrição do serviço auto-gerada a partir das sessões"**: mapeia para o campo de descrição do serviço da DPS (nome exato não confirmado sem o Anexo I) — tecnicamente viável, mas o código de serviço (LC116/NBS) precisa ser definido uma única vez na config da empresa (Seção 9 acima), não por sessão individual.

### 9.5 Serviços novos necessários (mapeamento preliminar — não é desenho de domínio, é direção)

| Serviço/Componente | Responsabilidade | Motivado por |
|---|---|---|
| `DpsBuilder` | Monta o XML da DPS a partir de Payment/Package/Patient/Company-config | Leiaute XML exigido pela API (Seção 5) |
| `CertificateManager` | Armazena/aplica o certificado digital da empresa para assinatura de DPS/Evento | Autenticação obrigatória por certificado (Seção 4) — **decisão arquitetural pendente da [LACUNA] sobre tipo de certificado (A1 vs A3/HSM)** |
| `NationalNFSeProvider` (ou `SefinNacionalClient`) | Cliente HTTP para `POST /nfse`, `GET /nfse/{chaveAcesso}`, `POST /nfse/{chaveAcesso}/eventos`, `GET /danfse/{chaveAcesso}` | Seção 3 |
| `FiscalEventReconciliationWorker` | Job periódico que consulta `GET /nfse/{chaveAcesso}/eventos` (ou distribui via NSU/ADN) para detectar eventos não iniciados pelo CRM (cancelamento de ofício, deferimento de análise fiscal, manifestação do tomador) | Ausência de webhook nativo (Seção 6) |
| `XMLStorage` | Armazena o XML assinado da NFS-e e do DANFSe (retenção obrigatória para auditoria fiscal) | XML é a fonte da verdade, DANFSe é derivado sob demanda (Seção 2) |
| `AuditService` / log de emissão | Registra toda tentativa de emissão (sucesso/erro/código), pela ausência de fila de retry gerenciada pela plataforma nacional | Seção 7 (reprocessamento é responsabilidade do consumidor) |
| `MunicipalParamsCache` | Cache local (com TTL, refresh manual) dos parâmetros municipais (alíquota, regime) | Evitar consulta a `GET /parametros_municipais/...` a cada emissão |
| `FiscalInvoice` (entidade) | Representa o documento fiscal, referenciando `Payment`/`Invoice`, com seu próprio ciclo de vida (emitida/cancelada/substituída) | Seção 9.1 |
| `JudicialBypassFiscalFlow` (sub-fluxo, não necessariamente serviço novo isolado) | Trata o caso `Package.type === 'liminar'` que exige `POST /decisao-judicial/nfse` | Seção 9.3 |

### 9.6 Workers/filas — decorrência direta da natureza síncrona da API

Como a emissão em si (`POST /nfse`) é **síncrona**, **não é necessário** um worker/fila para a emissão-fim-a-fim (diferente de, por exemplo, processamento de imagem GMB). Porém, é necessário worker assíncrono para:
- **Reconciliação de eventos de terceiros** (Seção 6, 9.5) — não descoberto sem polling.
- **Retry de emissão** em caso de timeout/erro de rede (não erro de negócio) — a API não gerencia isso.
- Possivelmente, geração/cache de **DANFSe** sob demanda pesada (não confirmado como necessário, mas comum em integrações fiscais de alto volume — **[LACUNA]**, sem dado de rate limit encontrado nas fontes lidas para esta chamada específica).

---

## 10. Roadmap da Implementação (direção para a Fase 2)

1. **Fechar as lacunas bloqueantes antes de desenhar o domínio**: obter e ler o Anexo I (leiaute/regras DPS-NFSe), o Anexo II (leiaute/regras de Eventos, incluindo códigos de `tipoEvento`) e o Anexo A (tabela IBGE de municípios). Sem isso, o `DpsBuilder` da Fase 2 não pode ser especificado com precisão de campos obrigatórios.
2. **Confirmar formalmente a situação de convênio de Goiânia** (Seção 1) e decidir explicitamente: emissão via **Sefin Nacional** (mais simples, contribuinte comum sem sistema próprio) ou via **Sefin municipal de Goiânia** (se o município mantiver ambiente autorizador próprio) — isso muda o host-base de todas as chamadas.
3. **Decidir o tipo de certificado digital** (A1 arquivo vs A3/HSM) antes de desenhar `CertificateManager` — condiciona se a assinatura pode ocorrer 100% em backend Node.js ou exige um serviço/hardware de assinatura externo.
4. **Obter certificado de teste e validar o Swagger real em Produção Restrita** — as tentativas desta pesquisa foram bloqueadas por exigência de certificado/mTLS (Seção 3.8); só com acesso real ao Swagger é possível confirmar nomes exatos de campos JSON de request/response que os manuais em prosa não detalham.
5. **Desenhar `FiscalInvoice` como entidade nova e desacoplada de `Invoice`**, seguindo o mesmo princípio já usado no projeto para `payment.paymentStatus` (Payment como SSOT, nunca recriar shadow state cruzado) — ver `project_payment_ssot_architecture.md` na memória do projeto.
6. **Mapear o gatilho de emissão para o momento de settlement do Payment** (não provisioning), coerente com a arquitetura já existente descrita no CLAUDE.md.
7. **Tratar `Package.type === 'liminar'` como um sub-fluxo fiscal distinto** (bypass judicial), não uma variação trivial do fluxo regular — precisa de um passo administrativo de autorização municipal prévia, fora do controle do CRM.
8. **Planejar a migração antecipada para os campos IBS/CBS** (NT009), com prazo oficial (sujeito a novo adiamento) de 03/08/2026 — mesmo que a Fase 2 não implemente esses campos de imediato, o modelo de dados da DPS deve reservar espaço para eles desde o início, para evitar uma segunda migração de schema poucos meses depois do go-live.
9. **Prever worker de reconciliação de eventos** desde a primeira versão do domínio (Fase 2), já que a ausência de webhook nativo (Seção 6) não é um detalhe de implementação tardia — é uma restrição estrutural da API que afeta o desenho do próprio ciclo de vida de `FiscalInvoice`.
10. **Não prometer "1 clique sem nenhuma tela de configuração" na primeira versão** até confirmar, via Anexo I, que todos os campos obrigatórios da DPS realmente podem ser auto-derivados de Patient/Payment/Package/Company-config sem exceções — o próprio fluxo de decisão judicial (Seção 3.4) já mostra que a plataforma nacional às vezes exige preenchimento manual de campos normalmente calculados.

---

## Fontes e cobertura (para auditoria desta pesquisa)

**Lidas integralmente (PDF, via Read/extração nativa de texto)**:
- Manual dos Contribuintes — Guia para utilização das APIs do ADN (`manual-contribuintes-apis-adn-sistema-nacional-nfse.pdf`, 3 páginas)
- Manual dos Contribuintes — Guia para utilização das APIs do Emissor Público Nacional (`manual-contribuintes-emissor-publico-api-sistema-nacional-nfs-e-v1-2-out2025.pdf`, 6 páginas)
- Manual dos Contribuintes — Emissão por Decisão Administrativa ou Judicial (`manual-contribuintes-emissor-publico-api-emissao-decisao-administrativa-e-judicial.pdf`, 8 páginas)
- Manual dos Municípios Conveniados — Guia para utilização das APIs do ADN (`manual-municipios-apis-adn-sistema-nacional-nfs-e-v1-2-out21025.pdf`, 11 páginas)

**Não lido integralmente** (baixado, mas fora do escopo desta pesquisa por ser manual de UI, não de API): Guia do Emissor Público Nacional Web (`guia-emissorpubliconacionalweb_snnfse-ern-v12.pdf`, 104 páginas) — pode conter detalhes de campos úteis para a Fase 2 (a UI expõe os mesmos campos que a API recebe).

**Páginas HTML lidas**: `documentacao-tecnica` (índice), `documentacao-atual`, `apis-prod-restrita-e-producao`, `atualizacoes-e-implantacoes`, `rtc`, página inicial do portal (`gov.br/nfse/pt-br`).

**Inacessíveis nesta pesquisa**: Swaggers ao vivo (`adn.nfse.gov.br/contribuintes/docs`, `/danfse/docs` — HTTP 496, provável exigência de certificado de cliente/mTLS); anexos em xlsx/hyperlink interno de PDF (Anexo I, II, IV, A, B, C, VI, VII).

**Fontes secundárias usadas apenas para contexto de prazo legal** (não substituem confirmação no texto primário oficial): notícias/blogs sobre adesão de Goiânia e prazo de obrigatoriedade nacional (AGM-GO, PortalGO, TOTVS, LegisWeb) — sinalizadas explicitamente como tal no texto acima.

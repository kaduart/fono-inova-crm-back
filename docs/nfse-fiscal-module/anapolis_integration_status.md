# NFS-e — Situação de Integração de Anápolis-GO (município da clínica)

> Correção de escopo: o documento `project_nfse_phase1_official_spec.md` (Seção 1) citou "Goiânia" como
> base geográfica do CRM por engano. **A clínica é em Anápolis-GO** (código IBGE **5201108**). Este documento
> substitui, para fins de decisão de host de API, qualquer suposição feita a partir de Goiânia no doc de Fase 1.
>
> Pesquisa realizada em 2026-07-16, com fontes oficiais (site da Prefeitura de Anápolis, Diário Oficial do
> Município — DOM, e Portal Nacional gov.br/nfse). Nenhuma fonte usada como base de resposta é blog de
> fornecedor de software ou opinião de terceiro sem lastro em fonte primária — quando um resultado de busca
> trouxe apenas fornecedor/blog, foi descartado ou citado só como "não usado para responder".

---

## 1. Anápolis aderiu ao Ambiente Nacional (Sistema Nacional NFS-e)? Desde quando?

**✅ Confirmado, parcialmente — com uma ressalva relevante de nuance técnica (ver Seção 3).**

- O Portal Nacional (`gov.br/nfse`) declara adesão de **100% dos 5.571 entes federados** brasileiros à
  plataforma nacional NFS-e, incluindo "100% da arrecadação nacional de serviços" e todos os municípios com
  mais de 500 mil habitantes — mas a página em texto não lista Anápolis nominalmente; a lista individual por
  município está apenas no painel Power BI e numa planilha `.xlsx` (`municipiosaderentes20260710.xlsx`), que
  não pôde ser aberta/lida em texto nesta pesquisa (binário, fora do alcance das ferramentas disponíveis).
  Fonte: gov.br/nfse, página "Monitoramento das Adesões à NFS-e" — <https://www.gov.br/nfse/pt-br/municipios/monitoramento-adesoes>
  (consultada 2026-07-16). **✅ Confirmado pela documentação oficial nacional** (adesão nacional universal),
  mas **❓ não confirmado nominalmente para Anápolis** nessa página específica.

- A confirmação **específica e nominal de Anápolis** vem do site oficial da própria Prefeitura:
  - Notícia oficial: *"Anápolis adota NFS-e padrão nacional; medida visa simplificar cotidiano das empresas"*
    — <https://www.anapolis.go.gov.br/anapolis-adota-nfs-e-padrao-nacional-medida-visa-simplificar-cotidiano-das-empresas/>
    (publicada por volta de março/2026, conteúdo indica publicação após 3 de março de 2026). Texto:
    *"A mudança foi oficializada pelo Decreto nº 52.525, publicado em 3 de março, alinhando o município às
    novas diretrizes de modernização do sistema tributário brasileiro. O decreto entrou em vigor na data de
    sua publicação, **com efeitos retroativos a 1º de janeiro de 2026**."*
  - Notícia anterior (fase de anúncio, antes da adoção formal): *"Anápolis inicia implantação do Modelo de
    Nota Fiscal de Serviço Eletrônica (NFS-e) no padrão nacional"* —
    <https://www.anapolis.go.gov.br/anapolis-inicia-implantacao-do-modelo-de-nota-fiscal-de-servico-eletronica-nfs-e-no-padrao-nacional/>
    (imagem datada de dezembro/2025). Texto: *"A Prefeitura de Anápolis iniciará, em 2026, a adoção do novo
    Modelo Nacional da NFS-e (...) Durante o período de transição, o modelo conceitual ABRASF 2.04,
    atualmente utilizado, permanecerá em pleno funcionamento."*

  **⚠ Confirmado por documentação municipal**: adesão/adoção formal do padrão nacional em Anápolis, com
  vigência retroativa a **01/01/2026**, formalizada pelo **Decreto nº 52.525** (publicado 03/03/2026).

- **Não foi encontrado o texto integral do Decreto nº 52.525 no Diário Oficial do Município (DOM)** — a
  busca dirigida a `dom.anapolis.go.gov.br` não indexou esse número de decreto especificamente (foram
  encontrados decretos vizinhos, ex.: nº 52.517 de 30/01/2026, o que é consistente cronologicamente, mas não
  substitui a leitura do texto primário). **❓ Lacuna**: número/data exatos do Decreto 52.525 estão
  confirmados apenas pela notícia da própria Prefeitura (fonte oficial, mas não é o documento legal
  primário) — recomenda-se localizar a edição do DOM correspondente antes de qualquer decisão contratual/fiscal
  formal.

- **Divergência encontrada e não resolvida por inferência**: o resumo gerado automaticamente por uma das
  buscas na web (não uma fonte primária, e sim a camada de sumarização da própria ferramenta de busca) citou
  datas específicas — *"início em 5 de janeiro de 2026"* e *"desativação definitiva do ABRASF 2.04 em 1º de
  fevereiro de 2026"* — que **não puderam ser localizadas no texto integral das duas notícias oficiais
  fetchadas diretamente** (o texto oficial fala apenas em "efeitos retroativos a 1º de janeiro de 2026" para
  o Decreto 52.525, e em "a desativação definitiva do webservice ABRASF 2.04 também será comunicada
  oportunamente aos contribuintes" — sem data fixa — no comunicado de implantação). **Registrado como
  divergência não resolvida**: as datas "05/01/2026" e "01/02/2026" **não devem ser tratadas como
  confirmadas** até serem encontradas em fonte primária (DOM ou decreto/portaria específica sobre
  desativação do ABRASF).

---

## 2. Anápolis emite via ADN/Sefin Nacional diretamente, ou mantém sistema autorizador/emissor próprio transcrito para o padrão nacional?

**⚠ Confirmado por documentação/comunicação oficial municipal — resposta relevante e diferente da suposição da Fase 1.**

Anápolis **mantém sistema autorizador/emissor próprio (municipal)**, agora adaptado ao leiaute nacional —
**não** delega a emissão regular à Sefin Nacional. Citação direta, mesma notícia oficial da Seção 1:

> *"Vale ressaltar que a emissão das notas continuará sendo feita pelo sistema municipal, como já ocorre
> atualmente. Ou seja, empresas e profissionais seguem emitindo a NFS-e através de sistemas emissores
> próprios ou terceirizados que já encontram-se integrados com o webservice local / municipal. **A única
> exceção são os Microempreendedores Individuais (MEI), que continuam utilizando o Emissor Nacional**,
> conforme regra federal."*
> — <https://www.anapolis.go.gov.br/anapolis-adota-nfs-e-padrao-nacional-medida-visa-simplificar-cotidiano-das-empresas/>

Isso é o **oposto** do que a Fase 1 assumiu por padrão para "município sem sistema próprio" (Sefin Nacional
como emissor público). Anápolis **tem** sistema próprio, então, para uma empresa comum (não-MEI, regime
normal), o ponto de emissão é o **webservice municipal** (adaptado ao leiaute nacional/DPS), não os endpoints
`adn.nfse.gov.br` descritos na Seção 3 do doc de Fase 1.

Confirmação complementar sobre o suporte técnico do webservice municipal: a mesma notícia orienta o
contribuinte com sistema próprio/terceirizado a contatar `suporte.anapolis@notacontrol.com.br` em caso de
dúvida sobre adequação ao novo webservice — indício de que o operador técnico do sistema autorizador
municipal de Anápolis é a empresa **NotaControl** (não confirmado como o nome oficial do sistema em nenhum
decreto lido; **❓ lacuna** — não encontrado documento oficial que nomeie o fornecedor/plataforma
explicitamente, só o e-mail de domínio `notacontrol.com.br` usado como canal de suporte).

Também existe menção, em Portaria municipal (nº 460/2025), ao sistema de acesso **ISSNET Online**
(`www.issnetonline.com.br/anapolis`) como o portal de cadastro/acesso do contribuinte ao sistema eletrônico de
gerenciamento do ISSQN — fonte: Portaria SEMEC nº 460/2025, Anexo Único, publicada 19/05/2025 (Diário
Oficial, edição 3.693/2025). **⚠ Confirmado por documentação municipal.** Não ficou claro nesta pesquisa se
"ISSNET Online" e o sistema operado por "NotaControl" são a mesma plataforma, uma sucedeu a outra, ou
coexistem em papéis diferentes (ex.: um é o portal do contribuinte/cadastro, outro é o webservice técnico de
recepção de XML) — **❓ lacuna** a resolver antes da Fase 2/3 de implementação.

O Decreto nº 51.678/2025 (anterior à adoção do padrão nacional, 09/05/2025, DOM edição 3.687/2025 —
<https://dom.anapolis.go.gov.br/materias/59236>) descreve o modelo então vigente do "sistema eletrônico de
gerenciamento do ISSQN" do Município, com endpoints de **Recepção e Processamento de Lote de RPS**, **Consulta
de Situação de Lote de RPS**, **Consulta de NFS-e por RPS**, **Cancelamento de NFS-e**, **Substituição de
NFS-e** — estrutura de lote/RPS típica do modelo conceitual **ABRASF**, e não do modelo DPS/NFS-e nacional
(seção 2 do doc de Fase 1). Isso corrobora que, até a virada para o padrão nacional, Anápolis operava um
sistema próprio em ABRASF — e a mudança de 2026 foi uma **transcrição do mesmo sistema próprio** para o novo
leiaute, não uma migração de emissão para a Sefin Nacional. **✅ Confirmado por documentação municipal
primária (texto integral do decreto, lido via Diário Oficial).**

---

## 3. Existe integração híbrida (transição, sistema legado em paralelo)?

**⚠ Confirmado por documentação oficial municipal — e a resposta é mais rica que um simples "sim/não":
há DUAS transições sobrepostas, com públicos-alvo diferentes.**

1. **Transição ABRASF 2.04 → leiaute nacional no próprio webservice municipal** (já concluída ou em fase
   final, segundo o texto oficial mais recente): segundo a notícia de anúncio (fim de 2025), *"durante o
   período de transição, o modelo conceitual ABRASF 2.04, atualmente utilizado, permanecerá em pleno
   funcionamento"* até desativação a ser comunicada. A notícia de março/2026 (mais recente, com efeitos
   retroativos a 01/01/2026) já trata o padrão nacional como vigente e obrigatório para os inscritos na
   Secretaria Municipal de Economia, então essa transição específica está, na prática, encerrada ou em fase
   final — mas a **data exata de desligamento do ABRASF 2.04 não foi confirmada em fonte primária** (ver
   divergência na Seção 1).

2. **Transição sistema municipal → Ambiente Nacional (API Nacional / Emissor Nacional) para contribuintes do
   Simples Nacional/MEI** — esta é uma transição **distinta, futura e com data oficial confirmada**:
   > *"Empresários e profissionais da área contábil deverão, obrigatoriamente, **a partir de 1º de setembro
   > de 2026**, realizar a emissão de notas fiscais de serviços por meio do Ambiente Nacional da NFS-e (...)
   > a emissão das NFS-e para empresas optantes do Simples Nacional deixará de ocorrer por meio da
   > comunicação com o validador municipal (webservice municipal) e passará a ser realizada diretamente no
   > Ambiente Nacional através do Emissor Nacional, que é gratuito."*
   > — <https://www.anapolis.go.gov.br/prefeitura-de-anapolis-alerta-optantes-pelo-simples-nacional-sobre-novas-regras-para-emissao-da-nota-fiscal-de-servicos-eletronica/>
   (publicada 2026, seção Economia)

   Essa regra **só se aplica a ME/EPP optantes do Simples Nacional** (e situações correlatas: "Pendente de
   Opção", excesso de sublimite, opção pelo regime regular de IBS/CBS) — **não** se aplica a empresas em
   regime normal (Lucro Presumido/Real), que **permanecem no webservice municipal** mesmo após 01/09/2026,
   segundo o texto lido. MEI já usa o Emissor Nacional desde a adoção do padrão nacional (Seção 2).

   **✅ Confirmado por documentação oficial municipal, com data específica e público-alvo explícito.**

**Resumo da hibridez, hoje (2026-07-16):**
| Regime tributário do contribuinte | Onde emite hoje | Muda quando |
|---|---|---|
| MEI | Emissor Nacional (Ambiente Nacional) | Já migrado |
| Simples Nacional (ME/EPP) | Webservice municipal (padrão nacional) | Migra para Ambiente Nacional em 01/09/2026 |
| Lucro Presumido / Real (regime normal) | Webservice municipal (padrão nacional) | Sem previsão de migração para Ambiente Nacional encontrada nas fontes lidas |

---

## 4. Órgão municipal responsável pela administração tributária/NFS-e

**✅ Confirmado por documentação oficial municipal.**

- **Secretaria Municipal de Economia (SEMEC)** é o órgão citado nominalmente no Decreto nº 51.678/2025, na
  Portaria nº 460/2025 e nas notícias oficiais como responsável pelo cadastro de prestadores de serviço, pela
  administração tributária do ISSQN e pela regulamentação da NFS-e (ex.: *"a emissão da NFS-e no padrão
  nacional passa a ser obrigatória para os prestadores de serviços inscritos na **Secretaria Municipal de
  Economia**"*). SEMEC também opera o subdomínio institucional `semec.anapolis.go.gov.br`.
- O **Núcleo de Nota Fiscal Eletrônica** (telefone (62) 3902-2195, e-mail `notaeletronica@anapolis.go.gov.br`)
  e o **Núcleo de Cadastro Econômico** (telefone (62) 3902-1332, e-mail `caesemfaz@anapolis.go.gov.br`) são as
  unidades operacionais de atendimento dentro da SEMEC, conforme
  <https://www.anapolis.go.gov.br/notas-fiscais-avulsas-passam-a-ser-extintas-a-partir-de-2026-em-anapolis/>.

---

## 5. Documentação oficial municipal publicada (decreto/instrução normativa/portaria)

**✅/⚠ Confirmado — lista de instrumentos localizados e lidos (parcial ou integralmente):**

| Instrumento | Data | Publicação (DOM) | Conteúdo | Nível de leitura nesta pesquisa |
|---|---|---|---|---|
| **Decreto nº 51.678** | 09/05/2025 | Edição 3.687/2025, publicada 13/05/2025 — <https://dom.anapolis.go.gov.br/materias/59236> | Regulamenta arts. 94, 116, 118, 120, 122 da LC nº 136/2006 (CTRMA); institui o sistema eletrônico de gerenciamento do ISSQN; disciplina NFS-e, NFSA-e, RPS, DES e demais declarações eletrônicas — **modelo então vigente, estrutura ABRASF (lote/RPS)** | ✅ Texto integral lido via HTML do DOM |
| **Portaria nº 460/2025** (SEMEC) | 19/05/2025 | Edição 3.693/2025 | Regulamentação geral de emissão de NFS-e; cadastro via ISSNET Online; declarações mensais; encerramento automático da apuração do ISSQN | ⚠ PDF baixado, mas extração de texto malsucedida nesta pesquisa (conteúdo binário não decodificado); confirmado apenas pelo resumo da notícia oficial da Prefeitura |
| **Portaria nº 461/2025** | 19/05/2025 | — | Cancelamento/Substituição de NFS-e e uso de Carta de Correção Eletrônica (CC-e) | ❓ Não lida (só referência indireta via notícia) |
| **Portaria nº 462/2025** | 19/05/2025 | — | DES-IF (instituições financeiras) | ❓ Não lida |
| **Portaria nº 463/2025** | 19/05/2025 | Edição 3.693/2025 — <https://dom.anapolis.go.gov.br/materias/60426> | Enquadramento CNAE × Lista de Serviços/ISSQN | ❓ Não lida |
| **Portaria nº 464/2025** | 19/05/2025 | — | (não detalhada na notícia-resumo) | ❓ Não lida |
| **Decreto nº 52.525** | publicado 03/03/2026 (ano inferido pelo contexto, ver Seção 1), efeitos retroativos a 01/01/2026 | **Não localizado no DOM nesta pesquisa** | Oficializa a adoção do padrão nacional da NFS-e em Anápolis | ⚠ Confirmado só pela notícia oficial da Prefeitura — **texto legal primário não encontrado (lacuna)** |

---

## Divergências encontradas (resumo)

1. **Datas específicas de transição (05/01/2026 início; 01/02/2026 desligamento do ABRASF)** apareceram no
   resumo automático de uma busca na web, mas **não foram corroboradas** no texto integral das notícias
   oficiais da Prefeitura efetivamente lidas nesta pesquisa. Tratar como **não confirmadas**.
2. **Numeração/ano do Decreto nº 52.525** — confirmado só pela notícia institucional da Prefeitura (fonte
   oficial, mas secundária em relação ao ato legal); o registro primário no Diário Oficial do Município não
   foi localizado nesta pesquisa via busca dirigida ao domínio `dom.anapolis.go.gov.br`.
3. **Relação entre "ISSNET Online" e o sistema operado por "NotaControl"** (e-mail de suporte
   `suporte.anapolis@notacontrol.com.br`) — não está claro se são a mesma plataforma, uma sucedeu a outra, ou
   desempenham papéis técnicos diferentes (portal de cadastro vs. webservice de recepção de XML).

---

## Implicação prática para o CRM

**Decisão de host de API não pode ser fechada apenas com o que foi encontrado — depende também de um fato de
negócio que esta pesquisa não pode responder: o regime tributário da clínica.**

- Se a clínica está em **regime normal (Lucro Presumido/Real)**: o CRM deve integrar com o **webservice
  municipal de Anápolis** (sistema próprio, transcrito ao leiaute nacional/DPS), **não** com os endpoints
  `adn.nfse.gov.br` / Sefin Nacional descritos na Seção 3 do documento de Fase 1 — aquela seção assumiu, por
  padrão, que a Sefin Nacional seria o emissor (cenário de "município sem sistema próprio"), o que **não se
  aplica a Anápolis**.
- Se a clínica está no **Simples Nacional**: hoje (2026-07-16) também usa o webservice municipal, mas
  **deverá migrar para o Ambiente Nacional / Emissor Nacional / API Nacional a partir de 01/09/2026** — nesse
  caso, os endpoints do documento de Fase 1 (Sefin Nacional) **passam a ser corretos a partir dessa data**,
  não antes.
- Se a clínica é **MEI**: já usa o Emissor Nacional (Ambiente Nacional) — cenário improvável para uma clínica
  com pacotes/convênio/liminar, mas registrado por completude.
- **Bloqueio para a Fase 2/3**: antes de escolher o host de API concreto para o sistema municipal de
  Anápolis, é preciso (a) confirmar o regime tributário da clínica junto ao setor financeiro/contábil do
  cliente, e (b) obter da SEMEC ou do suporte técnico (`suporte.anapolis@notacontrol.com.br` e/ou
  `www.issnetonline.com.br/anapolis`) a URL do webservice de recepção de XML no padrão nacional e o manual
  de integração correspondente — nenhum desses dois documentos técnicos foi encontrado nesta pesquisa (só a
  existência do sistema foi confirmada, não o endpoint técnico).

## Lacunas remanescentes explícitas

- ❓ Texto primário completo do Decreto nº 52.525 (não localizado no DOM).
- ❓ URL/manual técnico do webservice municipal de Anápolis no padrão nacional (endpoint de recepção de
  DPS/XML) — não documentado nas fontes lidas.
- ❓ Se "ISSNET Online" e "NotaControl" são o mesmo sistema/fornecedor.
- ❓ Data exata (se já ocorrida) de desativação definitiva do webservice ABRASF 2.04 em Anápolis.
- ❓ Confirmação nominal de Anápolis na lista/planilha de municípios aderentes do Portal Nacional (arquivo
  binário não lido nesta pesquisa).
- ❓ Regime tributário da clínica (fato de negócio, não documental) — condiciona qual host de API é o correto
  a partir de agora vs. a partir de 01/09/2026.

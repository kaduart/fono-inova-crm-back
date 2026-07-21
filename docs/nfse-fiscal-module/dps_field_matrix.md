# Anexo I — Matriz de Campos da DPS/NFS-e (Sistema Nacional NFS-e)

> Sprint 1 da Fase 1.5 (validação técnica) do módulo fiscal NFS-e. Objetivo único: obter e documentar o leiaute completo do **Anexo I** (`ANEXO_I-SEFIN_ADN-DPS_NFSe-SNNFSe`), que na Fase 1 (`project_nfse_phase1_official_spec.md`) não havia sido obtido — só hyperlinks internos de PDF haviam sido identificados, não o arquivo em si.
>
> **Resultado desta pesquisa: o Anexo I FOI obtido**, na íntegra, em formato `.xlsx` oficial. Este documento é derivado da leitura completa (programática, célula a célula) das abas relevantes desse arquivo.

---

## 1. Resumo

- **Anexo I obtido**: sim, arquivo `.xlsx` completo, baixado diretamente do domínio oficial `gov.br/nfse`.
  - **Versão**: `v1.01`, publicada em **09/02/2026** (`20260209`).
  - **URL oficial**: `https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/anexo_i-sefin_adn-dps_nfse-snnfse-v1-01-20260209.xlsx`
  - Encontrado a partir da página `https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual` (seção "Anexos de Layout" — rótulo distinto de "Anexos de Domínio", onde ficam os Anexos A/B/C). Essa seção não apareceu na Fase 1 porque o link do Anexo I está numa linha de tabela HTML mais abaixo na página, não no hyperlink interno do PDF que a Fase 1 tentou seguir.
  - O arquivo contém 5 abas: `MUN.INCID_INFO.SERV.`, `EXPORTACAO_EMISSÃO_NFS-e`, `RN_RECEPCAO_DPS`, `LEIAUTE DPS_NFS-e` (417 linhas — leiaute completo, lida integralmente) e `RN DPS_NFS-e` (655 linhas — regras de negócio/erros por campo, lida parcialmente/amostralmente).
- **Cobertura da matriz de campos**: **completa para a árvore XML inteira** da NFS-e e da DPS (todas as ~340 linhas de campo/grupo da aba `LEIAUTE DPS_NFS-e`, da raiz `NFS-e` até `Signature`). Isso fecha a lacuna geral que a Fase 1 registrou na Seção 5 ("sem os Anexos I/II/A baixados, não é possível enumerar a lista completa de campos obrigatórios vs. opcionais... nem a árvore XML completa").
- **O que NÃO foi obtido/confirmado nesta pesquisa** (lacunas remanescentes, ver Seção 5): Anexo II (Eventos, códigos de `tipoEvento`), Anexo IV (regras ADN), leitura completa das 655 regras de negócio da aba `RN DPS_NFS-e` (só amostra representativa foi processada), conteúdo integral do Anexo B (NBS) e Anexo C (`cIndOp` do grupo IBSCBS).
- **Achado colateral relevante para o CRM**: a aba `MUN.INCID_INFO.SERV.` deste mesmo Anexo I lista o código de tributação nacional (`cTribNac`) `040803` = **Fonoaudiologia**, além de `040801` Terapia ocupacional, `040802` Fisioterapia, `040901` Terapias diversas, `040101/040102` Medicina/Biomedicina — todos sob o item 4 (LC 116/03, "Serviços de saúde, assistência médica e congêneres"), diretamente relevante ao código de serviço que a clínica deve configurar no `DpsBuilder`.

---

## 2. Matriz de Campos

Convenções: **Obrigatoriedade** deriva da coluna `OCOR.` original do Anexo I: `1-1` no nível raiz = Obrigatório; `0-1` = Opcional; `1-1` dentro de um grupo `0-1`/`CG`/`CE` = Condicional (só obrigatório se o grupo/escolha pai estiver presente); `CE`/`CG` = Condicional por escolha exclusiva (choice) entre alternativas do mesmo grupo. Tipo: `C`=caractere, `N`=numérico, `D`=data/hora, `G`=grupo estrutural (sem valor próprio), `E`=elemento, `CE`=elemento de escolha (choice), `CG`=grupo de escolha, `A`=atributo, `ID`=identificador.

Todas as linhas desta seção têm **Fonte**: `ANEXO_I-SEFIN_ADN-DPS_NFSe-SNNFSe-v1.01-20260209.xlsx`, aba `LEIAUTE DPS_NFS-e`, gov.br/nfse, publicação 09/02/2026 — e **Confiança**: ✅ (documentação oficial nacional, leitura direta da planilha, sem inferência).

### 2.1 `NFS-e` (raiz) e `NFSe/infNFSe` (dados gerados pela plataforma)

| Campo | XPath | Obrig./Cond./Opc. | Tipo/Tam. | Enum | Regra/Fórmula |
|---|---|---|---|---|---|
| `versao` | `NFSe/` | Obrigatório | C, 1-4 | — | Versão do leiaute da NFS-e (atributo `A`) |
| `id` | `NFSe/infNFSe/` | Obrigatório | ID, C, **53** posições | — | `"NFS" + Cód.Mun.(7) + AmbGer(1) + TipoInscrFederal(1) + InscrFederal(14, CPF c/ zeros à esq.) + nNFSe(13) + AnoMesEmis(4) + Cód.Num.aleatório(9) + DV(1)`. DV = módulo 11 |
| `xLocEmi` | `NFSe/infNFSe/` | Obrigatório | C, 150 | — | Nome do município emissor (derivado de `cLocEmi` da DPS) |
| `xLocPrestacao` | `NFSe/infNFSe/` | Obrigatório | C, 150 | — | Nome do município da prestação (derivado de `cLocPrestacao`) |
| `nNFSe` | `NFSe/infNFSe/` | Obrigatório | N, 13 | 0000000000000–9999999999999 | Sequencial por emitente, gerado pela Sefin, nunca reutilizado |
| `cLocIncid` | `NFSe/infNFSe/` | Condicional | N, 7 | — | Só existe se operação tributável (`tribISSQN=1`); ausente se imunidade/exportação/não incidência (`tribISSQN=2,3,4`) |
| `xLocIncid` | `NFSe/infNFSe/` | Condicional | C, 150 | — | Obrigatório apenas quando `cLocIncid` está presente |
| `xTribNac` | `NFSe/infNFSe/` | Obrigatório | C, 600 | — | Descrição do subitem da Lista Nacional de Serviços (Anexo III citado no manual, distinto do Anexo I) |
| `xTribMun` | `NFSe/infNFSe/` | Condicional | C, 600 | — | Descrição do código de tributação municipal |
| `xNBS` | `NFSe/infNFSe/` | Condicional | C, 600 | — | Descrição do código NBS |
| `verAplic` | `NFSe/infNFSe/` | Obrigatório | C, 1-20 | — | Versão do software emissor (livre) |
| `ambGer` | `NFSe/infNFSe/` | Obrigatório | N, 1 | **1**=Sistema Próprio do Município; **2**=Sefin Nacional NFS-e | Fecha lacuna da Fase 1 (valor `1` não estava confirmado) |
| `tpEmis` | `NFSe/infNFSe/` | Obrigatório | N, 1 | **1**=Emissão direta no modelo NFS-e Nacional; **2**=Emissão em leiaute próprio do município, transcrita | Fecha lacuna da Fase 1 |
| `procEmi` | `NFSe/infNFSe/` | Condicional | N, 1 | **1**=App do contribuinte (API); **2**=App do fisco (Web); **3**=App do fisco (App) | Só em NFS-e emitida pela Sefin Nacional; município não pode informar ao compartilhar |
| `cStat` | `NFSe/infNFSe/` | Obrigatório | N, 3 | **100**=NFS-e Gerada; **102**=Decisão Judicial/Administrativa; **103**=NFS-e Avulsa; **107**=NFS-e MEI | **Fecha a lacuna mais crítica da Fase 1** — enum completo de `cStat`, antes só se conhecia o valor 102 |
| `dhProc` | `NFSe/infNFSe/` | Obrigatório | D, UTC | — | Deve ser ≤ data/hora de recepção pelo sistema (regra RN, `E1278`) |
| `nDFSe` | `NFSe/infNFSe/` | Obrigatório | N, 1-13 | 0–9999999999999 | `0` quando não há DFe gerado por ambiente próprio do município |
| `emit/CNPJ` | `NFSe/infNFSe/emit/` | Condicional (choice CNPJ×CPF) | N, 14 | — | Inscrição federal do emitente da NFS-e |
| `emit/CPF` | `NFSe/infNFSe/emit/` | Condicional (choice) | N, 11 | — | Idem, pessoa física |
| `emit/IM` | `NFSe/infNFSe/emit/` | Opcional | C, 15 | — | Indicador municipal |
| `emit/xNome` | `NFSe/infNFSe/emit/` | Obrigatório | C, 150 | — | Nome/Razão Social |
| `emit/xFant` | `NFSe/infNFSe/emit/` | Opcional | C, 150 | — | Nome fantasia |
| `emit/enderNac/{xLgr,nro,xCpl,xBairro,cMun,UF,CEP}` | `NFSe/infNFSe/emit/enderNac/` | Obrigatório (xCpl opcional) | C/N variados | `cMun`=tabela IBGE | Endereço nacional do emitente |
| `emit/fone`, `emit/email` | `NFSe/infNFSe/emit/` | Opcional | N 9-20 / C 80 | — | — |

### 2.2 `NFSe/infNFSe/valores` (valores calculados pela plataforma — ISSQN)

| Campo | Obrig./Cond. | Tipo/Tam. | Fórmula/Enum |
|---|---|---|---|
| `vCalcDR` | Condicional | N, 1-15V2 | Valor calculado de dedução/redução da BC |
| `tpBM` | Condicional | C, 40 | **1**=Isenção; **2**=Redução BC em %; **3**=Redução BC em R$; **4**=Alíquota Diferenciada |
| `vCalcBM` | Condicional | N, 1-15V2 | Valor calculado do benefício municipal |
| `vBC` | Condicional | N, 1-15V2 | `vBC = vServ − descIncond − (vDR ou vCalcDR + vCalcReeRepRes) − (vRedBCBM ou vCalcBM)` |
| `pAliqAplic` | Condicional | N, 1-2V2 | Ordem de prioridade: alíquota parametrizada > alíquota informada na DPS > alíquota diferenciada por benefício. Ausente se Regime Especial = "Profissional Autônomo"/"Sociedade de Profissionais" + Exigibilidade "Exigível" |
| `vISSQN` | Condicional | N, 1-15V2 | `vISSQN = vBC × pAliqAplic` |
| `vTotalRet` | Opcional | N, 1-15V2 | `Σ(vRetCP + vRetIRRF + vRetCSLL + ISSQN retido)` |
| `vLiq` | **Obrigatório** | N, 1-15V2 | `vServ − descCond − descIncond − valores retidos` |
| `xOutInf` | Opcional | C, 2000 | Mensagem do fisco para cenários 28/34 da aba `EXPORTACAO_EMISSÃO_NFS-e` (não lida nesta pesquisa) |

### 2.3 `NFSe/infNFSe/IBSCBS` (grupo calculado pela plataforma — Reforma Tributária, NT009)

Confirma o que a Fase 1 já sabia (obrigatório a partir de 03/08/2026, Simples Nacional só a partir de 2027) e acrescenta a árvore completa:

| Campo/Grupo | XPath (resumido) | Fórmula |
|---|---|---|
| `cLocalidadeIncid`, `xLocalidadeIncid` | `IBSCBS/` | Local de incidência do IBS/CBS (pode divergir do ISSQN) |
| `pRedutor` | `IBSCBS/` | Redutor em compra governamental |
| `valores/vBC` | `IBSCBS/valores/` | `vBC = vServ − descIncond − vCalcReeRepRes − vISSQN − vPIS − vCOFINS` (até 2026) ou sem PIS/COFINS (até 2032) |
| `valores/uf/{pIBSUF,pRedAliqUF,pAliqEfetUF}` | `.../valores/uf/` | `pAliqEfetUF = pIBSUF × (1−pRedAliqUF) × (1−pRedutor)` |
| `valores/mun/{pIBSMun,pRedAliqMun,pAliqEfetMun}` | `.../valores/mun/` | Análogo, municipal |
| `valores/fed/{pCBS,pRedAliqCBS,pAliqEfetCBS}` | `.../valores/fed/` | Análogo, CBS federal |
| `totCIBS/vTotNF` | `.../totCIBS/` | `vTotNF = vLiq` (2026) / `vLiq + vCBS + vIBSTot` (a partir de 2027) |
| `totCIBS/gIBS/{vIBSTot, gIBSCredPres(pCredPresIBS,vCredPresIBS), gIBSUFTot(vDifUF,vIBSUF), gIBSMunTot(vDifMun,vIBSMun)}` | `.../gIBS/...` | `vIBSTot = vIBSUF + vIBSMun`; `vIBSUF = vBC × (pIBSUF ou pAliqEfetUF)` |
| `totCIBS/gCBS/{gCBSCredPres(pCredPresCBS,vCredPresCBS), vDifCBS, vCBS}` | `.../gCBS/...` | `vCBS = vBC × (pCBS ou pAliqEfetCBS)` |
| `totCIBS/gTribRegular/{pAliqEfeRegIBSUF,vTribRegIBSUF,pAliqEfeRegIBSMun,vTribRegIBSMun,pAliqEfeRegCBS,vTribRegCBS}` | `.../gTribRegular/` | `vTribRegX = vBC × pAliqEfeRegX` |
| `totCIBS/gTribCompraGov/{pIBSUF,vIBSUF,pIBSMun,vIBSMun,pCBS,vCBS}` | `.../gTribCompraGov/` | Específico de compras governamentais |

### 2.4 `NFSe/infNFSe/DPS/infDPS` (dados declarados pelo emitente — identificação)

| Campo | Obrig./Cond. | Tipo/Tam. | Enum | Regra |
|---|---|---|---|---|
| `DPS/versao` | Obrigatório | C, 1-4 | — | Versão do leiaute da DPS (atributo) |
| `infDPS/id` | Obrigatório | ID, C, **45** posições | — | `"DPS" + Cód.Mun.(7) + TipoInscrFederal(1) + InscrFederal(14, CPF c/ zeros à esq.) + Série(5) + Núm.DPS(15)`. **Confirma e fecha a lacuna da Fase 1** sobre o tamanho total (3+7+1+14+5+15=45) |
| `tpAmb` | Obrigatório | N, 1 | **1**=Produção; **2**=Homologação | Novo — não confirmado na Fase 1 |
| `dhEmi` | Obrigatório | D, UTC | — | Data/hora de emissão da DPS |
| `verAplic` | Obrigatório | C, 1-20 | — | Versão do app que gerou a DPS |
| `serie` | Obrigatório | N, 1-5 | Faixas: 00001-49999 app próprio; 50000-69999 emissor móvel; 70000-79999 emissor Web; 80000-89999 transcrição manual (Web) | — |
| `nDPS` | Obrigatório | N, 1-15 | 1–999999999999999 | — |
| `dCompet` | Obrigatório | D, AAAA-MM-DD | — | Deve ser a mesma data do fato gerador (prestação do serviço) |
| `tpEmit` | Obrigatório | N, 1 | **1**=Prestador; **2**=Tomador; **3**=Intermediário | — |
| `cMotivoEmisTI` | Condicional | N, 1 | **1**=Importação de Serviço; **2**=Obrigado por legislação municipal; **3**=Recusa de emissão pelo prestador; **4**=Rejeição da NFS-e do prestador | Só quando `tpEmit=2` ou `3` |
| `chNFSeRej` | Condicional | N, 50 | — | Obrigatório se `cMotivoEmisTI=4` |
| `cLocEmi` | Obrigatório | N, 7 | — | Tabela IBGE; município onde o emitente está cadastrado/autorizado |
| `subst/chSubstda` | Condicional (grupo `subst`, 0-1) | C, 50 | — | **Confirma o campo `chSubstda`** que a Fase 1 só tinha "inferido do texto do manual, não confirmado no XSD" — agora confirmado no leiaute oficial. Prazo máx. de substituição parametrizável: 2 anos |
| `subst/cMotivo` | Condicional | N, 1 | **1**=Desenquadramento Simples Nacional; **2**=Enquadramento SN; **3**=Inclusão retroativa Imunidade/Isenção; **4**=Exclusão retroativa; **5**=Rejeição pelo tomador/intermediário; **99**=Outros | — |
| `subst/xMotivo` | Condicional | C, 15-255 | — | Obrigatório apenas se `cMotivo=99` |

### 2.5 `prest` / `toma` / `interm` (Prestador, Tomador, Intermediário — mesma estrutura nos três)

| Campo | Obrig./Cond. | Tipo/Tam. | Enum |
|---|---|---|---|
| `CNPJ` / `CPF` | Condicional (choice) | N, 14 / N, 11 | — |
| `NIF` | Condicional (choice) | C, 40 | Identificação fiscal estrangeira |
| `cNaoNIF` | Condicional (choice) | N, 1 | **0**=Não informado na origem; **1**=Dispensado; **2**=Não exigência |
| `CAEPF` | Opcional | N, 14 | — |
| `IM` | Opcional | C, 15 | Indicador municipal |
| `xNome` | Obrigatório (toma) / Opcional (prest) | C, 150 | — |
| `end/endNac/{cMun,CEP}` | Condicional (choice endNac×endExt) | N 7 / C 8 | `cMun`=tabela IBGE |
| `end/endExt/{cPais,cEndPost,xCidade,xEstProvReg}` | Condicional (choice) | C 2 / C 1-11 / C 1-60 / C 1-60 | `cPais`=tabela ISO |
| `end/{xLgr,nro,xCpl,xBairro}` | Obrigatório (xCpl opcional) | C variados | — |
| `fone`, `email` | Opcional | N 6-20 / C 1-80 | — |
| **Só em `prest`**: `regTrib/opSimpNac` | Obrigatório | N, 1 | **1**=Não Optante; **2**=MEI; **3**=ME/EPP |
| **Só em `prest`**: `regTrib/regApTribSN` | Condicional | N, 1 | **1**=Apuração federal+municipal pelo SN; **2**=Federal pelo SN, ISSQN por legislação municipal; **3**=Ambos fora do SN | Só se `opSimpNac=3` e ultrapassou sublimite |
| **Só em `prest`**: `regTrib/regEspTrib` | Obrigatório | N, 1 | **0**=Nenhum; **1**=Ato Cooperado; **2**=Estimativa; **3**=Microempresa Municipal; **4**=Notário/Registrador; **5**=Profissional Autônomo; **6**=Sociedade de Profissionais; **9**=Outros |

### 2.6 `serv` (dados do serviço prestado)

| Campo | Obrig./Cond. | Tipo/Tam. | Enum |
|---|---|---|---|
| `locPrest/cLocPrestacao` | Condicional (choice) | N, 7 | Tabela IBGE, concessão de rodovia, ou `0000000`="Águas Marítimas" |
| `locPrest/cPaisPrestacao` | Condicional (choice) | C, 2 | Tabela ISO países |
| `cServ/cTribNac` | Obrigatório | N, 6 | Conforme aba `MUN.INCID_INFO.SERV.` do próprio Anexo I (ver Seção 3) |
| `cServ/cTribMun` | Condicional | N, 3 | Código de tributação municipal |
| `cServ/xDescServ` | Obrigatório | C, 1000 | Descrição completa do serviço |
| `cServ/cNBS` | Condicional | N, 9 | Conforme Anexo B |
| `cServ/cIntContrib` | Opcional | C, 20 | Código interno do contribuinte |
| `comExt/mdPrestacao` | Condicional (grupo `comExt`, 0-1) | N, 1 | **0**=Desconhecido; **1**=Transfronteiriço; **2**=Consumo no Brasil; **3**=Movimento Temporário de PF; **4**=Consumo no Exterior |
| `comExt/vincPrest` | Condicional | N, 1 | **0**=Sem vínculo; **1**=Controlada; **2**=Controladora; **3**=Coligada; **4**=Matriz; **5**=Filial/sucursal; **6**=Outro; **9**=Desconhecido |
| `comExt/tpMoeda` | Condicional | N, 3 | Tabela de moedas do Banco Central |
| `comExt/vServMoeda` | Condicional | N, 1-15V2 | Valor em moeda estrangeira |
| `comExt/mecAFComexP` | Condicional | N, 2 | 00-08 (mecanismos de fomento — prestador) |
| `comExt/mecAFComexT` | Condicional | N, 2 | 00-26 (mecanismos de fomento — tomador) |
| `comExt/movTempBens` | Condicional | N, 1 | **0**=Desconhecido; **1**=Não; **2**=Vinculada-Importação; **3**=Vinculada-Exportação |
| `comExt/{nDI,nRE}` | Opcional | C 1-12 / C 12 | Nº Declaração de Importação / Registro de Exportação |
| `comExt/mdic` | Condicional | N, 1 | **0**=Não enviar ao MDIC; **1**=Enviar |
| `obra/{inscImobFisc,cObra,cCIB,end}` | Condicional (grupo `obra`, 0-1) | — | Não aplicável a clínica (construção civil) |
| `atvEvento/{xNome,dtIni,dtFim,idAtvEvt,end}` | Condicional (grupo `atvEvento`, 0-1) | — | Não aplicável a clínica (eventos artísticos/culturais/esportivos) |
| `infoCompl/{idDocTec,docRef,xPed,gItemPed/xItemPed,xInfComp}` | Opcional | C variados | `docRef` obrigatório se DPS emitida por Tomador/Intermediário |

### 2.7 `valores` (DPS — declarados pelo emitente)

| Campo | Obrig./Cond. | Tipo/Tam. | Enum/Fórmula |
|---|---|---|---|
| `vServPrest/vReceb` | Condicional | N, 1-15V2 | Valor recebido pelo intermediário |
| `vServPrest/vServ` | **Obrigatório** | N, 1-15V2 | Valor do serviço |
| `vDescCondIncond/{vDescIncond,vDescCond}` | Condicional (grupo 0-1) | N, 1-15V2 | Descontos incondicionado/condicionado |
| `vDedRed/pDR` / `vDR` | Condicional (choice: %, R$, ou documento) | N, 1-3V2 / N, 1-15V2 | 3 opções mutuamente exclusivas |
| `vDedRed/documentos/docDedRed/tpDedRed` | Condicional | N, 2 | **01**=Alimentação/frigobar (descontinuado a partir de jan/2026); **02**=Materiais; **03**=Produção Externa; **04**=Reembolso de despesas; **05**=Repasse consorciado; **06**=Repasse plano de saúde; **07**=Serviços; **08**=Subempreitada de mão de obra; **99**=Outras |
| `vDedRed/documentos/docDedRed/{chNFSe,chNFe,NFSeMun,NFNFS,nDocFisc,nDoc}` | Condicional (choice, 6 opções de doc.) | variados | NFS-e / NF-e / outra NFS-e municipal / NF-NFS não eletrônica / outro doc. fiscal / outro doc. |
| `vDedRed/documentos/docDedRed/{dtEmiDoc,vDedutivelRedutivel,vDeducaoReducao}` | Obrigatório (dentro do grupo) | D / N 1-15V2 / N 1-15V2 | `vDeducaoReducao ≤ vDedutivelRedutivel` |
| `vDedRed/documentos/docDedRed/fornec/*` | Condicional | (mesma estrutura de prest/toma) | Fornecedor do serviço deduzido |
| `trib/tribMun/tribISSQN` | **Obrigatório** | N, 1 | **1**=Operação tributável; **2**=Imunidade; **3**=Exportação de serviço; **4**=Não Incidência |
| `trib/tribMun/cPaisResult` | Condicional | C, 2 | Obrigatório se indicada exportação de serviço |
| `trib/tribMun/tpImunidade` | Condicional | N, 1 | **0**=Não informado na origem; **1**=Patrimônio/renda/serviços recíprocos (CF art.150,VI,a); **2**=Templos religiosos (VI,b); **3**=Partidos/sindicatos/educação/assistência social (VI,c); **4**=Livros/jornais/periódicos (VI,d); **5**=Fonogramas/videofonogramas musicais nacionais (VI,e) |
| `trib/tribMun/exigSusp/tpSusp` | Condicional (grupo 0-1) | N, 1 | **1**=Suspensa por Decisão Judicial; **2**=Suspensa por Processo Administrativo — **relevante para o domínio `liminar` do CRM** |
| `trib/tribMun/exigSusp/nProcesso` | Condicional | C, 30 | Nº do processo |
| `trib/tribMun/BM/{nBM,vRedBCBM,pRedBCBM}` | Condicional (grupo 0-1) | N 14 / N 1-15V2 / N 1-3V2 | `nBM`= 7(IBGE)+2(tipo: 01-legislação,02-regime especial,03-retenção,04-outros)+5(sequencial) |
| `trib/tribMun/tpRetISSQN` | **Obrigatório** | N, 1 | **1**=Não Retido; **2**=Retido pelo Tomador; **3**=Retido pelo Intermediário |
| `trib/tribMun/pAliq` | Condicional | N, 1V2 | Só informado pelo emitente se município não pertence ao Sistema Nacional (senão vem parametrizado) |
| `trib/tribFed/piscofins/CST` | Condicional (grupo `piscofins` 0-1) | N, 2 | 00 a 99 — Código de Situação Tributária PIS/COFINS (tabela extensa, ver arquivo fonte) |
| `trib/tribFed/piscofins/{vBCPisCofins,pAliqPis,pAliqCofins,vPis,vCofins}` | Condicional | N variados | Apuração própria PIS/COFINS |
| `trib/tribFed/piscofins/tpRetPisCofins` | Condicional | N, 1 | **0**=Nenhum retido; **1**=PIS/COFINS retidos; **2**=Não retidos; **3**=PIS/COFINS/CSLL retidos; **4** a **9** = combinações — este é o campo `tpRetPisCofins` da NT007 já citado na Fase 1 (Seção 8) |
| `trib/tribFed/{vRetCP,vRetIRRF,vRetCSLL}` | Condicional | N, 1-15V2 | Retenções federais |
| `trib/totTrib/vTotTrib/{vTotTribFed,vTotTribEst,vTotTribMun}` | Obrigatório (dentro do grupo) | N, 1-15V2 | Lei 12.741/2012 ("valor aproximado dos tributos") |
| `trib/totTrib/pTotTrib/{pTotTribFed,pTotTribEst,pTotTribMun}` | Obrigatório (dentro do grupo) | N, 1-2V2 | Idem, percentual |
| `trib/totTrib/indTotTrib` | Condicional (choice) | N, 1 | **0**=Não informar tributos estimados (Decreto 8.264/2014) |
| `trib/totTrib/pTotTribSN` | Condicional (choice) | N, 1-2V2 | % aproximado do total de tributos do Simples Nacional |

### 2.8 `IBSCBS` (DPS — declarado pelo emitente, distinto do grupo calculado em 2.3)

| Campo | Obrig./Cond. | Tipo/Tam. | Enum |
|---|---|---|---|
| `finNFSe` | Obrigatório | N, 1 | **0**=NFS-e regular (único valor documentado até NT005) |
| `indFinal` | Condicional | N, 1 | **0**=Não; **1**=Sim (uso/consumo pessoal, art.57). **Nota da fonte**: será descontinuado com a NT005 ao longo de 2026 |
| `cIndOp` | Obrigatório | N, 6 | Tabela "código indicador de operação" — Anexo C (`ANEXO_C-INDOP_IBSCBS-SNNFSe-v1.01-20260122`, não lido nesta pesquisa) |
| `tpOper` | Condicional | N, 1 | **1**=Fornecimento com pagamento posterior; **2**=Recebimento com fornecimento já realizado; **3**=Fornecimento com pagamento já realizado; **4**=Recebimento com fornecimento posterior; **5**=Concomitantes |
| `gRefNFSe/refNFSe` | Condicional (obrigatório se `tpOper=2` ou `3`) | C, 1-99 ocorrências, 50 | Chave da NFS-e referenciada |
| `tpEnteGov` | Condicional | N, 1 | **1**=União; **2**=Estado; **3**=Distrito Federal; **4**=Município — só em compras governamentais |
| `indDest` | Obrigatório | N, 1 | **0**=Destinatário = tomador; **1**=Destinatário ≠ tomador |
| `dest/*` | Condicional (grupo 0-1) | (mesma estrutura de prest/toma) | Só quando `indDest=1` |
| `imovel/*` | Condicional (grupo 0-1) | — | Operações sobre bens imóveis, exceto obras |
| `valores/gReeRepRes/documentos/*` | Condicional | — | Reembolso/repasse/ressarcimento (dFeNacional, docFiscalOutro, docOutro, fornec) |
| `valores/gReeRepRes/documentos/tpReeRepRes` | Condicional | N, 2 | **01**=Repasse intermediação imobiliária; **02**=Repasse a fornecedor (turismo); **03**/**04**=Reembolso agência de propaganda (produção externa/mídia); **99**=Outros |
| `valores/trib/gIBSCBS/CST` | Obrigatório | N, 3 | Código de Situação Tributária IBS/CBS (tabela não detalhada nesta aba) |
| `valores/trib/gIBSCBS/cClassTrib` | Obrigatório | N, 6 | Código de Classificação Tributária IBS/CBS |
| `valores/trib/gIBSCBS/cCredPres` | Condicional | N, 2 | Código de crédito presumido |
| `valores/trib/gIBSCBS/gTribRegular/{CSTReg,cClassTribReg}` | Condicional (grupo 0-1) | N 3 / N 6 | Tributação regular alternativa |
| `valores/trib/gIBSCBS/gDif/{pDifUF,pDifMun,pDifCBS}` | Condicional (grupo 0-1) | N, 1-3V2 | Percentuais de diferimento |

### 2.9 Assinatura

| Campo | XPath | Obrig./Cond. |
|---|---|---|
| `Signature` (da DPS) | `NFSe/infNFSe/DPS/infDPS/Signature` | Condicional — obrigatório quando enviado via API; opcional em outros casos por regra de validação |
| `Signature` (da NFS-e) | `NFSe/Signature` | Obrigatório |

---

## 3. Enums / domínios de valores confirmados

Todos ✅ confirmados pelo Anexo I oficial (mesma fonte da Seção 2). Consolidação dos enums já listados campo a campo acima, para referência rápida:

- **`cStat`** (NFS-e): 100 Gerada · 102 Decisão Judicial/Administrativa · 103 Avulsa · 107 MEI
- **`ambGer`**: 1 Sistema Próprio do Município · 2 Sefin Nacional NFS-e
- **`tpEmis`**: 1 Emissão direta modelo nacional · 2 Emissão em leiaute próprio, transcrita
- **`tpAmb`** (DPS): 1 Produção · 2 Homologação
- **`tpEmit`**: 1 Prestador · 2 Tomador · 3 Intermediário
- **`tribISSQN`**: 1 Operação tributável · 2 Imunidade · 3 Exportação de serviço · 4 Não Incidência
- **`tpImunidade`**: 0 a 5 (ver Seção 2.7)
- **`exigSusp/tpSusp`**: 1 Decisão Judicial · 2 Processo Administrativo
- **`tpRetISSQN`**: 1 Não Retido · 2 Retido pelo Tomador · 3 Retido pelo Intermediário
- **`tpRetPisCofins`**: 0 a 9 (combinações de retenção PIS/COFINS/CSLL)
- **`subst/cMotivo`**: 1, 2, 3, 4, 5, 99
- **`regTrib/opSimpNac`**: 1 Não Optante · 2 MEI · 3 ME/EPP
- **`regTrib/regEspTrib`**: 0, 1, 2, 3, 4, 5, 6, 9
- **`tpDedRed`**: 01 a 08, 99 (01 descontinuado a partir de jan/2026)
- **`cNaoNIF`**: 0, 1, 2
- **`mdPrestacao`**: 0 a 4 · **`vincPrest`**: 0-6, 9 · **`movTempBens`**: 0-3 · **`mdic`**: 0, 1
- **`finNFSe`** (IBSCBS): apenas 0 documentado
- **`indFinal`**: 0, 1 (a ser descontinuado — NT005, 2026)
- **`tpOper`** (IBSCBS): 1 a 5 · **`tpEnteGov`**: 1-4 · **`indDest`**: 0, 1
- **`tipoChaveDFe`**: 1 NFS-e · 2 NF-e · 3 CT-e · 9 Outro
- **`tpReeRepRes`**: 01-04, 99

**Enums citados mas não obtidos nesta pesquisa** (ficam fora do Anexo I, remetidos a outros anexos):
- Códigos de `cTribNac` completos (Lista Nacional de Serviços) — parcialmente obtidos via aba `MUN.INCID_INFO.SERV.` do próprio arquivo (ver amostra de saúde na Seção 1); tabela completa (~340 subitens) não transcrita nesta pesquisa.
- `cNBS` — Anexo B (`ANEXO_B-NBS2-LISTA_SERVICO_NACIONAL-SNNFSe-v1.01-20260122.xlsx`), não lido.
- `cIndOp` — Anexo C (`ANEXO_C-INDOP_IBSCBS-SNNFSe-v1.01-20260122.xlsx`), não lido.
- `CST`/`cClassTrib` do grupo IBS/CBS (`valores/trib/gIBSCBS`) — tabela de códigos não está nesta aba do Anexo I; provavelmente no Anexo VI/VII (NT009), não lido.
- `CST` de PIS/COFINS — enum extenso (00 a 99) **foi obtido** e está descrito na célula original (ver aba `LEIAUTE DPS_NFS-e`, linha 315); não reproduzido por extenso aqui por ser genérico do padrão fiscal federal (não específico do Anexo I).

---

## 4. Versões de XSD / arquivos identificados

Todos os links abaixo foram confirmados diretamente na página `https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual` (publicada 10/12/2025, atualizada 17/04/2026), seção "Esquemas XSD" / "Anexos de Layout" / "Anexos de Domínio". ✅ Confiança oficial.

| Arquivo | Versão | Obtido nesta pesquisa? |
|---|---|---|
| `NFSe-ESQUEMAS_XSD-v1.01-20260209.zip` | v1.01, 09/02/2026 | Não baixado (não necessário — Anexo I em xlsx já supre a matriz de campos; XSD binário ficaria para Fase 2/implementação) |
| `ANEXO_I-SEFIN_ADN-DPS_NFSe-SNNFSe-v1.01-20260209.xlsx` | v1.01, 09/02/2026 | **Sim — objeto desta pesquisa** |
| `ANEXO_A-MUNICIPIO_IBGE-PAISES_ISO2-v1.00-SNNFSe-20251210.xlsx` | v1.00, 10/12/2025 | Não baixado |
| `ANEXO_B-NBS2-LISTA_SERVICO_NACIONAL-SNNFSe-v1.01-20260122.xlsx` | v1.01, 22/01/2026 | Não baixado |
| `ANEXO_C-INDOP_IBSCBS-SNNFSe-v1.01-20260122.xlsx` (equivalente ao antigo `AnexoVII-IndOp_IBSCBS_V1.00.00` da seção RTC) | v1.01, 22/01/2026 | Não baixado |
| Anexo de Eventos (`anexo_ii-sefin_adn-...-snnfse-v1-01-20260122.xlsx` — nome exibido truncado na extração da página, não confirmado por extenso) | v1.01, 22/01/2026 | Não baixado — **continua sendo o item bloqueante para o fluxo de Cancelamento/Substituição (Seção 3.3 da Fase 1)**, fora do escopo deste sprint |

**Nota sobre continuidade de versão**: a Fase 1 registrou que "o leiaute atual está em vigor desde 29/09/2025" sem capturar o número de versão. Esta pesquisa confirma que a versão hoje vigente do Anexo I (leiaute DPS/NFS-e) é **v1.01 (09/02/2026)**, sucedendo uma v1.00 (10/12/2025) — ou seja, já houve ao menos uma revisão do leiaute desde a entrada em vigor do padrão nacional atual, antes mesmo da obrigatoriedade do IBS/CBS (03/08/2026).

---

## 5. Lacunas remanescentes (explícitas)

- ❓ **Anexo II (Eventos)** — não obtido nesta pesquisa (mesmo tendo o link já localizado na mesma página do Anexo I: `anexo_ii-sefin_adn-*-snnfse-v1-01-20260122.xlsx`). Continua bloqueante para o fluxo de Cancelamento/Substituição descrito na Fase 1 (Seção 3.3). **Recomendação**: próximo sprint da Fase 1.5 deve mirar especificamente este arquivo, já que o link foi localizado (mesma seção "Anexos de Layout" da página `documentacao-atual`).
- ❓ **Anexo IV (regras ADN)** — não obtido, link não localizado nesta pesquisa.
- ❓ **Anexo A (tabela IBGE/países)**, **Anexo B (NBS)**, **Anexo C (`cIndOp`)** — links localizados e confirmados, arquivos não baixados/lidos (fora do escopo declarado desta pesquisa, que era especificamente o Anexo I).
- ❓ **Aba `RN DPS_NFS-e` (655 linhas, regras de negócio/erros por campo)** — lida apenas por amostragem (primeiras ~30 linhas, cobrindo os campos iniciais de `infNFSe`). Confirma que a tabela exaustiva de códigos de rejeição que a Fase 1 marcou como lacuna (Seção 7 do doc. Fase 1) **existe e está nesta mesma aba do Anexo I** — ex.: `E1301`/`E1305` (obrigatoriedade condicional de `cLocIncid`), `E1274` (`ambGer`), `E1276` (`procEmi`), `E1278` (`dhProc`), `E1260`/`E1263`/`E1268` (versão e identificador da NFS-e). A leitura exaustiva das 655 linhas fica como próximo passo recomendado (não uma lacuna de disponibilidade da fonte, e sim de tempo de processamento neste sprint).
- ❓ **Aba `EXPORTACAO_EMISSÃO_NFS-e`** e **aba `RN_RECEPCAO_DPS`** do mesmo arquivo — não lidas nesta pesquisa; a primeira é citada no próprio leiaute (campo `xOutInf`, cenários 28/34) como fonte de regras de exportação de serviço.
- ❓ **Aba `MUN.INCID_INFO.SERV.`** (341 linhas, tabela completa de ~340 subitens de serviço com regra de incidência do ISSQN) — lida apenas por amostragem, focada nos subitens do item 4 (saúde), relevante à clínica. A tabela completa (todos os ~20 itens da LC 116) não foi transcrita.
- ❓ **Tipo de certificado digital (A1 vs A3/HSM)** — segue como lacuna da Fase 1, não endereçada neste sprint (fora de escopo).
- ❓ **Confirmação da situação de convênio de Goiânia** — idem, fora de escopo deste sprint.

**Nenhum campo foi preenchido por inferência de conhecimento genérico de NFS-e municipal (ABRASF)** — todo conteúdo desta matriz vem de leitura direta e programática (Python `zipfile`/`xml.etree`, sem parser de terceiros) do arquivo `.xlsx` oficial baixado do domínio `gov.br/nfse`.

---

## Fontes e cobertura desta pesquisa

- **Página HTML lida**: `https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual` (publicada 10/12/2025, atualizada 17/04/2026) — usada para localizar o link direto do Anexo I na seção "Anexos de Layout".
- **Arquivo baixado e lido integralmente (aba `LEIAUTE DPS_NFS-e`, 417 linhas) e parcialmente (aba `RN DPS_NFS-e`, amostra de ~30 de 655 linhas; aba `MUN.INCID_INFO.SERV.`, amostra de ~45 de 341 linhas)**: `ANEXO_I-SEFIN_ADN-DPS_NFSe-SNNFSe-v1.01-20260209.xlsx`, `https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/anexo_i-sefin_adn-dps_nfse-snnfse-v1-01-20260209.xlsx`.
- **Método de extração**: download direto (HTTP GET, sem autenticação/certificado necessário — arquivo público), parsing via `zipfile` + `xml.etree.ElementTree` (bibliotecas padrão do Python, sem parser de terceiros), reconstrução de linhas/colunas a partir de `xl/sharedStrings.xml` + `xl/worksheets/sheet{N}.xml`.
- **Não lidas nesta pesquisa**: abas `EXPORTACAO_EMISSÃO_NFS-e` e `RN_RECEPCAO_DPS` do mesmo arquivo; Anexos A, B, C, II, IV (links localizados para A/B/C, não baixados).

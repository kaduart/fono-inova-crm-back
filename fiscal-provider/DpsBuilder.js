// fiscal-provider/DpsBuilder.js
// Provider Layer (Fase 2 v3, Seção 1) — serializa o JSON estruturado do FiscalSnapshot em XML
// da DPS, seguindo os nomes de elemento confirmados em dps_field_matrix.md (Anexo I,
// v1.01-20260209). Não assina digitalmente (CertificateManager, ainda mock) e não faz HTTP.
//
// ⚠️ LIMITAÇÃO CONHECIDA E DOCUMENTADA: fomos capazes de confirmar os NOMES e a hierarquia dos
// elementos a partir da planilha derivada do Anexo I (dps_field_matrix.md), mas não obtivemos o
// arquivo .xsd literal nesta pesquisa. Este builder cobre o caminho feliz do fluxo regular
// (`tribISSQN=1`, operação tributável comum) — NÃO cobre ainda: imunidade/exportação de serviço,
// deduções (vDedRed), retenções federais (PIS/COFINS) nem o fluxo de decisão
// judicial/administrativa (liminarFlow=judicial_bypass usa
// endpoint e payload próprios, fora do escopo deste builder). Expandir aqui exige validação
// contra o XSD real, não suposição.

import { RegimeTributario } from '../constants/fiscalEnums.js';
import { formatInTimeZone } from 'date-fns-tz';
import { findFiscalServiceByCode } from '../domain/fiscal/FiscalServiceCatalog.js';

function escapeXml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function el(tag, content) {
  if (content === null || content === undefined || content === '') return '';
  return `<${tag}>${escapeXml(content)}</${tag}>`;
}

// end/{xLgr,nro,xCpl,xBairro} + end/endNac/{cMun,CEP} — dps_field_matrix.md Seção 2.5, mesma
// estrutura compartilhada por prest/toma/interm. Confirmado Obrigatório (só xCpl é opcional).
function enderecoXml(end) {
  if (!end) return '';
  const endNacXml = `<endNac>${el('cMun', end.cMun)}${el('CEP', end.cep)}</endNac>`;
  return `<end>${endNacXml}${el('xLgr', end.xLgr)}${el('nro', end.nro)}${el('xCpl', end.xCpl)}${el('xBairro', end.xBairro)}</end>`;
}

// regTrib/opSimpNac (dps_field_matrix.md Seção 2.5): 1=Não Optante, 2=MEI, 3=ME/EPP
function mapRegimeTributarioToOpSimpNac(regimeTributario) {
  switch (regimeTributario) {
    case RegimeTributario.SIMPLES_NACIONAL:
      return 3; // ME/EPP — MEI seria um regimeTributario próprio, não modelado ainda
    default:
      return 1; // Lucro Presumido/Real → Não Optante
  }
}

function formatDate(date) {
  if (!date) return '';
  return new Date(date).toISOString().slice(0, 10); // AAAA-MM-DD
}

function formatDateTime(date) {
  // Apesar do nome TSDateTimeUTC, o XSD nacional exige TZD como offset explícito e rejeita `Z`.
  // A clínica opera em America/Sao_Paulo; date-fns-tz preserva eventuais mudanças oficiais de
  // offset sem fixar `-03:00` manualmente.
  return formatInTimeZone(date ? new Date(date) : new Date(), 'America/Sao_Paulo', "yyyy-MM-dd'T'HH:mm:ssXXX");
}

// Item 04.08 da LC 116 (terapia ocupacional, fisioterapia e fonoaudiologia): o Anexo VIII
// v1.01.00 correlaciona a operação presencial ao cIndOp 030101. A classificação 200029/CST 200
// é a dos serviços de saúde humana do Anexo III da LC 214/2025 (redução de 60%). Estes valores
// ficam deliberadamente restritos a este serviço; outros serviços precisam de parametrização
// fiscal própria e nunca devem herdar silenciosamente o benefício de saúde.
function ibsCbsClassificationFor(serviceCode) {
  if (findFiscalServiceByCode(serviceCode)) {
    return { cIndOp: '030101', cst: '200', cClassTrib: '200029' };
  }
  throw new Error(`FISCAL_IBSCBS_NAO_CONFIGURADO: serviço ${serviceCode || 'não informado'}`);
}

/**
 * @param {Object} snapshot - FiscalSnapshot.json (produzido por FiscalSnapshotBuilder)
 * @param {Object} fiscalInvoice - para dpsId, serie, nNFSe/nDPS
 * @param {Object} fiscalProfile - para regimeTributario, cnpj, IM, municipioIBGE
 * @returns {string} XML da DPS (não assinado)
 */
export function buildDpsXml(snapshot, fiscalInvoice, fiscalProfile) {
  const infDPS = snapshot.infDPS;
  const tpAmb = infDPS.tpAmb;
  const opSimpNac = mapRegimeTributarioToOpSimpNac(fiscalProfile.regimeTributario);
  const ibsCbs = ibsCbsClassificationFor(infDPS.serv.cTribNac);
  const fiscalService = findFiscalServiceByCode(infDPS.serv.cTribNac);
  if (!fiscalService?.municipalServiceCode || !fiscalService?.nbsCode) {
    throw new Error(`FISCAL_SERVICO_MUNICIPAL_INCOMPLETO: serviço ${infDPS.serv.cTribNac || 'não informado'}`);
  }

  const prestXml = [
    el('CNPJ', infDPS.prest.cnpj),
    el('IM', infDPS.prest.im),
    el('xNome', infDPS.prest.xNome),
    enderecoXml(infDPS.prest.end),
    `<regTrib>${el('opSimpNac', opSimpNac)}${el('regEspTrib', 0)}</regTrib>`
  ].join('');

  // CNPJ/CPF é choice (Anexo I §2.5) — tomador PJ (convênio/empresa) usa CNPJ, senão CPF do paciente.
  const tomaXml = [
    infDPS.toma.cnpj ? el('CNPJ', infDPS.toma.cnpj) : el('CPF', infDPS.toma.cpf),
    el('xNome', infDPS.toma.nome),
    enderecoXml(infDPS.toma.end)
  ].join('');

  const servXml = [
    `<locPrest>${el('cLocPrestacao', infDPS.serv.cLocPrestacao)}</locPrest>`,
    `<cServ>${el('cTribNac', infDPS.serv.cTribNac)}${el('cTribMun', fiscalService.municipalServiceCode)}` +
      `${el('xDescServ', infDPS.serv.xDescServ)}${el('cNBS', fiscalService.nbsCode)}</cServ>`
  ].join('');

  // Caminho feliz: operação tributável comum (tribISSQN=1), sem retenção (tpRetISSQN=1).
  // Ver limitação documentada no topo do arquivo para os demais cenários.
  const valoresXml = [
    `<vServPrest>${el('vServ', infDPS.valores.vServ)}</vServPrest>`,
    `<trib>` +
      `<tribMun>${el('tribISSQN', 1)}${el('tpRetISSQN', 1)}</tribMun>` +
      // O grupo existe obrigatoriamente no XSD, embora todos os seus campos sejam condicionais.
      `<tribFed></tribFed>` +
      // Em homologação, declara que os totais estimados não serão informados. Em produção essa
      // escolha precisa vir da configuração contábil/IBPT da clínica; não deve ser presumida.
      (tpAmb === 2
        ? `<totTrib>${el('indTotTrib', 0)}</totTrib>`
        : (() => { throw new Error('FISCAL_TOTAL_TRIBUTOS_NAO_CONFIGURADO'); })()) +
    `</trib>`
  ].join('');

  const ibsCbsXml = [
    el('finNFSe', 0), // NFS-e regular
    el('indFinal', 1), // atendimento de saúde para uso/consumo pessoal
    el('cIndOp', ibsCbs.cIndOp),
    // Neste fluxo, quem foi escolhido no modal para receber a nota é simultaneamente tomador e
    // destinatário fiscal. O paciente atendido, quando diferente, permanece na discriminação.
    el('indDest', 0),
    `<valores><trib><gIBSCBS>${el('CST', ibsCbs.cst)}${el('cClassTrib', ibsCbs.cClassTrib)}</gIBSCBS></trib></valores>`
  ].join('');

  const infDPSXml = [
    el('tpAmb', tpAmb),
    el('dhEmi', formatDateTime(new Date())),
    el('verAplic', 'crm-fono-inova-1.0'),
    el('serie', fiscalInvoice.serie),
    el('nDPS', fiscalInvoice.nDPS),
    el('dCompet', formatDate(infDPS.dCompet)),
    el('tpEmit', 1), // Prestador
    el('cLocEmi', fiscalProfile.municipioIBGE),
    `<prest>${prestXml}</prest>`,
    `<toma>${tomaXml}</toma>`,
    `<serv>${servXml}</serv>`,
    `<valores>${valoresXml}</valores>`,
    `<IBSCBS>${ibsCbsXml}</IBSCBS>`
  ].join('');

  return `<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infDPS Id="${escapeXml(fiscalInvoice.dpsId || '')}">${infDPSXml}</infDPS></DPS>`;
}

/**
 * Extrator mínimo de campos da resposta (NÃO é um parser XML genérico — deliberadamente evita
 * adicionar dependência de terceiros sem decisão prévia. Cobre só os campos que o domínio precisa
 * ler de volta: cStat, chave de acesso (id), nNFSe. Se a resposta tiver estrutura mais rica,
 * trocar por uma biblioteca real (ex. fast-xml-parser) é trabalho de próxima iteração, não deste
 * PR.
 */
export function extractFieldsFromNfseResponseXml(xml) {
  const match = (tag) => {
    const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return m ? m[1] : null;
  };

  const idMatch = xml.match(/<infNFSe\s+id="([^"]+)"/) || xml.match(/<id>([^<]+)<\/id>/);

  return {
    cStat: match('cStat') ? Number(match('cStat')) : null,
    chaveAcesso: idMatch ? idMatch[1] : null,
    nNFSe: match('nNFSe') ? Number(match('nNFSe')) : null,
    ambGer: match('ambGer') ? Number(match('ambGer')) : null,
    tpEmis: match('tpEmis') ? Number(match('tpEmis')) : null
  };
}

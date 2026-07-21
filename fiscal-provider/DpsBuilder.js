// fiscal-provider/DpsBuilder.js
// Provider Layer (Fase 2 v3, Seção 1) — serializa o JSON estruturado do FiscalSnapshot em XML
// da DPS, seguindo os nomes de elemento confirmados em dps_field_matrix.md (Anexo I,
// v1.01-20260209). Não assina digitalmente (CertificateManager, ainda mock) e não faz HTTP.
//
// ⚠️ LIMITAÇÃO CONHECIDA E DOCUMENTADA: fomos capazes de confirmar os NOMES e a hierarquia dos
// elementos a partir da planilha derivada do Anexo I (dps_field_matrix.md), mas não obtivemos o
// arquivo .xsd literal nesta pesquisa. Este builder cobre o caminho feliz do fluxo regular
// (`tribISSQN=1`, operação tributável comum) — NÃO cobre ainda: imunidade/exportação de serviço,
// deduções (vDedRed), retenções federais (PIS/COFINS), grupo IBS/CBS (obrigatório a partir de
// 03/08/2026) nem o fluxo de decisão judicial/administrativa (liminarFlow=judicial_bypass usa
// endpoint e payload próprios, fora do escopo deste builder). Expandir aqui exige validação
// contra o XSD real, não suposição.

import { RegimeTributario } from '../constants/fiscalEnums.js';

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
  return (date ? new Date(date) : new Date()).toISOString();
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

  const prestXml = [
    el('CNPJ', infDPS.prest.cnpj),
    el('xNome', infDPS.prest.xNome),
    el('IM', infDPS.prest.im),
    `<regTrib>${el('opSimpNac', opSimpNac)}${el('regEspTrib', 0)}</regTrib>`
  ].join('');

  const tomaXml = [
    el('CPF', infDPS.toma.cpf),
    el('xNome', infDPS.toma.nome)
  ].join('');

  const servXml = [
    `<locPrest>${el('cLocPrestacao', infDPS.serv.cLocPrestacao)}</locPrest>`,
    `<cServ>${el('cTribNac', infDPS.serv.cTribNac)}${el('xDescServ', infDPS.serv.xDescServ)}</cServ>`
  ].join('');

  // Caminho feliz: operação tributável comum (tribISSQN=1), sem retenção (tpRetISSQN=1).
  // Ver limitação documentada no topo do arquivo para os demais cenários.
  const valoresXml = [
    `<vServPrest>${el('vServ', infDPS.valores.vServ)}</vServPrest>`,
    `<trib><tribMun>${el('tribISSQN', 1)}${el('tpRetISSQN', 1)}</tribMun></trib>`
  ].join('');

  const infDPSXml = [
    el('tpAmb', tpAmb),
    el('dhEmi', formatDateTime(new Date())),
    el('verAplic', 'crm-fono-inova-1.0'),
    el('dCompet', formatDate(infDPS.dCompet)),
    el('tpEmit', 1), // Prestador
    el('cLocEmi', fiscalProfile.municipioIBGE),
    `<prest>${prestXml}</prest>`,
    `<toma>${tomaXml}</toma>`,
    `<serv>${servXml}</serv>`,
    `<valores>${valoresXml}</valores>`
  ].join('');

  return `<?xml version="1.0" encoding="UTF-8"?><DPS versao="1.01"><infDPS id="${escapeXml(fiscalInvoice.dpsId || '')}">${infDPSXml}</infDPS></DPS>`;
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

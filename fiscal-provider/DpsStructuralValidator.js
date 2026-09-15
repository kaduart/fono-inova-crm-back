// fiscal-provider/DpsStructuralValidator.js
// Provider Layer — validação pré-envio da DPS (item 4 da tarefa de homologação de Anápolis,
// 2026-09-11).
//
// ⚠️ NÃO é o .xsd oficial. O arquivo real (schema_v101.xsd, manual §7.4.3) está bloqueado por
// 403 nesta rede — confirmado nesta tarefa com curl direto contra notacontrol.com.br e
// issnetonline.com.br (mesmo host que já retornava 403 no achado anterior registrado em
// compliance_checklist.md). Fabricar um .xsd sem poder confrontá-lo com o oficial daria falsa
// confiança — pior que não validar. Este validador é estrutural: deriva das mesmas fontes que já
// sustentam o DpsBuilder (docs/nfse-fiscal-module/dps_field_matrix.md, Anexo I oficial
// v1.01-20260209, e o Manual_integracao_v101.pdf anexado, Seção 8). Cobre só a árvore que o
// DpsBuilder hoje efetivamente emite (caminho feliz: operação tributável comum, sem
// isenção/imunidade/exportação/dedução/retenção federal/obra/evento — mesma limitação já
// documentada no topo de DpsBuilder.js). Pega os erros mais comuns e mais caros (elemento
// obrigatório ausente, CNPJ/CPF com tamanho errado, data em formato errado, Id fora do padrão de
// 45 posições) antes de gastar uma chamada HTTP real. Validação XSD literal contra o arquivo
// oficial continua sendo uma lacuna documentada, não resolvida aqui.
//
// Nunca renomear este arquivo/função para algo com "XSD" no nome, nem descrever o resultado como
// "validação XSD" em log, erro ou documentação — isto é uma validação estrutural/preflight, não
// uma validação de schema. `OFFICIAL_XSD_VALIDATION` abaixo existe justamente para dar um único
// lugar, importável e não-ambíguo, para checar esse status em vez de espalhar a frase em comentário.

import { DOMParser } from '@xmldom/xmldom';

/**
 * Status real da validação contra o .xsd oficial (schema_v101.xsd) — 'pending' até o arquivo ser
 * obtido (hoje bloqueado por 403, ver docs/nfse-fiscal-module/anapolis_audit_2026-09-11.md) e uma
 * validação de schema literal (ex. libxmljs/xmllint) ser implementada e confrontada com ele. Este
 * módulo (`validateDpsStructure`) nunca muda este valor para 'implemented' sozinho — só documenta
 * o estado real para quem for decidir se a base está pronta para emissão real.
 */
export const OFFICIAL_XSD_VALIDATION = 'pending';

function firstChildByLocalName(el, name) {
  if (!el || !el.childNodes) return null;
  for (let i = 0; i < el.childNodes.length; i += 1) {
    const node = el.childNodes[i];
    if (node.nodeType === 1 && (node.localName === name || node.tagName === name || node.tagName?.endsWith(`:${name}`))) {
      return node;
    }
  }
  return null;
}

function textOf(el) {
  if (!el) return null;
  const value = (el.textContent || '').trim();
  return value === '' ? null : value;
}

function addError(errors, path, message) {
  errors.push({ path, message });
}

/**
 * Valida um elemento-folha simples contra um spec de campo. `parent` pode ser null (grupo pai
 * ausente) — nesse caso só reporta erro se o campo for `required` dentro desse grupo (quem decide
 * se o próprio grupo é obrigatório é o chamador, via `requireGroup`).
 */
function checkLeaf(errors, parent, path, { name, required = false, pattern, minLen, maxLen, enumValues }) {
  const el = firstChildByLocalName(parent, name);
  const value = textOf(el);
  const fullPath = `${path}/${name}`;
  if (value === null) {
    if (required) addError(errors, fullPath, 'Elemento obrigatório ausente ou vazio');
    return null;
  }
  if (pattern && !pattern.test(value)) addError(errors, fullPath, `Valor "${value}" não bate com o formato esperado (${pattern})`);
  if (minLen && value.length < minLen) addError(errors, fullPath, `Tamanho mínimo ${minLen}, recebido ${value.length}`);
  if (maxLen && value.length > maxLen) addError(errors, fullPath, `Tamanho máximo ${maxLen}, recebido ${value.length}`);
  if (enumValues && !enumValues.includes(value)) addError(errors, fullPath, `Valor "${value}" fora do domínio permitido: ${enumValues.join(', ')}`);
  return value;
}

function requireGroup(errors, parent, path, name) {
  const el = firstChildByLocalName(parent, name);
  if (!el) addError(errors, `${path}/${name}`, 'Grupo obrigatório ausente');
  return el;
}

// prest/toma/interm compartilham a mesma estrutura (dps_field_matrix.md Seção 2.5) — CNPJ|CPF é
// choice; xNome é obrigatório em toma, opcional em prest (o CRM sempre informa nos dois).
function checkPessoa(errors, el, path, { xNomeRequired = false } = {}) {
  if (!el) return;
  const cnpj = textOf(firstChildByLocalName(el, 'CNPJ'));
  const cpf = textOf(firstChildByLocalName(el, 'CPF'));
  if (!cnpj && !cpf) {
    addError(errors, `${path}`, 'Choice CNPJ/CPF ausente — pelo menos um dos dois é obrigatório');
  } else {
    if (cnpj && !/^\d{14}$/.test(cnpj)) addError(errors, `${path}/CNPJ`, `CNPJ deve ter 14 dígitos, recebido "${cnpj}"`);
    if (cpf && !/^\d{11}$/.test(cpf)) addError(errors, `${path}/CPF`, `CPF deve ter 11 dígitos, recebido "${cpf}"`);
  }
  checkLeaf(errors, el, path, { name: 'xNome', required: xNomeRequired, maxLen: 300 });
}

/**
 * @param {string} xml - DPS não assinada (saída de DpsBuilder.buildDpsXml) ou já assinada (a
 *   assinatura entra como elemento irmão de infDPS — não afeta os checks aqui).
 * @returns {{ valid: boolean, errors: Array<{ path: string, message: string }> }}
 */
export function validateDpsStructure(xml) {
  const errors = [];
  let doc;
  try {
    doc = new DOMParser({
      errorHandler: {
        warning: () => {},
        error: (msg) => addError(errors, '/', `XML malformado: ${msg}`),
        fatalError: (msg) => addError(errors, '/', `XML malformado: ${msg}`)
      }
    }).parseFromString(String(xml || ''), 'text/xml');
  } catch (error) {
    return { valid: false, errors: [{ path: '/', message: `Falha ao fazer parse do XML: ${error.message}` }] };
  }
  if (errors.length) return { valid: false, errors };

  const root = doc.documentElement;
  if (!root || (root.localName !== 'DPS' && root.tagName !== 'DPS')) {
    return { valid: false, errors: [{ path: '/', message: 'Raiz esperada <DPS>, não encontrada' }] };
  }

  const infDPS = firstChildByLocalName(root, 'infDPS');
  if (!infDPS) return { valid: false, errors: [{ path: '/DPS', message: 'Elemento obrigatório <infDPS> ausente' }] };

  // TSIdDPS (manual pág. 27 / dps_field_matrix.md §2.4): "DPS" + 7(município) + 1(tipoInscr) +
  // 14(inscrição) + 5(série) + 15(núm.) = 45 posições fixas.
  const id = infDPS.getAttribute ? infDPS.getAttribute('Id') : null;
  if (!id) addError(errors, '/DPS/infDPS@Id', 'Atributo Id ausente');
  else if (!/^DPS\d{42}$/.test(id)) addError(errors, '/DPS/infDPS@Id', `Id deve ter exatamente 45 posições no formato DPS+42 dígitos, recebido "${id}" (${id.length} posições)`);

  const path = '/DPS/infDPS';
  checkLeaf(errors, infDPS, path, { name: 'tpAmb', required: true, enumValues: ['1', '2'] });
  // TSDateTimeUTC exige offset explícito (+hh:mm/-hh:mm) — o próprio DpsBuilder documenta que o
  // XSD nacional rejeita sufixo "Z", apesar do nome do tipo.
  checkLeaf(errors, infDPS, path, { name: 'dhEmi', required: true, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/ });
  checkLeaf(errors, infDPS, path, { name: 'verAplic', required: true, maxLen: 20 });
  checkLeaf(errors, infDPS, path, { name: 'serie', required: true, pattern: /^\d{1,5}$/ });
  checkLeaf(errors, infDPS, path, { name: 'nDPS', required: true, pattern: /^\d{1,15}$/ });
  checkLeaf(errors, infDPS, path, { name: 'dCompet', required: true, pattern: /^\d{4}-\d{2}-\d{2}$/ });
  checkLeaf(errors, infDPS, path, { name: 'tpEmit', required: true, enumValues: ['1', '2', '3'] });
  checkLeaf(errors, infDPS, path, { name: 'cLocEmi', required: true, pattern: /^\d{7}$/ });

  const prest = requireGroup(errors, infDPS, path, 'prest');
  if (prest) {
    checkPessoa(errors, prest, `${path}/prest`, { xNomeRequired: false });
    checkLeaf(errors, prest, `${path}/prest`, { name: 'IM', required: true, maxLen: 15 });
    const regTrib = requireGroup(errors, prest, `${path}/prest`, 'regTrib');
    if (regTrib) {
      checkLeaf(errors, regTrib, `${path}/prest/regTrib`, { name: 'opSimpNac', required: true, enumValues: ['1', '2', '3'] });
      checkLeaf(errors, regTrib, `${path}/prest/regTrib`, { name: 'regEspTrib', required: true, pattern: /^[0-9]$/ });
    }
  }

  // toma é 0-1 no leiaute geral, mas o DpsBuilder atual sempre emite um tomador — validado como
  // presente aqui porque é o que o caminho feliz hoje produz.
  const toma = firstChildByLocalName(infDPS, 'toma');
  if (toma) checkPessoa(errors, toma, `${path}/toma`, { xNomeRequired: true });

  const serv = requireGroup(errors, infDPS, path, 'serv');
  if (serv) {
    const locPrest = requireGroup(errors, serv, `${path}/serv`, 'locPrest');
    if (locPrest) {
      const cLoc = textOf(firstChildByLocalName(locPrest, 'cLocPrestacao'));
      const cPais = textOf(firstChildByLocalName(locPrest, 'cPaisPrestacao'));
      if (!cLoc && !cPais) addError(errors, `${path}/serv/locPrest`, 'Choice cLocPrestacao/cPaisPrestacao ausente');
      if (cLoc && !/^\d{7}$/.test(cLoc)) addError(errors, `${path}/serv/locPrest/cLocPrestacao`, `Deve ter 7 dígitos, recebido "${cLoc}"`);
    }
    const cServ = requireGroup(errors, serv, `${path}/serv`, 'cServ');
    if (cServ) {
      checkLeaf(errors, cServ, `${path}/serv/cServ`, { name: 'cTribNac', required: true, pattern: /^\d{6}$/ });
      checkLeaf(errors, cServ, `${path}/serv/cServ`, { name: 'cTribMun', required: true, maxLen: 10 });
      checkLeaf(errors, cServ, `${path}/serv/cServ`, { name: 'xDescServ', required: true, maxLen: 2000 });
    }
  }

  const valores = requireGroup(errors, infDPS, path, 'valores');
  if (valores) {
    const vServPrest = requireGroup(errors, valores, `${path}/valores`, 'vServPrest');
    if (vServPrest) checkLeaf(errors, vServPrest, `${path}/valores/vServPrest`, { name: 'vServ', required: true, pattern: /^\d+(\.\d{1,2})?$/ });
    const trib = requireGroup(errors, valores, `${path}/valores`, 'trib');
    if (trib) {
      const tribMun = requireGroup(errors, trib, `${path}/valores/trib`, 'tribMun');
      if (tribMun) {
        checkLeaf(errors, tribMun, `${path}/valores/trib/tribMun`, { name: 'tribISSQN', required: true, enumValues: ['1', '2', '3', '4'] });
        checkLeaf(errors, tribMun, `${path}/valores/trib/tribMun`, { name: 'tpRetISSQN', required: true, enumValues: ['1', '2', '3'] });
      }
      requireGroup(errors, trib, `${path}/valores/trib`, 'totTrib');
    }
  }

  return { valid: errors.length === 0, errors };
}

// Smoke test do webservice de HOMOLOGAÇÃO da NFS-e (ISS.Net/Nota Control, Anápolis).
// Não grava NADA no banco: só lê FiscalProfile + Certificate, monta uma DPS sintética com os dados
// fixos do ambiente de testes (série 8, município da prestação 5002704 — Campo Grande/MS, atividades
// 7/6/1601), valida a estrutura, assina e — só com --send — envia para o endpoint de homologação.
//
// Uso (a partir de back/):
//   node scripts/fiscal-homologacao-issnet.mjs                  # dry-run: imprime o XML, não envia
//   node scripts/fiscal-homologacao-issnet.mjs --send           # envia RecepcionarLoteDpsSincrono
//   node scripts/fiscal-homologacao-issnet.mjs --send --cTribMun=7 --valor=10 --nDPS=123
//   node scripts/fiscal-homologacao-issnet.mjs --probe          # só testa acesso (WSDL, validador, login)
//
// Sempre usa o endpoint de HOMOLOGAÇÃO, independentemente do FiscalProfile.ambiente.

import 'dotenv/config';
import http from 'node:http';
import https from 'node:https';
import mongoose from 'mongoose';
import { fiscalProfileRepository } from '../infrastructure/persistence/FiscalProfileRepository.js';
import { certificateRepository } from '../infrastructure/persistence/CertificateRepository.js';
import { buildCertificateContext } from '../fiscal-provider/buildCertificateContext.js';
import { buildDpsXml } from '../fiscal-provider/DpsBuilder.js';
import { validateDpsStructure } from '../fiscal-provider/DpsStructuralValidator.js';
import { buildDpsId } from '../services/fiscal/DpsIdentityService.js';
import { AnapolisMunicipalAdapter, ENDPOINTS } from '../adapters/fiscal/AnapolisMunicipalAdapter.js';
import { FiscalAmbiente } from '../constants/fiscalEnums.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const TEST_SERIE = 8;
const TEST_CLOC_PRESTACAO = '5002704';
const cTribMun = String(args.cTribMun || '7');
const valor = Number(args.valor || 10);
const nDPS = Number(args.nDPS || Math.floor(Date.now() / 1000) % 1_000_000_000);

const PROBES = [
  'https://nfse.issnetonline.com.br/wsnfsenacional/homologacao/nfse.asmx?wsdl',
  'https://nfse.issnetonline.com.br/wsnfsenacional/homologacao/validarxml',
  'http://www.issnetonline.com.br/homologacao/online/Login/Login.aspx'
];

function probe(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 15000 }, (res) => { res.resume(); resolve({ url, status: res.statusCode }); });
    req.on('error', (e) => resolve({ url, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ url, error: 'TIMEOUT' }); });
  });
}

async function main() {
  if (args.probe) {
    for (const url of PROBES) console.log(await probe(url));
    return;
  }

  await mongoose.connect(process.env.MONGO_URI);
  try {
    const profile = await fiscalProfileRepository.findFirstActive();
    if (!profile) throw new Error('Nenhum FiscalProfile ativo.');
    const certificate = profile.certificateRef ? await certificateRepository.findById(profile.certificateRef) : null;
    const { httpsAgent, certManager } = buildCertificateContext(certificate);
    if (!certManager) throw new Error('Certificado real não vinculado ao FiscalProfile.');

    const dpsId = buildDpsId({ municipioIBGE: profile.municipioIBGE, cnpj: profile.cnpj, serie: TEST_SERIE, nDPS });
    const snapshot = {
      infDPS: {
        tpAmb: 2,
        dCompet: new Date(),
        prest: { cnpj: profile.cnpj, im: profile.inscricaoMunicipal, xNome: profile.razaoSocial, end: profile.endereco ? {
          xLgr: profile.endereco.logradouro, nro: profile.endereco.numero, xCpl: profile.endereco.complemento,
          xBairro: profile.endereco.bairro, cMun: profile.municipioIBGE, cep: profile.endereco.cep
        } : null },
        toma: {
          nome: 'PACIENTE TESTE HOMOLOGACAO', cpf: args.cpf || '11144477735', cnpj: null,
          end: { xLgr: 'Rua Teste', nro: '100', xCpl: null, xBairro: 'Centro', cMun: TEST_CLOC_PRESTACAO, cep: '79002000' }
        },
        serv: {
          cTribNac: args.cTribNac || '040803',
          cTribMun,
          xDescServ: 'Servico de teste em homologacao',
          cLocPrestacao: TEST_CLOC_PRESTACAO
        },
        valores: { vServ: valor, vLiq: valor, pTotTribSN: profile.pTotTribSN ?? null }
      }
    };
    const invoice = { serie: TEST_SERIE, nDPS, dpsId };

    const xml = buildDpsXml(snapshot, invoice, profile);
    const check = validateDpsStructure(xml);
    console.log('Estrutura (validador derivado, não é o XSD oficial):', check.valid ? 'OK' : check.errors);
    if (!check.valid) return;

    const signed = await certManager.signElement(xml, { id: dpsId, rootLocalName: 'DPS', notaControl: true });
    console.log(`dpsId=${dpsId}  serie=${TEST_SERIE}  nDPS=${nDPS}  cTribMun=${cTribMun}  valor=${valor}`);

    if (!args.send) {
      console.log('\nDRY-RUN (nada enviado). XML assinado:\n');
      console.log(signed);
      return;
    }

    const adapter = new AnapolisMunicipalAdapter({
      ambiente: FiscalAmbiente.PRODUCAO_RESTRITA, httpsAgent, fiscalProfile: profile, certManager
    });
    console.log(`\nEnviando para ${ENDPOINTS[FiscalAmbiente.PRODUCAO_RESTRITA]} ...`);
    const result = await adapter.submitDps(signed);
    console.log(JSON.stringify({ success: result.success, error: result.error, fields: result.fields, httpStatus: result.diagnostics?.httpStatus }, null, 2));
    console.log('\nResposta bruta:\n', result.diagnostics?.response);

    if (result.success && args.reconcile) {
      console.log('\nReconciliação (ConsultarNfsePorDps — pode não existir em homologação):');
      console.log(await adapter.reconcileDps({ serie: TEST_SERIE, nDPS }));
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => { console.error('ERRO:', e.message); process.exitCode = 1; });

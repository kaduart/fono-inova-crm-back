/**
 * 🧪 DpsStructuralValidator — validação pré-envio da DPS (item 4 da tarefa de homologação de
 * Anápolis). Não é o .xsd oficial (bloqueado por 403 nesta rede) — ver comentário no topo do
 * arquivo fonte. Fixture reaproveitada de fiscalProviderLayer.test.js (DpsBuilder.buildDpsXml).
 */
import { describe, it, expect } from 'vitest';
import { buildDpsXml } from '../../fiscal-provider/DpsBuilder.js';
import { validateDpsStructure } from '../../fiscal-provider/DpsStructuralValidator.js';
import { ANAPOLIS_IBGE_CODE } from '../../fiscal-provider/MunicipioProviderRegistry.js';
import { RegimeTributario } from '../../constants/fiscalEnums.js';

const snapshot = {
  infDPS: {
    tpAmb: 2,
    dCompet: new Date('2026-07-01'),
    prest: { cnpj: '12345678000199', xNome: 'Clínica Fono Inova', im: '123456' },
    toma: { nome: 'Paciente Teste', cpf: '11122233344' },
    serv: { cTribNac: '040803', xDescServ: 'Fonoaudiologia', cLocPrestacao: ANAPOLIS_IBGE_CODE },
    valores: { vServ: 180 }
  }
};
const fiscalInvoice = {
  dpsId: 'DPS520110821234567800019900001000000000000001',
  serie: 1,
  nDPS: 1
};
const fiscalProfile = { regimeTributario: RegimeTributario.SIMPLES_NACIONAL, municipioIBGE: ANAPOLIS_IBGE_CODE };

function validDps() {
  return buildDpsXml(snapshot, fiscalInvoice, fiscalProfile);
}

describe('validateDpsStructure', () => {
  it('DPS produzida pelo DpsBuilder no caminho feliz passa sem erros', () => {
    const result = validateDpsStructure(validDps());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('o Id de infDPS tem exatamente 45 posições no fixture usado (confere a própria fixture)', () => {
    expect(fiscalInvoice.dpsId).toHaveLength(45);
    expect(fiscalInvoice.dpsId).toMatch(/^DPS\d{42}$/);
  });

  it('XML malformado nunca passa', () => {
    const result = validateDpsStructure('<DPS><infDPS Id="x">');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('string vazia nunca passa', () => {
    expect(validateDpsStructure('').valid).toBe(false);
  });

  it('raiz diferente de DPS é rejeitada', () => {
    const result = validateDpsStructure('<OutraCoisa/>');
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/Raiz esperada/);
  });

  it('infDPS ausente é rejeitado', () => {
    const result = validateDpsStructure('<DPS versao="1.01"></DPS>');
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/infDPS.*ausente/);
  });

  it('Id fora do padrão de 45 posições é bloqueado antes do HTTP', () => {
    const xml = validDps().replace(fiscalInvoice.dpsId, 'DPS123');
    const result = validateDpsStructure(xml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.includes('@Id'))).toBe(true);
  });

  it('CNPJ do prestador com tamanho errado é bloqueado', () => {
    const xml = validDps().replace('<CNPJ>12345678000199</CNPJ>', '<CNPJ>123</CNPJ>');
    const result = validateDpsStructure(xml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.endsWith('/CNPJ'))).toBe(true);
  });

  it('dhEmi com sufixo Z (em vez de offset) é bloqueado — XSD nacional rejeita Z (comentário do DpsBuilder)', () => {
    const xml = validDps().replace(/<dhEmi>([^<]+)-03:00<\/dhEmi>/, '<dhEmi>$1Z</dhEmi>');
    const result = validateDpsStructure(xml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.endsWith('/dhEmi'))).toBe(true);
  });

  it('dCompet fora do formato AAAA-MM-DD é bloqueado', () => {
    const xml = validDps().replace(/<dCompet>[^<]+<\/dCompet>/, '<dCompet>01/07/2026</dCompet>');
    const result = validateDpsStructure(xml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.endsWith('/dCompet'))).toBe(true);
  });

  it('tribISSQN fora do domínio permitido (1-4) é bloqueado', () => {
    const xml = validDps().replace('<tribISSQN>1</tribISSQN>', '<tribISSQN>9</tribISSQN>');
    const result = validateDpsStructure(xml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.endsWith('/tribISSQN'))).toBe(true);
  });

  it('remoção do grupo obrigatório <serv> é bloqueada', () => {
    const xml = validDps().replace(/<serv>[\s\S]*?<\/serv>/, '');
    const result = validateDpsStructure(xml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.endsWith('/serv'))).toBe(true);
  });

  it('remoção de xDescServ (obrigatório) é bloqueada', () => {
    const xml = validDps().replace(/<xDescServ>[^<]*<\/xDescServ>/, '');
    const result = validateDpsStructure(xml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.endsWith('/xDescServ'))).toBe(true);
  });

  it('múltiplos erros são todos reportados na mesma chamada (não para no primeiro)', () => {
    let xml = validDps();
    xml = xml.replace('<tpAmb>2</tpAmb>', '<tpAmb>9</tpAmb>');
    xml = xml.replace(/<xDescServ>[^<]*<\/xDescServ>/, '');
    const result = validateDpsStructure(xml);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * 🧪 Testes unitários - Provider Layer do módulo fiscal (PR3)
 *
 * Cobre só as peças que NÃO dependem de rede/certificado real: DpsBuilder (serialização XML),
 * FiscalProviderResolver (município-first + regra de migração de Anápolis), MockAdapter
 * (simulação de outcomes) e MockCertificateManager. SefinNacionalAdapter e
 * AnapolisMunicipalAdapter reais (com HTTP de verdade) ficam fora — não há certificado/endpoint
 * disponível para testar contra o ambiente real (ver comentários nos próprios arquivos).
 */

import { describe, it, expect } from 'vitest';
import { buildDpsXml, extractFieldsFromNfseResponseXml } from '../../fiscal-provider/DpsBuilder.js';
import { resolveProviderName } from '../../fiscal-provider/FiscalProviderResolver.js';
import { ANAPOLIS_IBGE_CODE } from '../../fiscal-provider/MunicipioProviderRegistry.js';
import { MockCertificateManager } from '../../fiscal-provider/CertificateManager.js';
import { MockAdapter } from '../../adapters/fiscal/MockAdapter.js';
import { AnapolisMunicipalAdapter } from '../../adapters/fiscal/AnapolisMunicipalAdapter.js';
import { FiscalProviderName } from '../../constants/fiscalProviders.js';
import { RegimeTributario } from '../../constants/fiscalEnums.js';

describe('DpsBuilder.buildDpsXml', () => {
  const snapshot = {
    infDPS: {
      tpAmb: 2,
      dCompet: new Date('2026-07-01'),
      prest: { cnpj: '12345678000199', xNome: 'Clínica Fono Inova', im: '123456' },
      toma: { nome: 'Paciente <Teste> & "Cia"', cpf: '11122233344' },
      serv: { cTribNac: '040803', xDescServ: 'Fonoaudiologia', cLocPrestacao: ANAPOLIS_IBGE_CODE },
      valores: { vServ: 180 }
    }
  };
  const fiscalInvoice = { dpsId: 'DPS520110800012345678000199000010000000001' };
  const fiscalProfile = { regimeTributario: RegimeTributario.SIMPLES_NACIONAL, municipioIBGE: ANAPOLIS_IBGE_CODE };

  it('produz XML bem formado com a raiz DPS/infDPS', () => {
    const xml = buildDpsXml(snapshot, fiscalInvoice, fiscalProfile);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<DPS versao="1.01">');
    expect(xml).toContain(`<infDPS id="${fiscalInvoice.dpsId}">`);
    expect(xml).toContain('<cTribNac>040803</cTribNac>');
    expect(xml).toContain('<vServ>180</vServ>');
  });

  it('escapa caracteres especiais do tomador (nunca gera XML quebrado)', () => {
    const xml = buildDpsXml(snapshot, fiscalInvoice, fiscalProfile);
    expect(xml).toContain('&lt;Teste&gt;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;Cia&quot;');
    expect(xml).not.toContain('<Teste>');
  });

  it('mapeia regimeTributario Simples Nacional para opSimpNac=3 (ME/EPP)', () => {
    const xml = buildDpsXml(snapshot, fiscalInvoice, fiscalProfile);
    expect(xml).toContain('<opSimpNac>3</opSimpNac>');
  });

  it('mapeia Lucro Presumido para opSimpNac=1 (Não Optante)', () => {
    const xml = buildDpsXml(snapshot, fiscalInvoice, { ...fiscalProfile, regimeTributario: RegimeTributario.LUCRO_PRESUMIDO });
    expect(xml).toContain('<opSimpNac>1</opSimpNac>');
  });
});

describe('DpsBuilder.extractFieldsFromNfseResponseXml', () => {
  it('extrai cStat, chave de acesso e nNFSe de uma resposta simulada', () => {
    const xml = '<NFSe><infNFSe id="ABC123XYZ"><cStat>100</cStat><nNFSe>42</nNFSe></infNFSe></NFSe>';
    const fields = extractFieldsFromNfseResponseXml(xml);
    expect(fields.cStat).toBe(100);
    expect(fields.chaveAcesso).toBe('ABC123XYZ');
    expect(fields.nNFSe).toBe(42);
  });

  it('retorna null para campos ausentes, sem lançar erro', () => {
    const fields = extractFieldsFromNfseResponseXml('<NFSe></NFSe>');
    expect(fields.cStat).toBeNull();
    expect(fields.chaveAcesso).toBeNull();
  });
});

describe('FiscalProviderResolver.resolveProviderName', () => {
  it('Anápolis + Lucro Presumido → webservice municipal, sempre', () => {
    const provider = resolveProviderName(
      { municipioIBGE: ANAPOLIS_IBGE_CODE, regimeTributario: RegimeTributario.LUCRO_PRESUMIDO },
      { asOfDate: new Date('2027-01-01') }
    );
    expect(provider).toBe(FiscalProviderName.ANAPOLIS_MUNICIPAL);
  });

  it('Anápolis + Simples Nacional, ANTES de 01/09/2026 → webservice municipal', () => {
    const provider = resolveProviderName(
      { municipioIBGE: ANAPOLIS_IBGE_CODE, regimeTributario: RegimeTributario.SIMPLES_NACIONAL },
      { asOfDate: new Date('2026-08-31') }
    );
    expect(provider).toBe(FiscalProviderName.ANAPOLIS_MUNICIPAL);
  });

  it('Anápolis + Simples Nacional, A PARTIR de 01/09/2026 → Sefin Nacional', () => {
    const provider = resolveProviderName(
      { municipioIBGE: ANAPOLIS_IBGE_CODE, regimeTributario: RegimeTributario.SIMPLES_NACIONAL },
      { asOfDate: new Date('2026-09-01') }
    );
    expect(provider).toBe(FiscalProviderName.SEFIN_NACIONAL);
  });

  it('município não catalogado → default Sefin Nacional', () => {
    const provider = resolveProviderName(
      { municipioIBGE: '9999999', regimeTributario: RegimeTributario.LUCRO_PRESUMIDO },
      { asOfDate: new Date() }
    );
    expect(provider).toBe(FiscalProviderName.SEFIN_NACIONAL);
  });
});

describe('MockAdapter', () => {
  it('submitDps com sucesso retorna cStat=100 e chave de acesso', async () => {
    const adapter = new MockAdapter();
    const result = await adapter.submitDps('<DPS/>');
    expect(result.success).toBe(true);
    expect(result.fields.cStat).toBe(100);
    expect(result.fields.chaveAcesso).toBeTruthy();
  });

  it('forceOutcome=rejected retorna success:false com errorCode', async () => {
    const adapter = new MockAdapter({ forceOutcome: 'rejected' });
    const result = await adapter.submitDps('<DPS/>');
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('E1301');
  });

  it('forceOutcome=timeout lança erro marcado isTimeout', async () => {
    const adapter = new MockAdapter({ forceOutcome: 'timeout' });
    await expect(adapter.submitDps('<DPS/>')).rejects.toMatchObject({ isTimeout: true });
  });

  it('forceOutcome=network_error lança erro marcado isNetworkError', async () => {
    const adapter = new MockAdapter({ forceOutcome: 'network_error' });
    await expect(adapter.submitDps('<DPS/>')).rejects.toMatchObject({ isNetworkError: true });
  });
});

describe('MockCertificateManager', () => {
  it('sign() anexa um marcador de mock, nunca uma assinatura real', async () => {
    const manager = new MockCertificateManager();
    const signed = await manager.sign('<DPS/>');
    expect(signed).toContain('<DPS/>');
    expect(signed).toContain('MOCK_SIGNATURE');
  });
});

describe('AnapolisMunicipalAdapter (stub)', () => {
  it('todos os métodos lançam erro explicando a lacuna, nunca simulam sucesso', async () => {
    const adapter = new AnapolisMunicipalAdapter();
    await expect(adapter.submitDps('<DPS/>')).rejects.toThrow('ANAPOLIS_ENDPOINT_DESCONHECIDO');
    await expect(adapter.queryByChave('x')).rejects.toThrow('ANAPOLIS_ENDPOINT_DESCONHECIDO');
    await expect(adapter.getDanfse('x')).rejects.toThrow('ANAPOLIS_ENDPOINT_DESCONHECIDO');
  });
});

/**
 * 🧪 TestFiscalConnectionService — extensão para diagnóstico municipal (item 7 da tarefa de
 * homologação de Anápolis). Nunca emite DPS: confirma isso estruturalmente (o serviço nem
 * importa AnapolisMunicipalAdapter, só o mapa ENDPOINTS exportado por ele) e comportamentalmente
 * (o request HTTP mockado é um GET simples, sem corpo SOAP).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../infrastructure/persistence/FiscalProfileRepository.js', () => ({
  fiscalProfileRepository: { findActiveByCnpj: vi.fn(), findFirstActive: vi.fn() }
}));
vi.mock('../../infrastructure/persistence/CertificateRepository.js', () => ({
  certificateRepository: { findById: vi.fn() }
}));
vi.mock('../../fiscal-provider/buildCertificateContext.js', () => ({
  buildCertificateContext: vi.fn()
}));
vi.mock('../../fiscal-provider/FiscalProviderResolver.js', () => ({
  resolveProviderName: vi.fn()
}));

import { fiscalProfileRepository } from '../../infrastructure/persistence/FiscalProfileRepository.js';
import { certificateRepository } from '../../infrastructure/persistence/CertificateRepository.js';
import { buildCertificateContext } from '../../fiscal-provider/buildCertificateContext.js';
import { resolveProviderName } from '../../fiscal-provider/FiscalProviderResolver.js';
import { FiscalProviderName } from '../../constants/fiscalProviders.js';
import { FiscalAmbiente } from '../../constants/fiscalEnums.js';

// Fake mínimo de node:https.request — resolve toda chamada com um 200 vazio, exceto quando o
// teste quer simular algo diferente via `nextResponse`.
let nextResponse = { statusCode: 200, chunks: [Buffer.from('ok')] };
let capturedRequests = [];
vi.mock('node:https', () => ({
  default: {
    request: vi.fn((options, callback) => {
      capturedRequests.push(options);
      const res = {
        statusCode: nextResponse.statusCode,
        on(event, handler) {
          if (event === 'data') nextResponse.chunks.forEach((c) => handler(c));
          if (event === 'end') handler();
          return res;
        }
      };
      callback(res);
      return {
        on: vi.fn(),
        end: vi.fn(),
        setTimeout: vi.fn()
      };
    })
  }
}));

const { testFiscalConnection } = await import('../../services/fiscal/TestFiscalConnectionService.js');

const fakeCertificate = { originalFilename: 'cert.pfx', issuer: 'ICP-Brasil', status: 'active', expiresAt: new Date(Date.now() + 1000 * 86400000) };

beforeEach(() => {
  vi.clearAllMocks();
  capturedRequests = [];
  nextResponse = { statusCode: 200, chunks: [Buffer.from('ok')] };
  buildCertificateContext.mockReturnValue({ httpsAgent: {} });
});

describe('testFiscalConnection — Sefin Nacional (regressão)', () => {
  it('continua resolvendo host/path da Sefin sem alteração', async () => {
    resolveProviderName.mockReturnValue(FiscalProviderName.SEFIN_NACIONAL);
    fiscalProfileRepository.findFirstActive.mockResolvedValue({ certificateRef: 'cert1', ambiente: FiscalAmbiente.PRODUCAO_RESTRITA });
    certificateRepository.findById.mockResolvedValue(fakeCertificate);

    const result = await testFiscalConnection();
    expect(result.ok).toBe(true);
    expect(result.providerName).toBe(FiscalProviderName.SEFIN_NACIONAL);
    expect(result.host).toBe('sefin.producaorestrita.nfse.gov.br');
  });
});

describe('testFiscalConnection — Anápolis municipal (item 7)', () => {
  it('não é mais "provider_not_supported" — resolve o host/path do .asmx de Anápolis', async () => {
    resolveProviderName.mockReturnValue(FiscalProviderName.ANAPOLIS_MUNICIPAL);
    fiscalProfileRepository.findFirstActive.mockResolvedValue({ certificateRef: 'cert1', ambiente: FiscalAmbiente.PRODUCAO_RESTRITA });
    certificateRepository.findById.mockResolvedValue(fakeCertificate);

    const result = await testFiscalConnection();
    expect(result.step).not.toBe('provider_not_supported');
    expect(result.host).toBe('nfse.issnetonline.com.br');
    expect(result.path).toBe('/wsnfsenacional/homologacao/nfse.asmx');
    expect(result.ambiente).toBe(FiscalAmbiente.PRODUCAO_RESTRITA);
  });

  it('usa o endpoint de produção quando o perfil está em produção', async () => {
    resolveProviderName.mockReturnValue(FiscalProviderName.ANAPOLIS_MUNICIPAL);
    fiscalProfileRepository.findFirstActive.mockResolvedValue({ certificateRef: 'cert1', ambiente: FiscalAmbiente.PRODUCAO });
    certificateRepository.findById.mockResolvedValue(fakeCertificate);

    const result = await testFiscalConnection();
    expect(result.path).toBe('/wsnfsenacional/anapolis/nfse.asmx');
  });

  it('nunca envia corpo SOAP nem chama uma operação — é sempre um GET simples', async () => {
    resolveProviderName.mockReturnValue(FiscalProviderName.ANAPOLIS_MUNICIPAL);
    fiscalProfileRepository.findFirstActive.mockResolvedValue({ certificateRef: 'cert1', ambiente: FiscalAmbiente.PRODUCAO_RESTRITA });
    certificateRepository.findById.mockResolvedValue(fakeCertificate);

    await testFiscalConnection();
    const soapRequests = capturedRequests.filter((r) => r.method !== 'GET' || r.headers?.SOAPAction);
    expect(soapRequests).toEqual([]);
    expect(capturedRequests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('403/ACCESS_DENIED (achado real desta auditoria, causa não determinada) não é tratado como falha de handshake TLS', async () => {
    resolveProviderName.mockReturnValue(FiscalProviderName.ANAPOLIS_MUNICIPAL);
    fiscalProfileRepository.findFirstActive.mockResolvedValue({ certificateRef: 'cert1', ambiente: FiscalAmbiente.PRODUCAO_RESTRITA });
    certificateRepository.findById.mockResolvedValue(fakeCertificate);
    nextResponse = { statusCode: 403, chunks: [Buffer.from('Forbidden')] };

    const result = await testFiscalConnection();
    expect(result.tls).toBe(true);
    expect(result.httpStatus).toBe(403);
    expect(result.step).toBe('application_response');
  });

  it('sem certificado vinculado: reporta o passo certo, nunca tenta conectar', async () => {
    resolveProviderName.mockReturnValue(FiscalProviderName.ANAPOLIS_MUNICIPAL);
    fiscalProfileRepository.findFirstActive.mockResolvedValue({ certificateRef: null });

    const result = await testFiscalConnection();
    expect(result.ok).toBe(false);
    expect(result.step).toBe('certificate_lookup');
    expect(capturedRequests).toEqual([]);
  });
});

describe('testFiscalConnection — provider não suportado permanece explícito', () => {
  it('mock/outro provider continua devolvendo provider_not_supported', async () => {
    resolveProviderName.mockReturnValue(FiscalProviderName.MOCK);
    fiscalProfileRepository.findFirstActive.mockResolvedValue({ certificateRef: 'cert1' });
    certificateRepository.findById.mockResolvedValue(fakeCertificate);

    const result = await testFiscalConnection();
    expect(result.step).toBe('provider_not_supported');
    expect(capturedRequests).toEqual([]);
  });
});

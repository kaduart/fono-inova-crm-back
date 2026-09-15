/**
 * 🧪 reconcileSubmission (_attemptSubmission.js) — prova que a identidade (CNPJ/IM) usada na
 * consulta de reconciliação vem do FiscalSnapshot IMUTÁVEL da tentativa original, nunca do
 * FiscalProfile atual (que pode ter mudado desde então). Item 4 do fechamento da etapa municipal
 * de Anápolis (2026-09-11).
 *
 * Mocka a classe do adapter inteira (não só reconcileDps) porque é a única forma de capturar
 * exatamente o que services/fiscal/_attemptSubmission.js realmente passa para
 * `new AnapolisMunicipalAdapter(...)` e depois para `.reconcileDps(...)` — os testes de
 * integração fiscais usam `overrideAdapter` e nunca exercitam este caminho de verdade.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../infrastructure/persistence/FiscalProfileRepository.js', () => ({
  fiscalProfileRepository: { findById: vi.fn() }
}));
vi.mock('../../infrastructure/persistence/CertificateRepository.js', () => ({
  certificateRepository: { findById: vi.fn() }
}));
vi.mock('../../infrastructure/persistence/FiscalSnapshotRepository.js', () => ({
  fiscalSnapshotRepository: { findByFiscalSubmission: vi.fn() }
}));
vi.mock('../../fiscal-provider/buildCertificateContext.js', () => ({
  buildCertificateContext: vi.fn(() => ({ httpsAgent: {}, certManager: null }))
}));

const reconcileDpsSpy = vi.fn().mockResolvedValue({ status: 'unknown', reason: 'TESTE' });
vi.mock('../../adapters/fiscal/AnapolisMunicipalAdapter.js', () => ({
  AnapolisMunicipalAdapter: vi.fn().mockImplementation(function AnapolisMunicipalAdapterFake(config) {
    this.config = config;
    this.reconcileDps = reconcileDpsSpy;
  })
}));
vi.mock('../../adapters/fiscal/SefinNacionalAdapter.js', () => ({ SefinNacionalAdapter: vi.fn() }));
vi.mock('../../adapters/fiscal/MockAdapter.js', () => ({ MockAdapter: vi.fn() }));

import { fiscalProfileRepository } from '../../infrastructure/persistence/FiscalProfileRepository.js';
import { certificateRepository } from '../../infrastructure/persistence/CertificateRepository.js';
import { fiscalSnapshotRepository } from '../../infrastructure/persistence/FiscalSnapshotRepository.js';
import { reconcileSubmission } from '../../services/fiscal/_attemptSubmission.js';
import { FiscalProviderName } from '../../constants/fiscalProviders.js';

const fiscalInvoice = { _id: 'inv1', fiscalProfileId: 'profile1', dpsId: 'dps1', nDPS: 42, serie: 1 };
const submission = { _id: 'sub1', providerSnapshot: FiscalProviderName.ANAPOLIS_MUNICIPAL };

beforeEach(() => {
  vi.clearAllMocks();
  reconcileDpsSpy.mockResolvedValue({ status: 'unknown', reason: 'TESTE' });
  certificateRepository.findById.mockResolvedValue(null);
});

describe('reconcileSubmission — identidade vem do snapshot, não do perfil atual', () => {
  it('usa CNPJ/IM do FiscalSnapshot da tentativa original, mesmo diferentes do FiscalProfile atual', async () => {
    fiscalProfileRepository.findById.mockResolvedValue({
      _id: 'profile1', ambiente: 'producao_restrita',
      // Perfil ATUAL — deliberadamente diferente do snapshot, para provar que não é isto que é usado.
      cnpj: '99999999000199', inscricaoMunicipal: '999999'
    });
    fiscalSnapshotRepository.findByFiscalSubmission.mockResolvedValue({
      json: { infDPS: { prest: { cnpj: '11111111000191', im: '111111' } } }
    });

    await reconcileSubmission(fiscalInvoice, submission);

    expect(fiscalSnapshotRepository.findByFiscalSubmission).toHaveBeenCalledWith('sub1');
    expect(reconcileDpsSpy).toHaveBeenCalledWith(expect.objectContaining({
      cnpj: '11111111000191',
      inscricaoMunicipal: '111111'
    }));
  });

  it('sem snapshot localizável: nunca chama o adapter, devolve unknown explicando o motivo', async () => {
    fiscalProfileRepository.findById.mockResolvedValue({ _id: 'profile1', cnpj: '99999999000199', inscricaoMunicipal: '999999' });
    fiscalSnapshotRepository.findByFiscalSubmission.mockResolvedValue(null);

    const result = await reconcileSubmission(fiscalInvoice, submission);

    expect(result).toMatchObject({ status: 'unknown', reason: 'FISCAL_SNAPSHOT_SEM_IDENTIDADE_PRESTADOR' });
    expect(reconcileDpsSpy).not.toHaveBeenCalled();
    // Nem chega a buscar o FiscalProfile/certificado — falha antes, não usa dado atual como fallback silencioso.
    expect(fiscalProfileRepository.findById).not.toHaveBeenCalled();
  });

  it('snapshot existe mas sem prest.cnpj/prest.im: mesmo tratamento — unknown, sem chamar o adapter', async () => {
    fiscalSnapshotRepository.findByFiscalSubmission.mockResolvedValue({ json: { infDPS: { prest: {} } } });

    const result = await reconcileSubmission(fiscalInvoice, submission);

    expect(result).toMatchObject({ status: 'unknown', reason: 'FISCAL_SNAPSHOT_SEM_IDENTIDADE_PRESTADOR' });
    expect(reconcileDpsSpy).not.toHaveBeenCalled();
  });

  it('com overrideAdapter (uso em teste), ausência de snapshot não bloqueia — mas não inventa identidade', async () => {
    fiscalSnapshotRepository.findByFiscalSubmission.mockResolvedValue(null);
    const override = { reconcileDps: vi.fn().mockResolvedValue({ status: 'unknown', reason: 'x' }) };

    await reconcileSubmission(fiscalInvoice, submission, { overrideAdapter: override });

    expect(override.reconcileDps).toHaveBeenCalledWith(expect.objectContaining({
      cnpj: undefined,
      inscricaoMunicipal: undefined
    }));
  });
});

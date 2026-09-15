/**
 * 🧪 Teste de integração - Fluxo completo de emissão fiscal (PR2+PR3+PR4)
 *
 * Cobre o que ficou pendente desde o PR2: FiscalInvoiceService/IssueFiscalInvoiceService/
 * RetryFiscalSubmissionService fim-a-fim contra um MongoDB real.
 *
 * 2026-09-11: passou a usar MongoMemoryReplSet (mesmo padrão já estabelecido em
 * tests/e2e/*.e2e.test.js) em vez de conectar em MONGO_URI/.env — nunca mais lê nenhuma
 * connection string externa. Réplica (não standalone) porque o domínio fiscal usa
 * runTransactionWithRetry (sessões/transações Mongo). `assertLoopbackOnlyDatabase` continua como
 * defesa em profundidade sobre a URI que o próprio MongoMemoryReplSet devolve — ver
 * docs/nfse-fiscal-module/anapolis_audit_2026-09-11.md para o incidente que motivou isso.
 *
 * Usa MockAdapter via `overrideAdapter` — nunca chama a Sefin Nacional nem o endpoint de Anápolis.
 */

import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import Patient from '../../models/Patient.js';
import Doctor from '../../models/Doctor.js';
import Payment from '../../models/Payment.js';
import FiscalProfile from '../../models/FiscalProfile.js';
import Certificate from '../../models/Certificate.js';

import { issueFiscalInvoiceService } from '../../services/fiscal/IssueFiscalInvoiceService.js';
import { retryFiscalSubmissionService } from '../../services/fiscal/RetryFiscalSubmissionService.js';
import { MockAdapter } from '../../adapters/fiscal/MockAdapter.js';
import { FiscalInvoiceStatus, CertificateStatus, RegimeTributario } from '../../constants/fiscalEnums.js';
import { FiscalOriginType } from '../../constants/fiscalEnums.js';
import { assertLoopbackOnlyDatabase } from './_guardAgainstProductionDb.js';

const TEST_CNPJ = '00000000000191';

let mongoServer;
let patient, doctor, certificate, fiscalProfile;

async function createPaidPayment(appointmentId) {
  return Payment.create({
    patient: patient._id,
    doctor: doctor._id,
    appointment: appointmentId,
    amount: 180,
    paymentDate: new Date(),
    paidAt: new Date(),
    paymentMethod: 'pix',
    status: 'paid',
    kind: 'session_payment'
  });
}

function draftFor(appointmentId) {
  return {
    fiscalProfileId: fiscalProfile._id,
    origin: { type: FiscalOriginType.APPOINTMENT, id: appointmentId },
    patient: patient._id,
    professional: doctor._id,
    serviceDescription: 'Prestação de serviços de Fonoaudiologia',
    serviceCode: '040803',
    valorServico: 180,
    valorLiquido: 180,
    dCompet: new Date()
  };
}

describe('Fluxo fiscal completo (Issue → Authorize / Reject / Retry)', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = mongoServer.getUri();
    assertLoopbackOnlyDatabase(uri);
    await mongoose.connect(uri);

    patient = await Patient.create({
      fullName: 'Paciente Teste Fiscal',
      dateOfBirth: new Date('1990-01-01'),
      phone: '11999999999',
      cpf: '11122233344',
      email: `fiscal.${Date.now()}@teste.com`
    });

    doctor = await Doctor.create({
      fullName: 'Doutor Teste Fiscal',
      email: `doctor.fiscal.${Date.now()}@teste.com`,
      specialty: 'fonoaudiologia',
      licenseNumber: `CRFA-${Date.now()}`,
      phoneNumber: '11988888888'
    });

    certificate = await Certificate.create({
      type: 'A1',
      passwordReference: 'secret-manager://test/fake',
      expiresAt: new Date(Date.now() + 365 * 86400000),
      status: CertificateStatus.ACTIVE
    });

    fiscalProfile = await FiscalProfile.create({
      cnpj: TEST_CNPJ,
      razaoSocial: 'Clínica Fono Inova LTDA (teste)',
      municipioIBGE: '5201108',
      cnae: '8650-0/03',
      codigoServicoLC116: '040803',
      inscricaoMunicipal: '123456',
      regimeTributario: RegimeTributario.LUCRO_PRESUMIDO,
      certificateRef: certificate._id,
      ativo: true
    });
  });

  afterAll(async () => {
    // Banco efêmero exclusivo deste teste (MongoMemoryReplSet) — parar o servidor descarta tudo
    // de uma vez, sem precisar de deleteMany({}) nenhum, com filtro ou sem. Nada aqui é
    // compartilhado com nenhum outro teste nem com produção.
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  });

  it('emissão feliz: DRAFT → PENDING_SUBMISSION → AUTHORIZED', async () => {
    const appointmentId = new mongoose.Types.ObjectId();
    await createPaidPayment(appointmentId);

    const { fiscalInvoice, outcome } = await issueFiscalInvoiceService.issue(draftFor(appointmentId), {
      overrideAdapter: new MockAdapter({ forceOutcome: 'success' })
    });

    expect(outcome).toBe('authorized');
    expect(fiscalInvoice.status).toBe(FiscalInvoiceStatus.AUTHORIZED);
    expect(fiscalInvoice.chaveAcesso).toBeTruthy();
    expect(fiscalInvoice.cStat).toBe(100);
  });

  it('rejeição de negócio: PENDING_SUBMISSION → REJECTED (terminal)', async () => {
    const appointmentId = new mongoose.Types.ObjectId();
    await createPaidPayment(appointmentId);

    const { fiscalInvoice, outcome } = await issueFiscalInvoiceService.issue(draftFor(appointmentId), {
      overrideAdapter: new MockAdapter({ forceOutcome: 'rejected' })
    });

    expect(outcome).toBe('rejected');
    expect(fiscalInvoice.status).toBe(FiscalInvoiceStatus.REJECTED);
    expect(fiscalInvoice.rejectionReason).toBeTruthy();
  });

  it('timeout mantém PENDING_SUBMISSION e retry exige reconciliação sem reenviar', async () => {
    const appointmentId = new mongoose.Types.ObjectId();
    await createPaidPayment(appointmentId);

    const first = await issueFiscalInvoiceService.issue(draftFor(appointmentId), {
      overrideAdapter: new MockAdapter({ forceOutcome: 'timeout' })
    });

    expect(first.outcome).toBe('timeout');
    expect(first.fiscalInvoice.status).toBe(FiscalInvoiceStatus.PENDING_SUBMISSION);

    const retried = await retryFiscalSubmissionService.retry(first.fiscalInvoice._id, {
      overrideAdapter: new MockAdapter({ forceOutcome: 'success' })
    });

    expect(retried.outcome).toBe('reconciliation_required');
    expect(retried.fiscalInvoice.status).toBe(FiscalInvoiceStatus.PENDING_SUBMISSION);
  });

  it('rejeita emissão duplicada para a mesma origem (idempotência de negócio)', async () => {
    const appointmentId = new mongoose.Types.ObjectId();
    await createPaidPayment(appointmentId);

    const { fiscalInvoice } = await issueFiscalInvoiceService.issue(draftFor(appointmentId), {
      overrideAdapter: new MockAdapter({ forceOutcome: 'success' })
    });

    await expect(
      issueFiscalInvoiceService.issue(draftFor(appointmentId), { overrideAdapter: new MockAdapter() })
    ).rejects.toThrow('FISCAL_INVOICE_NOT_ELIGIBLE');
  });

  it('retry rejeita se a FiscalInvoice não estiver PENDING_SUBMISSION', async () => {
    const appointmentId = new mongoose.Types.ObjectId();
    await createPaidPayment(appointmentId);

    const { fiscalInvoice } = await issueFiscalInvoiceService.issue(draftFor(appointmentId), {
      overrideAdapter: new MockAdapter({ forceOutcome: 'success' })
    });

    await expect(retryFiscalSubmissionService.retry(fiscalInvoice._id)).rejects.toThrow('FISCAL_INVOICE_STATUS_INVALIDO_PARA_RETRY');
  });
});

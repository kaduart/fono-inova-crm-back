/**
 * 🧪 Teste de integração dos controllers fiscais — valida contratos JSON dos endpoints MVP.
 *
 * Não sobe servidor HTTP. Cada controller é chamado diretamente com objetos req/res simulados,
 * o que valida: status HTTP, shape da resposta (success/data ou success/error/message) e conteúdo.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import Patient from '../../models/Patient.js';
import Doctor from '../../models/Doctor.js';
import Payment from '../../models/Payment.js';
import FiscalProfile from '../../models/FiscalProfile.js';
import Certificate from '../../models/Certificate.js';
import FiscalInvoice from '../../models/FiscalInvoice.js';
import FiscalSubmission from '../../models/FiscalSubmission.js';
import FiscalSnapshot from '../../models/FiscalSnapshot.js';
import ProviderTransaction from '../../models/ProviderTransaction.js';
import OfficialFiscalEvent from '../../models/OfficialFiscalEvent.js';
import FiscalAttachment from '../../models/FiscalAttachment.js';

import {
  getFiscalProfile,
  upsertFiscalProfile,
  createCertificate,
  listCertificates,
  emitFiscalInvoice,
  listFiscalInvoices,
  getFiscalInvoice,
  retryFiscalInvoice,
  cancelFiscalInvoice,
  downloadFiscalInvoiceXml,
  downloadFiscalInvoicePdf
} from '../../controllers/fiscalController.js';

import { FiscalProviderName } from '../../constants/fiscalProviders.js';
import { FiscalInvoiceStatus, CertificateStatus, RegimeTributario } from '../../constants/fiscalEnums.js';
import { FiscalOriginType } from '../../constants/fiscalEnums.js';
import * as MunicipioProviderRegistry from '../../fiscal-provider/MunicipioProviderRegistry.js';

const TEST_CNPJ = '00000000000191';

const TEST_DB = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.TEST_MONGO_URI;

let patient, doctor, certificate, fiscalProfile, payment, emittedInvoiceId;
let originalRegistry;

function createRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(key, value) { this.headers[key] = value; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; }
  };
  return res;
}

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

describe('Contratos JSON dos endpoints fiscais (MVP)', () => {
  beforeAll(async () => {
    if (!TEST_DB) throw new Error('MONGO_URI não configurado');
    await mongoose.connect(TEST_DB);

    // Força o MockAdapter para Anápolis durante os testes de controller — sem endpoint real nem
    // certificado, o adapter AnapolisMunicipalAdapter falharia em network_error. Isso não altera
    // regra de negócio, apenas simula um provider funcional para validar os contratos JSON.
    originalRegistry = { ...MunicipioProviderRegistry.MUNICIPIO_PROVIDER_REGISTRY };
    MunicipioProviderRegistry.MUNICIPIO_PROVIDER_REGISTRY[MunicipioProviderRegistry.ANAPOLIS_IBGE_CODE] = FiscalProviderName.MOCK;

    patient = await Patient.create({
      fullName: 'Paciente Fiscal Controller',
      dateOfBirth: new Date('1990-01-01'),
      phone: '11999999999',
      email: `fiscal-controller.${Date.now()}@teste.com`
    });

    doctor = await Doctor.create({
      fullName: 'Doutor Fiscal Controller',
      email: `doctor.fiscal-controller.${Date.now()}@teste.com`,
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
      razaoSocial: 'Clínica Fono Inova LTDA',
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
    await FiscalAttachment.deleteMany({});
    await OfficialFiscalEvent.deleteMany({});
    await ProviderTransaction.deleteMany({});
    await FiscalSnapshot.deleteMany({});
    await FiscalSubmission.deleteMany({});
    await FiscalInvoice.deleteMany({});
    await FiscalProfile.deleteOne({ _id: fiscalProfile?._id });
    await Certificate.deleteOne({ _id: certificate?._id });
    await Payment.deleteMany({ patient: patient?._id });
    await Doctor.deleteOne({ _id: doctor?._id });
    await Patient.deleteOne({ _id: patient?._id });
    await mongoose.disconnect();
  });

  it('GET /profile retorna success/data ou 404 padronizado', async () => {
    const req = { query: { cnpj: TEST_CNPJ } };
    const res = createRes();
    await getFiscalProfile(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.cnpj).toBe(TEST_CNPJ);
  });

  it('POST /profile retorna success/data', async () => {
    const req = {
      body: {
        cnpj: TEST_CNPJ,
        razaoSocial: 'Clínica Fono Inova LTDA (atualizado)',
        municipioIBGE: '5201108',
        cnae: '8650-0/03',
        codigoServicoLC116: '040803',
        inscricaoMunicipal: '123456',
        regimeTributario: RegimeTributario.LUCRO_PRESUMIDO,
        certificateRef: certificate._id
      }
    };
    const res = createRes();
    await upsertFiscalProfile(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.razaoSocial).toContain('atualizado');
  });

  it('POST /certificates retorna success/data', async () => {
    const req = {
      body: {
        type: 'A1',
        passwordReference: 'secret-manager://test/fake2',
        expiresAt: new Date(Date.now() + 365 * 86400000),
        status: CertificateStatus.ACTIVE
      }
    };
    const res = createRes();
    await createCertificate(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data._id).toBeDefined();
  });

  it('POST /nfse/emit retorna success/data com fiscalInvoice e outcome', async () => {
    const appointmentId = new mongoose.Types.ObjectId();
    payment = await createPaidPayment(appointmentId);

    const req = {
      body: {
        fiscalProfileId: fiscalProfile._id.toString(),
        origin: { type: FiscalOriginType.APPOINTMENT, id: appointmentId.toString() },
        patient: patient._id.toString(),
        professional: doctor._id.toString(),
        serviceDescription: 'Prestação de serviços de Fonoaudiologia',
        serviceCode: '040803',
        valorServico: 180,
        valorLiquido: 180,
        vISSQN: 0,
        dCompet: new Date()
      },
      headers: {}
    };
    const res = createRes();
    await emitFiscalInvoice(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.fiscalInvoice).toBeDefined();
    expect(res.body.data.outcome).toBe('authorized');
    expect(res.body.data.fiscalInvoice.status).toBe(FiscalInvoiceStatus.AUTHORIZED);

    emittedInvoiceId = res.body.data.fiscalInvoice._id;
  });

  it('GET /nfse retorna success/data com paginação', async () => {
    const req = { query: { limit: 10, page: 1 } };
    const res = createRes();
    await listFiscalInvoices(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();
  });

  it('GET /nfse/:id retorna success/data', async () => {
    const req = { params: { id: emittedInvoiceId } };
    const res = createRes();
    await getFiscalInvoice(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data._id.toString()).toBe(emittedInvoiceId.toString());
  });

  it('GET /nfse/:id/xml retorna XML', async () => {
    const req = { params: { id: emittedInvoiceId } };
    const res = createRes();
    await downloadFiscalInvoiceXml(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/xml');
    expect(typeof res.body).toBe('string');
  });

  it('GET /nfse/:id/pdf retorna PDF (mock)', async () => {
    const req = { params: { id: emittedInvoiceId } };
    const res = createRes();
    await downloadFiscalInvoicePdf(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/pdf');
    expect(Buffer.isBuffer(res.body)).toBe(true);
  });

  it('POST /nfse/:id/cancel retorna success/data', async () => {
    const req = { params: { fiscalInvoiceId: emittedInvoiceId.toString() }, headers: {} };
    const res = createRes();
    await cancelFiscalInvoice(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
  });

  it('POST /nfse/:id/retry rejeia nota não-pendente com erro consistente', async () => {
    const req = { params: { fiscalInvoiceId: emittedInvoiceId.toString() }, headers: {} };
    const res = createRes();
    await retryFiscalInvoice(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('INTERNAL_ERROR');
    expect(res.body.message).toContain('FISCAL_INVOICE_STATUS_INVALIDO_PARA_RETRY');
  });
});

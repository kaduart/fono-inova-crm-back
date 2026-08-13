/**
 * 🧪 Contrato de SCHEMA dos documentos criados pela transferência
 *
 * Por que existe: a suíte principal (transferPackageCredit.test.js) mocka os
 * models para rodar sem banco — e mock não valida enum. Resultado: o command
 * passou 50 testes e quebrou no primeiro clique em produção, porque eu inventei
 * `paymentMethod: 'transferencia_pacote'`, valor que não existe no enum de
 * Appointment nem de Session.
 *
 * Aqui usamos os models REAIS e `validateSync()`, que roda offline, sem
 * conexão. Se algum valor sair do enum, este teste falha antes do deploy.
 *
 * ⚠️ Local e produção compartilham o mesmo MongoDB neste projeto. Nada aqui
 * conecta: validateSync é puramente em memória.
 */

import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';

// Guard: nenhuma credencial real deve estar carregada.
for (const key of ['MONGO_URI', 'MONGODB_URI', 'MONGO_URL', 'DATABASE_URL']) {
  if (process.env[key] && /mongodb\+srv|\.mongodb\.net|prod/i.test(process.env[key])) {
    throw new Error(`🚫 ABORTADO: ${key} aponta para infraestrutura real.`);
  }
  delete process.env[key];
}

const Appointment = (await import('../../models/Appointment.js')).default;
const Session = (await import('../../models/Session.js')).default;
const Package = (await import('../../models/Package.js')).default;
const PackageCreditTransfer = (await import('../../models/PackageCreditTransfer.js')).default;

const oid = () => new mongoose.Types.ObjectId();

/** Espelha o documento que transferPackageCreditCommand cria para o destino. */
function targetPackageDoc() {
  return {
    patient: oid(),
    doctor: oid(),
    specialty: 'psicologia',
    sessionType: 'psicologia',
    type: 'therapy',
    model: 'prepaid',
    paymentType: 'full',
    sessionValue: 180,
    totalSessions: 4,
    totalValue: 720,
    totalPaid: 720,
    fundedByTransfer: 720,
    date: new Date(),
    durationMonths: 2,
    sessionsPerWeek: 1,
    frequencyInterval: 'weekly',
    status: 'active',
    notes: 'Financiado por transferência',
  };
}

function targetAppointmentDoc() {
  return {
    patient: oid(),
    doctor: oid(),
    date: new Date(),
    time: '14:40',
    duration: 40,
    specialty: 'psicologia',
    package: oid(),
    serviceType: 'package_session',
    operationalStatus: 'scheduled',
    clinicalStatus: 'pending',
    paymentStatus: 'package_paid',
    isPaid: true,
    visualFlag: 'ok',
    paymentOrigin: 'package_prepaid',
    paymentMethod: null,
    billingType: 'particular',
    sessionValue: 180,
    isFirstAppointment: true,
    transferId: oid(),
    sourceAppointmentId: oid(),
  };
}

function targetSessionDoc() {
  return {
    date: new Date(),
    time: '14:40',
    patient: oid(),
    doctor: oid(),
    package: oid(),
    appointmentId: oid(),
    sessionValue: 180,
    sessionType: 'psicologia',
    specialty: 'psicologia',
    status: 'scheduled',
    isPaid: true,
    paymentStatus: 'package_paid',
    paymentOrigin: 'package_prepaid',
    visualFlag: 'ok',
    transferId: oid(),
  };
}

/** Carimbo aplicado às sessões de ORIGEM convertidas. */
function sourceStampDoc() {
  return {
    patient: oid(),
    doctor: oid(),
    date: new Date(),
    time: '16:00',
    specialty: 'fonoaudiologia',
    operationalStatus: 'canceled',
    cancelSource: 'converted_to_package',
    missed: false,
    confirmedAbsence: false,
    transferId: oid(),
    transferredToPackage: oid(),
    targetAppointmentId: oid(),
  };
}

function errorsOf(doc) {
  const err = doc.validateSync();
  if (!err) return [];
  return Object.values(err.errors).map(e => `${e.path}: ${e.message}`);
}

describe('documentos criados pela transferência passam pelos schemas reais', () => {
  it('pacote de destino é válido', () => {
    expect(errorsOf(new Package(targetPackageDoc()))).toEqual([]);
  });

  it('appointment de destino é válido (inclusive paymentMethod)', () => {
    expect(errorsOf(new Appointment(targetAppointmentDoc()))).toEqual([]);
  });

  it('session de destino é válida', () => {
    expect(errorsOf(new Session(targetSessionDoc()))).toEqual([]);
  });

  it('carimbo da sessão de origem é válido', () => {
    expect(errorsOf(new Appointment(sourceStampDoc()))).toEqual([]);
  });

  it('registro de transferência é válido', () => {
    const doc = new PackageCreditTransfer({
      sourcePackageId: oid(),
      targetPackageId: oid(),
      patientId: oid(),
      sessionCount: 4,
      unitValue: 180,
      amount: 720,
      reason: 'Mudança terapêutica',
      status: 'completed',
      idempotencyKey: 'k1',
    });
    expect(errorsOf(doc)).toEqual([]);
  });
});

describe('valores de enum usados pelo command existem de fato', () => {
  const enumOf = (model, path) => model.schema.path(path)?.enumValues || [];

  it("'converted_to_package' está no enum de cancelSource", () => {
    expect(enumOf(Appointment, 'cancelSource')).toContain('converted_to_package');
  });

  it("'canceled' é o valor canônico de operationalStatus (não 'cancelled')", () => {
    const values = enumOf(Appointment, 'operationalStatus');
    expect(values).toContain('canceled');
    expect(values).not.toContain('cancelled');
  });

  it('o command não inventa paymentMethod fora do enum', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      resolve(here, '../../services/billing/commands/transferPackageCreditCommand.js'), 'utf8'
    );

    const allowed = new Set([
      ...enumOf(Appointment, 'paymentMethod'),
      ...enumOf(Session, 'paymentMethod'),
    ].filter(Boolean).map(String));

    const used = [...src.matchAll(/paymentMethod:\s*'([^']+)'/g)].map(m => m[1]);
    for (const value of used) {
      expect(allowed.has(value), `paymentMethod '${value}' não existe no enum`).toBe(true);
    }
  });
});

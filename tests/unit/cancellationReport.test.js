/**
 * Relatório de cancelamentos por solicitante — regras puras (sem banco).
 * Cobre: validação do solicitante, antecedência, separação de falta/automático,
 * percentuais, taxa por profissional/paciente e distinção "pedido pelo
 * profissional" × "pedido por pacientes da agenda dele".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { parseCancelRequester, setLegacyGraceUntilForTests } from '../../domain/appointment/cancelRequester.js';
import {
  hoursInAdvance,
  buildCancellationReport,
  buildCancellationDetails,
  isReportableCancel,
  bucketOf,
} from '../../services/analytics/cancellationReport.service.js';

// Atendimento 2026-09-10 10:00 (America/Sao_Paulo, UTC-3) = 13:00Z. `date` é guardado UTC 12:00.
const doctorA = { _id: 'dA', fullName: 'Dra. Ana', specialty: 'fonoaudiologia' };
const doctorB = { _id: 'dB', fullName: 'Dr. Bruno', specialty: 'psicologia' };
const pat1 = { _id: 'p1', fullName: 'Paciente Um' };
const pat2 = { _id: 'p2', fullName: 'Paciente Dois' };

let seq = 0;
const row = (over = {}) => ({
  _id: `a${++seq}`,
  date: new Date('2026-09-10T12:00:00.000Z'),
  time: '10:00',
  doctor: doctorA,
  patient: pat1,
  specialty: 'fonoaudiologia',
  operationalStatus: 'canceled',
  confirmedAbsence: false,
  cancelReason: 'motivo',
  canceledAt: new Date('2026-09-08T13:00:00.000Z'), // 48h antes
  ...over,
});

describe('parseCancelRequester', () => {
  const GRACE_ORIGINAL = new Date('2026-11-30T23:59:59-03:00');
  afterEach(() => setLegacyGraceUntilForTests(GRACE_ORIGINAL));

  it('transição: tela antiga sem solicitante é aceita e marcada como legacy_client', () => {
    setLegacyGraceUntilForTests(new Date(Date.now() + 3600_000));
    expect(parseCancelRequester({})).toEqual({ cancelRequester: null, cancelRequestedAt: null, cancelChannel: 'legacy_client' });
  });

  it('exige o solicitante por padrão (após a transição)', () => {
    setLegacyGraceUntilForTests(new Date(0));
    expect(() => parseCancelRequester({})).toThrow(/quem solicitou/i);
    try { parseCancelRequester({}); } catch (e) {
      expect(e.code).toBe('MISSING_CANCEL_REQUESTER');
      expect(e.status).toBe(400);
    }
  });

  it('rejeita valor fora do enum', () => {
    try { parseCancelRequester({ cancelRequester: 'vizinho' }); throw new Error('não lançou'); }
    catch (e) { expect(e.code).toBe('INVALID_CANCEL_REQUESTER'); }
  });

  it.each(['patient', 'professional', 'clinic'])('aceita %s', (v) => {
    expect(parseCancelRequester({ cancelRequester: v })).toEqual({ cancelRequester: v, cancelRequestedAt: null });
  });

  it('opcional quando required=false → "Não informado" (null)', () => {
    expect(parseCancelRequester({}, { required: false })).toEqual({ cancelRequester: null, cancelRequestedAt: null });
  });

  it('aceita cancelRequestedAt válido e rejeita futuro/inválido', () => {
    const ok = parseCancelRequester({ cancelRequester: 'patient', cancelRequestedAt: '2026-09-08T10:00:00Z' });
    expect(ok.cancelRequestedAt.toISOString()).toBe('2026-09-08T10:00:00.000Z');
    expect(() => parseCancelRequester({ cancelRequester: 'patient', cancelRequestedAt: 'xx' })).toThrow();
    const future = new Date(Date.now() + 86400000).toISOString();
    expect(() => parseCancelRequester({ cancelRequester: 'patient', cancelRequestedAt: future })).toThrow(/futuro/);
  });
});

describe('hoursInAdvance', () => {
  it('usa cancelRequestedAt quando existe (horário do pedido, não do registro)', () => {
    const r = row({
      cancelRequestedAt: new Date('2026-09-09T13:00:00.000Z'), // 24h antes
      canceledAt: new Date('2026-09-10T12:00:00.000Z'),        // registrado 1h antes
    });
    expect(hoursInAdvance(r)).toBe(24);
  });

  it('cai para canceledAt quando não há cancelRequestedAt', () => {
    expect(hoursInAdvance(row())).toBe(48);
  });

  it('negativo quando o pedido veio depois do horário; null sem data de registro', () => {
    expect(hoursInAdvance(row({ canceledAt: new Date('2026-09-10T15:00:00.000Z') }))).toBe(-2);
    expect(hoursInAdvance(row({ canceledAt: null }))).toBeNull();
  });
});

describe('classificação', () => {
  it('automático, falta (no-show) e agendamento ativo ficam FORA do cancelamento', () => {
    expect(isReportableCancel(row({ cancelSource: 'guide_closure' }))).toBe(false);
    expect(isReportableCancel(row({ cancelSource: 'converted_to_package' }))).toBe(false);
    expect(isReportableCancel(row({ operationalStatus: 'missed' }))).toBe(false);
    expect(isReportableCancel(row({ operationalStatus: 'scheduled' }))).toBe(false);
    expect(isReportableCancel(row())).toBe(true);
  });

  it('"falta confirmada" na UI = paciente AVISOU que não virá → continua sendo cancelamento', () => {
    expect(isReportableCancel(row({ confirmedAbsence: true, cancelRequester: 'patient' }))).toBe(true);
  });

  it('sem solicitante → unspecified (nunca inferido do texto do motivo)', () => {
    expect(bucketOf(row({ cancelReason: 'paciente doente' }))).toBe('unspecified');
    expect(bucketOf(row({ cancelRequester: 'clinic' }))).toBe('clinic');
  });
});

describe('buildCancellationReport', () => {
  const totals = {
    all: 40,
    byDoctor: new Map([['dA', 20], ['dB', 20]]),
    byPatient: new Map([['p1', 10], ['p2', 30]]),
  };

  const rows = [
    row({ cancelRequester: 'patient', doctor: doctorA, patient: pat1 }),                       // 48h
    row({ cancelRequester: 'patient', doctor: doctorA, patient: pat1,
          canceledAt: new Date('2026-09-10T09:00:00.000Z') }),                                 // 4h → <24h
    row({ cancelRequester: 'professional', doctor: doctorA, patient: pat2,
          canceledAt: new Date('2026-09-10T09:00:00.000Z') }),                                 // 4h → <24h
    row({ cancelRequester: 'professional', doctor: doctorB, patient: pat2 }),                  // 48h
    row({ cancelRequester: 'clinic', doctor: doctorB, patient: pat2 }),
    row({ doctor: doctorB, patient: pat2 }),                                                    // não informado
    row({ cancelSource: 'guide_closure' }),                                                     // automático
    row({ operationalStatus: 'missed' }),                                                       // falta (no-show)
  ];

  const report = buildCancellationReport(rows, totals);

  it('resumo separa cancelamento, falta e automático', () => {
    expect(report.summary.totalCanceled).toBe(6);
    expect(report.summary.absences).toBe(1);
    expect(report.summary.automaticCancellations).toBe(1);
    expect(report.summary.lessThan24h).toBe(2);
    expect(report.summary.unspecified).toBe(1);
    expect(report.summary.cancelRate).toBe(15); // 6 / 40
  });

  it('quantidade e percentual por solicitante somam o total', () => {
    const by = Object.fromEntries(report.byRequester.map((b) => [b.requester, b]));
    expect(by.patient.count).toBe(2);
    expect(by.patient.percent).toBe(33.3);
    expect(by.professional.count).toBe(2);
    expect(by.clinic.count).toBe(1);
    expect(by.unspecified.count).toBe(1);
    expect(by.patient.lessThan24h).toBe(1);
    expect(by.professional.lessThan24h).toBe(1);
    expect(report.byRequester.reduce((s, b) => s + b.count, 0)).toBe(report.summary.totalCanceled);
  });

  it('profissional: separa o que ELE pediu do que pacientes da agenda dele pediram', () => {
    const a = report.professionals.find((p) => p.doctorId === 'dA');
    expect(a.requestedByProfessional).toBe(1);
    expect(a.requestedByPatients).toBe(2);
    expect(a.canceledTotal).toBe(3);
    expect(a.totalAppointments).toBe(20);
    expect(a.professionalRate).toBe(5);   // 1/20
    expect(a.agendaCancelRate).toBe(15);  // 3/20
    expect(a.lessThan24hByProfessional).toBe(1);
  });

  it('paciente: recorrência e taxa sobre os agendamentos dele', () => {
    const p1 = report.patients.find((p) => p.patientId === 'p1');
    expect(p1.requestedByPatient).toBe(2);
    expect(p1.patientRate).toBe(20);      // 2/10
    expect(p1.lessThan24hByPatient).toBe(1);
    expect(report.patients[0].patientId).toBe('p1'); // mais recorrente primeiro
  });

  it('sem denominador a taxa é 0 (não NaN/Infinity)', () => {
    const r = buildCancellationReport(rows, { all: 0, byDoctor: new Map(), byPatient: new Map() });
    expect(r.summary.cancelRate).toBe(0);
    expect(r.professionals.every((p) => p.professionalRate === 0)).toBe(true);
  });
});

describe('buildCancellationDetails', () => {
  it('filtra por solicitante e traz motivo, antecedência e registrador', () => {
    const rows = [
      row({ cancelRequester: 'professional', cancelReason: 'Congresso', canceledBy: { name: 'Secretária Maria' } }),
      row({ cancelRequester: 'patient' }),
      row({ cancelSource: 'guide_closure', cancelRequester: undefined }),
    ];
    const items = buildCancellationDetails(rows, { requester: 'professional' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      date: '2026-09-10',
      time: '10:00',
      requester: 'professional',
      reason: 'Congresso',
      registeredBy: 'Secretária Maria',
      hoursInAdvance: 48,
      lessThan24h: false,
      doctorName: 'Dra. Ana',
      patientName: 'Paciente Um',
    });
  });
});

import { previousPeriod, buildComparison } from '../../services/analytics/cancellationReport.service.js';

describe('comparação com período anterior', () => {
  it('período anterior equivalente (mesma duração, imediatamente antes)', () => {
    expect(previousPeriod({ startDate: '2026-10-01', endDate: '2026-10-31' })).toEqual({ startDate: '2026-08-31', endDate: '2026-09-30' });
  });

  const mk = (patient, professional, unspecified) => ({
    summary: { totalCanceled: patient + professional + unspecified, unspecified },
    byRequester: [
      { requester: 'patient', count: patient }, { requester: 'professional', count: professional },
      { requester: 'clinic', count: 0 }, { requester: 'unspecified', count: unspecified },
    ],
  });

  it('diferença absoluta; base anterior zero não gera percentual', () => {
    const c = buildComparison(mk(5, 2, 0), mk(0, 0, 0), { startDate: 'a', endDate: 'b' });
    expect(c.total).toEqual({ current: 7, previous: 0, diff: 7 });
    expect(c.byRequester.find((r) => r.requester === 'patient')).toMatchObject({ current: 5, previous: 0, diff: 5 });
    expect(JSON.stringify(c)).not.toMatch(/percent.*Infinity|NaN/);
    expect(c.byRequesterReliable).toBe(false); // base anterior sem dados
  });

  it('cobertura muito diferente entre períodos → não confiável por solicitante', () => {
    expect(buildComparison(mk(5, 3, 0), mk(1, 0, 9), {}).byRequesterReliable).toBe(false);
    expect(buildComparison(mk(5, 3, 2), mk(4, 3, 3), {}).byRequesterReliable).toBe(true);
  });
});

describe('cancelamentos automáticos novos são separados dos manuais sem solicitante', () => {
  const build = (rows) => buildCancellationReport(rows, { all: 0, byDoctor: new Map(), byPatient: new Map() });

  it.each(['liminar_plan_update', 'unconfirmed_auto', 'package_exhausted'])('cancelSource %s conta como automático, não como "Não informado"', (cancelSource) => {
    const report = build([row({ cancelSource }), row({ cancelRequester: null })]);
    expect(report.summary.automaticCancellations).toBe(1);
    expect(report.summary.unspecified).toBe(1); // só o manual sem solicitante
  });

  it('histórico antigo (sem cancelSource) NÃO é reclassificado — segue como "Não informado"', () => {
    const report = build([row({ cancelReason: 'Dia da semana removido da terapia "fono" (plano atualizado)' })]);
    expect(report.summary.automaticCancellations).toBe(0);
    expect(report.summary.unspecified).toBe(1);
  });
});

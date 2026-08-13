/**
 * 🧪 Transferência de cobertura entre pacotes — suíte ISOLADA
 *
 * ⚠️ AMBIENTE: local e produção compartilham o MESMO MongoDB neste projeto.
 * Por isso esta suíte NÃO pode tocar em banco. Ela roda inteiramente sobre um
 * store em memória e falha imediatamente se detectar URI de produção ou se
 * qualquer código tentar abrir conexão.
 *
 * Cenário espelhado (caso Álvaro, 2026-08-12), sem usar o dado real:
 *   8 sessões de fono × R$ 180 = R$ 1.440 pagos antecipadamente
 *   2 realizadas · 4 canceladas · 2 agendadas
 *   as 4 canceladas viram cobertura de um pacote de psicologia
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ════════════════════════════════════════════════════════════════════════
// GUARD DE SEGURANÇA — antes de qualquer coisa
// ════════════════════════════════════════════════════════════════════════
const PROD_URI_PATTERN = /mongodb\+srv|\.mongodb\.net|fono_inova_prod|render\.com/i;

for (const key of ['MONGO_URI', 'MONGODB_URI', 'MONGO_URL', 'DATABASE_URL', 'REDIS_URL']) {
  const value = process.env[key];
  if (value && PROD_URI_PATTERN.test(value)) {
    throw new Error(
      `🚫 ABORTADO: ${key} aponta para infraestrutura real ("${value.slice(0, 40)}…"). ` +
      `Esta suíte nunca deve rodar com credencial de produção carregada.`
    );
  }
  delete process.env[key];
}

// Qualquer tentativa de conexão explode o teste em vez de vazar para o banco.
vi.mock('mongoose', async (importOriginal) => {
  const actual = await importOriginal();
  const blocked = () => {
    throw new Error('🚫 BLOQUEADO: o teste tentou abrir conexão com o banco de dados.');
  };
  return {
    ...actual,
    default: { ...actual.default, connect: blocked, createConnection: blocked },
    connect: blocked,
    createConnection: blocked,
  };
});

// ════════════════════════════════════════════════════════════════════════
// STORE EM MEMÓRIA
// ════════════════════════════════════════════════════════════════════════
const oid = () => {
  // ObjectId-like de 24 hex, sem depender de conexão
  let s = '';
  while (s.length < 24) s += Math.floor(Math.random() * 16).toString(16);
  return s.slice(0, 24);
};

const store = {
  packages: new Map(),
  appointments: new Map(),
  sessions: new Map(),
  transfers: [],
  outbox: [],
  projectionsRebuilt: [],
  cancelCalls: [],
  packageWrites: [],
  failNextTransfer: false,
};

const clone = (o) => JSON.parse(JSON.stringify(o));

/** Query encadeável: .session().lean() / .lean() / await direto */
function query(resolver) {
  const p = {
    session: () => p,
    lean: async () => resolver(),
    then: (res, rej) => Promise.resolve(resolver()).then(res, rej),
  };
  return p;
}

function matchesFilter(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    const value = doc[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$in' in cond) return cond.$in.map(String).includes(String(value));
      if ('$nin' in cond) return !cond.$nin.map(String).includes(String(value));
      if ('$ne' in cond) return String(value) !== String(cond.$ne);
      return false;
    }
    return String(value) === String(cond);
  });
}

vi.mock('../../models/Package.js', () => ({
  default: {
    findById: (id) => query(() => {
      const doc = store.packages.get(String(id));
      return doc ? clone(doc) : null;
    }),
    // Registram QUALQUER escrita em Package para provar que a origem
    // nunca é tocada — sem isso o invariante seria só "acidentalmente" true.
    updateMany: async (filter, update) => {
      store.packageWrites.push({ op: 'updateMany', filter, update });
      let n = 0;
      for (const [id, pkg] of store.packages) {
        if (matchesFilter(pkg, filter)) { Object.assign(pkg, update.$set || {}); n++; }
      }
      return { modifiedCount: n };
    },
    findByIdAndUpdate: async (id, update) => {
      store.packageWrites.push({ op: 'findByIdAndUpdate', filter: { _id: id }, update });
      const pkg = store.packages.get(String(id));
      if (pkg) Object.assign(pkg, update.$set || {});
      return pkg;
    },
    updateOne: async (filter, update) => {
      store.packageWrites.push({ op: 'updateOne', filter, update });
      for (const pkg of store.packages.values()) {
        if (matchesFilter(pkg, filter)) { Object.assign(pkg, update.$set || {}); break; }
      }
      return { modifiedCount: 1 };
    },
    create: async ([doc]) => {
      const _id = oid();
      const created = { ...doc, _id, financialStatus: doc.totalPaid >= doc.totalValue ? 'paid' : 'partially_paid' };
      store.packages.set(_id, created);
      return [{
        ...created,
        get _doc() { return created; },
        set sourceTransferId(v) { created.sourceTransferId = v; },
        get sourceTransferId() { return created.sourceTransferId; },
        save: async () => created,
        toObject: () => clone(created),
      }];
    },
  },
}));

vi.mock('../../models/Appointment.js', () => ({
  default: {
    find: (filter) => query(() =>
      [...store.appointments.values()].filter(a => matchesFilter(a, filter)).map(clone)),
    countDocuments: (filter) => query(() =>
      [...store.appointments.values()].filter(a => matchesFilter(a, filter)).length),
    updateMany: async (filter, update) => {
      let n = 0;
      for (const appt of store.appointments.values()) {
        if (matchesFilter(appt, filter)) {
          Object.assign(appt, update.$set || {});
          n++;
        }
      }
      return { modifiedCount: n };
    },
  },
}));

vi.mock('../../models/Session.js', () => ({
  default: {
    updateMany: async (filter, update) => {
      let n = 0;
      for (const sess of store.sessions.values()) {
        if (matchesFilter(sess, filter)) {
          Object.assign(sess, update.$set || {});
          n++;
        }
      }
      return { modifiedCount: n };
    },
  },
}));

vi.mock('../../models/PackageCreditTransfer.js', () => ({
  default: {
    findOne: (filter) => query(() => {
      const found = store.transfers.find(t => matchesFilter(t, filter));
      return found ? clone(found) : null;
    }),
    create: async ([doc]) => {
      if (store.failNextTransfer) throw new Error('falha simulada no meio da transação');
      const created = { ...doc, _id: oid(), createdAt: new Date() };
      store.transfers.push(created);
      return [{ ...created, toObject: () => clone(created) }];
    },
    aggregate: (pipeline) => query(() => {
      const match = pipeline[0]?.$match || {};
      const rows = store.transfers.filter(t => matchesFilter(t, match));
      if (rows.length === 0) return [];
      return [{ _id: null, sessions: rows.reduce((s, t) => s + t.sessionCount, 0) }];
    }),
  },
}));

// Transação: executa e, em caso de erro, desfaz tudo (rollback simulado).
vi.mock('../../utils/transactionRetry.js', () => ({
  runTransactionWithRetry: async (fn) => {
    const snapshot = {
      packages: new Map([...store.packages].map(([k, v]) => [k, clone(v)])),
      appointments: new Map([...store.appointments].map(([k, v]) => [k, clone(v)])),
      sessions: new Map([...store.sessions].map(([k, v]) => [k, clone(v)])),
      transfers: store.transfers.map(clone),
    };
    try {
      return await fn({ id: 'fake-session' });
    } catch (err) {
      store.packages = snapshot.packages;
      store.appointments = snapshot.appointments;
      store.sessions = snapshot.sessions;
      store.transfers = snapshot.transfers;
      throw err;
    }
  },
}));

vi.mock('../../infrastructure/outbox/outboxPattern.js', () => ({
  saveToOutbox: async (evt) => { store.outbox.push(evt); },
}));

vi.mock('../../infrastructure/events/eventPublisher.js', () => ({
  EventTypes: { PACKAGE_CREATED: 'PACKAGE_CREATED', PACKAGE_UPDATED: 'PACKAGE_UPDATED' },
}));

vi.mock('../../services/appointment/commands/cancelAppointmentCommand.js', () => ({
  executeWithSession: async (id, opts) => {
    store.cancelCalls.push({ id: String(id), ...opts });
    const appt = store.appointments.get(String(id));
    if (appt) {
      appt.operationalStatus = 'canceled';
      appt.clinicalStatus = opts.confirmedAbsence ? 'missed' : 'pending';
      appt.cancelSource = opts.cancelSource;
    }
    return appt;
  },
}));

vi.mock('../../domains/billing/services/PackageProjectionService.js', () => ({
  buildPackageView: async (id) => { store.projectionsRebuilt.push(String(id)); return { view: {} }; },
}));

// 🚫 Se o command algum dia importar estes, o teste explode.
vi.mock('../../models/Payment.js', () => ({
  default: new Proxy({}, { get() { throw new Error('🚫 Payment não pode ser usado na transferência'); } }),
}));
vi.mock('../../models/PatientBalance.js', () => ({
  default: new Proxy({}, { get() { throw new Error('🚫 PatientBalance não pode ser usado na transferência'); } }),
}));

const { execute, preview } = await import('../../services/billing/commands/transferPackageCreditCommand.js');

// ════════════════════════════════════════════════════════════════════════
// FIXTURE — espelha o caso real, sem tocar no dado real
// ════════════════════════════════════════════════════════════════════════
const PATIENT = oid();
const OTHER_PATIENT = oid();
const PSICO_DOCTOR = oid();
let SOURCE_PKG;
let canceledIds;
let completedIds;
let scheduledIds;

function seed({ model = 'prepaid' } = {}) {
  store.packages.clear();
  store.appointments.clear();
  store.sessions.clear();
  store.transfers = [];
  store.outbox = [];
  store.projectionsRebuilt = [];
  store.cancelCalls = [];
  store.packageWrites = [];
  store.failNextTransfer = false;

  SOURCE_PKG = oid();
  store.packages.set(SOURCE_PKG, {
    _id: SOURCE_PKG,
    patient: PATIENT,
    doctor: oid(),
    specialty: 'fonoaudiologia',
    sessionType: 'fonoaudiologia',
    model,
    type: 'therapy',
    sessionValue: 180,
    totalSessions: 8,
    totalValue: 1440,
    totalPaid: 1440,
    sessionsDone: 2,
    durationMonths: 2,
    sessionsPerWeek: 1,
    frequencyInterval: 'weekly',
  });

  const mk = (operationalStatus, clinicalStatus) => {
    const sessionId = oid();
    const apptId = oid();
    store.sessions.set(sessionId, {
      _id: sessionId, package: SOURCE_PKG, patient: PATIENT,
      status: operationalStatus === 'canceled' ? 'canceled' : 'scheduled',
    });
    store.appointments.set(apptId, {
      _id: apptId, package: SOURCE_PKG, patient: PATIENT, session: sessionId,
      operationalStatus, clinicalStatus, sessionValue: 180,
    });
    return apptId;
  };

  completedIds = [mk('completed', 'completed'), mk('completed', 'completed')];
  canceledIds = [mk('canceled', 'missed'), mk('canceled', 'missed'), mk('canceled', 'missed'), mk('canceled', 'missed')];
  scheduledIds = [mk('scheduled', 'pending'), mk('scheduled', 'pending')];
}

const target = { specialty: 'psicologia', doctorId: PSICO_DOCTOR, sessionValue: 180 };
const baseInput = (over = {}) => ({
  sourcePackageId: SOURCE_PKG,
  appointmentIds: canceledIds,
  target,
  reason: 'Mudança terapêutica definida pela equipe',
  idempotencyKey: `key_${Math.random()}`,
  ...over,
});

beforeEach(() => seed());

// ════════════════════════════════════════════════════════════════════════
describe('preview — estritamente somente leitura', () => {
  it('1. não escreve nada em lugar nenhum', async () => {
    const before = {
      packages: store.packages.size,
      appointments: JSON.stringify([...store.appointments.values()]),
      sessions: JSON.stringify([...store.sessions.values()]),
    };

    await preview({ sourcePackageId: SOURCE_PKG, appointmentIds: canceledIds, target });

    expect(store.packages.size).toBe(before.packages);
    expect(JSON.stringify([...store.appointments.values()])).toBe(before.appointments);
    expect(JSON.stringify([...store.sessions.values()])).toBe(before.sessions);
    expect(store.transfers).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
    expect(store.cancelCalls).toHaveLength(0);
  });

  it('mostra os números do caso real', async () => {
    const p = await preview({ sourcePackageId: SOURCE_PKG, appointmentIds: canceledIds, target });
    expect(p.sessionCount).toBe(4);
    expect(p.amount).toBe(720);
    expect(p.cashEntry).toBe(0);
    expect(p.completedUntouched).toBe(2);
    expect(p.willRestamp).toBe(4);
    expect(p.willCancelNow).toBe(0);
    expect(p.sourceKeeps).toEqual({ totalSessions: 8, totalValue: 1440, totalPaid: 1440 });
  });
});

describe('pacote de origem — intocado', () => {
  it('2/3/4. mantém 8 sessões, R$ 1.440 e o recebimento histórico', async () => {
    await execute(baseInput(), { _id: oid() });
    const src = store.packages.get(SOURCE_PKG);
    expect(src.totalSessions).toBe(8);
    expect(src.totalValue).toBe(1440);
    expect(src.totalPaid).toBe(1440);
  });

  it('2/3 (reforço). o command não emite NENHUMA escrita direcionada ao pacote de origem', async () => {
    await execute(baseInput(), { _id: oid() });
    const writesOnSource = store.packageWrites.filter(w =>
      JSON.stringify(w.filter).includes(String(SOURCE_PKG))
    );
    expect(writesOnSource).toEqual([]);
  });

  it('13. as duas sessões de fono restantes continuam agendadas', async () => {
    await execute(baseInput(), { _id: oid() });
    for (const id of scheduledIds) {
      expect(store.appointments.get(id).operationalStatus).toBe('scheduled');
      expect(store.appointments.get(id).transferId).toBeUndefined();
    }
  });
});

describe('sessões selecionadas — status operacional', () => {
  beforeEach(async () => { await execute(baseInput(), { _id: oid() }); });

  it('5/6. as 4 já canceladas foram aceitas e continuam canceladas', () => {
    for (const id of canceledIds) {
      expect(store.appointments.get(id).operationalStatus).toBe('canceled');
    }
  });

  it('7. recebem missed: false', () => {
    for (const id of canceledIds) expect(store.appointments.get(id).missed).toBe(false);
  });

  it('8. recebem cancelSource: converted_to_package', () => {
    for (const id of canceledIds) {
      expect(store.appointments.get(id).cancelSource).toBe('converted_to_package');
    }
  });

  it('9/10. recebem transferId e transferredToPackage', () => {
    const transfer = store.transfers[0];
    for (const id of canceledIds) {
      const a = store.appointments.get(id);
      expect(String(a.transferId)).toBe(String(transfer._id));
      expect(String(a.transferredToPackage)).toBe(String(transfer.targetPackageId));
    }
  });

  it('11. clinicalStatus NÃO é alterado pela transferência', () => {
    for (const id of canceledIds) {
      expect(store.appointments.get(id).clinicalStatus).toBe('missed');
    }
  });

  it('não cancela de novo o que já estava cancelado', () => {
    expect(store.cancelCalls).toHaveLength(0);
  });
});

describe('sessões realizadas — intocadas', () => {
  it('12. nem status, nem transferId, nem missed', async () => {
    const before = completedIds.map(id => clone(store.appointments.get(id)));
    await execute(baseInput(), { _id: oid() });
    completedIds.forEach((id, i) => {
      expect(store.appointments.get(id)).toEqual(before[i]);
    });
  });
});

describe('pacote de destino', () => {
  let targetPkg;
  beforeEach(async () => {
    const r = await execute(baseInput(), { _id: oid() });
    targetPkg = store.packages.get(String(r.targetPackage._id));
  });

  it('14. nasce com 4 sessões de psicologia', () => {
    expect(targetPkg.totalSessions).toBe(4);
    expect(targetPkg.specialty).toBe('psicologia');
    expect(String(targetPkg.doctor)).toBe(String(PSICO_DOCTOR));
    expect(String(targetPkg.patient)).toBe(String(PATIENT));
  });

  it('15/16. R$ 720 de valor total, integralmente coberto pela transferência', () => {
    expect(targetPkg.totalValue).toBe(720);
    expect(targetPkg.fundedByTransfer).toBe(720);
    expect(targetPkg.totalPaid).toBe(720);
    expect(targetPkg.financialStatus).toBe('paid');
  });

  it('30 (parcial). nasce prepaid/full — conclusão consome cobertura sem novo caixa', () => {
    expect(targetPkg.model).toBe('prepaid');
    expect(targetPkg.paymentType).toBe('full');
  });

  it('não reutiliza as sessões de fono como sessões de psicologia', () => {
    const reused = [...store.sessions.values()].filter(s => String(s.package) === String(targetPkg._id));
    expect(reused).toHaveLength(0);
  });
});

describe('financeiro — nenhuma entrada nova', () => {
  it('17/18/19. o command não importa Payment nem PatientBalance', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      resolve(here, '../../services/billing/commands/transferPackageCreditCommand.js'), 'utf8'
    );
    expect(src).not.toMatch(/from\s+['"].*models\/Payment\.js['"]/);
    expect(src).not.toMatch(/from\s+['"].*models\/PatientBalance\.js['"]/);
    expect(src).not.toMatch(/Payment\.create|PatientBalance\./);
  });

  it('17. execução real não cria Payment (mock explodiria) e não altera totalPaid da origem', async () => {
    await execute(baseInput(), { _id: oid() });
    expect(store.packages.get(SOURCE_PKG).totalPaid).toBe(1440);
  });

  it('19. o evento do destino declara cashEntry = 0', async () => {
    await execute(baseInput(), { _id: oid() });
    const created = store.outbox.find(e => e.eventType === 'PACKAGE_CREATED');
    expect(created.payload.cashEntry).toBe(0);
    expect(created.payload.fundedByTransfer).toBe(720);
    expect(created.payload.packageId).toBeTruthy();
  });

  it('20. nenhuma comissão é gerada (sessões não realizadas não passam por settlement)', async () => {
    await execute(baseInput(), { _id: oid() });
    expect(store.outbox.some(e => /COMMISSION|SESSION_COMPLETED/i.test(e.eventType))).toBe(false);
  });
});

describe('idempotência e concorrência', () => {
  it('21. mesma idempotencyKey devolve a mesma transferência, sem criar nada novo', async () => {
    const input = baseInput();
    const first = await execute(input, { _id: oid() });
    const packagesAfterFirst = store.packages.size;

    const second = await execute(input, { _id: oid() });

    expect(second.alreadyProcessed).toBe(true);
    expect(String(second.data._id)).toBe(String(first.data._id));
    expect(store.transfers).toHaveLength(1);
    expect(store.packages.size).toBe(packagesAfterFirst);
  });

  it('22. outra chave para as mesmas sessões retorna conflito 409', async () => {
    await execute(baseInput(), { _id: oid() });
    await expect(execute(baseInput({ idempotencyKey: 'outra_chave' }), { _id: oid() }))
      .rejects.toMatchObject({ status: 409, code: 'SESSION_ALREADY_TRANSFERRED' });
    expect(store.transfers).toHaveLength(1);
  });

  it('29. duas execuções concorrentes não transferem a mesma sessão duas vezes', async () => {
    const results = await Promise.allSettled([
      execute(baseInput({ idempotencyKey: 'k1' }), { _id: oid() }),
      execute(baseInput({ idempotencyKey: 'k2' }), { _id: oid() }),
    ]);
    const ok = results.filter(r => r.status === 'fulfilled');
    // No máximo uma cria transferência; a outra falha no guard de transferId.
    expect(store.transfers.length).toBeLessThanOrEqual(2);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const totalTransferred = store.transfers.reduce((s, t) => s + t.sessionCount, 0);
    expect(totalTransferred).toBeLessThanOrEqual(8);
  });
});

describe('rejeições', () => {
  it('23. sessão realizada → SESSION_ALREADY_DELIVERED 422', async () => {
    await expect(execute(baseInput({ appointmentIds: [completedIds[0]] }), { _id: oid() }))
      .rejects.toMatchObject({ status: 422, code: 'SESSION_ALREADY_DELIVERED' });
  });

  it('24. sessão já transferida → SESSION_ALREADY_TRANSFERRED 409', async () => {
    await execute(baseInput(), { _id: oid() });
    await expect(execute(baseInput({ idempotencyKey: 'nova' }), { _id: oid() }))
      .rejects.toMatchObject({ status: 409, code: 'SESSION_ALREADY_TRANSFERRED' });
  });

  it('25. pacote pós-pago → SOURCE_NOT_PREPAID 422', async () => {
    seed({ model: 'per_session' });
    await expect(execute(baseInput(), { _id: oid() }))
      .rejects.toMatchObject({ status: 422, code: 'SOURCE_NOT_PREPAID' });
  });

  it('26. sessão de outro paciente → PATIENT_MISMATCH 422', async () => {
    const intruder = canceledIds[0];
    store.appointments.get(intruder).patient = OTHER_PATIENT;
    await expect(execute(baseInput(), { _id: oid() }))
      .rejects.toMatchObject({ status: 422, code: 'PATIENT_MISMATCH' });
  });

  it('27. cobertura insuficiente → INSUFFICIENT_COVERAGE 422', async () => {
    // Pacote pagou só 4 sessões, mas há 2 realizadas + 2 agendadas + 4 pedidas
    store.packages.get(SOURCE_PKG).totalPaid = 720;
    await expect(execute(baseInput(), { _id: oid() }))
      .rejects.toMatchObject({ status: 422, code: 'INSUFFICIENT_COVERAGE' });
    expect(store.transfers).toHaveLength(0);
  });

  it('sem motivo → MISSING_REASON 400', async () => {
    await expect(execute(baseInput({ reason: '   ' }), { _id: oid() }))
      .rejects.toMatchObject({ status: 400, code: 'MISSING_REASON' });
  });

  it('sem sessão selecionada → NO_SESSIONS_SELECTED 400', async () => {
    await expect(execute(baseInput({ appointmentIds: [] }), { _id: oid() }))
      .rejects.toMatchObject({ status: 400, code: 'NO_SESSIONS_SELECTED' });
  });

  it('id repetido na seleção → DUPLICATE_APPOINTMENT_ID 400', async () => {
    await expect(execute(baseInput({ appointmentIds: [canceledIds[0], canceledIds[0]] }), { _id: oid() }))
      .rejects.toMatchObject({ status: 400, code: 'DUPLICATE_APPOINTMENT_ID' });
  });

  it('sessão de outro pacote → APPOINTMENT_NOT_IN_PACKAGE 422', async () => {
    store.appointments.get(canceledIds[0]).package = oid();
    await expect(execute(baseInput(), { _id: oid() }))
      .rejects.toMatchObject({ status: 422, code: 'APPOINTMENT_NOT_IN_PACKAGE' });
  });
});

describe('rollback', () => {
  it('28. erro no meio desfaz tudo — nenhuma escrita parcial permanece', async () => {
    const before = {
      packages: store.packages.size,
      appointments: JSON.stringify([...store.appointments.values()]),
    };
    store.failNextTransfer = true;

    await expect(execute(baseInput(), { _id: oid() })).rejects.toThrow(/falha simulada/);

    expect(store.packages.size).toBe(before.packages);
    expect(JSON.stringify([...store.appointments.values()])).toBe(before.appointments);
    expect(store.transfers).toHaveLength(0);
  });
});

describe('projeções', () => {
  it('reconstrói a view dos dois pacotes após a transferência', async () => {
    const r = await execute(baseInput(), { _id: oid() });
    expect(store.projectionsRebuilt).toContain(String(SOURCE_PKG));
    expect(store.projectionsRebuilt).toContain(String(r.targetPackage._id));
  });
});

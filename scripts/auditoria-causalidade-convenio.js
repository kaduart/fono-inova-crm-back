#!/usr/bin/env node
/**
 * 🔍 Auditoria de Causalidade – Convênio (Appointment → Session → Payment)
 *
 * Objetivo:
 *   1. Determinar se payments com session=NULL nasceram assim ou perderam o vínculo.
 *   2. Determinar se sessions completed sem payment nunca tiveram payment ou o perderam.
 *
 * Uso:
 *   cd back && node -r dotenv/config scripts/auditoria-causalidade-convenio.js
 */

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';

const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

const CORTE_DATA = new Date('2026-05-01T00:00:00.000Z');

function fmtDate(d) {
  if (!d) return null;
  const date = new Date(d);
  return isNaN(date) ? String(d) : date.toISOString();
}

function fmtId(id) {
  if (!id) return null;
  return id.toString ? id.toString() : String(id);
}

function isValidObjectIdString(str) {
  return typeof str === 'string' && /^[0-9a-fA-F]{24}$/.test(str);
}

function toObjectId(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  const str = id.toString ? id.toString() : String(id);
  if (!isValidObjectIdString(str)) return null;
  return new mongoose.Types.ObjectId(str);
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const dbName = db.databaseName;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  🔍 AUDITORIA DE CAUSALIDADE – CONVÊNIO');
  console.log(`  Banco: ${dbName}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ── Coleções disponíveis (incluindo backups) ─────────────────
  const allCollections = (await db.listCollections().toArray()).map(c => c.name).sort();
  const backupCollections = allCollections.filter(n =>
    /backup|_deleted|duplicate/i.test(n) && /appointment|session|payment|guide/i.test(n)
  );
  console.log('Coleções relacionadas encontradas:', backupCollections.join(', ') || '(nenhuma)');
  console.log('');

  // ── FASE 1: Payments de convênio com session=NULL ────────────
  console.log('─── FASE 1: Payments de convênio com session=NULL ───');

  const qPayments = {
    billingType: 'convenio',
    session: null,
    amount: { $gt: 0 },
    status: { $nin: ['canceled', 'refunded'] }
  };

  const paymentsOrfaos = await db.collection('payments').find(qPayments).sort({ createdAt: 1 }).toArray();
  console.log(`Encontrados ${paymentsOrfaos.length} payments com session=NULL\n`);

  // Coletar IDs para batch lookups
  const appointmentIdsFase1 = paymentsOrfaos
    .map(p => p.appointment)
    .filter(Boolean)
    .map(fmtId);
  const guideIdsFase1 = paymentsOrfaos
    .map(p => p.insuranceGuide)
    .filter(Boolean)
    .map(fmtId);

  const appointmentsMapFase1 = new Map();
  for (const chunk of chunkArray(appointmentIdsFase1, 100)) {
    const docs = await db.collection('appointments')
      .find({ _id: { $in: chunk.map(id => new mongoose.Types.ObjectId(id)) } })
      .toArray();
    for (const d of docs) appointmentsMapFase1.set(fmtId(d._id), d);
  }

  const sessionsMapFase1 = new Map();
  const sessionIdsFromAppointments = [...appointmentsMapFase1.values()]
    .map(a => a.session)
    .filter(Boolean)
    .map(fmtId);
  const appointmentIdsForSessionLookup = [...appointmentsMapFase1.values()]
    .map(a => fmtId(a._id));

  // Sessions por appointmentId
  for (const chunk of chunkArray(appointmentIdsForSessionLookup, 100)) {
    const docs = await db.collection('sessions')
      .find({ appointmentId: { $in: chunk.map(id => new mongoose.Types.ObjectId(id)) } })
      .toArray();
    for (const d of docs) {
      sessionsMapFase1.set(fmtId(d._id), d);
      sessionsMapFase1.set(`appt:${fmtId(d.appointmentId)}`, d);
    }
  }
  // Sessions por sessionId referenciado no appointment
  const missingSessionIds = sessionIdsFromAppointments.filter(id => !sessionsMapFase1.has(id));
  for (const chunk of chunkArray(missingSessionIds, 100)) {
    const docs = await db.collection('sessions')
      .find({ _id: { $in: chunk.map(id => new mongoose.Types.ObjectId(id)) } })
      .toArray();
    for (const d of docs) sessionsMapFase1.set(fmtId(d._id), d);
  }

  const guidesMapFase1 = new Map();
  for (const chunk of chunkArray(guideIdsFase1, 100)) {
    const docs = await db.collection('insuranceguides')
      .find({ _id: { $in: chunk.map(id => new mongoose.Types.ObjectId(id)) } })
      .toArray();
    for (const d of docs) guidesMapFase1.set(fmtId(d._id), d);
  }

  // Outros payments dos appointments (batch)
  const outrosPaymentsMap = new Map();
  if (appointmentIdsFase1.length > 0) {
    const outrosPayments = await db.collection('payments')
      .find({
        appointment: { $in: appointmentIdsFase1.map(id => new mongoose.Types.ObjectId(id)) },
        _id: { $nin: paymentsOrfaos.map(p => p._id) }
      })
      .sort({ createdAt: 1 })
      .toArray();
    for (const p of outrosPayments) {
      const apptId = fmtId(p.appointment);
      if (!outrosPaymentsMap.has(apptId)) outrosPaymentsMap.set(apptId, []);
      outrosPaymentsMap.get(apptId).push(p);
    }
  }

  // Eventos (batch) - só para payments e appointments (limitado)
  const eventosPaymentMap = new Map();
  const paymentIdsFase1 = paymentsOrfaos.map(p => fmtId(p._id));
  for (const chunk of chunkArray(paymentIdsFase1, 50)) {
    const events = await db.collection('eventstore')
      .find({ aggregateType: 'payment', aggregateId: { $in: chunk } })
      .sort({ createdAt: 1 })
      .toArray();
    for (const e of events) {
      if (!eventosPaymentMap.has(e.aggregateId)) eventosPaymentMap.set(e.aggregateId, []);
      eventosPaymentMap.get(e.aggregateId).push(e);
    }
  }

  const eventosAppointmentMap = new Map();
  for (const chunk of chunkArray(appointmentIdsFase1, 50)) {
    const events = await db.collection('eventstore')
      .find({ aggregateType: 'appointment', aggregateId: { $in: chunk } })
      .sort({ createdAt: 1 })
      .toArray();
    for (const e of events) {
      if (!eventosAppointmentMap.has(e.aggregateId)) eventosAppointmentMap.set(e.aggregateId, []);
      eventosAppointmentMap.get(e.aggregateId).push(e);
    }
  }

  // Backups (batch)
  const backupHitsPorPayment = new Map();
  for (const pay of paymentsOrfaos) {
    backupHitsPorPayment.set(fmtId(pay._id), { payment: [], appointment: [], session: [] });
  }
  for (const colName of backupCollections) {
    const col = db.collection(colName);
    for (const chunk of chunkArray(paymentIdsFase1, 50)) {
      const hits = await col.find({ _id: { $in: chunk.map(id => new mongoose.Types.ObjectId(id)) } }).toArray();
      for (const h of hits) backupHitsPorPayment.get(fmtId(h._id)).payment.push({ collection: colName, doc: h });
    }
    for (const chunk of chunkArray(appointmentIdsFase1, 50)) {
      const hits = await col.find({ _id: { $in: chunk.map(id => new mongoose.Types.ObjectId(id)) } }).toArray();
      for (const h of hits) {
        // Procurar qual payment está relacionado
        for (const pay of paymentsOrfaos) {
          if (fmtId(pay.appointment) === fmtId(h._id)) {
            backupHitsPorPayment.get(fmtId(pay._id)).appointment.push({ collection: colName, doc: h });
          }
        }
      }
    }
  }

  const fase1Resultados = [];

  for (const pay of paymentsOrfaos) {
    const payId = fmtId(pay._id);
    const appointment = pay.appointment ? appointmentsMapFase1.get(fmtId(pay.appointment)) : null;
    let session = null;
    if (appointment) {
      if (appointment.session) session = sessionsMapFase1.get(fmtId(appointment.session));
      if (!session) session = sessionsMapFase1.get(`appt:${fmtId(appointment._id)}`);
    }
    const guide = pay.insuranceGuide
      ? guidesMapFase1.get(fmtId(pay.insuranceGuide))
      : (appointment?.insuranceGuide ? guidesMapFase1.get(fmtId(appointment.insuranceGuide)) : null);

    const eventosPayment = eventosPaymentMap.get(payId) || [];
    const eventosAppointment = appointment ? eventosAppointmentMap.get(fmtId(appointment._id)) || [] : [];

    const outrosPaymentsDoAppointment = outrosPaymentsMap.get(fmtId(pay.appointment)) || [];
    const backupHits = backupHitsPorPayment.get(payId);

    // Determinar causalidade
    let hipoteseCausalidade = 'INDETERMINADO';
    let evidenciasCausalidade = [];

    if (!appointment) {
      hipoteseCausalidade = 'SEM_APPOINTMENT';
      evidenciasCausalidade.push('Payment não possui appointment');
    } else if (!session) {
      hipoteseCausalidade = 'APPOINTMENT_SEM_SESSION';
      evidenciasCausalidade.push('Appointment existe mas não tem session vinculada');
    } else if (session.status !== 'completed') {
      hipoteseCausalidade = 'SESSION_NAO_COMPLETED';
      evidenciasCausalidade.push(`Session status=${session.status}`);
    } else {
      const payCreated = new Date(pay.createdAt);
      const sessCreated = new Date(session.createdAt);

      if (payCreated < sessCreated) {
        hipoteseCausalidade = 'B_NASCEU_SEM_SESSION';
        evidenciasCausalidade.push('Payment criado antes da session');
      } else {
        const eventosAlteracao = eventosPayment.filter(e =>
          /STATUS_CHANGED|UPDATED|MODIFIED|SESSION_UNLINKED|PAYMENT_UNLINKED/i.test(e.eventType) ||
          (e.payload && (e.payload.previousSessionId || e.payload.session !== undefined))
        );

        if (eventosAlteracao.length > 0) {
          hipoteseCausalidade = 'A_PERDEU_VINCULO';
          evidenciasCausalidade.push(`Eventos de alteração no payment: ${eventosAlteracao.map(e => e.eventType).join(', ')}`);
        } else if (outrosPaymentsDoAppointment.length > 0) {
          const maisRecente = outrosPaymentsDoAppointment.filter(p => new Date(p.createdAt) > payCreated);
          if (maisRecente.length > 0) {
            hipoteseCausalidade = 'A_PERDEU_VINCULO';
            evidenciasCausalidade.push(`Outro payment mais recente no mesmo appointment: ${maisRecente.map(p => fmtId(p._id)).join(', ')}`);
          } else {
            hipoteseCausalidade = 'B_NASCEU_SEM_SESSION';
            evidenciasCausalidade.push('Nenhum evento de alteração e nenhum payment mais recente no appointment');
          }
        } else {
          hipoteseCausalidade = 'B_NASCEU_SEM_SESSION';
          evidenciasCausalidade.push('Nenhum evento de alteração e nenhum outro payment no appointment');
        }
      }
    }

    const appointmentPaymentAtual = appointment?.payment ? fmtId(appointment.payment) : null;
    const apontaParaOutro = appointmentPaymentAtual && appointmentPaymentAtual !== payId;

    fase1Resultados.push({
      paymentId: payId,
      amount: pay.amount,
      status: pay.status,
      insuranceStatus: pay.insurance?.status,
      createdAt: fmtDate(pay.createdAt),
      updatedAt: fmtDate(pay.updatedAt),
      source: pay.source,
      kind: pay.kind,
      hipoteseCausalidade,
      evidenciasCausalidade,
      appointment: appointment ? {
        id: fmtId(appointment._id),
        createdAt: fmtDate(appointment.createdAt),
        updatedAt: fmtDate(appointment.updatedAt),
        operationalStatus: appointment.operationalStatus,
        paymentAtual: appointmentPaymentAtual,
        apontaParaOutroPayment: apontaParaOutro,
        historyActions: (appointment.history || []).map(h => ({
          action: h.action,
          newStatus: h.newStatus,
          timestamp: fmtDate(h.timestamp),
          context: h.context
        }))
      } : null,
      session: session ? {
        id: fmtId(session._id),
        createdAt: fmtDate(session.createdAt),
        updatedAt: fmtDate(session.updatedAt),
        status: session.status,
        completedAt: fmtDate(session.completedAt),
        paymentId: session.paymentId ? fmtId(session.paymentId) : null,
        insuranceGuide: session.insuranceGuide ? fmtId(session.insuranceGuide) : null
      } : null,
      guide: guide ? {
        id: fmtId(guide._id),
        number: guide.number,
        status: guide.status,
        totalSessions: guide.totalSessions,
        usedSessions: guide.usedSessions
      } : null,
      outrosPaymentsDoAppointment: outrosPaymentsDoAppointment.map(p => ({
        id: fmtId(p._id),
        amount: p.amount,
        status: p.status,
        session: p.session ? fmtId(p.session) : null,
        createdAt: fmtDate(p.createdAt),
        updatedAt: fmtDate(p.updatedAt)
      })),
      eventosPayment: eventosPayment.map(e => ({
        eventType: e.eventType,
        createdAt: fmtDate(e.createdAt),
        source: e.metadata?.source,
        payloadKeys: Object.keys(e.payload || {})
      })),
      backupHits: {
        payment: backupHits.payment.map(h => ({ collection: h.collection, createdAt: fmtDate(h.doc.createdAt) })),
        appointment: backupHits.appointment.map(h => ({ collection: h.collection, createdAt: fmtDate(h.doc.createdAt) })),
        session: []
      }
    });
  }

  const antes30Abr = fase1Resultados.filter(r => new Date(r.createdAt) < CORTE_DATA);
  const aPartir01Mai = fase1Resultados.filter(r => new Date(r.createdAt) >= CORTE_DATA);

  console.log(`  Até 30/04/2026: ${antes30Abr.length} casos`);
  console.log(`  A partir de 01/05/2026: ${aPartir01Mai.length} casos`);
  console.log('');

  const contagemCausalidade = {};
  for (const r of fase1Resultados) {
    contagemCausalidade[r.hipoteseCausalidade] = (contagemCausalidade[r.hipoteseCausalidade] || 0) + 1;
  }
  console.log('Classificação de causalidade:');
  for (const [k, v] of Object.entries(contagemCausalidade)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('');

  // ── FASE 2: Sessions completed sem payment válido ────────────
  console.log('─── FASE 2: Sessions completed sem payment válido ───');

  const qSessions = {
    status: 'completed',
    $and: [
      {
        $or: [
          { paymentMethod: 'convenio' },
          { paymentOrigin: 'convenio' }
        ]
      },
      {
        $or: [
          { paymentId: { $exists: false } },
          { paymentId: null }
        ]
      }
    ]
  };

  const sessionsSemPayment = await db.collection('sessions').find(qSessions).sort({ createdAt: 1 }).toArray();
  console.log(`Encontradas ${sessionsSemPayment.length} sessions completed sem paymentId\n`);

  // Batch lookups para Fase 2
  const appointmentIdsFase2 = sessionsSemPayment
    .map(s => s.appointmentId)
    .map(fmtId)
    .filter(isValidObjectIdString);

  const appointmentsMapFase2 = new Map();
  for (const chunk of chunkArray(appointmentIdsFase2, 100)) {
    const docs = await db.collection('appointments')
      .find({ _id: { $in: chunk.map(id => new mongoose.Types.ObjectId(id)) } })
      .toArray();
    for (const d of docs) appointmentsMapFase2.set(fmtId(d._id), d);
  }

  // Buscar todos os payments relacionados de uma vez
  const paymentsRelacionados = await db.collection('payments').find({
    $or: [
      { appointment: { $in: appointmentIdsFase2.map(id => new mongoose.Types.ObjectId(id)) } },
      { session: { $in: sessionsSemPayment.map(s => s._id) } }
    ]
  }).sort({ createdAt: 1 }).toArray();

  const paymentsPorAppointmentFase2 = new Map();
  const paymentsPorSessionFase2 = new Map();
  for (const p of paymentsRelacionados) {
    if (p.appointment) {
      const apptId = fmtId(p.appointment);
      if (!paymentsPorAppointmentFase2.has(apptId)) paymentsPorAppointmentFase2.set(apptId, []);
      paymentsPorAppointmentFase2.get(apptId).push(p);
    }
    if (p.session) {
      const sessId = fmtId(p.session);
      if (!paymentsPorSessionFase2.has(sessId)) paymentsPorSessionFase2.set(sessId, []);
      paymentsPorSessionFase2.get(sessId).push(p);
    }
  }

  const appointmentPaymentIds = [...appointmentsMapFase2.values()]
    .map(a => a.payment)
    .map(fmtId)
    .filter(isValidObjectIdString);
  const appointmentPaymentsMap = new Map();
  for (const chunk of chunkArray(appointmentPaymentIds, 100)) {
    const docs = await db.collection('payments')
      .find({ _id: { $in: chunk.map(id => new mongoose.Types.ObjectId(id)) } })
      .toArray();
    for (const d of docs) appointmentPaymentsMap.set(fmtId(d._id), d);
  }

  // Backups (batch) para sessions e appointments
  const backupHitsFase2 = new Map();
  for (const sess of sessionsSemPayment) {
    backupHitsFase2.set(fmtId(sess._id), { session: [], appointment: [], payment: [] });
  }
  for (const colName of backupCollections) {
    const col = db.collection(colName);
    const sessionIds = sessionsSemPayment.map(s => s._id);
    for (const chunk of chunkArray(sessionIds, 100)) {
      const hits = await col.find({ _id: { $in: chunk } }).toArray();
      for (const h of hits) backupHitsFase2.get(fmtId(h._id)).session.push({ collection: colName, doc: h });
    }
    const apptIds = [...appointmentsMapFase2.values()].map(a => a._id).filter(Boolean);
    for (const chunk of chunkArray(apptIds, 100)) {
      const hits = await col.find({ _id: { $in: chunk } }).toArray();
      for (const h of hits) {
        for (const sess of sessionsSemPayment) {
          if (fmtId(sess.appointmentId) === fmtId(h._id)) {
            backupHitsFase2.get(fmtId(sess._id)).appointment.push({ collection: colName, doc: h });
          }
        }
      }
    }
  }

  const fase2Resultados = [];

  for (const sess of sessionsSemPayment) {
    const sessId = fmtId(sess._id);
    const appointment = sess.appointmentId ? appointmentsMapFase2.get(fmtId(sess.appointmentId)) : null;

    const paymentsPorAppointment = paymentsPorAppointmentFase2.get(fmtId(sess.appointmentId)) || [];
    const paymentsPorSession = paymentsPorSessionFase2.get(sessId) || [];
    const todosPaymentsRelacionados = [...paymentsPorAppointment, ...paymentsPorSession]
      .filter((p, i, arr) => arr.findIndex(x => fmtId(x._id) === fmtId(p._id)) === i);

    const appointmentPayment = appointment?.payment ? appointmentPaymentsMap.get(fmtId(appointment.payment)) : null;
    const backupHits = backupHitsFase2.get(sessId);

    let hipotese = 'INDETERMINADO';
    let evidencias = [];

    if (todosPaymentsRelacionados.length === 0) {
      hipotese = 'B_NUNCA_EXISTIU';
      evidencias.push('Nenhum payment encontrado por appointment ou session');
    } else {
      const paymentsComSession = todosPaymentsRelacionados.filter(p =>
        p.session && fmtId(p.session) === sessId
      );
      const paymentsCancelados = todosPaymentsRelacionados.filter(p =>
        ['canceled', 'refunded'].includes(p.status)
      );

      if (paymentsComSession.length > 0) {
        hipotese = 'A_EXISTIU_E_FOI_PERDIDO';
        evidencias.push(`Payments que já referenciaram esta session: ${paymentsComSession.map(p => fmtId(p._id)).join(', ')}`);
      } else if (paymentsCancelados.length > 0) {
        hipotese = 'A_EXISTIU_E_FOI_CANCELADO';
        evidencias.push(`Payments cancelados/refunded encontrados: ${paymentsCancelados.map(p => `${fmtId(p._id)}(${p.status})`).join(', ')}`);
      } else {
        hipotese = 'B_NUNCA_EXISTIU';
        evidencias.push('Payments relacionados existem mas nenhum referenciava esta session e nenhum está cancelado');
      }
    }

    fase2Resultados.push({
      sessionId: sessId,
      date: fmtDate(sess.date),
      createdAt: fmtDate(sess.createdAt),
      updatedAt: fmtDate(sess.updatedAt),
      completedAt: fmtDate(sess.completedAt),
      status: sess.status,
      paymentMethod: sess.paymentMethod,
      paymentOrigin: sess.paymentOrigin,
      insuranceGuide: sess.insuranceGuide ? fmtId(sess.insuranceGuide) : null,
      sessionValue: sess.sessionValue,
      hipotese,
      evidencias,
      appointment: appointment ? {
        id: fmtId(appointment._id),
        createdAt: fmtDate(appointment.createdAt),
        operationalStatus: appointment.operationalStatus,
        paymentAtual: appointment.payment ? fmtId(appointment.payment) : null,
        paymentAtualDetalhe: appointmentPayment ? {
          id: fmtId(appointmentPayment._id),
          amount: appointmentPayment.amount,
          status: appointmentPayment.status,
          session: appointmentPayment.session ? fmtId(appointmentPayment.session) : null,
          createdAt: fmtDate(appointmentPayment.createdAt)
        } : null
      } : null,
      paymentsRelacionados: todosPaymentsRelacionados.map(p => ({
        id: fmtId(p._id),
        amount: p.amount,
        status: p.status,
        session: p.session ? fmtId(p.session) : null,
        appointment: p.appointment ? fmtId(p.appointment) : null,
        createdAt: fmtDate(p.createdAt),
        updatedAt: fmtDate(p.updatedAt),
        insuranceStatus: p.insurance?.status
      })),
      backupHits: {
        session: backupHits.session.map(h => ({ collection: h.collection, createdAt: fmtDate(h.doc.createdAt), status: h.doc.status })),
        appointment: backupHits.appointment.map(h => ({ collection: h.collection, createdAt: fmtDate(h.doc.createdAt) })),
        payment: backupHits.payment.map(h => ({ collection: h.collection, createdAt: fmtDate(h.doc.createdAt), status: h.doc.status }))
      }
    });
  }

  const contagemFase2 = {};
  for (const r of fase2Resultados) {
    contagemFase2[r.hipotese] = (contagemFase2[r.hipotese] || 0) + 1;
  }
  console.log('Classificação de causalidade (sessions sem payment):');
  for (const [k, v] of Object.entries(contagemFase2)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('');

  // ── Salvar relatório ─────────────────────────────────────────
  const output = {
    geradoEm: new Date().toISOString(),
    banco: dbName,
    corteData: CORTE_DATA.toISOString(),
    colecoesDisponiveis: allCollections,
    backupCollections,
    fase1: {
      total: fase1Resultados.length,
      ate30Abr: antes30Abr.length,
      aPartir01Mai: aPartir01Mai.length,
      contagemCausalidade,
      detalhes: fase1Resultados
    },
    fase2: {
      total: fase2Resultados.length,
      contagemCausalidade: contagemFase2,
      detalhes: fase2Resultados
    }
  };

  const outDir = path.resolve(process.cwd(), 'auditoria-output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `auditoria-causalidade-convenio-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

  // ── Resumo final ─────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  📊 RESUMO');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`FASE 1 (payments session=NULL): ${fase1Resultados.length}`);
  console.log(`  Até 30/04: ${antes30Abr.length}`);
  console.log(`  A partir de 01/05: ${aPartir01Mai.length}`);
  for (const [k, v] of Object.entries(contagemCausalidade)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('');
  console.log(`FASE 2 (sessions completed sem payment): ${fase2Resultados.length}`);
  for (const [k, v] of Object.entries(contagemFase2)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('');
  console.log(`Relatório completo salvo em: ${outFile}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('💥 Erro na auditoria:', err);
  process.exit(1);
});

/**
 * Loader da receita por campanha contra um MongoDB DESCARTÁVEL (mongodb-memory-server),
 * com a amostra fictícia gravada direto na coleção (dado de teste, nunca produção).
 * Confere: período por occurredAt, invariante 1.290 = 480 + 570 + 240, telefone com máscara achado pelo
 * índice de Patient.phone, campanha só a partir da data do contato e que o loader NÃO escreve nada.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import FinancialLedger from '../../models/FinancialLedger.js';
import AdConversion from '../../models/AdConversion.js';
import LeadAttribution from '../../models/LeadAttribution.js';
import Patient from '../../models/Patient.js';
import { loadRevenueAttribution } from '../../services/attribution/revenueAttribution.js';
import { amostra, ESPERADO } from '../../services/attribution/fixtures/receitaFicticia.js';

const OID_FIELDS = ['_id', 'patient', 'payment', 'package', 'reversalOfEntryId', 'appointment'];
const toDb = (rows) => rows.map((r) => {
  const out = { ...r };
  for (const f of OID_FIELDS) if (typeof out[f] === 'string' && /^[0-9a-f]{24}$/.test(out[f])) out[f] = new mongoose.Types.ObjectId(out[f]);
  return out;
});

let mongod;
const counts = async () => Promise.all([FinancialLedger, AdConversion, LeadAttribution, Patient].map((m) => m.collection.countDocuments()));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await FinancialLedger.collection.insertMany(toDb(amostra.ledgerEntries));
  await AdConversion.collection.insertMany(toDb(amostra.adConversions));
  await LeadAttribution.collection.insertMany(toDb(amostra.leadAttributions));
  await Patient.collection.insertMany(toDb(amostra.patients));
  // crédito de outro mês, fora do período (não pode entrar na soma)
  await FinancialLedger.collection.insertOne({
    _id: new mongoose.Types.ObjectId(), type: 'payment_received', direction: 'credit', amount: 999,
    patient: new mongoose.Types.ObjectId(amostra.patients[0]._id), correlationId: 'ficticio-outubro', occurredAt: new Date('2026-10-15T15:00:00Z'),
  });
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe('loadRevenueAttribution (Mongo descartável)', () => {
  it('novembro/2026 fecha 1.290 = 480 + 570 + 240, sem escrever nada', async () => {
    const antes = await counts();
    const r = await loadRevenueAttribution({
      since: new Date('2026-11-01T03:00:00.000Z'),
      until: new Date('2026-12-01T02:59:59.999Z'),
    });
    expect(r.totalLiquidoLedger).toBe(ESPERADO.total);
    expect(r.porNivel).toEqual({ comprovada: 480, provavel: 570, sem_vinculo: 240 });
    // Iris ("(62) 99999-0009") divide o número com o irmão ("+55 62 99999-0009"): provável
    expect(r.linhas.find((l) => l.nivel === 'provavel' && l.origem === 'google_ads')).toMatchObject({ liquido: 470, pacientes: 3 });
    expect(r.invariante.fecha).toBe(true);
    expect(await counts()).toEqual(antes);
  });

  it('outubro/2026 só vê o lançamento de outubro', async () => {
    const r = await loadRevenueAttribution({
      since: new Date('2026-10-01T03:00:00.000Z'),
      until: new Date('2026-11-01T02:59:59.999Z'),
    });
    expect(r.totalLiquidoLedger).toBe(999);
    // Ana só chegou pelo Google em 05/11 (eventTime): o pagamento de 15/10 não vai para a campanha
    expect(r.porNivel).toEqual({ comprovada: 0, provavel: 0, sem_vinculo: 999 });
    expect(r.semVinculo.motivos).toEqual({ contato_da_campanha_depois_do_recebimento: 999 });
  });
});

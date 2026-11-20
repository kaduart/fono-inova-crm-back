/**
 * Loader + estornos pelo saldo (estorno-v3-saldo-por-recebimento) contra um MongoDB DESCARTÁVEL,
 * com a amostra fictícia de estornos. Confere que o carregador traz, como referência, os
 * recebimentos fora do período E o estorno anterior ao período que já consumiu saldo, e que
 * o resultado de novembro é o mesmo da função pura (e do KAS): 450 = 500 − 50.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import FinancialLedger from '../../models/FinancialLedger.js';
import AdConversion from '../../models/AdConversion.js';
import Patient from '../../models/Patient.js';
import { loadRevenueAttribution, loadRevenueInputs } from '../../services/attribution/revenueAttribution.js';
import { amostraEstornos, ESPERADO_ESTORNOS } from '../../services/attribution/fixtures/estornosFicticios.js';

const OID_FIELDS = ['_id', 'patient', 'payment', 'reversalOfEntryId', 'appointment'];
const toDb = (rows) => rows.map((r) => {
  const out = { ...r };
  for (const f of OID_FIELDS) if (typeof out[f] === 'string' && /^[0-9a-f]{24}$/.test(out[f])) out[f] = new mongoose.Types.ObjectId(out[f]);
  return out;
});

let mongod;
const NOV = { since: new Date('2026-11-01T03:00:00.000Z'), until: new Date('2026-12-01T02:59:59.999Z') };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await FinancialLedger.collection.insertMany(toDb([...amostraEstornos.ledgerEntries, ...amostraEstornos.referenceEntries]));
  await AdConversion.collection.insertMany(toDb(amostraEstornos.adConversions));
  await Patient.collection.insertMany(toDb(amostraEstornos.patients));
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe('estornos pelo saldo (Mongo descartável)', () => {
  it('carrega o estorno anterior ao período como referência', async () => {
    const raw = await loadRevenueInputs(NOV);
    const refs = raw.referenceEntries.map((e) => String(e._id)).sort();
    expect(refs).toEqual(amostraEstornos.referenceEntries.map((e) => e._id).sort());
  });

  it('novembro fecha por campanha: 100, 500, −100 e sem vínculo −50', async () => {
    const r = await loadRevenueAttribution(NOV);
    expect(r.totalLiquidoLedger).toBe(ESPERADO_ESTORNOS.total);
    expect(Object.fromEntries(r.linhas.map((l) => [l.campanha, l.liquido]))).toEqual(ESPERADO_ESTORNOS.campanhas);
    expect(r.porNivel.sem_vinculo).toBe(ESPERADO_ESTORNOS.sem_vinculo);
    expect(r.invariante.fecha).toBe(true);
  });
});

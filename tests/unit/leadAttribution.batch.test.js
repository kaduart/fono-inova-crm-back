/**
 * getAttributionsByPhones (lote) deve devolver, por telefone, o MESMO que getAttributionByPhone.
 * 11/11/2026: o cron de conversões (refreshUnknownSources) chamava a versão unitária em série
 * para até 300 docs a cada 10 min; o lote faz 2 consultas no total.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import LeadAttribution from '../../models/LeadAttribution.js';
import Lead from '../../models/Leads.js';
import { getAttributionByPhone, getAttributionsByPhones } from '../../services/leadAttributionService.js';

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await LeadAttribution.collection.insertMany([
    // variante sem o 9: precisa casar com o telefone com 9
    { phone: '556291110797', source: 'meta_ads', method: 'ctwa', firstMessageAt: new Date('2026-11-01') },
    // duas variantes do mesmo número: vale a mais antiga
    { phone: '5562991590750', source: 'google_ads', method: 'token', firstMessageAt: new Date('2026-11-05') },
    { phone: '556291590750', source: 'instagram', method: 'keyword', firstMessageAt: new Date('2026-11-02') },
  ]);
  await Lead.collection.insertMany([
    { name: 'Com origem', contact: { phone: '5562981454927' }, metaTracking: { source: 'tiktok', ttclid: 'tt1' } },
    { name: 'Sem origem', contact: { phone: '5562992944659' } },
  ]);
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const strip = (a) => (a ? JSON.parse(JSON.stringify(a)) : a);

describe('getAttributionsByPhones', () => {
  it('devolve o mesmo resultado que a versão unitária, telefone a telefone', async () => {
    const phones = ['5562991110797', '62991590750', '5562981454927', '5562992944659', '5562900000000', '5562991110797'];
    const batch = await getAttributionsByPhones(phones);
    for (const p of phones) {
      expect(strip(batch.get(p))).toEqual(strip(await getAttributionByPhone(p)));
    }
    expect(batch.get('5562991110797').source).toBe('meta_ads');
    expect(batch.get('62991590750').source).toBe('instagram');
    expect(batch.get('5562981454927')).toMatchObject({ source: 'tiktok', from: 'lead', ttclid: 'tt1' });
    expect(batch.get('5562992944659')).toMatchObject({ source: null, from: 'lead' });
    expect(batch.get('5562900000000')).toBeNull();
  });

  it('lista vazia não consulta nada', async () => {
    expect((await getAttributionsByPhones([])).size).toBe(0);
  });
});

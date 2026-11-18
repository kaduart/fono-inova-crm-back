/**
 * 18/11/2026: gclid capturado na leadattribution não chegava ao Lead nem à AdConversion,
 * então o google-offline.csv saía só com a linha de exemplo.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import LeadAttribution from '../../models/LeadAttribution.js';
import Lead from '../../models/Leads.js';
import {
  captureInboundAttribution, syncLeadGclid, findGclidForConversion, leadPhoneFormats,
} from '../../services/leadAttributionService.js';

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await LeadAttribution.collection.deleteMany({});
  await Lead.collection.deleteMany({});
});

const leadOf = (id) => Lead.collection.findOne({ _id: id });

describe('leadPhoneFormats', () => {
  it('cobre 55, +55, sem DDI e com/sem o 9', () => {
    const f = leadPhoneFormats('5562991590750');
    expect(f).toEqual(expect.arrayContaining(['5562991590750', '+5562991590750', '62991590750', '556291590750', '6291590750']));
  });
});

describe('syncLeadGclid', () => {
  it('grava gclid, origem google_ads e campanha no lead do telefone (qualquer formato)', async () => {
    const { insertedId } = await Lead.collection.insertOne({ name: 'A', contact: { phone: '+5562991590750' }, metaTracking: { source: 'website' } });
    const n = await syncLeadGclid({ phone: '556291590750', gclid: 'G1', campaign: 'camp' });
    expect(n).toBe(1);
    const l = await leadOf(insertedId);
    expect(l.metaTracking).toMatchObject({ gclid: 'G1', source: 'google_ads', campaign: 'camp' });
  });

  it('não sobrescreve gclid existente nem origem paga de outra plataforma', async () => {
    const { insertedId } = await Lead.collection.insertOne({ name: 'B', contact: { phone: '5562991590750' }, metaTracking: { source: 'meta_ads', gclid: 'OLD', campaign: 'x' } });
    expect(await syncLeadGclid({ phone: '5562991590750', gclid: 'NEW', campaign: 'y' })).toBe(0);
    expect((await leadOf(insertedId)).metaTracking).toMatchObject({ gclid: 'OLD', source: 'meta_ads', campaign: 'x' });
  });
});

describe('captureInboundAttribution com gclid', () => {
  it('telefone com origem forte sem gclid ganha o gclid da mensagem seguinte e o lead também', async () => {
    await LeadAttribution.collection.insertOne({ phone: '5562991590750', source: 'meta_ads', method: 'ctwa', confidence: 'high', gclid: null, firstMessageAt: new Date('2026-11-10') });
    const { insertedId } = await Lead.collection.insertOne({ name: 'C', contact: { phone: '5562991590750' }, metaTracking: { source: '' } });
    await captureInboundAttribution({ phone: '5562991590750', text: 'Olá\n---ref:google_ads|avaliacao|GCL123|utm_source=google' });
    const attr = await LeadAttribution.collection.findOne({ phone: '5562991590750' });
    expect(attr).toMatchObject({ source: 'meta_ads', gclid: 'GCL123', campaign: 'avaliacao' }); // first-touch preservado
    const lead = await leadOf(insertedId);
    expect(lead.metaTracking).toMatchObject({ gclid: 'GCL123', source: 'google_ads', campaign: 'avaliacao' });
  });
});

describe('findGclidForConversion', () => {
  it('1º usa o gclid do lead do agendamento', async () => {
    const { insertedId } = await Lead.collection.insertOne({ name: 'D', contact: { phone: '5562999990000' }, metaTracking: { gclid: 'LEADG', campaign: 'c1' } });
    expect(await findGclidForConversion({ leadId: insertedId, phone: null })).toMatchObject({ gclid: 'LEADG', campaign: 'c1', method: 'lead' });
  });

  it('sem gclid no lead, usa a leadattribution com gclid do telefone (variante sem o 9)', async () => {
    const { insertedId } = await Lead.collection.insertOne({ name: 'E', contact: { phone: '5562988887777' }, metaTracking: { source: '' } });
    await LeadAttribution.collection.insertOne({ phone: '556288887777', source: 'google_ads', method: 'site_signature', gclid: 'ATTRG', campaign: 'c2', firstMessageAt: new Date() });
    expect(await findGclidForConversion({ leadId: insertedId, phone: '5562988887777' })).toMatchObject({ gclid: 'ATTRG', campaign: 'c2' });
  });

  it('nada encontrado → null', async () => {
    expect(await findGclidForConversion({ leadId: null, phone: '5562900000000' })).toBeNull();
  });
});

/**
 * 18/11/2026: anúncio click-to-WhatsApp (com ou sem ctwa_clid) chega ao Lead como Meta Ads,
 * e um clid que chega depois completa a leadattribution sem trocar a origem first-touch.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import LeadAttribution from '../../models/LeadAttribution.js';
import Lead from '../../models/Leads.js';
import { captureInboundAttribution, syncLeadCtwa, getAttributionByPhone } from '../../services/leadAttributionService.js';

let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); }, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => { await LeadAttribution.collection.deleteMany({}); await Lead.collection.deleteMany({}); });

const PHONE = '5562991590750';
const CLID = 'ARAkLkA8rmlFeiCktEJQ-QTwRmyU9y4';
const insertLead = async (metaTracking = {}, phone = PHONE) =>
  (await Lead.collection.insertOne({ name: 'X', contact: { phone }, metaTracking })).insertedId;

describe('syncLeadCtwa', () => {
  it('origem fraca (palavra-chave instagram) vira meta_ads com adId, link e clid', async () => {
    const id = await insertLead({ source: 'instagram' }, '62991590750');
    const n = await syncLeadCtwa({ phone: PHONE, adId: '120', ctwaClid: CLID, adSourceUrl: 'https://fb.me/x' });
    expect(n).toBe(1);
    const l = await Lead.collection.findOne({ _id: id });
    expect(l.metaTracking).toMatchObject({ source: 'meta_ads', adId: '120', ctwaClid: CLID, adSourceUrl: 'https://fb.me/x' });
  });

  it('não troca origem paga de outra plataforma nem sobrescreve clid', async () => {
    const id = await insertLead({ source: 'google_ads', ctwaClid: 'ARAoutroclid000' });
    await syncLeadCtwa({ phone: PHONE, adId: '120', ctwaClid: CLID });
    const l = await Lead.collection.findOne({ _id: id });
    expect(l.metaTracking.source).toBe('google_ads');
    expect(l.metaTracking.ctwaClid).toBe('ARAoutroclid000');
  });

  it('idempotente', async () => {
    await insertLead({});
    expect(await syncLeadCtwa({ phone: PHONE, adId: '120' })).toBe(1);
    expect(await syncLeadCtwa({ phone: PHONE, adId: '120' })).toBe(0);
  });
});

describe('captureInboundAttribution com anúncio', () => {
  it('anúncio sem clid grava Meta Ads; clid que chega depois completa sem trocar a origem', async () => {
    await insertLead({});
    await captureInboundAttribution({ phone: PHONE, text: 'Olá', ctwa: { sourceId: '120', sourceUrl: 'https://www.instagram.com/p/x/', ctwaClid: null } });
    let la = await LeadAttribution.findOne({ phone: PHONE }).lean();
    expect(la).toMatchObject({ source: 'instagram_ads', method: 'ctwa', adId: '120', ctwaClid: null });

    await captureInboundAttribution({ phone: PHONE, text: 'oi', ctwa: { sourceId: '120', sourceUrl: 'https://fb.me/y', ctwaClid: CLID } });
    la = await LeadAttribution.findOne({ phone: PHONE }).lean();
    expect(la.source).toBe('instagram_ads');
    expect(la.ctwaClid).toBe(CLID);

    const attr = await getAttributionByPhone(PHONE);
    expect(attr.ctwaClid).toBe(CLID);
    const lead = await Lead.collection.findOne({ 'contact.phone': PHONE });
    expect(lead.metaTracking).toMatchObject({ source: 'meta_ads', adId: '120', ctwaClid: CLID });
  });

  it('"vim pelo Instagram" e depois anúncio: o anúncio substitui a palavra-chave', async () => {
    await captureInboundAttribution({ phone: PHONE, text: 'Vim pelo Instagram' });
    await captureInboundAttribution({ phone: PHONE, text: 'oi', ctwa: { sourceId: '120', sourceUrl: 'https://fb.me/y' } });
    const la = await LeadAttribution.findOne({ phone: PHONE }).lean();
    expect(la).toMatchObject({ source: 'meta_ads', method: 'ctwa', confidence: 'high', adId: '120' });
  });
});

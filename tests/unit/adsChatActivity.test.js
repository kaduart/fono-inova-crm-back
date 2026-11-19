/**
 * Retomada dos leads de anúncio: lista os telefones de anúncio e confere a última conversa (SÓ LEITURA),
 * guardando o resultado só no WhatsAppScanRun.
 */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { default: LeadAttribution } = await import('../../models/LeadAttribution.js');
const { default: WhatsAppScanRun } = await import('../../models/WhatsAppScanRun.js');
const { listAdPhones, runAdsChatActivity, startOfDayBRT } = await import('../../services/adsChatActivity.js');

let mongod;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => { await LeadAttribution.deleteMany({}); await WhatsAppScanRun.deleteMany({}); });

describe('adsChatActivity', () => {
    it('startOfDayBRT = meia-noite de Brasília em UTC', () => {
        expect(startOfDayBRT('2026-10-20').toISOString()).toBe('2026-10-20T03:00:00.000Z');
        expect(startOfDayBRT('20/10/2026')).toBeNull();
    });

    it('listAdPhones pega só anúncio (source *_ads ou ctwa) a partir da data', async () => {
        const since = startOfDayBRT('2026-10-20');
        await LeadAttribution.create([
            { phone: '5562999990001', source: 'meta_ads', method: 'token', firstMessageAt: new Date('2026-10-25') },
            { phone: '5562999990002', source: 'instagram', method: 'ctwa', firstMessageAt: new Date('2026-10-25') },
            { phone: '5562999990003', source: 'instagram', method: 'keyword', firstMessageAt: new Date('2026-10-25') },
            { phone: '5562999990004', source: 'google_ads', method: 'token', firstMessageAt: new Date('2026-10-01') },
        ]);
        expect((await listAdPhones({ since })).sort()).toEqual(['5562999990001', '5562999990002']);
    });

    it('runAdsChatActivity passa só os finais de 8 dígitos e devolve as linhas dos telefones pedidos', async () => {
        const run = await WhatsAppScanRun.create({ kind: 'ads_chat_activity', convenio: 'ads', phones: ['5562999990001', '556299990002'] });
        const clinicAt = new Date('2026-11-18T12:00:00Z');
        const readChatActivity = vi.fn(async () => ({
            chats: 10, unresolved: 1,
            rows: [
                { phone: '5562999990001', clinicAt, contactAt: null },
                { phone: '5562988887777', clinicAt, contactAt: clinicAt }, // fora da lista
            ],
        }));
        const stats = await runAdsChatActivity({ runId: run._id, readChatActivity });
        expect([...readChatActivity.mock.calls[0][0].onlyTails].sort()).toEqual(['99990001', '99990002']);
        expect(stats).toMatchObject({ people: 2, chats: 10, withChat: 1, unresolved: 1 });
        expect(stats.rows).toEqual([{ phone: '5562999990001', clinicAt, contactAt: null }]);
    });

    it('scan sem telefones não chama o WhatsApp', async () => {
        const run = await WhatsAppScanRun.create({ kind: 'ads_chat_activity', convenio: 'ads', phones: [] });
        const readChatActivity = vi.fn();
        expect((await runAdsChatActivity({ runId: run._id, readChatActivity })).people).toBe(0);
        expect(readChatActivity).not.toHaveBeenCalled();
    });
});

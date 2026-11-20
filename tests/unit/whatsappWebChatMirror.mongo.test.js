/**
 * Ponte WhatsApp Web → tela Conversas contra um MongoDB DESCARTÁVEL, com telefones fictícios.
 * Confere: chave desligada não grava nada; recebida cria a conversa (lead mínimo sem Amanda);
 * reprocessar não duplica; resposta pelo celular entra como humana e zera não lidas; mensagem que o
 * ERP já gravou não é copiada; catch-up antigo não passa à frente da última; e as rotas que a tela
 * usa (inbox e mensagens) devolvem o que foi gravado.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const emitted = vi.hoisted(() => []);
vi.mock('../../config/socket.js', () => ({ emitSocketEvent: async (event, payload) => { emitted.push({ event, payload }); return { emitted: true }; } }));

const Message = (await import('../../models/Message.js')).default;
const ChatProjection = (await import('../../models/ChatProjection.js')).default;
const Lead = (await import('../../models/Leads.js')).default;
const { mirrorWebMessage, scheduleOutboundMirror, contentOf } = await import('../../services/whatsappWebChatMirror.js');
const { getChatInbox } = await import('../../routes/chat/inbox.js');
const { getChatMessages } = await import('../../routes/chat/messages.js');

const ON = { WA_WEB_CHAT_MIRROR: 'on', CLINIC_PHONE_E164: '5562900000000' };
const quiet = { info() {}, warn() {} };
const T0 = 1_795_000_000; // 2026-11-18, segundos
const PHONE = '5562999990001';

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

let mongod;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Message.init();
});
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  await Promise.all([Message.deleteMany({}), ChatProjection.deleteMany({}), Lead.deleteMany({})]);
  emitted.length = 0;
});

const inbound = (over = {}) => ({ direction: 'inbound', waMessageId: `false_${PHONE}@c.us_A1`, phone: PHONE, body: 'Oi, quero agendar avaliação', type: 'chat', timestamp: T0, notifyName: 'Ana Teste', ...over });

describe('chave', () => {
  it('desligada (padrão): não grava nada', async () => {
    const r = await mirrorWebMessage(inbound(), { env: {}, log: quiet });
    expect(r.status).toBe('off');
    expect(await Message.countDocuments()).toBe(0);
    expect(await Lead.countDocuments()).toBe(0);
    expect(await ChatProjection.countDocuments()).toBe(0);
  });
  it('só "on" liga', async () => {
    expect((await mirrorWebMessage(inbound(), { env: { WA_WEB_CHAT_MIRROR: 'true' }, log: quiet })).status).toBe('off');
  });
});

describe('recebida', () => {
  it('telefone novo: cria lead mínimo sem Amanda, a mensagem e a linha da conversa', async () => {
    const r = await mirrorWebMessage(inbound(), { env: ON, log: quiet });
    expect(r.status).toBe('saved');
    const lead = await Lead.findOne({}).lean();
    expect(lead.contact.phone).toBe(PHONE);
    expect(lead.autoReplyEnabled).toBe(false);
    expect(lead.name).toBe('Ana Teste');
    const msg = await Message.findOne({}).lean();
    expect(msg).toMatchObject({ direction: 'inbound', from: PHONE, to: '5562900000000', type: 'text', content: 'Oi, quero agendar avaliação', status: 'received' });
    expect(String(msg.lead)).toBe(String(lead._id));
    const chat = await ChatProjection.findOne({}).lean();
    expect(chat).toMatchObject({ phone: PHONE, lastMessage: 'Oi, quero agendar avaliação', lastDirection: 'inbound', unreadCount: 1 });
    expect(chat.lastMessageAt).toEqual(new Date(T0 * 1000));
    expect(emitted.map((e) => e.event)).toEqual(['message:new']);
  });

  it('o mesmo evento de novo (catch-up, reenvio): não duplica nem soma não lida', async () => {
    await mirrorWebMessage(inbound(), { env: ON, log: quiet });
    const r = await mirrorWebMessage(inbound({ source: 'catchup' }), { env: ON, log: quiet });
    expect(r.status).toBe('exists');
    expect(await Message.countDocuments()).toBe(1);
    expect(await Lead.countDocuments()).toBe(1);
    expect((await ChatProjection.findOne({}).lean()).unreadCount).toBe(1);
  });

  it('lead existente com o telefone em outro formato (+, sem o 9): reaproveita, não cria outro', async () => {
    const lead = await Lead.create({ name: 'Família Teste', contact: { phone: '+556299990001' } });
    const r = await mirrorWebMessage(inbound(), { env: ON, log: quiet });
    expect(r.leadId).toBe(String(lead._id));
    expect(await Lead.countDocuments()).toBe(1);
    expect((await ChatProjection.findOne({}).lean()).contactName).toBe('Família Teste');
  });

  it('áudio sem texto vira [áudio]; imagem com legenda mantém a legenda', async () => {
    expect(contentOf('', 'ptt')).toBe('[áudio]');
    expect(contentOf('olha o laudo', 'image')).toBe('[imagem] olha o laudo');
    await mirrorWebMessage(inbound({ body: '', type: 'ptt' }), { env: ON, log: quiet });
    const msg = await Message.findOne({}).lean();
    expect(msg).toMatchObject({ type: 'audio', content: '[áudio]' });
  });

  it('sem telefone resolvido (@lid) ou sem id: ignora', async () => {
    expect((await mirrorWebMessage(inbound({ phone: null }), { env: ON, log: quiet })).status).toBe('skipped');
    expect((await mirrorWebMessage(inbound({ waMessageId: null }), { env: ON, log: quiet })).status).toBe('skipped');
    expect(await Message.countDocuments()).toBe(0);
  });
});

describe('enviada pela clínica', () => {
  it('resposta pelo celular: entra como humana (manual) e zera não lidas', async () => {
    await mirrorWebMessage(inbound(), { env: ON, log: quiet });
    await mirrorWebMessage({ direction: 'outbound', waMessageId: `true_${PHONE}@c.us_B1`, phone: PHONE, body: 'Oi Ana! Temos amanhã à tarde.', type: 'chat', timestamp: T0 + 60 }, { env: ON, log: quiet });
    const out = await Message.findOne({ direction: 'outbound' }).lean();
    expect(out).toMatchObject({ from: '5562900000000', to: PHONE, status: 'sent', metadata: { sentBy: 'manual' } });
    const chat = await ChatProjection.findOne({}).lean();
    expect(chat).toMatchObject({ lastDirection: 'outbound', unreadCount: 0, lastMessage: 'Oi Ana! Temos amanhã à tarde.' });
  });

  it('mensagem que o ERP já gravou (mesmo waMessageId): não copia e não mexe na conversa', async () => {
    const lead = await Lead.create({ contact: { phone: PHONE } });
    await Message.create({ waMessageId: `true_${PHONE}@c.us_ERP`, from: '5562900000000', to: PHONE, direction: 'outbound', content: 'enviada pelo ERP', status: 'sent', lead: lead._id, metadata: { sentBy: 'manual' } });
    const r = await mirrorWebMessage({ direction: 'outbound', waMessageId: `true_${PHONE}@c.us_ERP`, phone: PHONE, body: 'enviada pelo ERP', timestamp: T0 }, { env: ON, log: quiet });
    expect(r.status).toBe('exists');
    expect(await Message.countDocuments()).toBe(1);
    expect(await ChatProjection.countDocuments()).toBe(0);
  });

  it('a cópia da enviada espera o atraso configurado e não segura quem chamou', async () => {
    const timers = [];
    const scheduled = scheduleOutboundMirror({ waMessageId: 'true_x_C1', phone: PHONE, body: 'oi', timestamp: T0 }, { env: { ...ON, WA_WEB_CHAT_MIRROR_OUTBOUND_DELAY_MS: '15000' }, log: quiet, setTimer: (fn, ms) => timers.push({ fn, ms }) });
    expect(scheduled).toBe(true);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(15000);
    expect(await Message.countDocuments()).toBe(0);
    expect(scheduleOutboundMirror({ waMessageId: 'y', phone: PHONE }, { env: {}, setTimer: () => { throw new Error('não deveria agendar'); } })).toBe(false);
  });
});

describe('ordem', () => {
  it('mensagem antiga (catch-up) é gravada, mas não passa à frente da última da conversa', async () => {
    await mirrorWebMessage(inbound({ waMessageId: 'novo', body: 'mensagem nova', timestamp: T0 + 600 }), { env: ON, log: quiet });
    await mirrorWebMessage(inbound({ waMessageId: 'velho', body: 'mensagem velha', timestamp: T0, source: 'catchup' }), { env: ON, log: quiet });
    expect(await Message.countDocuments()).toBe(2);
    const chat = await ChatProjection.findOne({}).lean();
    expect(chat.lastMessage).toBe('mensagem nova');
    expect(chat.unreadCount).toBe(1);
  });
});

describe('rotas da tela Conversas', () => {
  it('inbox lista a conversa e as mensagens aparecem em ordem', async () => {
    await mirrorWebMessage(inbound(), { env: ON, log: quiet });
    await mirrorWebMessage({ direction: 'outbound', waMessageId: 'resp', phone: PHONE, body: 'Respondido', timestamp: T0 + 30 }, { env: ON, log: quiet });
    const inboxRes = fakeRes();
    await getChatInbox({ query: {} }, inboxRes);
    expect(inboxRes.body.success).toBe(true);
    expect(inboxRes.body.data).toHaveLength(1);
    expect(inboxRes.body.data[0]).toMatchObject({ phone: PHONE, lastMessage: 'Respondido' });
    const msgsRes = fakeRes();
    await getChatMessages({ params: { leadId: String(inboxRes.body.data[0].leadId) }, query: {} }, msgsRes);
    expect(msgsRes.body.data.map((m) => m.content)).toEqual(['Oi, quero agendar avaliação', 'Respondido']);
  });
});

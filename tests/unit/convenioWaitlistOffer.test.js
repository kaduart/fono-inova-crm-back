import { describe, expect, it } from 'vitest';
import { buildAccreditedText, buildPrivateOfferText, offerCapacity, OFFER_DAILY_CAP } from '../../services/convenioWaitlistOffer.js';

// 12/11/2026 é quinta-feira. Horário de São Paulo = UTC-3.
const sp = (hh, mm = 0, day = 12) => new Date(Date.UTC(2026, 10, day, hh + 3, mm));

describe('textos do envio em massa (texto do Kadu, negrito do WhatsApp)', () => {
    it('retomar contato: primeiro nome, atendente, convênio e especialidade', () => {
        const t = buildPrivateOfferText({ name: 'ANA PAULA SILVA', convenio: 'ipasgo', especialidade: 'Fonoaudiologia', atendente: 'Bia' });
        const lines = t.split('\n');
        expect(lines[0]).toBe('Oi, Ana! Tudo bem? 🥰💚');
        expect(lines[1]).toBe('');
        expect(lines[2]).toBe('Aqui é a Bia, da *Clínica Fono Inova!*');
        expect(t).toContain('atendimento pelo *IPASGO*, lembra?');
        expect(t).toContain('acompanhamento em *fonoaudiologia*. 💚');
        expect(t).not.toContain('**');
        expect(lines.at(-1)).toBe('*Me conta, ainda podemos te ajudar com esse atendimento?* 😊');
    });

    it('retomar contato sem nome, atendente nem especialidade', () => {
        const t = buildPrivateOfferText({ name: 'Contato do WhatsApp', convenio: 'geap' });
        expect(t.startsWith('Oi! Tudo bem?')).toBe(true);
        expect(t).toContain('Aqui é da *Clínica Fono Inova!*');
        expect(t).toContain('procurando esse acompanhamento. 💚');
    });

    it('agora atendemos: convênio e especialidades liberadas', () => {
        const t = buildAccreditedText({ name: 'joão', convenio: 'unimed', especialidades: 'Fonoaudiologia e Psicologia' });
        expect(t.startsWith('Oi, João! Tudo bem? 🥰💚')).toBe(true);
        expect(t).toContain('*agora estamos atendendo pelo Unimed em fonoaudiologia e psicologia!* 💚✨');
        expect(t).not.toContain('R$');
        expect(buildAccreditedText({ name: '', convenio: 'ipasgo' })).toContain('*agora estamos atendendo pelo IPASGO!* 💚✨');
    });
});

describe('offerCapacity (anti-bloqueio)', () => {
    it('limita pelo teto diário e pelo horário', () => {
        expect(offerCapacity({ now: sp(9), sentToday: 0 }).capacity).toBe(OFFER_DAILY_CAP);
        expect(offerCapacity({ now: sp(9), sentToday: OFFER_DAILY_CAP }).reason).toBe('limite_diario');
        expect(offerCapacity({ now: sp(9), sentToday: OFFER_DAILY_CAP }).capacity).toBe(0);
        const late = offerCapacity({ now: sp(18, 15), sentToday: 0 });
        expect(late.capacity).toBeGreaterThan(0);
        expect(late.capacity).toBeLessThan(OFFER_DAILY_CAP);
        expect(offerCapacity({ now: sp(19), sentToday: 0 }).capacity).toBe(0);
        expect(offerCapacity({ now: sp(7), sentToday: 0 }).capacity).toBe(0);
        expect(offerCapacity({ now: sp(10, 0, 14), sentToday: 0 }).reason).toBe('fim_de_semana'); // sábado
    });
});

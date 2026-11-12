import { describe, expect, it } from 'vitest';
import { buildAccreditedText, buildPrivateOfferText, offerCapacity, OFFER_DAILY_CAP } from '../../services/convenioWaitlistOffer.js';

// 12/11/2026 é quinta-feira. Horário de São Paulo = UTC-3.
const sp = (hh, mm = 0, day = 12) => new Date(Date.UTC(2026, 10, day, hh + 3, mm));

describe('textos do envio em massa', () => {
    it('particular: primeiro nome, valor antes do preço, horário genérico, 1 coração', () => {
        const t = buildPrivateOfferText({ name: 'ANA PAULA SILVA', convenio: 'ipasgo', especialidade: 'Fonoaudiologia' });
        expect(t.startsWith('Oi, Ana!')).toBe(true);
        expect(t).toContain('IPASGO');
        expect(t.indexOf('faz diferença')).toBeLessThan(t.indexOf('R$ 180'));
        expect(t).toContain('quinta de manhã');
        expect(t.match(/💚/g)).toHaveLength(1);
    });

    it('credenciado: avisa que agora atende o plano, sem preço, com especialidades liberadas', () => {
        const t = buildAccreditedText({ name: 'Contato do WhatsApp', convenio: 'unimed', especialidades: 'Fonoaudiologia e Psicologia' });
        expect(t.startsWith('Oi!')).toBe(true);
        expect(t).toContain('agora atendemos pelo Unimed em fonoaudiologia e psicologia');
        expect(t).not.toContain('R$');
        expect(t.match(/💚/g)).toHaveLength(1);
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

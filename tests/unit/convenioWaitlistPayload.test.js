import { describe, expect, it } from 'vitest';
import { WAITLIST_CONSENT_VERSIONS } from '../../constants/convenioWaitlist.js';
import { parseWaitlistPayload } from '../../utils/convenioWaitlistPayload.js';

const CONSENT = { aceito: true, versao: WAITLIST_CONSENT_VERSIONS[0] };

const validBody = {
    nome: '  Maria   da Silva ',
    telefone: '(62) 99201-3573',
    email: 'Maria@Email.com',
    convenio: 'GEAP',
    especialidade: 'Terapia Ocupacional',
    idadeCrianca: '4',
    periodo: 'Manhã',
    consentimento: CONSENT,
    origem: { source: 'instagram', medium: 'bio', campaign: 'links', referrer: 'direct' },
    contexto: { pagePath: '/convenio-geap-anapolis' },
    device: { type: 'mobile' },
    ga4: { clientId: 'abc.123' },
};

describe('parseWaitlistPayload', () => {
    it('normaliza um cadastro válido', () => {
        const result = parseWaitlistPayload(validBody);
        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({
            name: 'Maria da Silva',
            phone: '5562992013573',
            email: 'maria@email.com',
            convenio: 'geap',
            especialidade: 'Terapia Ocupacional',
            idadeCrianca: 4,
            periodo: 'Manhã',
            consentVersion: WAITLIST_CONSENT_VERSIONS[0],
        });
        expect(result.value.source).toMatchObject({
            pagePath: '/convenio-geap-anapolis',
            utmSource: 'instagram',
            deviceType: 'mobile',
            ga4ClientId: 'abc.123',
        });
    });

    it('aceita cadastro só com o obrigatório: e-mail e detalhes são opcionais', () => {
        const result = parseWaitlistPayload({
            nome: 'João Pedro',
            telefone: '62992013573',
            convenio: 'ipasgo',
            consentimento: CONSENT,
        });
        expect(result.ok).toBe(true);
        expect(result.value.email).toBeNull();
        expect(result.value.idadeCrianca).toBeNull();
        expect(result.value.especialidade).toBeNull();
    });

    it('exige consentimento explícito (true booleano) — ausente, false ou texto são rejeitados', () => {
        const message = 'Consentimento de contato e privacidade é obrigatório';
        expect(parseWaitlistPayload({ ...validBody, consentimento: undefined })).toEqual({ ok: false, message });
        expect(parseWaitlistPayload({ ...validBody, consentimento: { versao: CONSENT.versao } })).toEqual({ ok: false, message });
        expect(parseWaitlistPayload({ ...validBody, consentimento: { aceito: false, versao: CONSENT.versao } })).toEqual({ ok: false, message });
        expect(parseWaitlistPayload({ ...validBody, consentimento: { aceito: 'true', versao: CONSENT.versao } })).toEqual({ ok: false, message });
    });

    it('rejeita versão de consentimento desconhecida ou ausente', () => {
        const message = 'Versão do consentimento inválida';
        expect(parseWaitlistPayload({ ...validBody, consentimento: { aceito: true, versao: 'v-inventada' } })).toEqual({ ok: false, message });
        expect(parseWaitlistPayload({ ...validBody, consentimento: { aceito: true } })).toEqual({ ok: false, message });
    });

    it('rejeita convênio desconhecido', () => {
        expect(parseWaitlistPayload({ ...validBody, convenio: 'unimed' })).toEqual({ ok: false, message: 'Convênio inválido' });
        expect(parseWaitlistPayload({ ...validBody, convenio: undefined }).ok).toBe(false);
    });

    it('rejeita nome curto ou ausente', () => {
        expect(parseWaitlistPayload({ ...validBody, nome: 'Jo' }).ok).toBe(false);
        expect(parseWaitlistPayload({ ...validBody, nome: '   ' }).ok).toBe(false);
    });

    it('rejeita telefone inválido', () => {
        expect(parseWaitlistPayload({ ...validBody, telefone: '123' }).ok).toBe(false);
        expect(parseWaitlistPayload({ ...validBody, telefone: '' }).ok).toBe(false);
    });

    it('rejeita e-mail mal formado, mas aceita ausente ou vazio', () => {
        expect(parseWaitlistPayload({ ...validBody, email: 'sem-arroba' }).ok).toBe(false);
        expect(parseWaitlistPayload({ ...validBody, email: '' }).ok).toBe(true);
        expect(parseWaitlistPayload({ ...validBody, email: undefined }).ok).toBe(true);
    });

    it('descarta idade fora de 0–18 em vez de rejeitar o cadastro', () => {
        expect(parseWaitlistPayload({ ...validBody, idadeCrianca: '45' }).value.idadeCrianca).toBeNull();
        expect(parseWaitlistPayload({ ...validBody, idadeCrianca: 'abc' }).value.idadeCrianca).toBeNull();
        expect(parseWaitlistPayload({ ...validBody, idadeCrianca: 0 }).value.idadeCrianca).toBe(0);
    });

    it('não quebra com body inválido', () => {
        expect(parseWaitlistPayload(undefined).ok).toBe(false);
        expect(parseWaitlistPayload('texto').ok).toBe(false);
    });
});

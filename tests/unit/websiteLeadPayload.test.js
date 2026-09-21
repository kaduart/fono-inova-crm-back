import { describe, expect, it } from 'vitest';
import { extractWebsiteLeadPersonalData } from '../../utils/websiteLeadPayload.js';

describe('extractWebsiteLeadPersonalData (POST /api/leads/from-website)', () => {
    it('formato original: dadosPessoais', () => {
        const result = extractWebsiteLeadPersonalData({
            dadosPessoais: { nome: 'Ana Paula', telefone: '(62) 99201-3573', email: 'ana@email.com' },
        });
        expect(result).toEqual({
            nome: 'Ana Paula',
            telefone: '(62) 99201-3573',
            email: 'ana@email.com',
            format: 'dadosPessoais',
        });
    });

    it('formato do site: nome/telefone/email no topo do body', () => {
        const result = extractWebsiteLeadPersonalData({
            nome: 'Bruno Lima',
            telefone: '+55 (62) 99201-3573',
            email: 'bruno@email.com',
        });
        expect(result).toEqual({
            nome: 'Bruno Lima',
            telefone: '+55 (62) 99201-3573',
            email: 'bruno@email.com',
            format: 'flat',
        });
    });

    it('quando os dois formatos vêm juntos (como o site envia hoje), dadosPessoais tem precedência', () => {
        const result = extractWebsiteLeadPersonalData({
            nome: 'Nome do topo',
            telefone: '62111111111',
            dadosPessoais: { nome: 'Nome estruturado', telefone: '62222222222' },
        });
        expect(result).toMatchObject({ nome: 'Nome estruturado', telefone: '62222222222', format: 'dadosPessoais' });
    });

    it('dadosPessoais incompleto não bloqueia: cai para o formato do topo', () => {
        const result = extractWebsiteLeadPersonalData({
            nome: 'Carla Dias',
            telefone: '62333333333',
            dadosPessoais: { nome: 'Sem telefone' },
        });
        expect(result).toMatchObject({ nome: 'Carla Dias', telefone: '62333333333', format: 'flat' });
    });

    it('e-mail é opcional nos dois formatos', () => {
        expect(extractWebsiteLeadPersonalData({ dadosPessoais: { nome: 'A', telefone: '1' } }).email).toBeNull();
        expect(extractWebsiteLeadPersonalData({ nome: 'A', telefone: '1' }).email).toBeNull();
    });

    it('devolve null sem nome e telefone (a rota responde 400)', () => {
        expect(extractWebsiteLeadPersonalData({ nome: 'Só nome' })).toBeNull();
        expect(extractWebsiteLeadPersonalData({ telefone: '62999999999' })).toBeNull();
        expect(extractWebsiteLeadPersonalData({ dadosPessoais: { email: 'a@b.com' } })).toBeNull();
        expect(extractWebsiteLeadPersonalData({})).toBeNull();
        expect(extractWebsiteLeadPersonalData(undefined)).toBeNull();
        expect(extractWebsiteLeadPersonalData('texto')).toBeNull();
    });
});

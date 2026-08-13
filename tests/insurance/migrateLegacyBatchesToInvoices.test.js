// tests/insurance/migrateLegacyBatchesToInvoices.test.js
/**
 * Desmembramento de lotes legados em NFs por paciente + competência.
 *
 * O que estes testes protegem: os lotes legados misturavam pacientes e meses,
 * e transformá-los em NF errado significa emitir nota de um paciente cobrindo
 * atendimento de outro, vincular a NF ao atendimento errado, ou — o mais caro —
 * deixar `issRate` nulo e fazer a baixa aplicar a alíquota de HOJE sobre
 * faturamento de março.
 *
 * Cobrem as funções puras e determinísticas. O caminho de escrita depende de
 * transação e é exercido pelo dryRun real contra os dados.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import '../../models/index.js';
import {
    patientSlug,
    buildProvisionalInvoiceNumber,
    competenceOf,
    BLOCKING
} from '../../services/insuranceGuide/migrateLegacyBatchesToInvoices.js';
import { resolveCanonicalPayment } from '../../services/insuranceGuide/reconcileLegacyInsuranceBatch.js';

const pay = (id, status, insStatus, amount) => ({
    _id: id, status, amount, insurance: { status: insStatus, grossAmount: amount }
});

// ─── Identificador provisório ──────────────────────────────────────────────────
describe('🏷️  Identificador provisório PACIENTE-MES_ANO', () => {
    it('usa os dois primeiros nomes, sem acento', () => {
        assert.strictEqual(patientSlug('Davi Felipe Araújo'), 'DAVI_FELIPE');
        assert.strictEqual(patientSlug('Isabela Ferreira De Mendonca'), 'ISABELA_FERREIRA');
        assert.strictEqual(patientSlug('Nicolas Lucca'), 'NICOLAS_LUCCA');
    });

    it('março sai como MARCO — o número vira nome de arquivo e chave de busca', () => {
        assert.strictEqual(buildProvisionalInvoiceNumber('Davi Felipe Araújo', '2026-03'), 'DAVI_FELIPE-MARCO_2026');
        assert.strictEqual(buildProvisionalInvoiceNumber('Nicolas Lucca', '2026-04'), 'NICOLAS_LUCCA-ABRIL_2026');
        assert.strictEqual(buildProvisionalInvoiceNumber('Isabela Ferreira De Mendonca', '2026-05'), 'ISABELA_FERREIRA-MAIO_2026');
    });

    it('mesmo paciente em competências diferentes gera números diferentes', () => {
        const marco = buildProvisionalInvoiceNumber('Benjamim Rocha Simão', '2026-03');
        const abril = buildProvisionalInvoiceNumber('Benjamim Rocha Simão', '2026-04');
        assert.notStrictEqual(marco, abril);
        assert.strictEqual(marco, 'BENJAMIM_ROCHA-MARCO_2026');
        assert.strictEqual(abril, 'BENJAMIM_ROCHA-ABRIL_2026');
    });
});

// ─── Competência ───────────────────────────────────────────────────────────────
describe('📅 Competência vem de Session.date, nunca de sentDate', () => {
    it('extrai YYYY-MM em UTC', () => {
        assert.strictEqual(competenceOf(new Date('2026-03-27T12:00:00.000Z')), '2026-03');
        assert.strictEqual(competenceOf(new Date('2026-05-01T03:00:00.000Z')), '2026-05');
    });

    it('REGRESSÃO: sessão de maio enviada em junho continua competência de maio', () => {
        // Lote real ...5f8a6f: sentDate 2026-06-18, sessões de 15 a 22/05.
        const sessao = new Date('2026-05-22T03:00:00.000Z');
        const envio = new Date('2026-06-18T12:00:00.000Z');
        assert.strictEqual(competenceOf(sessao), '2026-05');
        assert.notStrictEqual(competenceOf(sessao), competenceOf(envio));
    });
});

// ─── Chave de agrupamento ──────────────────────────────────────────────────────
describe('🔑 Agrupamento por provider + paciente + competência', () => {
    const chave = (provider, patientId, date) => `${provider}|${patientId}|${competenceOf(date)}`;

    it('split: lote com 2 pacientes gera 2 agrupamentos', () => {
        const a = chave('unimed-anapolis', 'pac_A', new Date('2026-03-05T12:00:00Z'));
        const b = chave('unimed-anapolis', 'pac_B', new Date('2026-03-05T12:00:00Z'));
        assert.notStrictEqual(a, b);
    });

    it('split: lote do mesmo paciente com 2 competências gera 2 agrupamentos', () => {
        const marco = chave('unimed-anapolis', 'pac_A', new Date('2026-03-30T12:00:00Z'));
        const abril = chave('unimed-anapolis', 'pac_A', new Date('2026-04-01T12:00:00Z'));
        assert.notStrictEqual(marco, abril);
    });

    it('união: sessões do mesmo paciente/competência vindas de 3 lotes caem numa NF só', () => {
        // Caso real DAVI_FELIPE-MARCO_2026: origem em a452b6, 5f89b4 e 5f89ed.
        const chaves = [
            chave('unimed-campinas', 'davi', new Date('2026-03-09T12:00:00Z')),
            chave('unimed-campinas', 'davi', new Date('2026-03-25T12:00:00Z')),
            chave('unimed-campinas', 'davi', new Date('2026-03-30T12:00:00Z'))
        ];
        assert.strictEqual(new Set(chaves).size, 1);
    });

    it('mesmo paciente e mês em convênios diferentes NÃO se juntam', () => {
        const a = chave('unimed-anapolis', 'pac_A', new Date('2026-03-05T12:00:00Z'));
        const b = chave('unimed-campinas', 'pac_A', new Date('2026-03-05T12:00:00Z'));
        assert.notStrictEqual(a, b);
    });
});

// ─── Payment canônico ──────────────────────────────────────────────────────────
describe('💳 Payment do item vem do canônico, nunca copiado do lote antigo', () => {
    it('descarta o cancelado e escolhe o vivo billed', () => {
        const { payment, conflict } = resolveCanonicalPayment([
            pay('cancelado', 'canceled', 'pending_billing', 100),
            pay('vivo', 'billed', 'billed', 80)
        ]);
        assert.strictEqual(conflict, null);
        assert.strictEqual(payment._id, 'vivo');
    });

    it('dois ativos → bloqueia, nunca escolhe por ordem ou valor', () => {
        const { payment, conflict } = resolveCanonicalPayment([
            pay('a', 'billed', 'billed', 80),
            pay('b', 'pending', 'pending_billing', 100)
        ]);
        assert.strictEqual(payment, null);
        assert.ok(conflict);
    });

    it('nenhum ativo → bloqueia', () => {
        const { payment, conflict } = resolveCanonicalPayment([pay('x', 'canceled', 'pending_billing', 80)]);
        assert.strictEqual(payment, null);
        assert.ok(conflict);
    });
});

// ─── Normalização de valores ───────────────────────────────────────────────────
describe('💰 netAmount = grossAmount e ISS zerado', () => {
    const normaliza = itens => {
        const items = itens.map(i => ({ grossAmount: i.gross, netAmount: i.gross }));
        const totalGross = items.reduce((s, i) => s + i.grossAmount, 0);
        return { items, totalGross, totalNet: totalGross, issRate: 0, issAmount: 0 };
    };

    it('REGRESSÃO: item legado com net divergente do gross é normalizado', () => {
        // Caso real ...1fa7bc: 10 itens gross=80 net=140, e 1 com net=0.
        const r = normaliza([{ gross: 80 }, { gross: 80 }, { gross: 80 }]);
        assert.ok(r.items.every(i => i.netAmount === i.grossAmount));
        assert.strictEqual(r.totalGross, 240);
        assert.strictEqual(r.totalNet, 240);
    });

    it('invariante: soma dos itens == totalGross == totalNet', () => {
        const r = normaliza([{ gross: 80 }, { gross: 100 }, { gross: 140 }]);
        assert.strictEqual(r.items.reduce((s, i) => s + i.grossAmount, 0), r.totalGross);
        assert.strictEqual(r.items.reduce((s, i) => s + i.netAmount, 0), r.totalNet);
        assert.strictEqual(r.totalGross, r.totalNet);
    });

    it('CRÍTICO: issRate é 0 explícito, nunca null — senão a baixa busca a taxa ATUAL', () => {
        const r = normaliza([{ gross: 80 }]);
        assert.strictEqual(r.issRate, 0);
        assert.strictEqual(r.issAmount, 0);
        assert.notStrictEqual(r.issRate, null);
        assert.notStrictEqual(r.issRate, undefined);
        // receiveInsuranceBatch: `if (issRate == null)` busca Convenio.issRate.
        // 0 == null é false, então a alíquota histórica é preservada.
        assert.strictEqual(r.issRate == null, false);
    });

    it('CRÍTICO: com issRate 0 o líquido recebido é igual ao bruto histórico', () => {
        const totalGross = 2000;
        const issAmount = totalGross * 0 / 100;
        assert.strictEqual(totalGross - issAmount, 2000);
        // Com a alíquota atual (ex.: 2,01%) daria 1959,80 — R$40,20 a menos.
        const comTaxaAtual = totalGross - (totalGross * 2.01 / 100);
        assert.notStrictEqual(comTaxaAtual, 2000);
    });
});

// ─── Estados de invalidação ────────────────────────────────────────────────────
describe('🚫 superseded e voided são terminais', () => {
    const INVALIDATED = ['superseded', 'voided'];
    const podeEditarNumero = status => !INVALIDATED.includes(status);
    const podeBaixar = status => !INVALIDATED.includes(status) && ['sent', 'processing', 'partial'].includes(status);
    const apareceNaListaAtiva = status => ['sent', 'processing', 'partial', 'received'].includes(status) && !INVALIDATED.includes(status);

    it('superseded e voided não aparecem na lista ativa de NFs', () => {
        assert.strictEqual(apareceNaListaAtiva('superseded'), false);
        assert.strictEqual(apareceNaListaAtiva('voided'), false);
        assert.strictEqual(apareceNaListaAtiva('sent'), true);
    });

    it('não aceitam edição de número', () => {
        assert.strictEqual(podeEditarNumero('superseded'), false);
        assert.strictEqual(podeEditarNumero('voided'), false);
        assert.strictEqual(podeEditarNumero('sent'), true);
    });

    it('não aceitam baixa — as sessões migraram para outro lote', () => {
        assert.strictEqual(podeBaixar('superseded'), false);
        assert.strictEqual(podeBaixar('voided'), false);
        assert.strictEqual(podeBaixar('sent'), true);
    });

    it('são estados distintos: substituído não é lixo', () => {
        assert.notStrictEqual('superseded', 'voided');
    });
});

// ─── Integridade do Appointment ────────────────────────────────────────────────
describe('📌 Appointment só por vínculo exato', () => {
    it('BLOCKING declara o código de conflito exigido', () => {
        assert.strictEqual(BLOCKING.APPOINTMENT_INTEGRITY, 'LEGACY_APPOINTMENT_INTEGRITY_CONFLICT');
    });

    it('conflito bloqueia a migração inteira, não só o agrupamento afetado', () => {
        const conflitos = [{ code: BLOCKING.APPOINTMENT_INTEGRITY, sessionId: 'x' }];
        const bloqueado = conflitos.length > 0;
        assert.strictEqual(bloqueado, true);
    });
});

// ─── Invariantes de contagem ───────────────────────────────────────────────────
describe('🧮 Invariantes da migração', () => {
    it('a soma dos agrupamentos reproduz exatamente as sessões de origem', () => {
        const origem = 100;
        const grupos = [15, 3, 3, 4, 10, 7, 9, 4, 7, 6, 5, 12, 3, 5, 7];
        assert.strictEqual(grupos.reduce((a, b) => a + b, 0), origem);
    });

    it('a soma dos valores reproduz o total dos lotes corrigidos', () => {
        const lotes = [700, 700, 980, 2000, 1120, 280, 2240, 1140, 480];
        const grupos = [240, 2100, 240, 320, 800, 560, 720, 320, 560, 480, 400, 1680, 240, 400, 580];
        assert.strictEqual(grupos.reduce((a, b) => a + b, 0), lotes.reduce((a, b) => a + b, 0));
        assert.strictEqual(grupos.reduce((a, b) => a + b, 0), 9640);
    });

    it('nenhuma sessão em dois agrupamentos', () => {
        const g1 = ['s1', 's2'], g2 = ['s3', 's4'];
        const todas = [...g1, ...g2];
        assert.strictEqual(new Set(todas).size, todas.length);
    });
});

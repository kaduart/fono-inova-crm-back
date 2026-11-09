/**
 * Resumo do log de revisão manual do reconciliationWorker (2026-11-09).
 * O log não deve despejar a lista inteira — só contagem por tipo/severidade,
 * soma de valores e até 3 IDs de exemplo.
 */
import { describe, it, expect } from 'vitest';
import { __testables } from '../../workers/reconciliationWorker.js';

const { summarizeManualReview } = __testables;

describe('summarizeManualReview', () => {
    it('agrupa por tipo, conta severidade, soma valores e limita exemplos a 3', () => {
        const items = [
            ...Array.from({ length: 40 }, (_, i) => ({
                type: 'phantom-credit-on-inactive-payment', paymentId: `p${i}`, status: 'canceled', netCredit: 150, severity: 'high'
            })),
            { type: 'orphan-ledger-entry', ledgerEntryId: 'l1', paymentId: 'p-o1', amount: 170, severity: 'medium' },
            { type: 'orphan-ledger-entry', ledgerEntryId: 'l2', paymentId: 'p-o2', amount: 250.5, severity: 'medium' },
        ];

        const out = summarizeManualReview(items);

        expect(Object.keys(out)).toEqual(['phantom-credit-on-inactive-payment', 'orphan-ledger-entry']);
        expect(out['phantom-credit-on-inactive-payment']).toEqual({
            count: 40, bySeverity: { high: 40 }, totalAmount: 6000, sampleIds: ['p0', 'p1', 'p2']
        });
        expect(out['orphan-ledger-entry']).toEqual({
            count: 2, bySeverity: { medium: 2 }, totalAmount: 420.5, sampleIds: ['p-o1', 'p-o2']
        });
    });

    it('lista vazia ou itens incompletos não quebram', () => {
        expect(summarizeManualReview([])).toEqual({});
        expect(summarizeManualReview([{}])).toEqual({
            unknown: { count: 1, bySeverity: { unknown: 1 }, totalAmount: 0, sampleIds: [] }
        });
    });
});

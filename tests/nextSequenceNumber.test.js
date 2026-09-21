/**
 * Numeração amigável do pacote (FONO-6): max+1, com count como piso para legado.
 */
import { describe, it, expect, vi } from 'vitest';
import { computeNextSequenceNumber, getNextPackageSequenceNumber } from '../domain/package/nextSequenceNumber.js';

describe('computeNextSequenceNumber', () => {
    it('numeração contínua: igual ao comportamento antigo (count+1)', () => {
        expect(computeNextSequenceNumber({ count: 3, maxSequenceNumber: 3 })).toBe(4);
    });

    it('sem pacotes anteriores → 1', () => {
        expect(computeNextSequenceNumber({ count: 0, maxSequenceNumber: 0 })).toBe(1);
        expect(computeNextSequenceNumber({})).toBe(1);
    });

    it('buraco na sequência (pacote saiu da especialidade): usa o maior número, não a contagem', () => {
        // Isis, fono depois de mover o FONO-6: seqs {1,2,3,4,5,7,8}, count=7 → count+1 daria 8 (duplicado)
        expect(computeNextSequenceNumber({ count: 7, maxSequenceNumber: 8 })).toBe(9);
    });

    it('legado sem sequenceNumber (count > max): count é o piso', () => {
        expect(computeNextSequenceNumber({ count: 5, maxSequenceNumber: 2 })).toBe(6);
        expect(computeNextSequenceNumber({ count: 5, maxSequenceNumber: null })).toBe(6);
    });
});

describe('getNextPackageSequenceNumber', () => {
    function fakeModel({ count, last }) {
        const countQuery = Object.assign(Promise.resolve(count), { session: vi.fn() });
        const leanResult = Promise.resolve(last);
        const findChain = { sort: vi.fn(), select: vi.fn(), lean: vi.fn(), session: vi.fn() };
        findChain.sort.mockReturnValue(findChain);
        findChain.select.mockReturnValue(findChain);
        findChain.lean.mockReturnValue(Object.assign(leanResult, { session: findChain.session }));
        return {
            model: {
                countDocuments: vi.fn().mockReturnValue(countQuery),
                findOne: vi.fn().mockReturnValue(findChain),
            },
            countQuery,
            findChain,
        };
    }

    it('escopa por paciente + especialidade e devolve max+1', async () => {
        const { model } = fakeModel({ count: 7, last: { sequenceNumber: 8 } });
        const next = await getNextPackageSequenceNumber(model, { patientId: 'p1', sessionType: 'fonoaudiologia' });
        expect(next).toBe(9);
        expect(model.countDocuments).toHaveBeenCalledWith({ patient: 'p1', sessionType: 'fonoaudiologia' });
        expect(model.findOne).toHaveBeenCalledWith({ patient: 'p1', sessionType: 'fonoaudiologia', sequenceNumber: { $ne: null } });
    });

    it('sem pacote numerado → cai no count', async () => {
        const { model } = fakeModel({ count: 2, last: null });
        expect(await getNextPackageSequenceNumber(model, { patientId: 'p1', sessionType: 'psicologia' })).toBe(3);
    });

    it('lê dentro da transação quando recebe mongoSession', async () => {
        const { model, countQuery, findChain } = fakeModel({ count: 1, last: { sequenceNumber: 1 } });
        const mongoSession = { id: 'tx' };
        await getNextPackageSequenceNumber(model, { patientId: 'p1', sessionType: 'psicologia' }, mongoSession);
        expect(countQuery.session).toHaveBeenCalledWith(mongoSession);
        expect(findChain.session).toHaveBeenCalledWith(mongoSession);
    });
});

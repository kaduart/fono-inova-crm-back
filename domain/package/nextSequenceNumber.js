// domain/package/nextSequenceNumber.js
//
// Identificador amigável do pacote ("FONO-6"): sequencial por paciente + especialidade.
//
// Antes (createPackageV2): count + 1. Quebra assim que a contagem deixa de ser igual ao maior
// número usado — pacote que muda de especialidade, é transferido ou removido deixa buraco, e o
// próximo pacote nasce com número JÁ EXISTENTE (caso Isis, 2026-09-21: tirar o FONO-6 da fono faria
// o próximo fono virar FONO-8, que já existia).
//
// Agora: max(sequenceNumber existente) + 1, usando count como piso para pacotes legados sem
// sequenceNumber (count > max nesse caso). Sem buraco/colisão, e idêntico ao comportamento antigo
// quando a numeração é contínua.

export function computeNextSequenceNumber({ count = 0, maxSequenceNumber = 0 } = {}) {
    return Math.max(Number(count) || 0, Number(maxSequenceNumber) || 0) + 1;
}

/**
 * @param {import('mongoose').Model} PackageModel
 * @param {{ patientId: any, sessionType: string }} scope
 * @param {import('mongoose').ClientSession | null} mongoSession — contar dentro da transação evita
 *   colisão com outro pacote do mesmo paciente/especialidade sendo criado em paralelo
 */
export async function getNextPackageSequenceNumber(PackageModel, { patientId, sessionType }, mongoSession = null) {
    const filter = { patient: patientId, sessionType };

    const countQuery = PackageModel.countDocuments(filter);
    const lastQuery = PackageModel.findOne({ ...filter, sequenceNumber: { $ne: null } })
        .sort({ sequenceNumber: -1 })
        .select('sequenceNumber')
        .lean();

    if (mongoSession) {
        countQuery.session(mongoSession);
        lastQuery.session(mongoSession);
    }

    const [count, last] = await Promise.all([countQuery, lastQuery]);
    return computeNextSequenceNumber({ count, maxSequenceNumber: last?.sequenceNumber });
}

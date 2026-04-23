// scripts/limpar-package-consumed-caixa.js
// ============================================================
// CORREÇÃO DEFINITIVA: Remove paidAt de package_consumed
//
// Problema: package_consumed estava com paidAt preenchido,
// o que fazia o caixa contabilizar consumo de sessão como
// entrada de dinheiro (duplicação de caixa).
//
// Ação:
// 1. Unset paidAt em todos kind='package_consumed'
// 2. Status 'paid' → 'consumed' (não é caixa)
// 3. Adiciona nota de correção
//
// Uso: node scripts/limpar-package-consumed-caixa.js [dry-run]
// ============================================================

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Payment from '../models/Payment.js';

dotenv.config();

const DRY_RUN = process.argv.includes('dry-run');

async function main() {
    console.log(`[Limpar Package Consumed] Iniciando... ${DRY_RUN ? '(DRY-RUN)' : '(EXECUÇÃO REAL)'}`);

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) throw new Error('MONGO_URI não encontrado no .env');
    await mongoose.connect(mongoUri);
    console.log('[Limpar Package Consumed] Conectado ao MongoDB');

    // 1. Contar quantos vamos afetar
    const afetados = await Payment.countDocuments({
        kind: 'package_consumed',
        $or: [
            { paidAt: { $ne: null } },
            { status: 'paid' }
        ]
    });

    console.log(`[Limpar Package Consumed] Registros a corrigir: ${afetados}`);

    if (afetados === 0) {
        console.log('[Limpar Package Consumed] Nada a fazer. Banco já está limpo.');
        await mongoose.disconnect();
        process.exit(0);
    }

    if (DRY_RUN) {
        // Mostrar amostra
        const amostra = await Payment.find({
            kind: 'package_consumed',
            $or: [
                { paidAt: { $ne: null } },
                { status: 'paid' }
            ]
        }).limit(5).select('_id amount paidAt status billingType createdAt').lean();

        console.log('[DRY-RUN] Amostra dos registros que seriam corrigidos:');
        console.table(amostra);
        console.log(`[DRY-RUN] Total que seria corrigido: ${afetados}`);
    } else {
        // Execução real
        const result = await Payment.updateMany(
            {
                kind: 'package_consumed',
                $or: [
                    { paidAt: { $ne: null } },
                    { status: 'paid' }
                ]
            },
            {
                $unset: { paidAt: 1 },
                $set: {
                    status: 'consumed',
                    updatedAt: new Date(),
                    notes: (existing) => {
                        // Não podemos usar existing aqui em updateMany,
                        // então usamos $concat se quisermos preservar notas
                        return undefined;
                    }
                }
            }
        );

        console.log(`[CORRIGIDO] Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);

        // Agora adicionar nota sem sobrescrever notas existentes
        const comNota = await Payment.updateMany(
            {
                kind: 'package_consumed',
                status: 'consumed',
                'notes': { $not: /CORREÇÃO CAIXA/ }
            },
            {
                $set: {
                    notes: { $concat: ['[CORREÇÃO CAIXA: paidAt removido, status alterado de paid para consumed pois package_consumed NÃO é entrada de caixa] ', { $ifNull: ['$notes', ''] }] }
                }
            }
        );
        // Nota: $concat não funciona em $set de updateMany no mongoose direto, precisamos de aggregate ou loop
        // Vamos fazer com cursor para garantir
    }

    // Se não for dry-run, fazer a correção das notas com cursor
    if (!DRY_RUN) {
        const cursor = Payment.find({
            kind: 'package_consumed',
            status: 'consumed'
        }).cursor();

        let notasAtualizadas = 0;
        for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
            if (!doc.notes || !doc.notes.includes('CORREÇÃO CAIXA')) {
                doc.notes = `[CORREÇÃO CAIXA: paidAt removido, status alterado de paid para consumed pois package_consumed NÃO é entrada de caixa] ${doc.notes || ''}`.trim();
                await doc.save({ validateBeforeSave: false });
                notasAtualizadas++;
            }
        }
        console.log(`[CORRIGIDO] Notas atualizadas: ${notasAtualizadas}`);

        // Validação final
        const restantes = await Payment.countDocuments({
            kind: 'package_consumed',
            $or: [
                { paidAt: { $ne: null } },
                { status: 'paid' }
            ]
        });
        console.log(`[VALIDAÇÃO] Registros package_consumed ainda com paidAt/paid: ${restantes}`);
    }

    await mongoose.disconnect();
    console.log('[Limpar Package Consumed] Finalizado.');
    process.exit(0);
}

main().catch(err => {
    console.error('[Limpar Package Consumed] Erro fatal:', err);
    process.exit(1);
});

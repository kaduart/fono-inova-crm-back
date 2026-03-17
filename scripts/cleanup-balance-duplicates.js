/**
 * DIAGNÓSTICO E CLEANUP — Débitos duplicados no PatientBalance
 *
 * Padrão de duplicata detectado:
 *   - Débito MANUAL: sessionId=null, appointmentId=null, description="DD/MM/YYYY"
 *   - Débito SESSÃO: sessionId!=null, description="Sessão DD/MM/YYYY - HH:MM"
 *   - Mesmo paciente, mesma data (independente do valor) → DUPLICATA
 *
 * Uso:
 *   DRY_RUN=true  node --experimental-vm-modules scripts/cleanup-balance-duplicates.js
 *   DRY_RUN=false node --experimental-vm-modules scripts/cleanup-balance-duplicates.js
 */

import mongoose from 'mongoose';
import PatientBalance from '../models/PatientBalance.js';
import '../models/Patient.js';
import dotenv from 'dotenv';

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false'; // default: true (só diagnóstico)

// Extrai "YYYY-MM-DD" de descrições como "09/03/2026" ou "Sessão 09/03/2026 - 15:20"
function extrairData(description) {
    const match = description?.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!match) return null;
    return `${match[3]}-${match[2]}-${match[1]}`; // YYYY-MM-DD
}

async function diagnosticar() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const balances = await PatientBalance.find({})
        .populate('patient', 'fullName')
        .lean();

    console.log(`📊 Total de pacientes com PatientBalance: ${balances.length}\n`);

    let totalDuplicatas = 0;
    let totalValorDuplicado = 0;
    const relatorioPorPaciente = [];

    for (const balance of balances) {
        const debitos = balance.transactions.filter(t => t.type === 'debit');
        const manuais = debitos.filter(t => !t.sessionId && !t.appointmentId);
        const sessaoLinked = debitos.filter(t => t.sessionId || t.appointmentId);

        // Set de datas que têm sessão vinculada
        const datasComSessao = new Set(
            sessaoLinked.map(s => extrairData(s.description)).filter(Boolean)
        );

        const duplicatas = [];

        for (const manual of manuais) {
            const dataManual = extrairData(manual.description);
            if (!dataManual) continue; // descrição sem data válida — ignora

            if (datasComSessao.has(dataManual)) {
                // Encontra a(s) sessão(ões) vinculada(s) para logar
                const sessoes = sessaoLinked.filter(s => extrairData(s.description) === dataManual);
                duplicatas.push({
                    manualId: manual._id.toString(),
                    sessaoIds: sessoes.map(s => s._id.toString()),
                    data: dataManual,
                    valorManual: manual.amount,
                    valoresSessao: sessoes.map(s => s.amount),
                    descricaoManual: manual.description,
                    descricoesSessao: sessoes.map(s => s.description),
                    isPaidManual: manual.isPaid,
                });
                totalDuplicatas++;
                totalValorDuplicado += manual.amount;
            }
        }

        if (duplicatas.length > 0) {
            relatorioPorPaciente.push({
                paciente: balance.patient?.fullName || balance.patient,
                patientBalanceId: balance._id.toString(),
                saldoAtual: balance.currentBalance,
                duplicatas,
            });
        }
    }

    // Relatório
    console.log('='.repeat(60));
    console.log(`RELATÓRIO DE DUPLICATAS`);
    console.log('='.repeat(60));

    for (const p of relatorioPorPaciente) {
        console.log(`\n👤 ${p.paciente} (saldo: R$ ${p.saldoAtual})`);
        for (const d of p.duplicatas) {
            console.log(`   ❌ DUPLICATA em ${d.data}:`);
            console.log(`      Manual : [${d.manualId}] "${d.descricaoManual}" R$ ${d.valorManual} isPaid=${d.isPaidManual}`);
            for (let i = 0; i < d.sessaoIds.length; i++) {
                console.log(`      Sessão : [${d.sessaoIds[i]}] "${d.descricoesSessao[i]}" R$ ${d.valoresSessao[i]}`);
            }
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log(`Total pacientes afetados : ${relatorioPorPaciente.length}`);
    console.log(`Total duplicatas         : ${totalDuplicatas}`);
    console.log(`Valor manual removido    : R$ ${totalValorDuplicado}`);
    console.log('='.repeat(60));

    if (DRY_RUN) {
        console.log('\n⚠️  DRY_RUN=true — nenhuma alteração feita.');
        console.log('   Para aplicar: DRY_RUN=false node --experimental-vm-modules scripts/cleanup-balance-duplicates.js\n');
        await mongoose.disconnect();
        return;
    }

    // APLICAR CORREÇÕES
    console.log('\n🔧 Aplicando correções...\n');
    let corrigidos = 0;

    for (const p of relatorioPorPaciente) {
        const balance = await PatientBalance.findById(p.patientBalanceId);
        if (!balance) continue;

        const idsParaRemover = new Set(p.duplicatas.map(d => d.manualId));
        const valorRemovido = p.duplicatas.reduce((sum, d) => sum + d.valorManual, 0);

        const antes = balance.transactions.length;
        balance.transactions = balance.transactions.filter(
            t => !idsParaRemover.has(t._id.toString())
        );
        const depois = balance.transactions.length;

        // currentBalance: só subtrai o valor não pago (isPaid=false infla o saldo devedor)
        // isPaid=true já foi compensado por um pagamento — não afeta currentBalance
        const valorNaoPago = p.duplicatas
            .filter(d => !d.isPaidManual)
            .reduce((sum, d) => sum + d.valorManual, 0);

        balance.currentBalance -= valorNaoPago;
        balance.totalDebited -= valorRemovido;

        await balance.save();
        corrigidos++;

        console.log(`✅ ${p.paciente}: removidas ${antes - depois} transação(ões), saldo R$${p.saldoAtual} → R$${balance.currentBalance}`);
    }

    console.log(`\n🎉 Correção concluída: ${corrigidos} paciente(s) corrigido(s)`);
    await mongoose.disconnect();
}

diagnosticar().catch(err => {
    console.error('❌ Erro:', err);
    process.exit(1);
});

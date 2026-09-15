// Reparo pontual: pacote da Julia Boarati (8 sessões x R$160 = R$1.280) só tinha 1
// Payment registrado (R$160, a sessão retroativa em débito absorvida na criação).
// Causa raiz: bug no TherapyPackageFormModal.tsx (front) — ao absorver uma sessão em
// débito, o formulário sugeria como "valor a pagar" só a soma das retroativas (R$160),
// não o valor total do pacote (R$1.280). No submit, o valor da retroativa é subtraído
// do valor digitado pra achar o "dinheiro novo" a lançar — sugerir só a retroativa fazia
// essa subtração zerar (160-160=0), e nenhum Payment do restante era criado. Já corrigido
// no código (ver diff em TherapyPackageFormModal.tsx). Este script só lança o Payment que
// faltou no caso real da Julia, hoje.
//
// Uso: node scripts/fix-julia-package-receipt-2026-09-15.mjs

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const PACKAGE_ID = '6aa99e13eb2964190fecd267';
const MISSING_AMOUNT = 1120; // 1280 (totalValue) - 160 (já registrado)

async function main() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) { console.error('MONGO_URI/MONGODB_URI não encontrado no .env'); process.exit(1); }

    await mongoose.connect(uri);
    console.log('Conectado ao Mongo:', mongoose.connection.name);

    const Payment = (await import('../models/Payment.js')).default;
    const Package = (await import('../models/Package.js')).default;

    const pkg = await Package.findById(PACKAGE_ID);
    if (!pkg) { console.error('Pacote não encontrado — nada foi alterado.'); await mongoose.disconnect(); process.exit(1); }

    console.log('\nANTES:', {
        totalPaid: pkg.totalPaid,
        balance: pkg.balance,
        financialStatus: pkg.financialStatus,
        payments: pkg.payments
    });

    // Idempotência: não duplica se já existir um package_receipt pra esse valor hoje
    const existing = await Payment.findOne({ package: pkg._id, kind: 'package_receipt' });
    if (existing) {
        console.log('\nJá existe um Payment package_receipt para este pacote — nada foi criado:', existing._id);
        await mongoose.disconnect();
        process.exit(0);
    }

    const todayBrasilia = moment.tz('America/Sao_Paulo').startOf('day').toDate();

    const payment = await Payment.create({
        package: pkg._id,
        patient: pkg.patient,
        doctor: pkg.doctor,
        specialty: pkg.specialty,
        amount: MISSING_AMOUNT,
        paymentMethod: pkg.paymentMethod || 'pix',
        paymentDate: todayBrasilia,
        financialDate: todayBrasilia,
        kind: 'package_receipt',
        status: 'paid',
        paidAt: new Date(),
        billingType: pkg.type === 'liminar' ? 'liminar' : 'particular',
        serviceType: 'package_session',
        notes: 'Pagamento do pacote (saldo restante) — reparo de dados 2026-09-15, causa raiz corrigida em TherapyPackageFormModal.tsx'
    });
    console.log('\nPayment criado:', payment._id, payment.amount, payment.kind);

    pkg.payments = Array.from(new Set([...(pkg.payments || []).map(String), payment._id.toString()]));
    pkg.totalPaid = Number(pkg.totalPaid || 0) + MISSING_AMOUNT;
    await pkg.save(); // pre-save recalcula financialStatus/balance/financialBalance automaticamente

    const after = await Package.findById(PACKAGE_ID);
    console.log('\nDEPOIS:', {
        totalPaid: after.totalPaid,
        balance: after.balance,
        financialStatus: after.financialStatus,
        payments: after.payments
    });

    await mongoose.disconnect();
    console.log('\nOK — desconectado.');
}

main().catch(async (err) => {
    console.error('Erro:', err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});

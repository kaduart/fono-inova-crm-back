// Script para verificar detalhes dos pagamentos problemáticos
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;

async function checkPaymentDetails() {
    try {
        console.log('🔌 Conectando ao MongoDB...');
        await mongoose.connect(MONGO_URI);
        console.log('✅ Conectado ao MongoDB\n');

        const { default: Payment } = await import('../models/Payment.js');

        const patientId = '698f0ad139d78a9c5746e037';

        console.log(`🔍 Detalhes dos pagamentos do paciente ${patientId}:\n`);

        const payments = await Payment.find({ patient: patientId }).lean();

        for (let i = 0; i < payments.length; i++) {
            const p = payments[i];
            console.log(`📄 Pagamento ${i + 1}:`);
            console.log(`   ID: ${p._id}`);
            console.log(`   Criado em: ${p.createdAt}`);
            console.log(`   Atualizado em: ${p.updatedAt}`);
            console.log(`   Tipo de faturamento: ${p.billingType}`);
            console.log(`   Método de pagamento: ${p.paymentMethod}`);
            console.log(`   Status: ${p.status}`);
            console.log(`   Valor (amount): ${p.amount}`);
            console.log(`   Data do pagamento: ${p.paymentDate}`);
            console.log(`   Tipo de serviço: ${p.serviceType}`);
            console.log(`   Convênio:`);
            console.log(`      - Provedor: ${p.insurance?.provider}`);
            console.log(`      - Valor bruto: ${p.insurance?.grossAmount}`);
            console.log(`      - Status: ${p.insurance?.status}`);
            console.log(`      - Código de autorização: ${p.insurance?.authorizationCode}`);
            console.log(`   Sessão: ${p.session || 'N/A'}`);
            console.log(`   Pacote: ${p.package || 'N/A'}`);
            console.log(`   Agendamento: ${p.appointment || 'N/A'}`);
            console.log(`   Doutor: ${p.doctor || 'N/A'}`);
            console.log(`   Notas: ${p.notes || 'N/A'}`);
            console.log('');
        }

        // Verificar se há algum pacote ou sessão vinculado que possa ter informações do paciente
        console.log('\n🔍 Verificando pacotes vinculados...');
        const packageIds = payments.filter(p => p.package).map(p => p.package.toString());
        console.log(`   IDs de pacotes: ${packageIds.join(', ') || 'Nenhum'}`);

        if (packageIds.length > 0) {
            const { default: Package } = await import('../models/Package.js');
            const packages = await Package.find({ _id: { $in: packageIds } }).select('_id patient name').lean();
            console.log('\n   Detalhes dos pacotes:');
            for (const pkg of packages) {
                console.log(`      - ${pkg._id}: Paciente=${pkg.patient}, Nome=${pkg.name || 'N/A'}`);
            }
        }

        // Verificar sessões
        console.log('\n🔍 Verificando sessões vinculadas...');
        const sessionIds = payments.filter(p => p.session).map(p => p.session.toString());
        console.log(`   IDs de sessões: ${sessionIds.join(', ') || 'Nenhum'}`);

        if (sessionIds.length > 0) {
            const { default: Session } = await import('../models/Session.js');
            const sessions = await Session.find({ _id: { $in: sessionIds } }).select('_id patient date').lean();
            console.log('\n   Detalhes das sessões:');
            for (const s of sessions) {
                console.log(`      - ${s._id}: Paciente=${s.patient}, Data=${s.date}`);
            }
        }

    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Desconectado do MongoDB');
    }
}

checkPaymentDetails();

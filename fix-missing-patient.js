// Script para corrigir o paciente faltante
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;

async function fixMissingPatient() {
    try {
        console.log('🔌 Conectando ao MongoDB...');
        await mongoose.connect(MONGO_URI);
        console.log('✅ Conectado ao MongoDB\n');

        const { default: Patient } = await import('./models/Patient.js');
        const { default: Payment } = await import('./models/Payment.js');
        const { default: Session } = await import('./models/Session.js');

        const missingPatientId = '698f0ad139d78a9c5746e037';

        console.log('🔍 Analisando dados do paciente faltante...\n');

        // Buscar informações dos pagamentos para tentar identificar o paciente
        const payments = await Payment.find({ patient: missingPatientId }).lean();
        const sessionIds = payments.filter(p => p.session).map(p => p.session.toString());
        
        console.log(`📊 Resumo:`);
        console.log(`   - Pagamentos: ${payments.length}`);
        console.log(`   - Sessões: ${sessionIds.length}`);
        console.log(`   - Convênio: ${payments[0]?.insurance?.provider || 'N/A'}`);
        console.log(`   - Datas: ${payments.map(p => p.paymentDate).join(', ')}`);

        // Verificar se já existe algum paciente com dados similares
        console.log('\n🔍 Verificando pacientes existentes com mesmo convênio...');
        const existingPatients = await Patient.find({
            'healthPlan.name': { $regex: 'unimed', $options: 'i' }
        }).select('_id fullName healthPlan').limit(10).lean();

        if (existingPatients.length > 0) {
            console.log('   Pacientes com Unimed encontrados:');
            for (const p of existingPatients) {
                console.log(`      - ${p._id}: ${p.fullName}`);
            }
        }

        // Perguntar ao usuário o que fazer
        console.log('\n⚠️  O QUE DESEJA FAZER?');
        console.log('1. Criar um novo paciente genérico "Paciente Recuperado" com o ID antigo');
        console.log('2. Vincular todos os pagamentos/sessões a um paciente existente (por ID)');
        console.log('3. Apenas mostrar os dados sem fazer alterações');
        console.log('4. Deletar os pagamentos/sessões órfãos\n');

        // Por padrão, vamos apenas mostrar o que seria feito na opção 1
        console.log('💡 SUGESTÃO (Opção 1 - Criar paciente genérico):');
        console.log('   Seria criado um paciente com:');
        console.log('   - ID: 698f0ad139d78a9c5746e037 (mesmo ID para manter vinculação)');
        console.log('   - Nome: "Paciente Recuperado - Unimed Anápolis"');
        console.log('   - Plano de saúde: Unimed Anápolis');
        console.log('   - Data de nascimento: 01/01/2000 (placeholder)');
        console.log('');
        console.log('   Isso permitiria:');
        console.log('   ✓ Ver os pagamentos no InsuranceTab com nome');
        console.log('   ✓ Manter o histórico financeiro intacto');
        console.log('   ✓ Possibilidade de atualizar os dados depois');

        // Simular a criação (não executar ainda)
        const wouldBePatient = {
            _id: new mongoose.Types.ObjectId(missingPatientId),
            fullName: 'Paciente Recuperado - Unimed Anápolis',
            dateOfBirth: new Date('2000-01-01'),
            healthPlan: {
                name: 'Unimed Anápolis',
                policyNumber: 'N/A'
            },
            notes: 'Paciente recuperado automaticamente. Dados originais perdidos. Criado em: ' + new Date().toISOString()
        };

        console.log('\n📋 Dados que seriam inseridos:');
        console.log(JSON.stringify(wouldBePatient, null, 2));

        console.log('\n⚠️  Para executar a correção, descomente o código no script.');
        
        /* DESCOMENTE PARA EXECUTAR A CORREÇÃO
        
        console.log('\n🚀 Criando paciente...');
        const newPatient = await Patient.create(wouldBePatient);
        console.log('✅ Paciente criado:', newPatient._id);
        console.log('   Nome:', newPatient.fullName);
        
        // Verificar se os pagamentos agora encontram o paciente
        const updatedPayments = await Payment.find({ patient: missingPatientId })
            .populate('patient', 'fullName')
            .lean();
        
        console.log('\n📊 Verificação pós-correção:');
        for (const p of updatedPayments) {
            console.log(`   - ${p._id}: Paciente=${p.patient?.fullName || 'N/A'}`);
        }
        
        */

    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Desconectado do MongoDB');
    }
}

fixMissingPatient();

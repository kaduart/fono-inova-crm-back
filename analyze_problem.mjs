import mongoose from 'mongoose';

const uri = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function analyze() {
  try {
    await mongoose.connect(uri);
    
    const Appointment = mongoose.model('Appointment', new mongoose.Schema({}, { strict: false }));
    const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
    
    console.log('🔴 PROBLEMA IDENTIFICADO:\n');
    
    // Agendamento 08:00
    const apt8h = await Appointment.findById('69cad540122af7d586a5650d').lean();
    console.log('📅 Agendamento 08:00:');
    console.log(`   operationalStatus: "${apt8h.operationalStatus}" ❌ (deveria ser "completed")`);
    console.log(`   clinicalStatus: "${apt8h.clinicalStatus}" ✅`);
    console.log(`   paymentStatus: "${apt8h.paymentStatus}" ✅`);
    console.log(`   sessionValue: R$ ${apt8h.sessionValue}`);
    
    const payment8h = await Payment.findById('69cad542122af7d586a56515').lean();
    console.log(`   Pagamento: ${payment8h.status} ❌ (deveria ser "paid")`);
    console.log(`   Valor do pagamento: R$ ${payment8h.amount || payment8h.value}`);
    
    console.log('\n📅 Agendamento 14:00:');
    const apt14h = await Appointment.findById('69cad798122af7d586a5664e').lean();
    console.log(`   operationalStatus: "${apt14h.operationalStatus}" ❌ (deveria ser "completed")`);
    console.log(`   clinicalStatus: "${apt14h.clinicalStatus}" ✅`);
    console.log(`   paymentStatus: "${apt14h.paymentStatus}" ✅`);
    
    const payment14h = await Payment.findById('69cad798122af7d586a5665c').lean();
    console.log(`   Pagamento: ${payment14h.status} ❌ (deveria ser "paid")`);
    console.log(`   Valor do pagamento: R$ ${payment14h.amount || payment14h.value} ❌ (undefined!)`);
    
    console.log('\n📅 Agendamento 18:00 (V2 - Funcionando):');
    const apt18h = await Appointment.findById('69cadb7149afd4d4aa539cfd').lean();
    console.log(`   operationalStatus: "${apt18h.operationalStatus}" ✅`);
    console.log(`   clinicalStatus: "${apt18h.clinicalStatus}" ✅`);
    console.log(`   paymentStatus: "${apt18h.paymentStatus}" ✅`);
    
    console.log('\n🔴 CAUSA RAIZ:');
    console.log('   O fluxo LEGACY atualiza clinicalStatus para "completed" mas NÃO atualiza operationalStatus!');
    console.log('   Isso faz o frontend achar que o agendamento ainda não foi completado.');
    console.log('   Quando o usuário clica em "Completar" novamente, pode criar outro pagamento.');
    
    console.log('\n✅ SOLUÇÃO:');
    console.log('   1. Corrigir o fluxo legacy para atualizar operationalStatus = "completed"');
    console.log('   2. Corrigir o pagamento para status = "paid"');
    console.log('   3. Ou usar o fluxo V2 que está funcionando corretamente');
    
  } catch (err) {
    console.error('Erro:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

analyze();

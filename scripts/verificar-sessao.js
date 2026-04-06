import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const sessionId = process.argv[2];

if (!sessionId) {
  console.log('Uso: node scripts/verificar-sessao.js <sessionId>');
  process.exit(1);
}

async function verificar() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    
    const Session = mongoose.model('Session', new mongoose.Schema({}, { collection: 'sessions' }));
    const session = await Session.findById(sessionId).lean();
    
    if (!session) {
      console.log('❌ Sessão não encontrada');
      return;
    }
    
    console.log('════════════════════════════════════════');
    console.log('📋 DETALHES DA SESSÃO');
    console.log('════════════════════════════════════════');
    console.log(`ID: ${session._id}`);
    console.log(`Status: ${session.status}`);
    console.log(`Data: ${session.date}`);
    console.log(`Paciente: ${session.patient}`);
    console.log(`Médico: ${session.doctor}`);
    console.log(`Completa em: ${session.completedAt || 'Nunca'}`);
    console.log(`Pagamento: ${session.paymentStatus || 'N/A'}`);
    console.log('════════════════════════════════════════');
    
    if (session.status === 'completed') {
      console.log('\n⚠️  Esta sessão JÁ foi completada!');
      console.log('Não é possível completar novamente.');
    }
    
    await mongoose.disconnect();
  } catch (err) {
    console.error('Erro:', err.message);
  }
}

verificar();

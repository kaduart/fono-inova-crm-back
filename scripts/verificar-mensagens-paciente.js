import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const sessionId = '69b809bc7c7e8bd1b3b9123b';

async function verificar() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    
    const Session = mongoose.model('Session', new mongoose.Schema({}, { collection: 'sessions' }));
    const Patient = mongoose.model('Patient', new mongoose.Schema({}, { collection: 'patients' }));
    const Message = mongoose.model('Message', new mongoose.Schema({}, { collection: 'messages' }));
    
    const session = await Session.findById(sessionId).lean();
    if (!session) {
      console.log('❌ Sessão não encontrada');
      return;
    }
    
    console.log('Sessão encontrada:', session._id);
    console.log('Paciente ID:', session.patient);
    
    const patient = await Patient.findById(session.patient).lean();
    if (!patient) {
      console.log('❌ Paciente não encontrado');
      return;
    }
    
    console.log('\n📱 Paciente:', patient.fullName);
    console.log('Telefone:', patient.phone);
    
    const messages = await Message.find({
      $or: [
        { from: patient.phone },
        { to: patient.phone }
      ]
    }).sort({ timestamp: -1 }).limit(20).lean();
    
    console.log('\n💬 Últimas mensagens:');
    messages.forEach(m => {
      const direction = m.direction === 'outbound' ? '← Enviada' : '→ Recebida';
      console.log(`  [${direction}] ${m.content?.substring(0, 60)}...`);
    });
    
    await mongoose.disconnect();
  } catch (err) {
    console.error('Erro:', err.message);
  }
}

verificar();

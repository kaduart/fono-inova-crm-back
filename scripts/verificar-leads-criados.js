import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const numerosRecuperados = [
  '556293051307',
  '556295029657',
  '556294305831',
  '556299551196',
  '556299020184',
  '556292643467',
  '556292104736',
  '556293834447',
  '556291488099',
  '556295707714',
  '556293743095',
  '556294177117',
  '556181694922',
  '556295431533',
  '556294248231',
  '556294353046'
];

async function verificar() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const Lead = mongoose.model('Lead', new mongoose.Schema({}, { collection: 'leads' }));
    
    console.log('🔍 Verificando leads dos números recuperados:\n');
    
    for (const numero of numerosRecuperados) {
      const leads = await Lead.find({
        $or: [
          { 'contact.phone': numero },
          { 'contact.phone': '+' + numero }
        ]
      }).sort({ createdAt: -1 }).limit(3);
      
      if (leads.length > 0) {
        console.log(`✅ ${numero}: ${leads.length} lead(s) encontrado(s)`);
        leads.forEach(l => {
          console.log(`   - ${l.name} | ${l.status} | ${l.createdAt.toISOString()}`);
        });
      } else {
        console.log(`⏳ ${numero}: Aguardando criação (worker ainda processando)`);
      }
    }
    
    console.log('\n💡 Os workers estão processando as mensagens.');
    console.log('Verifique novamente em alguns minutos.');
    
    await mongoose.disconnect();
  } catch (err) {
    console.error('Erro:', err.message);
  }
}

verificar();

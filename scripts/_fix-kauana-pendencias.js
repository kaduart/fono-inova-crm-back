import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Payment = (await import('../models/Payment.js')).default;
  const Session = (await import('../models/Session.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;

  // Sessão 699c6a74353c11d3c7775dbc: payment ativo 6a3da8379c02f146eb876b66
  const p = await Payment.findById('6a3da8379c02f146eb876b66').lean();
  if (p && p.status !== 'billed' && p.insurance?.status !== 'billed') {
    await Payment.updateOne(
      { _id: p._id },
      {
        $set: {
          status: 'billed',
          amount: 80,
          'insurance.status': 'billed',
          'insurance.billedAt': new Date(),
          'insurance.grossAmount': 80
        }
      }
    );
    await Session.findByIdAndUpdate(p.session, { $set: { paymentStatus: 'pending', sessionValue: 80 } });
    await Appointment.findOneAndUpdate({ session: p.session }, { $set: { paymentStatus: 'pending', sessionValue: 80 } });
    console.log('✅ Payment 6a3da8379c02f146eb876b66 faturado');
  } else {
    console.log('⚠️ Payment 6a3da8379c02f146eb876b66 já faturado ou não encontrado');
  }

  // Sessão 69986c057c92d32c1fd44a25: payment ativo 69af0891381a1dc2998ab091
  const p2 = await Payment.findById('69af0891381a1dc2998ab091').lean();
  console.log('Payment 69af0891381a1dc2998ab091 status:', p2?.status, 'insurance.status:', p2?.insurance?.status);
  if (p2 && p2.status !== 'billed' && p2.insurance?.status === 'billed') {
    await Payment.updateOne({ _id: p2._id }, { status: 'billed' });
    console.log('✅ Payment 69af0891381a1dc2998ab091 sincronizado para billed');
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

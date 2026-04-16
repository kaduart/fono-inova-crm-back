import mongoose from 'mongoose';
import Session from './models/Session.js';
import dotenv from 'dotenv';

dotenv.config();

const SESSION_ID = '69d3107ba14c560c7eb92acc';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const session = await Session.findById(SESSION_ID).lean();
  if (!session) {
    console.log('Sessão não encontrada.');
    await mongoose.disconnect();
    return;
  }
  console.log('Sessão encontrada:', {
    patient: session.patient,
    date: session.date,
    time: session.time,
    status: session.status,
    sessionValue: session.sessionValue,
    paymentMethod: session.paymentMethod,
    package: session.package
  });
  await Session.deleteOne({ _id: SESSION_ID });
  console.log(`Sessão ${SESSION_ID} deletada.`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

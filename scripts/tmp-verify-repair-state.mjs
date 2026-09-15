import 'dotenv/config';
import mongoose from 'mongoose';
async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const patientId = new mongoose.Types.ObjectId('6a5a9269ce43485b2af4edbc');
  const pb = await db.collection('patientbalances').findOne({ patient: patientId });
  console.log('currentBalance:', pb.currentBalance, '| totalDebited:', pb.totalDebited, '| totalCredited:', pb.totalCredited);
  console.log(`total transactions: ${pb.transactions.length}`);
  pb.transactions.forEach((t, i) => {
    console.log(`[${i}] _id=${t._id} type=${t.type} amount=${t.amount} isPaid=${t.isPaid} isDeleted=${t.isDeleted} linkedDebitId=${t.linkedDebitId} desc=${JSON.stringify(t.description)}`);
  });
  await mongoose.disconnect();
}
run().catch(e => { console.error(e); process.exit(1); });

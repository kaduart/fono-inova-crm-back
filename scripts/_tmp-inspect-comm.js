import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const commId = '6a68e62109dbc5293672a8dd';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const raw = await mongoose.connection.db.collection('insurancecommunications').findOne({ _id: new mongoose.Types.ObjectId(commId) });
  console.log(JSON.stringify(raw, null, 2));
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

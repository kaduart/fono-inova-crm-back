import 'dotenv/config';
import mongoose from 'mongoose';
await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
const db = mongoose.connection.db;
const d7 = new Date(Date.now() - 7*864e5);
const tail = (p) => String(p||'').replace(/\D/g,'').slice(-8);
const unk = await db.collection('adconversions').find({ createdAt:{ $gte:d7 }, source:'unknown' }).toArray();
console.log('SEM ORIGEM:', unk.length);
for (const u of unk) {
  const t = tail(u.phone);
  const a = t ? await db.collection('leadattributions').findOne({ phone:{ $regex: t+'$' } }) : null;
  console.log(`..${t.slice(-4)} | agend ${u.createdAt.toISOString().slice(0,16)} | attr: ${a ? `${a.source}/${a.method} ${a.firstMessageAt.toISOString().slice(0,16)}` : 'NENHUMA'}`);
}
console.log('ORIGENS 7d:', JSON.stringify(await db.collection('leadattributions').aggregate([{ $match:{ firstMessageAt:{ $gte:d7 } } },{ $group:{ _id:{ s:'$source', m:'$method' }, n:{ $sum:1 } } }]).toArray()));
console.log('TEL INVALIDOS:', await db.collection('leadattributions').countDocuments({ phone:{ $not:/^55\d{10,11}$/ } }));
console.log('LEADS 7d:', await db.collection('leads').countDocuments({ createdAt:{ $gte:d7 } }));
console.log('PERDIDAS @lid:', JSON.stringify(await db.collection('leadattributions').find({ phone:{ $not:/^55\d{10,11}$/ } }, { projection:{ _id:0, source:1, method:1, firstMessageAt:1 } }).toArray()));
await mongoose.disconnect();

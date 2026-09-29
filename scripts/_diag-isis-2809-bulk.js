import mongoose from 'mongoose'; import dotenv from 'dotenv';
import { fileURLToPath } from 'url'; import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') }); dotenv.config();
await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
const db = mongoose.connection.db; const O = (s)=>new mongoose.Types.ObjectId(s);
const ISIS = O('685b0cfaaec14c7163585b5b');
const pats = await db.collection('patients').find({fullName:/caldas/i}).project({fullName:1}).toArray();
console.log('PACIENTES CALDAS', JSON.stringify(pats));
const ids = pats.map(p=>p._id);
const from = new Date('2026-09-27T00:00:00-03:00'), to = new Date('2026-09-30T00:00:00-03:00');
const pays = await db.collection('payments').find({patient:{$in:ids}, $or:[{paidAt:{$gte:from,$lt:to}},{createdAt:{$gte:from,$lt:to}},{updatedAt:{$gte:from,$lt:to}}]})
 .project({patient:1,amount:1,status:1,kind:1,paymentMethod:1,method:1,paidAt:1,serviceDate:1,financialDate:1,appointment:1,session:1,package:1,notes:1,description:1,createdAt:1,updatedAt:1,parentPayment:1,bulkId:1,batchId:1,groupId:1,source:1}).sort({paidAt:1}).toArray();
for (const p of pays) console.log(JSON.stringify(p));
// créditos / saldo
const pk = await db.collection('patients').findOne({_id:ISIS},{projection:{credit:1,creditBalance:1,balance:1,financial:1}});
console.log('ISIS PATIENT FIN', JSON.stringify(pk));
const bal = await db.collection('patientbalances').find({patient:{$in:ids}}).toArray().catch(()=>[]);
console.log('BALANCES', JSON.stringify(bal).slice(0,3000));
const cr = await db.collection('payments').find({patient:{$in:ids}, kind:{$in:['credit_balance','debt_settlement']}}).project({patient:1,amount:1,status:1,kind:1,paidAt:1,createdAt:1,notes:1}).toArray();
console.log('CREDIT/DEBT', JSON.stringify(cr));
process.exit(0);

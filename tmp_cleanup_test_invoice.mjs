import mongoose from 'mongoose';
import 'dotenv/config';

const MONGO_URI = process.env.MONGO_URI;
await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 20000 });
const db = mongoose.connection.db;

const invoiceId = new mongoose.Types.ObjectId('6a593bc0f2edc1055819dee6');

const submissions = await db.collection('fiscalsubmissions').find({ fiscalInvoice: invoiceId }).toArray();
console.log('fiscalsubmissions vinculadas:', submissions.length, submissions.map(s => s._id.toString()));

const submissionIds = submissions.map(s => s._id);
const snapshots = submissionIds.length
  ? await db.collection('fiscalsnapshots').find({ fiscalSubmission: { $in: submissionIds } }).toArray()
  : [];
console.log('fiscalsnapshots vinculados:', snapshots.length, snapshots.map(s => s._id.toString()));

const providerTx = submissionIds.length
  ? await db.collection('providertransactions').find({ fiscalSubmission: { $in: submissionIds } }).toArray()
  : [];
console.log('providertransactions vinculados:', providerTx.length);

const events = await db.collection('officialfiscalevents').find({ fiscalInvoice: invoiceId }).toArray();
console.log('officialfiscalevents vinculados:', events.length);

// Deleta em cascata (autorizado pelo usuário)
if (snapshots.length) await db.collection('fiscalsnapshots').deleteMany({ _id: { $in: snapshots.map(s => s._id) } });
if (providerTx.length) await db.collection('providertransactions').deleteMany({ _id: { $in: providerTx.map(p => p._id) } });
if (submissionIds.length) await db.collection('fiscalsubmissions').deleteMany({ _id: { $in: submissionIds } });
if (events.length) await db.collection('officialfiscalevents').deleteMany({ fiscalInvoice: invoiceId });
const invoiceResult = await db.collection('fiscalinvoices').deleteOne({ _id: invoiceId });

console.log('---');
console.log('fiscalinvoices removidos:', invoiceResult.deletedCount);
console.log('cascata removida: submissions=%d snapshots=%d providerTx=%d events=%d', submissionIds.length, snapshots.length, providerTx.length, events.length);

await mongoose.disconnect();

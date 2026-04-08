import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGO_URI);

const Snap = mongoose.model('DailyClosingSnapshot', new mongoose.Schema({}, { strict: false }), 'dailyclosingsnapshots');
const r = await Snap.deleteMany({ date: { $in: ['2026-04-07', '2026-04-06'] } });
console.log('Snapshots deletados:', r.deletedCount);

await mongoose.disconnect();

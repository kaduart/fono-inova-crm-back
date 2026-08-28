import 'dotenv/config';
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';

async function run() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_prod';
    await mongoose.connect(uri);
    const p = await Payment.findById('6a91db24840b39a658af1ba7').lean();
    console.log(JSON.stringify(p, null, 2));
    await mongoose.disconnect();
}
run().catch(e => { console.error(e); process.exit(1); });

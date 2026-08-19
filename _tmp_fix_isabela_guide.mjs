// WRITE (confirmed by user). Fixes InsuranceGuide 6a32afa7a75fceb53ac038d6 usedSessions
// 10 -> 8, matching real consumptionHistory evidence (8 entries), and reopens status
// to 'active' so the 2 pending appointments (19/08, 26/08) can be completed. Delete after use.
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import InsuranceGuide from './models/InsuranceGuide.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const GUIDE_ID = '6a32afa7a75fceb53ac038d6';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const guide = await InsuranceGuide.findById(GUIDE_ID);
  if (!guide) throw new Error('Guide not found');

  console.log('BEFORE:', {
    number: guide.number,
    status: guide.status,
    usedSessions: guide.usedSessions,
    totalSessions: guide.totalSessions,
    consumptionHistoryLength: guide.consumptionHistory?.length,
  });

  if (guide.usedSessions !== 10 || guide.consumptionHistory?.length !== 8 || guide.status !== 'exhausted') {
    throw new Error('SAFETY CHECK FAILED: guide state does not match expected pre-fix snapshot. Aborting without writing.');
  }

  guide.usedSessions = 8;
  guide.status = 'active';
  await guide.save();

  console.log('AFTER:', {
    number: guide.number,
    status: guide.status,
    usedSessions: guide.usedSessions,
    totalSessions: guide.totalSessions,
  });

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });

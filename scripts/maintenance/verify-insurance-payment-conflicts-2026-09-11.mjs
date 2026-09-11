#!/usr/bin/env node

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(scriptDir, '../../.env') });

const REPAIRED_SESSION_IDS = new Set([
  '6a7ce133d01df3056ebaea35', '6a7ce133d01df3056ebaea34',
  '6a7ce133d01df3056ebaea37', '6a7ce133d01df3056ebaea36',
  '6a7ce133d01df3056ebaea38', '6a4576de02c3c83ca19de717',
  '6a4576de02c3c83ca19de718', '6a4576de02c3c83ca19de71a',
  '6a1dc2eb4bafb710ab1610ad', '6a1dc25d4bafb710ab160f45',
  '6a1dc25d4bafb710ab160f43', '6a1dc25d4bafb710ab160f42',
  '6a1dc25d4bafb710ab160f40', '69d67dfe19c6571d8c76dbc5',
  '69d646e885f1fc2849c5b662', '6a0c540580cc438aa0b67d3c',
]);

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const { getInsuranceGuidesView } = await import('../../services/insuranceGuide/insuranceGuidesReadView.js');
  const view = await getInsuranceGuidesView({ detail: 'summary' });
  const conflicts = view.paymentIntegrityConflicts || [];
  const repairedStillConflicting = conflicts.filter(item => REPAIRED_SESSION_IDS.has(String(item.sessionId)));

  console.log(JSON.stringify({
    globalConflictCount: view.paymentIntegrityConflictCount,
    repairedSessionConflictCount: repairedStillConflicting.length,
    repairedSessionConflictIds: repairedStillConflicting.map(item => item.sessionId),
    expectedRepairedSessionConflictCount: 0,
  }, null, 2));

  if (repairedStillConflicting.length !== 0) process.exitCode = 2;
}

main()
  .catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });


import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
await mongoose.connect(MONGO_URI);

const correlationId = 'bbd7ba35-3f27-4832-adc4-395d756e046e';
const apptId = '6a4650b8f36c254eafc432e2';

const collections = await mongoose.connection.db.listCollections().toArray();
const results = {};

for (const collInfo of collections) {
  const collName = collInfo.name;
  const coll = mongoose.connection.db.collection(collName);
  const docs = await coll.find({
    $or: [
      { correlationId },
      { 'metadata.correlationId': correlationId },
      { 'payload.correlationId': correlationId },
      { 'data.correlationId': correlationId },
    ]
  }).limit(50).toArray();
  if (docs.length > 0) {
    results[collName] = docs;
  }
}

console.log('Collections with correlationId:', Object.keys(results));
for (const [k, v] of Object.entries(results)) {
  console.log(`\n=== ${k} (${v.length}) ===`);
  for (const doc of v) {
    console.log(JSON.stringify(doc, null, 2).substring(0, 800));
  }
}

await mongoose.disconnect();

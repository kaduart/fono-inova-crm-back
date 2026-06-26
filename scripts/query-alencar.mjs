import 'dotenv/config';
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const db = client.db();

// Busca Alencar
const pts = await db.collection('patients').find({ fullName: /alencar/i }, { projection: { fullName:1 } }).toArray();
console.log('patients:', JSON.stringify(pts, null, 2));

const leads = await db.collection('leads').find({ name: /alencar/i }, { projection: { name:1 } }).toArray();
console.log('leads:', JSON.stringify(leads, null, 2));

await client.close();

/**
 * Cria conta admin para Ricardo Maia Santos
 *
 *   node scripts/create-admin-user.js
 */

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGODB_URI não encontrado'); process.exit(1); }

const ADMIN_DATA = {
    fullName: 'Ricardo Maia Santos',
    email: 'ricardo@clinicafonoinova.com.br',
    password: '@Soundcar10',
    role: 'admin',
};

async function run() {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB');

    const db = mongoose.connection.db;
    const col = db.collection('admins');

    const existing = await col.findOne({ email: ADMIN_DATA.email });
    if (existing) {
        console.log('⚠️  Usuário já existe:', existing.email, '| role:', existing.role);
        await mongoose.disconnect();
        return;
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(ADMIN_DATA.password, salt);

    const result = await col.insertOne({
        fullName: ADMIN_DATA.fullName,
        email: ADMIN_DATA.email,
        password: hashedPassword,
        role: ADMIN_DATA.role,
        createdAt: new Date(),
    });

    console.log('✅ Admin criado:', ADMIN_DATA.email, '| id:', result.insertedId);
    console.log('🔑 Role:', ADMIN_DATA.role);

    await mongoose.disconnect();
}

run().catch(err => { console.error('💥', err.message); process.exit(1); });

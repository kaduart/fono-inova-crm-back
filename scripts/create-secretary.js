/**
 * Cria conta de secretária no sistema
 *
 * Edite SECRETARY_DATA abaixo e rode:
 *   node scripts/create-secretary.js
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

// ── EDITE AQUI ──────────────────────────────────────────────────
const SECRETARY_DATA = {
    fullName: 'Josy',                          // nome completo
    email: 'josy@clinicafonoinova.com.br',     // email de login
    password: 'Fono@2026',                     // senha provisória
};
// ────────────────────────────────────────────────────────────────

async function run() {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB');

    const db = mongoose.connection.db;
    const col = db.collection('users');

    const existing = await col.findOne({ email: SECRETARY_DATA.email });
    if (existing) {
        console.log('⚠️  Usuário já existe:', existing.email, '| role:', existing.role);
        await mongoose.disconnect();
        return;
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(SECRETARY_DATA.password, salt);

    const result = await col.insertOne({
        fullName: SECRETARY_DATA.fullName,
        email: SECRETARY_DATA.email,
        password: hashedPassword,
        role: 'secretary',
        createdAt: new Date(),
    });

    console.log('✅ Secretária criada:', SECRETARY_DATA.email, '| id:', result.insertedId);
    console.log('🔑 Role: secretary');
    console.log('🔒 Senha provisória:', SECRETARY_DATA.password, '(peça para trocar no primeiro login)');

    await mongoose.disconnect();
}

run().catch(err => { console.error('💥', err.message); process.exit(1); });

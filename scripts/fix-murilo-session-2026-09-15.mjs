// Reparo pontual: Session do Murilo Azevedo Lisboa (11:20, 15/09/2026) ficou com
// isPaid=false / paymentStatus='unpaid' mesmo com o Payment já 'paid' (o PATCH
// /api/v2/payments/:id que marcou o pagamento como pago nunca sincronizava Session —
// bug já corrigido em routes/payment.v2.js). Esse update corrige só o dado histórico
// desse documento específico; não afeta nenhum outro registro.
//
// Uso: node scripts/fix-murilo-session-2026-09-15.mjs

import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const SESSION_ID = '6aa7e22a31d21e831a208344';
const PAID_AT = '2026-09-15T15:10:54.471Z'; // igual ao paidAt do Payment 6aa7e22a31d21e831a20834a

async function main() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) {
        console.error('MONGO_URI/MONGODB_URI não encontrado no .env');
        process.exit(1);
    }

    await mongoose.connect(uri);
    console.log('Conectado ao Mongo:', mongoose.connection.name);

    const Session = mongoose.connection.collection('sessions');
    const sessionId = new mongoose.Types.ObjectId(SESSION_ID);

    const before = await Session.findOne(
        { _id: sessionId },
        { projection: { isPaid: 1, paymentStatus: 1, paidAt: 1, patient: 1 } }
    );
    console.log('ANTES:', before);

    if (!before) {
        console.error('Session não encontrada — nada foi alterado.');
        await mongoose.disconnect();
        process.exit(1);
    }

    const result = await Session.updateOne(
        { _id: sessionId },
        { $set: { isPaid: true, paymentStatus: 'paid', paidAt: new Date(PAID_AT) } }
    );
    console.log('Resultado do update:', result);

    const after = await Session.findOne(
        { _id: sessionId },
        { projection: { isPaid: 1, paymentStatus: 1, paidAt: 1, patient: 1 } }
    );
    console.log('DEPOIS:', after);

    await mongoose.disconnect();
    console.log('OK — desconectado.');
}

main().catch(async (err) => {
    console.error('Erro:', err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});

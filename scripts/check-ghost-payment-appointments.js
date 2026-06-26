/**
 * Checa o status dos appointments vinculados aos ghost payments da Antonella.
 * Decide: DELETAR (se scheduled) ou CORRIGIR billingType (se completed).
 */
import mongoose from 'mongoose';
import fs from 'fs';

const PAYMENT_IDS = [
    '6a3c0c92c3dd2574dca6508d',
    '6a3c0c33c3dd2574dca64fea'
];
const APPOINTMENT_IDS = [
    '6a3c0c91bbd6959696d276e3',
    '6a3c0c32bbd6959696d276b5'
];

const DRY_RUN = !process.argv.includes('--apply');

async function run() {
    const envContent = fs.readFileSync('.env', 'utf8');
    const match = envContent.match(/MONGO_URI=[\"']?([^\"'\n]+)[\"']?/);
    const uri = match ? match[1] : null;
    if (!uri) { console.error('MONGO_URI nao encontrado'); process.exit(1); }
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });
    const db = mongoose.connection.db;

    console.log(`\nModo: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}\n`);

    const appts = await db.collection('appointments').find({
        _id: { $in: APPOINTMENT_IDS.map(id => new mongoose.Types.ObjectId(id)) }
    }).toArray();

    let allCompleted = true;
    for (const a of appts) {
        const isCompleted = ['completed', 'force_cancelled'].includes(a.operationalStatus);
        if (!isCompleted) allCompleted = false;
        console.log(`Appointment ${a._id}`);
        console.log(`  operationalStatus: ${a.operationalStatus}`);
        console.log(`  clinicalStatus:    ${a.clinicalStatus}`);
        console.log(`  date:              ${a.date}`);
        console.log(`  specialty:         ${a.specialty}`);
        console.log(`  billingType:       ${a.billingType}`);
        console.log(`  insuranceProvider: ${a.insuranceProvider}`);
        console.log();
    }

    if (appts.length === 0) {
        console.log('Appointments nao encontrados');
        await mongoose.disconnect();
        return;
    }

    if (allCompleted) {
        console.log('=> Appointments COMPLETED: sessoes reais do convenio');
        console.log('   Acao: CORRIGIR billingType para convenio (nao deletar)\n');
        if (!DRY_RUN) {
            await db.collection('payments').updateMany(
                { _id: { $in: PAYMENT_IDS.map(id => new mongoose.Types.ObjectId(id)) } },
                { $set: { billingType: 'convenio' } }
            );
            console.log('OK: billingType corrigido para convenio nos 2 payments.');
        } else {
            console.log('Use --apply para corrigir.');
        }
    } else {
        console.log('=> Appointments NAO completados: payments sao ghosts');
        console.log('   Acao: DELETAR\n');
        if (!DRY_RUN) {
            await db.collection('payments').deleteMany(
                { _id: { $in: PAYMENT_IDS.map(id => new mongoose.Types.ObjectId(id)) } }
            );
            console.log('OK: ghost payments deletados.');
        } else {
            console.log('Use --apply para deletar.');
        }
    }

    await mongoose.disconnect();
}

run().catch(err => { console.error('Erro:', err); process.exit(1); });

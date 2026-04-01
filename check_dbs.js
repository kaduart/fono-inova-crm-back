import mongoose from 'mongoose';

const uriBase = "mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net";
const databases = ['crm_test_e2e', 'crm_development', 'crm_production'];

async function checkDB(dbName) {
    try {
        const conn = await mongoose.createConnection(`${uriBase}/${dbName}`).asPromise();
        const userCount = await conn.collection('users').countDocuments();
        const users = await conn.collection('users')
            .find({ email: /clinicafonoinova|admin|test/i })
            .project({ email: 1, role: 1, fullName: 1 })
            .limit(5)
            .toArray();
        
        console.log(`\n=== ${dbName} ===`);
        console.log(`Total users: ${userCount}`);
        console.log('Usuários encontrados:', users.map(u => `${u.email} (${u.role})`).join('\n  ') || 'Nenhum match');
        
        await conn.close();
    } catch (e) {
        console.log(`\n=== ${dbName} === ERRO: ${e.message}`);
    }
}

async function main() {
    for (const db of databases) {
        await checkDB(db);
    }
    process.exit(0);
}

main();

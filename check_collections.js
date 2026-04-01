import mongoose from 'mongoose';

const uriBase = "mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net";

async function checkDB(dbName) {
    try {
        const conn = await mongoose.createConnection(`${uriBase}/${dbName}`).asPromise();
        const collections = await conn.db.listCollections().toArray();
        
        console.log(`\n=== ${dbName} ===`);
        console.log('Collections:', collections.map(c => c.name).join(', ') || 'Nenhuma');
        
        // Verificar se tem user em qualquer collection
        for (const coll of collections.slice(0, 3)) {
            const count = await conn.collection(coll.name).countDocuments();
            console.log(`  ${coll.name}: ${count} docs`);
        }
        
        await conn.close();
    } catch (e) {
        console.log(`\n=== ${dbName} === ERRO: ${e.message}`);
    }
}

async function main() {
    await checkDB('crm_development');
    process.exit(0);
}

main();

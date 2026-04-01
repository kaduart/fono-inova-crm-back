import mongoose from 'mongoose';

const uri = "mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development";

async function main() {
    const conn = await mongoose.createConnection(uri).asPromise();
    
    // Atualizar admin para ter fullName
    const result = await conn.collection('admins').updateOne(
        { email: 'clinicafonoinova@gmail.com' },
        { $set: { fullName: 'Admin Clinica' } }
    );
    
    console.log('Update result:', result);
    
    // Verificar
    const admin = await conn.collection('admins').findOne({ email: 'clinicafonoinova@gmail.com' });
    console.log('Admin atualizado:', admin);
    
    await conn.close();
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

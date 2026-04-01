import mongoose from 'mongoose';

const uriBase = "mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development";

async function main() {
    const conn = await mongoose.createConnection(uriBase).asPromise();
    
    // Verificar users
    const users = await conn.collection('users').find({}).limit(3).toArray();
    console.log('=== COLLECTION: users ===');
    console.log('Count:', await conn.collection('users').countDocuments());
    console.log('Samples:', users.map(u => ({ email: u.email, role: u.role, name: u.fullName })));
    
    // Verificar admins
    const admins = await conn.collection('admins').find({}).limit(3).toArray();
    console.log('\n=== COLLECTION: admins ===');
    console.log('Count:', await conn.collection('admins').countDocuments());
    console.log('Samples:', admins.map(a => ({ email: a.email, role: a.role, name: a.fullName })));
    
    // Verificar patients
    const patients = await conn.collection('patients').find({}).limit(3).toArray();
    console.log('\n=== COLLECTION: patients ===');
    console.log('Count:', await conn.collection('patients').countDocuments());
    console.log('Samples:', patients.map(p => ({ email: p.email, name: p.fullName })));
    
    await conn.close();
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

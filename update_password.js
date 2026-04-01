import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const uri = "mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development";

async function main() {
    const conn = await mongoose.createConnection(uri).asPromise();
    
    const newPassword = '@Soundcar10';
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(newPassword, salt);
    
    const result = await conn.collection('admins').updateOne(
        { email: 'clinicafonoinova@gmail.com' },
        { $set: { password: hash } }
    );
    
    console.log('Password updated:', result.modifiedCount === 1 ? 'OK' : 'Falhou');
    
    // Testar
    const admin = await conn.collection('admins').findOne({ email: 'clinicafonoinova@gmail.com' });
    const isMatch = await bcrypt.compare('@Soundcar10', admin.password);
    console.log('Password test:', isMatch ? 'OK' : 'Falhou');
    
    await conn.close();
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

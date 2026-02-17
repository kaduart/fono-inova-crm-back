
require('dotenv').config({ path: '../.env' });
const mongoose = require('mongoose');
const Doctor = require('../models/Doctor');

async function listDoctors() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Conectado ao Mongo');

        const doctors = await Doctor.find({});
        console.log('--- LISTA DE MÉDICOS ---');
        doctors.forEach(d => {
            console.log(`ID: ${d._id} | Nome: ${d.fullName} | Especialidade: ${d.specialty} | Ativo: ${d.active}`);
        });
        console.log('------------------------');

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

listDoctors();

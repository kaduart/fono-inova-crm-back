// models/Specialty.js
import mongoose from 'mongoose';

const specialtySchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true
    },
    description: String
});

// Certifique-se que está registrando o modelo corretamente
const Specialty = mongoose.model('Specialty', specialtySchema);

export default Specialty; 
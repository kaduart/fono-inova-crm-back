import mongoose from 'mongoose';

const s = new mongoose.Schema({
    n: { type: Number, min: 1 }
});

const M = mongoose.model('Sanity', s);

await mongoose.connect(process.env.MONGO_URI);

await M.create({ n: 0 });

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGO_URI);

const { default: User } = await import('./models/User.js');
const u = await User.findById('6a2806fbd330bd5bec8e8d37').lean();
console.log(u);

await mongoose.disconnect();

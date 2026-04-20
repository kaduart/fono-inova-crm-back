import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { config } from 'dotenv';
config();

const User = (await import('./models/User.js')).default;

await mongoose.connect(process.env.MONGO_URI);
const user = await User.findOne({ role: 'admin' }).select('_id fullName email role').lean();
if (!user) {
  console.log('Nenhum admin encontrado');
  process.exit(1);
}
const token = jwt.sign(
  { id: user._id.toString(), email: user.email, role: user.role, name: user.fullName },
  process.env.JWT_SECRET,
  { expiresIn: '2h' }
);
console.log('USER_ID=' + user._id.toString());
console.log('TOKEN=' + token);
await mongoose.disconnect();

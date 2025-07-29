import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import express from 'express';
import jwt from 'jsonwebtoken';
import Admin from '../models/Admin.js';
import Doctor from '../models/Doctor.js';
import User from '../models/User.js';
import { auth } from '../middleware/auth.js';

dotenv.config();

const router = express.Router();

router.post('/', async (req, res) => {
  const { email, password, role } = req.body;


  try {
    let user;
    if (role === 'doctor') {
      user = await Doctor.findOne({ email });
    } else if (role === 'admin') {
      user = await Admin.findOne({ email });
    } else {
      user = await User.findOne({ email, role });
    }
    if (!user) {
      return res.status(400).send({ error: 'Invalid email or role' });
    }

    if (!user.password) {
      return res.status(400).send({ error: 'Usuário não possui senha registrada' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).send({ error: 'Invalid password' });
    }

    const tokenPayload = {
      id: user._id.toString(),
      role: user.role,
      name: user.fullName
    };
    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '24h' });

    res.send({
      token,
      role: user.role,
      name: user.fullName
    });

  } catch (error) {
    console.error('Erro ao fazer login:', error); // <-- Adiciona este log
    res.status(500).send({ error: 'Server error', message: error.message });
  }
});


router.post('/renew-token', auth, (req, res) => {
  try {
    // Remove a propriedade 'iat' e 'exp' do usuário antes de gerar novo token
    const { iat, exp, ...userData } = req.user;

    const newToken = jwt.sign(
      userData,
      process.env.JWT_SECRET,
      { expiresIn: '1h' } // Ajuste o tempo conforme necessário
    );

    res.json({ newToken });
  } catch (error) {
    console.error('Error renewing token:', error);
    res.status(500).json({ error: 'Failed to renew token' });
  }
});


export default router;

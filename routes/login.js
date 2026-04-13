import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import express from 'express';
import jwt from 'jsonwebtoken';
import { auth } from '../middleware/auth.js';
import Admin from '../models/Admin.js';
import Doctor from '../models/Doctor.js';
import User from '../models/User.js';

dotenv.config();

const router = express.Router();

router.post('/', async (req, res) => {
  const { email, password, role } = req.body;
  const t0 = Date.now();
  const timing = { role: role || 'unknown' };

  try {
    let user;
    const t1 = Date.now();
    
    if (role === 'doctor') {
      user = await Doctor.findOne({ email })
        .select('+password')
        .populate('specialty', 'name');
    } else if (role === 'admin') {
      user = await Admin.findOne({ email }).select('+password');
    } else {
      user = await User.findOne({ email, role }).select('+password');
    }
    
    timing.dbQuery = Date.now() - t1;

    if (!user) {
      console.log(`[LOGIN_TIMING] ${email} | NOT_FOUND | total=${Date.now() - t0}ms | db=${timing.dbQuery}ms`);
      return res.status(400).send({ error: 'Invalid email or role' });
    }

    const t2 = Date.now();
    const isMatch = await bcrypt.compare(password.trim(), user.password);
    timing.bcrypt = Date.now() - t2;

    if (!isMatch) {
      console.log(`[LOGIN_TIMING] ${email} | WRONG_PASSWORD | total=${Date.now() - t0}ms | db=${timing.dbQuery}ms | bcrypt=${timing.bcrypt}ms`);
      return res.status(400).send({ error: 'Senha inválida' });
    }

    const t3 = Date.now();
    // Prepara os dados do usuário
    const userData = {
      id: user._id.toString(),
      name: user.fullName,
      email: user.email,
      role: user.role
    };
    // Adiciona specialty se for médico
    if (role === 'doctor' && user.specialty) {
      userData.specialty = user.specialty;
    }

    const token = jwt.sign(
      {
        id: user._id.toString(),
        role: user.role,
        name: user.fullName,
        specialty: role === 'doctor' ? user.specialty?.name : undefined
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    timing.jwt = Date.now() - t3;
    timing.total = Date.now() - t0;

    console.log(`[LOGIN_TIMING] ${email} | SUCCESS | total=${timing.total}ms | db=${timing.dbQuery}ms | bcrypt=${timing.bcrypt}ms | jwt=${timing.jwt}ms | role=${timing.role}`);

    res.send({ token, user: userData });

  } catch (error) {
    console.error('Erro ao fazer login:', error);
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

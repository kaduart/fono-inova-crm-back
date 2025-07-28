import dotenv from 'dotenv';
import express from 'express';

import { auth } from '../middleware/auth.js';
import Admin from '../models/Admin.js';
import Appointment from '../models/Appointment.js';
import Doctor from '../models/Doctor.js';
import User from '../models/User.js';
dotenv.config();

const router = express.Router();

router.post('/add-doctor', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).send({ error: 'Não autorizado add Profissional.' });
  }

  const { fullName, email, specialty, licenseNumber, phoneNumber, password } = req.body;

  try {
    const doctor = new Doctor({ fullName, email, specialty, licenseNumber, phoneNumber, password });
    await doctor.save();
    res.status(201).send({ message: 'Terapeuta adicionado com sucesso!' });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).send({ error: 'Email ou Licença já existe!' });
    }
    res.status(400).send({ error: error.message });
  }
});

router.post('/add-admin', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).send({ error: 'Não autorizado add admins' });
  }

  const { fullName, email, password } = req.body;

  try {
    const admin = new Admin({ fullName, email, password });
    await admin.save();
    res.status(201).send({ message: 'Admin adicionado com successo' });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).send({ error: 'Email ja existe' });
    }
    res.status(400).send({ error: error.message });
  }
});

/* router.post('/add', auth, async (req, res) => {

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized to add patients' });
  }

  const {
    fullName,
    dateOfBirth,
    gender,
    maritalStatus,
    profession,
    placeOfBirth,
    address,
    phone,
    email,
    cpf,
    rg,
    specialties,
    mainComplaint,
    clinicalHistory,
    medications,
    allergies,
    familyHistory,
    healthPlan,
    legalGuardian,
    emergencyContact,
    imageAuthorization,
  } = req.body;

  try {
    const patient = new Patient({
      fullName,
      dateOfBirth,
      gender,
      maritalStatus,
      profession,
      placeOfBirth,
      address,
      phone,
      email,
      cpf,
      rg,
      specialties,
      mainComplaint,
      clinicalHistory,
      medications,
      allergies,
      familyHistory,
      healthPlan,
      legalGuardian,
      emergencyContact,
      imageAuthorization,
    });

    await patient.save();
    res.status(201).json({ message: 'Patient added successfully!' });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Email, CPF or RG already exist!' });
    }
    res.status(400).json({ error: error.message });
  }
}); */



router.get('/profile', auth, async (req, res) => {
  try {
    const admin = await Admin.findById(req.user.id).select('-password');
    if (!admin) {
      return res.status(404).send({ error: 'Admin not found' });
    }
    res.json(admin);
  } catch (error) {
    console.error(error);
    res.status(500).send({ error: 'Server error' });
  }
});

router.put('/profile', auth, async (req, res) => {
  try {
    const { fullName, email } = req.body;
    const admin = await Admin.findById(req.user.id);
    if (!admin) {
      return res.status(404).send({ error: 'Admin not found' });
    }
    admin.fullName = fullName;
    admin.email = email;
    await admin.save();
    const adminWithoutPassword = admin.toObject();
    delete adminWithoutPassword.password;
    res.json({ message: 'Profile updated successfully', admin: adminWithoutPassword });
  } catch (error) {
    console.error(error);
    res.status(500).send({ error: 'Server error' });
  }
});

router.get('/total-doctors', auth, async (req, res) => {
  try {
    const totalDoctors = await Doctor.countDocuments();
    res.json({ totalDoctors });
  } catch (error) {
    console.error('Error fetching total doctors:', error);
    res.status(500).send({ error: 'Server error' });
  }
});

router.get('/total-patients', auth, async (req, res) => {
  try {
    const totalPatients = await User.countDocuments({ role: 'patient' });
    res.json({ totalPatients });
  } catch (error) {
    console.error('Error fetching total patients:', error);
    res.status(500).send({ error: 'Server error' });
  }
});

router.get('/doctor-overview', auth, async (req, res) => {
  try {
    const result = await Appointment.aggregate([
      {
        $lookup: {
          from: "doctors",
          localField: "doctor",
          foreignField: "_id",
          as: "doctorInfo"
        }
      },
      { $unwind: "$doctorInfo" },
      {
        $group: {
          _id: {
            doctorId: "$doctor",
            patientId: "$patient"
          },
          doctorName: { $first: "$doctorInfo.fullName" },
          specialty: { $first: "$doctorInfo.specialty" }
        }
      },
      {
        $group: {
          _id: {
            doctorId: "$_id.doctorId",
            doctorName: "$doctorName",
            specialty: "$specialty"
          },
          patients: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          doctorId: "$_id.doctorId",
          name: "$_id.doctorName",
          specialty: "$_id.specialty",
          patients: 1
        }
      }
    ]);

    res.json(result);
  } catch (error) {
    console.error('Error fetching doctor overview:', error);
    res.status(500).send({ error: 'Server error' });
  }
});

router.get('/patient-overview', auth, async (req, res) => {
  try {
    const patients = await User.find({ role: 'patient' }).select('fullName');
    const patientOverview = await Promise.all(patients.map(async (patient) => {
      const appointmentCount = await Appointment.countDocuments({ patientId: patient._id });
      return {
        name: `${patient.fullName}`,
        appointments: appointmentCount
      };
    }));
    res.json(patientOverview);
  } catch (error) {
    console.error('Error fetching patient overview:', error);
    res.status(500).send({ error: 'Server error' });
  }
});

router.get('/appointment/completed-cancelled', auth, async (req, res) => {
  try {
    const appointments = await Appointment.find({
      status: { $in: ['completed', 'cancelled'] }
    })
      .populate('doctor', 'fullName').populate('patientId', 'fullName')
      .sort({ date: -1 }); // Show latest first

    res.json(appointments);
  } catch (error) {
    console.error('Error fetching completed/cancelled appointments:', error);
    res.status(500).send({ error: 'Server error' });
  }
});

router.get('/appointments/upcoming', auth, async (req, res) => {
  try {
    // Set end of today (i.e. start of tomorrow)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Only fetch scheduled appointments for dates after today (i.e. tomorrow and beyond)
    const upcomingAppointments = await Appointment.find({
      status: 'scheduled',
      date: { $gte: today }
    })
      .populate('doctor', 'fullName').populate('patientId', 'fullName')
      .sort({ date: 1, time: 1 });

    res.json(upcomingAppointments);
  } catch (error) {
    console.error('Error fetching upcoming appointments:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;

import express from 'express';

const router = express.Router();

// Lista de especialidades com ícones e cores
// id = valor usado no MongoDB (deve bater com Doctor.specialty enum)
router.get('/', (req, res) => {
    res.json([
        {
            id: 'fonoaudiologia',
            name: 'Fonoaudiologia',
            icon: 'mic',
            color: '#4CAF50',
            sessionDuration: 40
        },
        {
            id: 'neuroped',
            name: 'Neuropediatria',
            icon: 'brain',
            color: '#2196F3',
            sessionDuration: 40
        },
        {
            id: 'psicologia',
            name: 'Psicologia',
            icon: 'psychology',
            color: '#FF9800',
            sessionDuration: 40
        },
        {
            id: 'terapia_ocupacional',
            name: 'Terapia Ocupacional',
            icon: 'accessibility',
            color: '#9C27B0',
            sessionDuration: 40
        },
        {
            id: 'fisioterapia',
            name: 'Fisioterapia',
            icon: 'fitness_center',
            color: '#F44336',
            sessionDuration: 40
        },
        {
            id: 'musicoterapia',
            name: 'Musicoterapia',
            icon: 'music_note',
            color: '#17c041',
            sessionDuration: 40
        },
        {
            id: 'psicomotricidade',
            name: 'Psicomotricidade',
            icon: 'directions_run',
            color: '#FF5722',
            sessionDuration: 40
        },
        {
            id: 'psicopedagogia',
            name: 'Psicopedagogia',
            icon: 'school',
            color: '#9C27B0',
            sessionDuration: 40
        },
        {
            id: 'neuropsicologia',
            name: 'Neuropsicologia',
            icon: 'psychology_alt',
            color: '#673AB7',
            sessionDuration: 40
        }
    ]);
});

export default router;
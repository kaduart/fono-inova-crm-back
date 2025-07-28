// middleware/validateId.js
import mongoose from 'mongoose';

export default function validateId(req, res, next) {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: 'ID inválido' });
    }
    next();
}

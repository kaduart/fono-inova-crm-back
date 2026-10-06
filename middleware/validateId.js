// middleware/validateId.js
import mongoose from 'mongoose';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

export default function validateId(req, res, next) {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return sendApiError(res, new AppError('BAD_REQUEST', 'ID inválido', { status: 400 }), req);
    }
    next();
}

// middleware/publicAuth.js
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

export const optionalAuth = async (req, res, next) => {
    try {
        const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
        if (token) {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secreta');

            if (decoded.id && mongoose.Types.ObjectId.isValid(decoded.id)) {
                const userModel = mongoose.model(
                    decoded.role === 'admin' ? 'Admin' :
                        decoded.role === 'secretary' ? 'Secretary' : 'Doctor'
                );

                const userExists = await userModel.exists({ _id: decoded.id });
                if (userExists) {
                    req.user = {
                        id: decoded.id,
                        role: decoded.role
                    };
                }
            }
        }
        next();
    } catch (err) {
        // Ignora erros de autenticação em rotas públicas
        next();
    }
};
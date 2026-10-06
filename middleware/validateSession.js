import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';
const validateSession = (req, res, next) => {
    if (req.body.status === 'canceled' && req.body.confirmedAbsence === undefined) {
        return sendApiError(
          res,
          new AppError('BAD_REQUEST', "Para sessões canceladas, o campo 'confirmedAbsence' é obrigatório", {
            status: 400,
          }),
          req
        );
    }
    next();
};

export default validateSession;
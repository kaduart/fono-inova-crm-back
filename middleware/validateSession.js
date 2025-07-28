const validateSession = (req, res, next) => {
    if (req.body.status === 'canceled' && req.body.confirmedAbsence === undefined) {
        return res.status(400).json({
            error: "Para sessões canceladas, o campo 'confirmedAbsence' é obrigatório"
        });
    }
    next();
};

export default validateSession;
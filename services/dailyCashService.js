// services/dailyCashService.js ou na rota de relatório

const getDailyCash = async (date) => {
    const startOfDay = moment(date).startOf('day').toDate();
    const endOfDay = moment(date).endOf('day').toDate();

    return Payment.aggregate([
        {
            $match: {
                $and: [
                    // Data do pagamento efetivo
                    {
                        $or: [
                            // Particular: data normal
                            { billingType: 'particular', paymentDate: { $gte: startOfDay, $lte: endOfDay } },
                            // Convênio: só quando recebeu
                            {
                                billingType: 'convenio',
                                'insurance.status': 'received',
                                'insurance.receivedAt': { $gte: startOfDay, $lte: endOfDay }
                            }
                        ]
                    },
                    { status: { $ne: 'cancelled' } }
                ]
            }
        },
        {
            $group: {
                _id: null,
                totalParticular: {
                    $sum: { $cond: [{ $eq: ['$billingType', 'particular'] }, '$amount', 0] }
                },
                totalConvenio: {
                    $sum: { $cond: [{ $eq: ['$billingType', 'convenio'] }, '$insurance.receivedAmount', 0] }
                },
                total: { $sum: '$amount' }
            }
        }
    ]);
};
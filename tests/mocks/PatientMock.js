export const mockPatient = {
    _id: '123',
    name: 'João da Silva',
    children: [
        { name: 'Maria', age: 5 },
        { name: 'Pedro', age: 7 }
    ]
};

// Mocker Mongoose com .lean()
export const Patient = {
    findById: () => ({
        lean: async () => mockPatient
    })
};

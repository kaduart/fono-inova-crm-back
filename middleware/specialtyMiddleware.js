const specialtyConfig = {
    fono: require('../config/fonoConfig'),
    neuroped: require('../config/neuropedConfig')
};

module.exports = (specialty) => {
    return (req, res, next) => {
        // Validar se especialidade existe
        if (!specialtyConfig[specialty]) {
            return res.status(400).json({ error: 'Especialidade não suportada' });
        }

        // Anexar configuração à requisição
        req.specialtyConfig = specialtyConfig[specialty];
        next();
    };
};
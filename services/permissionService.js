const checkEditPermission = (userId, evolution) => {
    if (evolution.createdBy.toString() === userId.toString()) return true;
    return userId.role === 'admin';
};

module.exports = checkEditPermission;

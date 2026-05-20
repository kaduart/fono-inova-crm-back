/**
 * Jest config para testes de snapshot financeiro
 */
export default {
    testEnvironment: 'node',
    transform: {},
    extensionsToTreatAsEsm: ['.js'],
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    testMatch: ['**/tests/**/*.snapshot.test.js'],
    setupFilesAfterEnv: [],
    verbose: true,
};

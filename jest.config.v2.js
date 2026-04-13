// jest.config.v2.js
// ⚙️ Configuração de testes para V2

export default {
  displayName: 'V2 Contract Tests',
  
  // Ambiente de teste
  testEnvironment: 'node',
  
  // Pattern de arquivos de teste (só DTO - sem dependência de banco)
  testMatch: [
    '**/tests/**/*.dto.test.js'
  ],
  
  // Setup files (desabilitado - testes não precisam de banco)
  // setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  
  // Transformações
  transform: {},
  
  // Coverage
  collectCoverageFrom: [
    'services/completeSessionService.v2.js',
    'dtos/*.js',
    'middleware/dtoMiddleware.js'
  ],
  
  // Reporters
  reporters: [
    'default',
    ['jest-junit', {
      outputDirectory: './coverage',
      outputName: 'junit-v2.xml'
    }]
  ],
  
  // Verbose
  verbose: true,
  
  // Timeout
  testTimeout: 30000
};

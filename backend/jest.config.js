module.exports = {
  testEnvironment: 'node',
  verbose: true,
  collectCoverage: true,
  coverageDirectory: 'coverage',
  testMatch: ['**/tests/**/*.test.js', '**/src/**/__tests__/**/*.test.js'],
  setupFilesAfterEnv: ['./tests/setup.js'],
  moduleFileExtensions: ['js', 'json'],
};

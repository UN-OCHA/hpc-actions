module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '../',
  testMatch: [
    '<rootDir>/test/specs/**/*.spec.ts',
  ],
  coverageDirectory: '<rootDir>/.coverage',
  coverageReporters: [
    ["lcov"]
  ],
  setupFilesAfterEnv: [
    '<rootDir>/test/jest-global-setup-hooks.ts'
  ],
};
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '../',
  testMatch: [
    '<rootDir>/test/specs/**/*.spec.ts',
  ],
  coverageDirectory: '<rootDir>/.coverage',
  coveragePathIgnorePatterns: [
    '<rootDir>/test',
  ],
  coverageReporters: [
    ["text"],
    ["lcov"],
  ],
  setupFilesAfterEnv: [
    '<rootDir>/test/jest-global-setup-hooks.ts'
  ],
};
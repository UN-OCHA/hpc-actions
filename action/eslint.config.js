const baseConfig = require('@unocha/hpc-repo-tools/eslint.config.base');

module.exports = [
  ...baseConfig,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      'unicorn/no-process-exit': 'off',
      'unicorn/prefer-module': 'off',
    },
  },
  {
    ignores: ['.github', 'dist', 'lib', '.prettierrc.js', 'eslint.config.js'],
  },
];

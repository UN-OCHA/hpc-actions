const baseConfig = require('@unocha/hpc-repo-tools/eslintrc.base');

module.exports = {
  ...baseConfig,
  parserOptions: {
    project: true,
    tsconfigRootDir: __dirname,
  },
  overrides: [
    ...baseConfig.overrides,
    {
      files: ['*.{ts,tsx}'],
      rules: {
        'unicorn/no-process-exit': 'off',
        'unicorn/prefer-module': 'off',
      },
    },
  ],
};

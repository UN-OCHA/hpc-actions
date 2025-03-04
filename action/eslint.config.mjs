import baseConfig from '@unocha/hpc-repo-tools/eslint.config.base.js';

export default [
  ...baseConfig,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
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

const js = require('@eslint/js');
const globals = require('globals');
module.exports = [
  { ignores: ['build/**', 'node_modules/**', 'coverage/**', 'public/**'] },
  { files: ['**/*.{js,jsx,mjs,cjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module',
      globals: { ...globals.node, ...globals.browser, ...globals.jest },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: { ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true, caughtErrors: 'none', varsIgnorePattern: '^React$' }],
    },
  },
  { files: ['**/*.cjs', 'src/setupProxy.js'], languageOptions: { sourceType: 'commonjs' } },
];

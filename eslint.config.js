import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/coverage/',
      '**/.aws-sam/',
      '**/test-results/',
      '**/playwright-report/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Before the style rules: it turns off formatting rules, `curly` among them.
  prettier,
  // Plain JS build/config scripts run in Node.
  { files: ['**/*.{js,mjs}'], languageOptions: { globals: globals.node } },
  // The project's TypeScript style guide (Google TypeScript Style Guide plus selected diet103
  // standards). Rules it states that a linter can't check (JSDoc on exports, Results for expected
  // failures, no `as` on external data) are left to review.
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'no-public' }],
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
        {
          selector: 'variable',
          modifiers: ['const', 'global'],
          format: ['camelCase', 'UPPER_CASE'],
        },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['UPPER_CASE'] },
        // Keys and imports follow whatever the other side (AWS, Cloudflare, HTTP) defines.
        {
          selector: ['objectLiteralProperty', 'objectLiteralMethod', 'typeProperty', 'import'],
          format: null,
        },
      ],
      curly: ['error', 'multi-line', 'consistent'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'default-case': 'error',
      'default-case-last': 'error',
      'no-new-wrappers': 'error',
      'no-array-constructor': 'error',
      'one-var': ['error', 'never'],
      'prefer-const': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportDefaultDeclaration', message: 'Use named exports.' },
        { selector: 'PrivateIdentifier', message: 'Use TypeScript `private`, not #private.' },
        { selector: 'TSEnumDeclaration[const=true]', message: 'const enum is not allowed.' },
        {
          selector:
            'FunctionExpression:not([generator=true]):not(:matches(MethodDefinition, Property[method=true], Property[kind="get"], Property[kind="set"]) > FunctionExpression)',
          message: 'Use an arrow function.',
        },
        {
          // `curly` can't tell loops from ifs: the guide lets only a one-line `if` skip braces.
          selector:
            ':matches(ForStatement, ForOfStatement, ForInStatement, WhileStatement, DoWhileStatement) > .body:not(BlockStatement)',
          message: 'Brace loop bodies.',
        },
        {
          selector:
            'IfStatement[alternate] > .consequent:not(BlockStatement), IfStatement > .alternate:not(BlockStatement, IfStatement)',
          message: 'Brace both branches of an if/else.',
        },
        {
          // Module-level named functions; nested helpers and typed variables may be arrows.
          selector:
            ':matches(Program, ExportNamedDeclaration) > VariableDeclaration > VariableDeclarator[id.typeAnnotation=undefined] > ArrowFunctionExpression',
          message: 'Use a function declaration for a named module-level function.',
        },
      ],
    },
  },
  // Tests may assert on values they just built.
  {
    files: ['**/test/**/*.ts', '**/e2e/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  // These tools load their config through a default export.
  {
    files: ['vitest.config.ts', 'web/vite.config.ts', 'web/playwright*.config.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);

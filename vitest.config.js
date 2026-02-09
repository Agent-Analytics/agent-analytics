import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.{js,mjs}'],
    testTimeout: 10000,
  },
});

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['web/src/**/*.spec.{ts,tsx}'],
    setupFiles: ['web/src/test-setup.ts'],
  },
});

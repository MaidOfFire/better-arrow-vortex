import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173 },
  // Module workers: the Beat This! worker loads ONNX Runtime's WebAssembly glue on demand.
  worker: { format: 'es' },
});

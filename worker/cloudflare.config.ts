import { bindings, defineConfig } from 'cf/config';

const name = 'seattle-schools-checker';

export default defineConfig({
  worker: {
    name,
    entrypoint: './worker.js',
    compatibilityDate: '2026-11-11',
    workersDev: true,
    previewUrls: false,
    env: {
      DB: bindings.d1({ id: '341c959f-14b7-4b1e-82bd-afd8adc9979a', name }),
      // Opaque identifiers for the pilot household. Kept out of the repository.
      FAMILY_ID: bindings.secret(),
      CHILD_IDS: bindings.secret(),
      INGEST_TOKEN: bindings.secret(),
      STATUS_TOKEN: bindings.secret(),
    },
  },
});

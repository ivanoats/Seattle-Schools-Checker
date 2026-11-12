import { bindings, defineConfig, defineContainer, exports } from 'cf/config';

const name = 'seattle-source-container-probe';
const probe = defineContainer({
  name,
  schedulingPolicy: 'durable-object',
  images: { base: { dockerfile: './Dockerfile', buildContext: '../..' } },
});

export default defineConfig({
  worker: {
    name,
    entrypoint: './worker.js',
    compatibilityDate: '2026-11-11',
    compatibilityFlags: ['nodejs_compat'],
    workersDev: true,
    previewUrls: false,
    exports: { SourceProbe: exports.durableObject({ storage: 'sqlite', container: probe }) },
    env: {
      PROBE: bindings.durableObject({ worker: name, exportName: 'SourceProbe' }),
      PROBE_TOKEN: bindings.secret(),
    },
  },
  containers: [probe],
});

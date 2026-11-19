import { bindings, defineConfig, triggers } from 'cf/config';

const name = 'seattle-schools-checker';

export default defineConfig({
  worker: {
    name,
    entrypoint: './worker.js',
    compatibilityDate: '2026-11-11',
    compatibilityFlags: ['nodejs_compat'],
    triggers: [triggers.scheduled({ schedule: '* * * * *' })],
    workersDev: true,
    previewUrls: false,
    env: {
      DB: bindings.d1({ id: '341c959f-14b7-4b1e-82bd-afd8adc9979a', name }),
      // Opaque identifiers for the pilot household. Kept out of the repository.
      FAMILY_ID: bindings.secret(),
      CHILD_IDS: bindings.secret(),
      INGEST_TOKEN: bindings.secret(),
      STATUS_TOKEN: bindings.secret(),
      // Access application identity and canonical origin for the invite-only UI.
      // Optional during the existing single-family runner pilot.
      ACCESS_TEAM_DOMAIN: bindings.secret(),
      ACCESS_AUD: bindings.secret(),
      APP_ORIGIN: bindings.secret(),
      PILOT_ADMIN_TOKEN: bindings.secret(),
      CONNECTION_KEY: bindings.secret(),
      SOURCE_DISCOVERY_TOKEN: bindings.secret(),
      SCHOOLOGY_DISCOVERY_TOKEN: bindings.secret(),
      SOURCE_CONNECTIONS_ENABLED: bindings.secret(),
      SCHOOLOGY_CONNECTIONS_ENABLED: bindings.secret(),
      HOSTED_CHECKS_ENABLED: bindings.secret(),
      HOSTED_CHECK_SKIP_DATES: bindings.secret(),
      REPORT_EMAIL_ENABLED: bindings.secret(),
      REPORT_EMAIL_FROM: bindings.secret(),
      REPORT_EMAIL_START_DATE: bindings.secret(),
      REPORT_EMAIL_TRANSPORT: bindings.secret(),
      BROWSER: bindings.browser(),
    },
  },
});

// Secrets (ANTHROPIC_API_KEY) and settings from the gitignored .env of the working dir; the real
// environment wins. Imported first: modules read the environment when they load.
try {
  process.loadEnvFile('.env')
} catch {}

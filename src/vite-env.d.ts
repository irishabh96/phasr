/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLERK_DESKTOP_CALLBACK_URL?: string;
  readonly VITE_CLERK_SESSION_JWT_TEMPLATE?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_RELEASE?: string;
  readonly VITE_SENTRY_TRACES_SAMPLE_RATE?: string;
  readonly VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE?: string;
  readonly VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE?: string;
}

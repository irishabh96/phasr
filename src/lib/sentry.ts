import * as Sentry from '@sentry/react';
import type { ErrorInfo } from 'react';

export const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;
export const SENTRY_RELEASE = import.meta.env.VITE_SENTRY_RELEASE as string | undefined;

export const isSentryConfigured = Boolean(SENTRY_DSN);

function readSampleRate(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(value, 0), 1);
}

function readTracesSampleRate(): number {
  return readSampleRate(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE, import.meta.env.PROD ? 0.1 : 0);
}

function readReplaysSessionSampleRate(): number {
  return readSampleRate(import.meta.env.VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE, import.meta.env.PROD ? 0.1 : 0);
}

function readReplaysOnErrorSampleRate(): number {
  return readSampleRate(import.meta.env.VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE, import.meta.env.PROD ? 1 : 0);
}

export function initSentry(router: unknown) {
  if (!SENTRY_DSN) {
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE,
    release: SENTRY_RELEASE,
    sendDefaultPii: true,
    integrations: [
      Sentry.tanstackRouterBrowserTracingIntegration(router),
      Sentry.replayIntegration({
        blockAllMedia: true,
        maskAllText: true,
      }),
    ],
    tracesSampleRate: readTracesSampleRate(),
    replaysSessionSampleRate: readReplaysSessionSampleRate(),
    replaysOnErrorSampleRate: readReplaysOnErrorSampleRate(),
  });
}

const handleReactRootError = Sentry.reactErrorHandler();

type ReactRootErrorInfo = {
  componentStack?: string | undefined;
  errorBoundary?: unknown | undefined;
};

export function sentryReactRootErrorHandler(error: unknown, errorInfo: ReactRootErrorInfo) {
  const normalizedErrorInfo: ErrorInfo = {
    componentStack: errorInfo.componentStack ?? null,
  };

  handleReactRootError(error, normalizedErrorInfo);
}

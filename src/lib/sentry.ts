import type { ErrorInfo } from 'react';
import type * as SentryReact from '@sentry/react';

export const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;
export const SENTRY_RELEASE = import.meta.env.VITE_SENTRY_RELEASE as string | undefined;

export const isSentryConfigured = Boolean(SENTRY_DSN);

// `@sentry/react` is a heavy dependency that is not needed for first
// paint. We keep it out of the entry chunk by importing it dynamically
// and only when Sentry is actually configured and something wants to
// report (or `initSentry` runs post-first-paint from `main.tsx`). The
// promise is memoised so the SDK is only fetched/evaluated once.
let sentryModule: Promise<typeof SentryReact> | null = null;

function loadSentry(): Promise<typeof SentryReact> {
  if (!sentryModule) {
    sentryModule = import('@sentry/react');
  }
  return sentryModule;
}

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

export async function initSentry(router: unknown): Promise<void> {
  if (!SENTRY_DSN) {
    return;
  }

  const Sentry = await loadSentry();

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE,
    release: SENTRY_RELEASE,
    sendDefaultPii: true,
    integrations: [
      Sentry.tanstackRouterBrowserTracingIntegration(router),
      Sentry.replayIntegration({
        // NOT blockAllMedia: its selector includes `svg`, and every icon in
        // this app is a lucide <svg>. Replay measures each blocked element
        // with getBoundingClientRect() from inside its whole-document
        // MutationObserver, so one blocked icon per mutation batch forces a
        // synchronous full-document layout. Switching tasks remounts a
        // subtree carrying hundreds of icons and the renderer stops
        // responding. Block real media explicitly instead.
        block: ["img", "image", "video", "audio", "canvas", "embed", "object"],
        maskAllText: true,
      }),
    ],
    tracesSampleRate: readTracesSampleRate(),
    replaysSessionSampleRate: readReplaysSessionSampleRate(),
    replaysOnErrorSampleRate: readReplaysOnErrorSampleRate(),
  });
}

// Created lazily from the dynamically-imported SDK so `@sentry/react`
// stays out of the entry chunk. React invokes these root handlers
// synchronously; reporting completes fire-and-forget once the SDK import
// resolves.
let reactRootErrorHandler: ReturnType<typeof SentryReact.reactErrorHandler> | null = null;

type ReactRootErrorInfo = {
  componentStack?: string | undefined;
  errorBoundary?: unknown | undefined;
};

export function sentryReactRootErrorHandler(error: unknown, errorInfo: ReactRootErrorInfo) {
  if (!isSentryConfigured) {
    return;
  }

  const normalizedErrorInfo: ErrorInfo = {
    componentStack: errorInfo.componentStack ?? null,
  };

  void loadSentry().then((Sentry) => {
    if (!reactRootErrorHandler) {
      reactRootErrorHandler = Sentry.reactErrorHandler();
    }
    reactRootErrorHandler(error, normalizedErrorInfo);
  });
}

type AuthTelemetryContext = {
  callbackKind: string;
  errorCode?: string;
  origin?: string;
  protocol?: string;
  expectedCookieNames?: string[];
  hasPhasrState?: boolean;
  reason?: string;
  storedCookieNames?: string[];
};

type P0TelemetryContext = {
  area: string;
  operation: string;
  [key: string]: unknown;
};

function normalizeError(error: unknown, fallbackMessage: string) {
  return error instanceof Error ? error : new Error(fallbackMessage);
}

function addP0Context(scope: SentryReact.Scope, context: P0TelemetryContext) {
  scope.setLevel('error');
  scope.setTag('priority', 'p0');
  scope.setTag('area', context.area);
  scope.setTag('operation', context.operation);
  if (typeof context.errorCode === 'string') {
    scope.setTag('error_code', context.errorCode);
  }
  scope.setContext('p0', context);
}

export function reportP0Error(
  message: string,
  error: unknown,
  context: P0TelemetryContext,
) {
  console.error(message, error);

  if (!isSentryConfigured) {
    return;
  }

  void loadSentry().then((Sentry) => {
    Sentry.withScope((scope) => {
      addP0Context(scope, context);
      Sentry.captureException(normalizeError(error, message));
    });
  });
}

export function reportP0Warning(
  message: string,
  context: P0TelemetryContext,
) {
  console.warn(message, context);

  if (!isSentryConfigured) {
    return;
  }

  void loadSentry().then((Sentry) => {
    Sentry.withScope((scope) => {
      scope.setLevel('warning');
      scope.setTag('priority', 'p0');
      scope.setTag('area', context.area);
      scope.setTag('operation', context.operation);
      if (typeof context.errorCode === 'string') {
        scope.setTag('error_code', context.errorCode);
      }
      scope.setContext('p0', context);
      Sentry.captureMessage(message);
    });
  });
}

export function captureAuthException(
  error: unknown,
  context: AuthTelemetryContext,
) {
  reportP0Error(`Phasr auth callback failed: ${context.callbackKind}`, error, {
    area: 'auth',
    operation: context.callbackKind,
    ...context,
  });
}

export function captureAuthWarning(
  message: string,
  context: AuthTelemetryContext,
) {
  reportP0Warning(message, {
    area: 'auth',
    operation: context.callbackKind,
    ...context,
  });
}

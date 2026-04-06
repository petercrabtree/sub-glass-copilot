type ReportSource = 'console.error' | 'window.error' | 'window.unhandledrejection';

interface DevErrorReport {
  source: ReportSource;
  message: string;
  url: string;
  path: string;
  title: string;
  timestamp: string;
  stack?: string;
  details?: unknown;
}

interface ReporterHandle {
  stop: () => void;
}

const REPORT_ENDPOINT = '/__dev/client-errors';
const DEDUPE_WINDOW_MS = 2500;
const RECENT_REPORT_LIMIT = 100;
const REPORTER_KEY = '__SUBGLASS_DEV_ERROR_REPORTER__';

function limitString(value: string, maxLength = 600): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function describeElement(element: Element): string {
  const tagName = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : '';
  const className =
    typeof element.className === 'string' && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 3).join('.')}`
      : '';
  const src =
    element instanceof HTMLImageElement
      ? element.currentSrc || element.src
      : element instanceof HTMLScriptElement
        ? element.src
        : element instanceof HTMLLinkElement
          ? element.href
          : undefined;
  return src ? `<${tagName}${id}${className}> ${src}` : `<${tagName}${id}${className}>`;
}

function serializeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return `[Function ${(value as Function).name || 'anonymous'}]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: 'cause' in value ? serializeValue(value.cause, depth + 1, seen) : undefined
    };
  }
  if (value instanceof URL) return value.toString();
  if (typeof Element !== 'undefined' && value instanceof Element) return describeElement(value);
  if (typeof Event !== 'undefined' && value instanceof Event) {
    return {
      type: value.type,
      target:
        typeof Element !== 'undefined' && value.target instanceof Element
          ? describeElement(value.target)
          : undefined
    };
  }

  if (Array.isArray(value)) {
    if (depth >= 3) return `[Array(${value.length})]`;
    return value.slice(0, 10).map((item) => serializeValue(item, depth + 1, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    const constructorName =
      value && typeof value === 'object' && 'constructor' in value
        ? (value as { constructor?: { name?: string } }).constructor?.name
        : undefined;

    if (depth >= 3) return `[${constructorName || 'Object'}]`;

    const entries = Object.entries(value as Record<string, unknown>).slice(0, 12);
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [key, serializeValue(entryValue, depth + 1, seen)])
    );
  }

  return String(value);
}

function summarizeValue(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value && typeof value === 'object' && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }

  try {
    return limitString(JSON.stringify(serializeValue(value)));
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function buildMessage(args: unknown[]): string {
  const summary = args.map((arg) => summarizeValue(arg)).filter(Boolean).join(' | ').trim();
  return summary || 'console.error called';
}

function buildFingerprint(report: DevErrorReport): string {
  const stackHead = report.stack?.split('\n').slice(0, 2).join('\n') || '';
  return [report.source, report.path, report.message, stackHead].join('::');
}

function shouldReport(report: DevErrorReport, recentReports: Map<string, number>): boolean {
  const now = Date.now();

  for (const [fingerprint, timestamp] of recentReports) {
    if (now - timestamp > DEDUPE_WINDOW_MS) {
      recentReports.delete(fingerprint);
    }
  }

  const fingerprint = buildFingerprint(report);
  const lastSeen = recentReports.get(fingerprint);
  if (typeof lastSeen === 'number' && now - lastSeen < DEDUPE_WINDOW_MS) {
    return false;
  }

  recentReports.set(fingerprint, now);
  if (recentReports.size > RECENT_REPORT_LIMIT) {
    const oldest = recentReports.keys().next().value;
    if (oldest) recentReports.delete(oldest);
  }

  return true;
}

async function postReport(report: DevErrorReport): Promise<void> {
  await fetch(REPORT_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
    keepalive: true
  });
}

function resourceFailureMessage(event: ErrorEvent): string {
  if (event.message?.trim()) return event.message.trim();
  if (typeof Element !== 'undefined' && event.target instanceof Element) {
    return `Resource failed to load: ${describeElement(event.target)}`;
  }
  return 'Window error event fired without a message';
}

function currentLocation() {
  return {
    url: window.location.href,
    path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    title: document.title
  };
}

export function startDevErrorReporter(): () => void {
  const globalScope = globalThis as typeof globalThis & {
    [REPORTER_KEY]?: ReporterHandle;
  };

  if (globalScope[REPORTER_KEY]) {
    return globalScope[REPORTER_KEY].stop;
  }

  const recentReports = new Map<string, number>();
  const originalConsoleError = console.error.bind(console);

  const send = (report: DevErrorReport) => {
    if (!shouldReport(report, recentReports)) return;
    void postReport(report).catch(() => {
      // Avoid recursive console.error loops if the dev endpoint is unavailable.
    });
  };

  const handleWindowError = (event: ErrorEvent) => {
    const { url, path, title } = currentLocation();
    send({
      source: 'window.error',
      message: resourceFailureMessage(event),
      url,
      path,
      title,
      timestamp: new Date().toISOString(),
      stack: event.error instanceof Error ? event.error.stack : undefined,
      details: serializeValue({
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error
      })
    });
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    const { url, path, title } = currentLocation();
    const reason = event.reason;
    send({
      source: 'window.unhandledrejection',
      message: `Unhandled promise rejection: ${summarizeValue(reason)}`,
      url,
      path,
      title,
      timestamp: new Date().toISOString(),
      stack: reason instanceof Error ? reason.stack : undefined,
      details: serializeValue(reason)
    });
  };

  const patchedConsoleError: typeof console.error = (...args) => {
    originalConsoleError(...args);

    const primaryError = args.find((arg) => arg instanceof Error);
    const { url, path, title } = currentLocation();
    send({
      source: 'console.error',
      message: buildMessage(args),
      url,
      path,
      title,
      timestamp: new Date().toISOString(),
      stack: primaryError instanceof Error ? primaryError.stack : undefined,
      details: serializeValue(args)
    });
  };

  console.error = patchedConsoleError;
  window.addEventListener('error', handleWindowError);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);

  const stop = () => {
    window.removeEventListener('error', handleWindowError);
    window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    if (console.error === patchedConsoleError) {
      console.error = originalConsoleError;
    }
    delete globalScope[REPORTER_KEY];
  };

  globalScope[REPORTER_KEY] = { stop };
  return stop;
}

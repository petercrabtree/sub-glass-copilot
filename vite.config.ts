import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

type DevErrorReport = {
  source: 'console.error' | 'window.error' | 'window.unhandledrejection';
  message: string;
  url: string;
  path: string;
  title: string;
  timestamp: string;
  stack?: string;
  details?: unknown;
};

type StreamingRequest = {
  method?: string;
  setEncoding?(encoding: string): void;
  on?(event: 'data', listener: (chunk: string) => void): void;
  on?(event: 'end', listener: () => void): void;
  on?(event: 'error', listener: (error: Error) => void): void;
};

type StreamingResponse = {
  statusCode: number;
  end(body?: string): void;
  writableEnded?: boolean;
};

type NextFunction = (err?: unknown) => void;

function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function formatDetails(details: unknown): string {
  if (typeof details === 'string') return details;

  try {
    return JSON.stringify(details, null, 2) ?? String(details);
  } catch {
    return String(details);
  }
}

function formatDevErrorReport(report: DevErrorReport): string {
  const lines = [
    '[subglass-dev] Browser reported an error',
    `source: ${report.source}`,
    `message: ${report.message}`,
    `time: ${report.timestamp}`,
    `path: ${report.path}`,
    `url: ${report.url}`
  ];

  if (report.title) lines.push(`title: ${report.title}`);
  if (report.stack) {
    lines.push('stack:');
    lines.push(indent(report.stack));
  }
  if (typeof report.details !== 'undefined') {
    lines.push('details:');
    lines.push(indent(formatDetails(report.details)));
  }

  return `\n${lines.join('\n')}\n`;
}

function createBrowserErrorBridgeMiddleware() {
  return (req: StreamingRequest, res: StreamingResponse, next: NextFunction) => {
    if (req.method !== 'POST') {
      next();
      return;
    }

    if (!req.setEncoding || !req.on) {
      next();
      return;
    }

    let body = '';
    req.setEncoding('utf8');

    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      try {
        const report = JSON.parse(body) as DevErrorReport;
        console.error(formatDevErrorReport(report));
        res.statusCode = 204;
        res.end();
      } catch (error) {
        console.error('[subglass-dev] Failed to parse browser error report', error);
        res.statusCode = 400;
        res.end('bad request');
      }
    });

    req.on('error', (error) => {
      console.error('[subglass-dev] Failed while reading browser error report', error);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end('internal error');
      }
    });
  };
}

function browserErrorBridgePlugin(): Plugin {
  const middleware = createBrowserErrorBridgeMiddleware();

  return {
    name: 'subglass-browser-error-bridge',
    apply: 'serve',
    configureServer(server) {
      server.config.logger.info(
        '[subglass-dev] Mirroring browser errors to the dev server terminal via /__dev/client-errors'
      );
      server.middlewares.use('/__dev/client-errors', middleware as never);
    }
  };
}

export default defineConfig({
  plugins: [browserErrorBridgePlugin(), sveltekit()]
});

import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { mockRedditFixtures } from './dev/mock-reddit-fixtures';

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
  setHeader?(name: string, value: string): void;
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

function mockRedditProxyPlugin(): Plugin {
  return {
    name: 'subglass-mock-reddit-proxy',
    apply: 'serve',
    configureServer(server) {
      server.config.logger.info(
        '[subglass-dev] Serving local mock Reddit fixtures via /__mock/reddit'
      );

      server.middlewares.use('/__mock/reddit', ((req: StreamingRequest & { url?: string }, res: StreamingResponse, next: NextFunction) => {
        const requestUrl = req.url ? new URL(req.url, 'http://localhost') : null;
        const pathname = requestUrl?.pathname || '/';
        const fixture = mockRedditFixtures[pathname];

        if (!fixture) {
          next();
          return;
        }

        res.statusCode = 200;
        res.setHeader?.('content-type', 'application/json; charset=utf-8');
        res.setHeader?.('cache-control', 'no-store');
        res.setHeader?.('access-control-allow-origin', '*');
        res.end(JSON.stringify(fixture, null, 2));
      }) as never);
    }
  };
}

export default defineConfig({
  plugins: [mockRedditProxyPlugin(), browserErrorBridgePlugin(), sveltekit()]
});

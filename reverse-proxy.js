const fs = require('fs');
const http = require('http');
const path = require('path');

const DEFAULT_SERVER_NAMES = 'longxiaui.xyz,www.longxiaui.xyz';
const CLEANUP_STATE = Symbol.for('codex-webui.reverse-proxy.cleanup-state');

function parsePort(portValue, fallbackValue, name) {
  const resolved = portValue ?? fallbackValue;
  const port = Number.parseInt(String(resolved), 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid ${name}: ${resolved}`);
  }

  return port;
}

function normalizeServerNames(serverNames) {
  return String(serverNames ?? DEFAULT_SERVER_NAMES)
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function getRequestHost(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader.trim()) {
    return '';
  }

  const normalized = hostHeader.trim().toLowerCase();
  if (normalized.startsWith('[')) {
    const closingIndex = normalized.indexOf(']');
    return closingIndex === -1 ? normalized : normalized.slice(1, closingIndex);
  }

  return normalized.replace(/:\d+$/, '');
}

function isAllowedHost(serverNames, hostHeader) {
  if (serverNames.length === 0) {
    return true;
  }
  return serverNames.includes(getRequestHost(hostHeader));
}

function createForwardedHeaders(req) {
  const remoteAddress = req.socket.remoteAddress || '';
  const existingForwardedFor = req.headers['x-forwarded-for'];
  const forwardedFor = existingForwardedFor
    ? `${existingForwardedFor}, ${remoteAddress}`
    : remoteAddress;

  return {
    ...req.headers,
    'x-forwarded-for': forwardedFor,
    'x-forwarded-host': req.headers.host || '',
    'x-forwarded-proto': 'http',
    'x-real-ip': remoteAddress,
    connection: req.headers.connection || 'keep-alive',
  };
}

function cleanupPidFile(pidFile, logger) {
  try {
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  } catch (error) {
    logger.error('[reverse-proxy] failed to clean pid file:', error.message);
  }
}

function registerCleanup(pidFile, logger) {
  if (!pidFile) {
    return;
  }

  if (!process[CLEANUP_STATE]) {
    process[CLEANUP_STATE] = { pidFiles: new Set() };

    process.on('SIGINT', () => {
      for (const activePidFile of process[CLEANUP_STATE].pidFiles) {
        cleanupPidFile(activePidFile, logger);
      }
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      for (const activePidFile of process[CLEANUP_STATE].pidFiles) {
        cleanupPidFile(activePidFile, logger);
      }
      process.exit(0);
    });

    process.on('exit', () => {
      for (const activePidFile of process[CLEANUP_STATE].pidFiles) {
        cleanupPidFile(activePidFile, logger);
      }
    });
  }

  process[CLEANUP_STATE].pidFiles.add(pidFile);
}

function startReverseProxy(options = {}) {
  const listenHost = options.listenHost || process.env.PROXY_HOST || '0.0.0.0';
  const listenPort = parsePort(options.listenPort, process.env.PROXY_PORT || '80', 'PROXY_PORT');
  const targetHost = options.targetHost || process.env.TARGET_HOST || '127.0.0.1';
  const targetPortValue = options.targetPort ?? process.env.TARGET_PORT;

  if (targetPortValue == null || String(targetPortValue).trim() === '') {
    throw new Error('TARGET_PORT is required');
  }

  const targetPort = parsePort(targetPortValue, targetPortValue, 'TARGET_PORT');
  const serverNames = normalizeServerNames(options.serverNames || process.env.PROXY_SERVER_NAMES);
  const dataDir = options.dataDir || path.join(__dirname, 'data');
  const pidFile = options.writePidFile === false
    ? null
    : options.pidFile || path.join(dataDir, 'reverse-proxy.pid');
  const logger = options.logger || console;
  const exitOnError = options.exitOnError !== false;

  fs.mkdirSync(dataDir, { recursive: true });
  registerCleanup(pidFile, logger);

  const server = http.createServer((req, res) => {
    if (!isAllowedHost(serverNames, req.headers.host)) {
      res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('421 Misdirected Request\n');
      return;
    }

    const proxyReq = http.request(
      {
        hostname: targetHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: createForwardedHeaders(req),
      },
      proxyRes => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', error => {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`502 Bad Gateway\n\n${error.message}\n`);
    });

    req.on('aborted', () => proxyReq.destroy());
    req.pipe(proxyReq);
  });

  server.on('clientError', (error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    logger.error('[reverse-proxy] client error:', error.message);
  });

  server.on('error', error => {
    logger.error('[reverse-proxy] failed to start:', error.message);
    if (exitOnError) {
      process.exitCode = 1;
    }
  });

  server.on('close', () => {
    cleanupPidFile(pidFile, logger);
  });

  server.listen(listenPort, listenHost, () => {
    if (pidFile) {
      fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
    }

    logger.log('[reverse-proxy] started');
    logger.log(`  listen: http://${listenHost}:${listenPort}`);
    logger.log(`  server: ${serverNames.length ? serverNames.join(', ') : '*'}`);
    logger.log(`  target: http://${targetHost}:${targetPort}`);
  });

  return server;
}

module.exports = {
  startReverseProxy,
};

if (require.main === module) {
  startReverseProxy();
}

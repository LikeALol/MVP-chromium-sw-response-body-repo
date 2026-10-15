import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const iterations = Number(process.env.ITERATIONS ?? 10);
let endpointHits = 0;

class CdpConnection {
  constructor(url) {
    this.nextId = 0;
    this.callbacks = new Map();
    this.listeners = new Set();
    this.socket = new WebSocket(url);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const callback = this.callbacks.get(message.id);
        this.callbacks.delete(message.id);
        if (message.error) callback.reject(new Error(message.error.message));
        else callback.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.callbacks.set(id, { resolve, reject }));
  }

  onMessage(listener) {
    this.listeners.add(listener);
  }

  close() {
    this.socket.close();
  }
}

async function unusedPort() {
  const temporaryServer = createTcpServer();
  temporaryServer.listen(0, '127.0.0.1');
  await once(temporaryServer, 'listening');
  const port = temporaryServer.address().port;
  temporaryServer.close();
  await once(temporaryServer, 'close');
  return port;
}

async function browserWebSocketUrl(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Chromium remote-debugging endpoint did not become available');
}

const certificateDirectory = mkdtempSync(join(tmpdir(), 'chromium-sw-body-repro-'));
const certificatePath = join(certificateDirectory, 'certificate.pem');
const keyPath = join(certificateDirectory, 'key.pem');
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-days',
    '1',
    '-keyout',
    keyPath,
    '-out',
    certificatePath,
  ],
  { stdio: 'ignore' },
);

const pageHtml = String.raw`<!doctype html>
<meta charset="utf-8">
<title>Service worker response-body CDP reproduction</title>
<script>
  window.run = async count => {
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }

    const lengths = [];
    for (let index = 0; index < count; index++) {
      const response = await fetch('/data?index=' + index);
      lengths.push((await response.text()).length);
    }
    return lengths;
  };
</script>`;

const workerScript = String.raw`self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (new URL(event.request.url).pathname === '/data')
    event.respondWith(fetch(event.request, { credentials: 'same-origin' }));
});`;

const server = createServer(
  { cert: readFileSync(certificatePath), key: readFileSync(keyPath) },
  (request, response) => {
    const url = new URL(request.url, 'https://localhost');
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(pageHtml) });
      response.end(pageHtml);
      return;
    }
    if (url.pathname === '/sw.js') {
      response.writeHead(200, {
        'content-type': 'text/javascript',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(workerScript),
      });
      response.end(workerScript);
      return;
    }
    if (url.pathname === '/data') {
      endpointHits++;
      const body = JSON.stringify({ index: url.searchParams.get('index'), padding: 'x'.repeat(1_300) });
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    response.writeHead(404).end();
  },
);

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
const origin = `https://localhost:${address.port}`;

const debugPort = await unusedPort();
const browser = await chromium.launch({
  channel: process.env.CHANNEL || 'chromium',
  headless: true,
  args: ['--ignore-certificate-errors', `--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*'],
});
const cdp = new CdpConnection(await browserWebSocketUrl(debugPort));
await cdp.open();
await cdp.send('Target.setAutoAttach', {
  autoAttach: true,
  flatten: true,
  waitForDebuggerOnStart: false,
});

const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();

const responses = new Map();
const bodyResults = [];
const pendingBodyReads = new Set();
const serviceWorkerSessions = new Set();

cdp.onMessage((message) => {
  if (message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'service_worker') {
    serviceWorkerSessions.add(message.params.sessionId);
    void cdp.send('Network.enable', {}, message.params.sessionId);
    return;
  }

  if (!serviceWorkerSessions.has(message.sessionId)) return;

  if (message.method === 'Network.responseReceived') {
    if (new URL(message.params.response.url).pathname === '/data') {
      responses.set(`${message.sessionId}:${message.params.requestId}`, message.params);
    }
    return;
  }

  if (message.method !== 'Network.loadingFinished') return;

  const key = `${message.sessionId}:${message.params.requestId}`;
  const responseEvent = responses.get(key);
  if (!responseEvent) return;

  const bodyRead = cdp
    .send('Network.getResponseBody', { requestId: message.params.requestId }, message.sessionId)
    .then((body) => {
      bodyResults.push({
        requestId: message.params.requestId,
        encodedDataLength: message.params.encodedDataLength,
        contentLength: responseEvent.response.headers['Content-Length'],
        cdpBodyLength: Buffer.byteLength(body.body, body.base64Encoded ? 'base64' : 'utf8'),
      });
    })
    .catch((error) => {
      bodyResults.push({ requestId: message.params.requestId, error: String(error) });
    })
    .finally(() => pendingBodyReads.delete(bodyRead));
  pendingBodyReads.add(bodyRead);
});

try {
  await page.goto(origin);
  const applicationBodyLengths = await page.evaluate((count) => window.run(count), iterations);
  await page.waitForTimeout(1_000);
  await Promise.all(pendingBodyReads);

  const result = {
    bugReproduced:
      endpointHits === iterations &&
      applicationBodyLengths.every((length) => length > 0) &&
      bodyResults.length === iterations &&
      bodyResults.every((result) => result.encodedDataLength > 0 && result.cdpBodyLength === 0),
    chromiumVersion: browser.version(),
    origin,
    iterations,
    endpointHits,
    applicationResponses: applicationBodyLengths.length,
    applicationEmptyBodies: applicationBodyLengths.filter((length) => length === 0).length,
    serviceWorkerSessions: serviceWorkerSessions.size,
    cdpResponses: bodyResults.length,
    cdpEmptyBodies: bodyResults.filter((result) => result.cdpBodyLength === 0).length,
    cdpErrors: bodyResults.filter((result) => result.error).length,
    sampleCdpResults: bodyResults.slice(0, 3),
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  cdp.close();
  await browser.close();
  server.close();
  rmSync(certificateDirectory, { recursive: true, force: true });
}

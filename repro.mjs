import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const iterations = Number(process.env.ITERATIONS ?? 10);
let endpointHits = 0;

function dataBody(index) {
  return JSON.stringify({ index: String(index), padding: 'x'.repeat(1_300) });
}

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
    return () => this.listeners.delete(listener);
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
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Chromium remote-debugging endpoint did not become available');
}

function chromeExecutable() {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH))
      throw new Error(`CHROME_PATH does not exist: ${process.env.CHROME_PATH}`);
    return process.env.CHROME_PATH;
  }
  for (const command of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    try {
      return execFileSync('which', [command], { encoding: 'utf8' }).trim();
    } catch {}
  }
  throw new Error('Chrome/Chromium was not found; set CHROME_PATH to its executable');
}

function waitForCdpEvent(cdp, method, sessionId, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeout);
    const unsubscribe = cdp.onMessage((message) => {
      if (message.method !== method || (sessionId && message.sessionId !== sessionId)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(message.params);
    });
  });
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
  window.prepare = async () => {
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  };

  window.run = async count => {
    const bodies = [];
    for (let index = 0; index < count; index++) {
      const response = await fetch('/data?index=' + index);
      bodies.push(await response.text());
    }
    return bodies;
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
      const body = dataBody(url.searchParams.get('index'));
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
const profilePath = join(certificateDirectory, 'chrome-profile');
const browserProcess = spawn(chromeExecutable(), [
  '--headless=new',
  '--ignore-certificate-errors',
  '--no-default-browser-check',
  '--no-first-run',
  `--remote-debugging-port=${debugPort}`,
  '--remote-debugging-address=127.0.0.1',
  '--remote-allow-origins=*',
  `--user-data-dir=${profilePath}`,
  'about:blank',
], { stdio: 'ignore' });
const cdp = new CdpConnection(await browserWebSocketUrl(debugPort));
await cdp.open();
const browserVersion = await cdp.send('Browser.getVersion');
await cdp.send('Target.setAutoAttach', {
  autoAttach: true,
  flatten: true,
  waitForDebuggerOnStart: false,
});

const responses = new Map();
const bodyResults = [];
const pendingBodyReads = new Set();
const serviceWorkerSessions = new Set();
let resolveServiceWorkerNetworkReady;
const serviceWorkerNetworkReady = new Promise((resolve) => {
  resolveServiceWorkerNetworkReady = resolve;
});

cdp.onMessage((message) => {
  if (message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'service_worker') {
    serviceWorkerSessions.add(message.params.sessionId);
    void cdp.send('Network.enable', {}, message.params.sessionId).then(resolveServiceWorkerNetworkReady);
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
      const contentLength = Object.entries(responseEvent.response.headers)
        .find(([name]) => name.toLowerCase() === 'content-length')?.[1];
      const requestIndex = new URL(responseEvent.response.url).searchParams.get('index');
      bodyResults.push({
        requestId: message.params.requestId,
        encodedDataLength: message.params.encodedDataLength,
        contentLength: Number(contentLength),
        expectedBodyLength: Buffer.byteLength(dataBody(requestIndex)),
        cdpBodyLength: Buffer.byteLength(body.body, body.base64Encoded ? 'base64' : 'utf8'),
      });
    })
    .catch((error) => {
      bodyResults.push({ requestId: message.params.requestId, error: String(error) });
    })
    .finally(() => pendingBodyReads.delete(bodyRead));
  pendingBodyReads.add(bodyRead);
});

const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
const { sessionId: pageSessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await Promise.all([
  cdp.send('Page.enable', {}, pageSessionId),
  cdp.send('Runtime.enable', {}, pageSessionId),
]);

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, pageSessionId);
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

try {
  const pageLoaded = waitForCdpEvent(cdp, 'Page.loadEventFired', pageSessionId);
  await cdp.send('Page.navigate', { url: origin }, pageSessionId);
  await pageLoaded;
  await evaluate('window.prepare()');
  await Promise.race([
    serviceWorkerNetworkReady,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Service-worker CDP Network domain was not enabled')), 5_000)),
  ]);
  const applicationBodies = await evaluate(`window.run(${JSON.stringify(iterations)})`);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await Promise.all(pendingBodyReads);

  const expectedBodies = Array.from({ length: iterations }, (_, index) => dataBody(index));
  const applicationBodiesMatch = applicationBodies.every((body, index) => body === expectedBodies[index]);

  const result = {
    bugReproduced:
      endpointHits === iterations &&
      applicationBodies.length === iterations &&
      applicationBodiesMatch &&
      bodyResults.length === iterations &&
      bodyResults.every((result) =>
        result.contentLength === result.expectedBodyLength &&
        result.encodedDataLength > 0 &&
        result.cdpBodyLength === 0),
    chromiumVersion: browserVersion.product,
    origin,
    iterations,
    endpointHits,
    endpointHitsMatchApplicationRequests: endpointHits === iterations,
    applicationResponses: applicationBodies.length,
    applicationBodiesMatchServerBodies: applicationBodiesMatch,
    applicationEmptyBodies: applicationBodies.filter((body) => body.length === 0).length,
    serviceWorkerSessions: serviceWorkerSessions.size,
    cdpResponses: bodyResults.length,
    cdpEmptyBodies: bodyResults.filter((result) => result.cdpBodyLength === 0).length,
    cdpErrors: bodyResults.filter((result) => result.error).length,
    sampleCdpResults: bodyResults.slice(0, 3),
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  cdp.close();
  if (browserProcess.exitCode === null) {
    const browserExited = once(browserProcess, 'exit');
    browserProcess.kill('SIGTERM');
    await Promise.race([browserExited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
  if (browserProcess.exitCode === null) {
    const browserExited = once(browserProcess, 'exit');
    browserProcess.kill('SIGKILL');
    await browserExited;
  }
  server.close();
  rmSync(certificateDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * End-to-end integration tests for Synthetic Solutions Inventory API
 * Tests every critical flow: auth, dashboard, inventory count, delivery, AI chat, admin
 * Run: node scripts/e2e-test.mjs
 */

const BASE = 'http://localhost:9000/api';
const RESULTS = [];
let adminToken = '';
let storeUserToken = '';
let testStoreId = null;
let testStoreUserId = null;
let testSessionId = null;
let testReceivingId = null;
let testProductId = null;
let testWarehouseId = null;
let testAdminDeviceId = null;
let testStoreDeviceId = null;

// ─── Mock AI stream server ────────────────────────────────────────────────────
// Used by the streaming-disconnect test (7e) to verify that the server-side
// AbortController actually cancels the upstream fetch when the client drops.
// The mock delays 10 s before sending any SSE data so the test abort fires first,
// and records each connection that the server closed before data was sent.

const MOCK_AI_PORT = 19998; // chosen to avoid conflict with the API server (9000)
let _mockServer = null;
let _mockAborts = 0;  // connections closed before data was sent
let _mockTotal = 0;   // total connections received
let _mockObserved = 0; // streaming requests accepted by the API route
let _streamObservedSystemPrompt = '';
let _scopedObservedContext = '';
let _unscopedObservedContext = '';
let _scopedTargetProductName = '';
let _scopedOtherProductName = '';
let _scopedTargetStock = '';
let _scopedOtherStock = '';

async function startMockAiServer() {
  if (_mockServer) return;
  const { createServer } = await import('node:http');
  const isSafeUnavailableContext = (systemContent) => {
    const hasNoRecentSessions = systemContent.includes(
      'RECENT SESSIONS: None found in the last 14 days.',
    );
    const hasUnavailableStockAlerts = systemContent.includes(
      'STOCK ALERTS: Unavailable — no current stock snapshot exists',
    );
    const exposesHistoricalStock = /CURRENT STOCK LEVELS:[\s\S]*42\.0/.test(systemContent);
    const claimsAllItemsAreHealthy = systemContent.includes('all items above minimum levels');
    return hasNoRecentSessions &&
      hasUnavailableStockAlerts &&
      !exposesHistoricalStock &&
      !claimsAllItemsAreHealthy;
  };
  await new Promise((resolve, reject) => {
    _mockServer = createServer((req, res) => {
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      if (req.url === '/observe') {
        _mockObserved++;
        // Hold the API route at its test synchronization point long enough for
        // the e2e client to abort and for Node to emit the request "aborted"
        // event before route setup continues.
        setTimeout(() => {
          if (!res.destroyed) {
            res.writeHead(204);
            res.end();
          }
        }, 100);
        return;
      }
      if (req.url === '/chat') {
        let requestBody = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { requestBody += chunk; });
        req.on('end', () => {
          let systemContent = '';
          try {
            const parsed = JSON.parse(requestBody);
            systemContent = parsed.messages?.find((message) => message.role === 'system')?.content ?? '';
          } catch {
            // Return an invalid-context response below; the test will fail clearly.
          }

          const contextIsSafe = isSafeUnavailableContext(systemContent);
          res.writeHead(contextIsSafe ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              message: {
                content: contextIsSafe
                  ? 'No finalized sessions were found in the last 14 days, so current stock is unavailable. Complete a new count before making a current-stock decision.'
                  : 'Current stock data is available.',
              },
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
        });
        return;
      }
      if (req.url === '/chat-unscoped') {
        let requestBody = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { requestBody += chunk; });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(requestBody);
            _unscopedObservedContext =
              parsed.messages?.find((message) => message.role === 'system')?.content ?? '';
          } catch {
            // The assertion below reports an empty context if the request is invalid.
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              message: { content: 'Deterministic unscoped inventory context received.' },
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
        });
        return;
      }
      if (req.url === '/stream-stale-chat') {
        let requestBody = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { requestBody += chunk; });
        req.on('end', () => {
          let systemContent = '';
          try {
            const parsed = JSON.parse(requestBody);
            systemContent = parsed.messages?.find((message) => message.role === 'system')?.content ?? '';
          } catch {
            // Return an unsafe response below; the test will fail clearly.
          }

          const contextIsSafe = isSafeUnavailableContext(systemContent);
          const content = contextIsSafe
            ? 'No finalized sessions were found in the last 14 days, so current stock is unavailable.'
            : 'Current stock data is available.';

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          res.end(
            `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n` +
            'data: [DONE]\n\n',
          );
        });
        return;
      }
      if (req.url === '/stream-scoped-chat') {
        let requestBody = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { requestBody += chunk; });
        req.on('end', () => {
          let systemContent = '';
          try {
            const parsed = JSON.parse(requestBody);
            systemContent = parsed.messages?.find((message) => message.role === 'system')?.content ?? '';
          } catch {
            // Return an unsafe response below; the test will fail clearly.
          }
          _scopedObservedContext = systemContent;

          const contextIsScoped =
            systemContent.includes(_scopedTargetProductName) &&
            systemContent.includes(_scopedTargetStock) &&
            !systemContent.includes(_scopedOtherProductName) &&
            !systemContent.includes(_scopedOtherStock);
          const content = contextIsScoped
            ? 'The requested store has 17.250 gallons in its target chemical.'
            : `Leaked context: ${_scopedOtherProductName} has ${_scopedOtherStock} gallons.`;

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          res.end(
            `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n` +
            'data: [DONE]\n\n',
          );
        });
        return;
      }
      if (req.url === '/stream-empty-scoped-chat') {
        let requestBody = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { requestBody += chunk; });
        req.on('end', () => {
          let systemContent = '';
          try {
            const parsed = JSON.parse(requestBody);
            systemContent = parsed.messages?.find((message) => message.role === 'system')?.content ?? '';
          } catch {
            // Return a failure response below; the test will report the missing context.
          }
          _scopedObservedContext = systemContent;

          const leakedValue = [
            _scopedTargetProductName,
            _scopedTargetStock,
            _scopedOtherProductName,
            _scopedOtherStock,
          ].find((value) => value && systemContent.includes(value));
          const contextIsUnavailableAndIsolated =
            systemContent.includes('STOCK ALERTS: Unavailable — no current stock snapshot exists') &&
            systemContent.includes('RECENT SESSIONS: None found in the last 14 days.') &&
            !leakedValue;
          const content = contextIsUnavailableAndIsolated
            ? 'No recent finalized sessions were found, so current stock is unavailable. Complete a new count before making a stock decision.'
            : `Leaked context: ${leakedValue ?? 'recent stock data was presented as available'}.`;

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          res.end(
            `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n` +
            'data: [DONE]\n\n',
          );
        });
        return;
      }
      if (req.url === '/stream-complete') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        // Send the content and terminal event separately so the test exercises
        // both chunk forwarding and normal upstream stream completion.
        res.write('data: {"choices":[{"delta":{"content":"deterministic stream chunk"},"finish_reason":null}]}\n\n');
        setTimeout(() => {
          if (!res.destroyed) {
            res.end('data: [DONE]\n\n');
          }
        }, 25);
        return;
      }
      if (req.url === '/report' || req.url === '/report-error') {
        let requestBody = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { requestBody += chunk; });
        req.on('end', () => {
          if (req.url === '/report-error') {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: { message: 'insufficient_quota: test provider credits exhausted' },
            }));
            return;
          }

          // Deterministic structured output for report response-shape checks.
          // The request body is also inspected to ensure the server sends the
          // provider measured usage, not a misleading sum of stock snapshots.
          let parsedRequest;
          try {
            parsedRequest = JSON.parse(requestBody);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'invalid test request' } }));
            return;
          }
          const reportUserMessage = parsedRequest.messages?.find((message) => message.role === 'user')?.content ?? '';
          const reportMathContract =
            reportUserMessage.includes('TOP 10 CONSUMERS BY MEASURED USAGE:') &&
            reportUserMessage.includes('USAGE MATH:') &&
            !reportUserMessage.includes('TOP 10 CONSUMERS BY VOLUME:');
          const reportForecastContract =
            reportUserMessage.includes('REORDER FORECASTS (calculated from verified finalized usage snapshots') &&
            reportUserMessage.includes('status=') &&
            reportUserMessage.includes('"verifiedSnapshotCount"') &&
            reportUserMessage.includes('"basisDays"') &&
            reportUserMessage.includes('"receivedDuringBasis"');
          if (!reportMathContract || !reportForecastContract) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: { message: 'report context omitted measured-usage or reorder-forecast evidence contract' },
            }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  title: 'Deterministic inventory summary',
                  overview: 'The test provider returned a stable report response.',
                  keyFindings: ['The test dataset contains 1 report finding.'],
                  anomalies: [],
                  recommendations: ['Review the 1 reported finding.'],
                  risks: [],
                  confidence: 0.75,
                  dataQuality: 'partial',
                  dataQualityNote: 'This response is supplied by the E2E test provider.',
                }),
              },
            }],
          }));
        });
        return;
      }
      _mockTotal++;
      let requestBody = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { requestBody += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(requestBody);
          _streamObservedSystemPrompt =
            parsed.messages?.find((message) => message.role === 'system')?.content ?? '';
        } catch {
          _streamObservedSystemPrompt = '';
        }
      });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      // SSE requires flushing initial bytes so undici's reader.read() blocks
      // rather than resolving immediately with an empty/done stream.
      // An SSE comment is a valid no-op that keeps the connection alive.
      res.write(': mock-heartbeat\n\n');
      // Track whether WE sent actual data normally (timer fired) vs. the socket
      // was closed by the API server's abort before payload was sent.
      let dataSentByServer = false;
      // Delay 10 s before sending real SSE data — test abort fires at ~500 ms.
      const t = setTimeout(() => {
        if (!res.destroyed) {
          dataSentByServer = true;
          res.write('data: {"choices":[{"delta":{"content":"mock"},"finish_reason":null}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 10_000);
      // req.socket 'close' fires reliably when the underlying TCP connection is
      // destroyed (res.on('close') fires with writableEnded=true in Node.js when
      // the socket is destroyed, making it unreliable for our check).
      req.socket.on('close', () => {
        clearTimeout(t);
        if (!dataSentByServer) { _mockAborts++; }
      });
    });
    _mockServer.once('error', reject);
    _mockServer.listen(MOCK_AI_PORT, resolve);
  });
}

function stopMockAiServer() {
  if (_mockServer) { _mockServer.close(); _mockServer = null; }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function req(method, path, body, token, timeoutMs = 10_000, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let data;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${method} ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function runPsqlScript(sql) {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);
  await execAsync(`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'E2E_SQL'\n${sql}\nE2E_SQL`);
}

async function runPsqlScalar(sql) {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);
  const escaped = sql.replace(/"/g, '\\"');
  const { stdout } = await execAsync(
    `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -t -A -c "${escaped}"`,
  );
  return stdout.trim();
}

function pass(label, detail = '') {
  RESULTS.push({ ok: true, label, detail });
  console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`);
}

function fail(label, detail = '') {
  RESULTS.push({ ok: false, label, detail });
  console.error(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
}

function check(label, condition, detail = '') {
  if (condition) pass(label, detail);
  else fail(label, detail);
}

function section(name) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${name}`);
  console.log('─'.repeat(60));
}

// ─── SEED: insert admin user directly via DB connection ──────────────────────

async function seedAdmin() {
  section('SEED — Bootstrap test data (admin, store_user, product)');
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  try {
    const { stdout } = await execAsync(
      '/home/runner/workspace/scripts/node_modules/.bin/tsx /home/runner/workspace/scripts/seed-test-user.ts',
    );
    console.log(stdout.split('\n').map(l => '  ' + l).join('\n'));
    pass('Test data seeded (admin, product, category)');
  } catch (e) {
    fail('Seed failed', e.message);
  }
}

// ─── FLOW 1: Auth ─────────────────────────────────────────────────────────────

async function testAuth() {
  section('FLOW 1 — Authentication');

  // 1a: login with wrong PIN
  let r = await req('POST', '/auth/login', { name: 'TestAdmin', pin: '9999' });
  check('Reject wrong PIN', r.status === 401, `status=${r.status}`);

  // 1b: login with wrong name
  r = await req('POST', '/auth/login', { name: 'Nobody', pin: '1234' });
  check('Reject unknown user', r.status === 401, `status=${r.status}`);

  // 1c: login missing PIN
  r = await req('POST', '/auth/login', { name: 'TestAdmin' });
  check('Reject missing PIN', r.status === 400, `status=${r.status}`);

  // 1d: successful admin login
  r = await req('POST', '/auth/login', { name: 'TestAdmin', pin: '1234' });
  check('Admin login succeeds', r.status === 200, `status=${r.status}`);
  check('Returns token', typeof r.data?.token === 'string', `token=${r.data?.token?.slice(0, 20)}…`);
  check('Returns user object', r.data?.user?.role === 'admin', `role=${r.data?.user?.role}`);
  adminToken = r.data?.token ?? '';

  // 1e: /auth/me with valid token
  r = await req('GET', '/auth/me', null, adminToken);
  check('/auth/me returns user', r.status === 200 && r.data?.name === 'TestAdmin', `name=${r.data?.name}`);

  // 1f: /auth/me with no token
  r = await req('GET', '/auth/me', null, null);
  check('/auth/me rejects unauthenticated', r.status === 401, `status=${r.status}`);

  // 1g: logout
  r = await req('POST', '/auth/logout', null, adminToken);
  check('Logout returns 200', r.status === 200, `status=${r.status}`);
}

// ─── FLOW 2: Admin — create store, create user, reset PIN, scoped login ───────

async function testAdmin() {
  section('FLOW 2 — Admin: store + user management');

  // 2a: create a store
  let r = await req('POST', '/stores', { name: 'Test Store Alpha', storeNumber: 'TST-E2E', city: 'Portland', state: 'OR' }, adminToken);
  check('Create store', r.status === 201, `status=${r.status} id=${r.data?.id}`);
  testStoreId = r.data?.id;

  // 2b: list stores
  r = await req('GET', '/stores', null, adminToken);
  check('List stores includes new store', r.status === 200 && r.data?.some(s => s.id === testStoreId), `count=${r.data?.length}`);

  // 2c: get store by id
  r = await req('GET', `/stores/${testStoreId}`, null, adminToken);
  check('Get store by id', r.status === 200 && r.data?.storeNumber === 'TST-E2E', `name=${r.data?.name}`);

  // 2d: create a store_user assigned to that store
  r = await req('POST', '/users', { name: 'StoreUser1', pin: '5678', role: 'store_user', storeId: testStoreId }, adminToken);
  check('Create store_user', r.status === 201, `status=${r.status} id=${r.data?.id}`);
  testStoreUserId = r.data?.id;

  // 2e: list users
  r = await req('GET', '/users', null, adminToken);
  check('List users (admin)', r.status === 200 && r.data?.some(u => u.id === testStoreUserId), `count=${r.data?.length}`);

  // 2f: store_user can't list users
  r = await req('GET', '/users', null, storeUserToken || 'bad-token');
  check('Non-admin blocked from /users', r.status === 401 || r.status === 403, `status=${r.status}`);

  // 2g: reset PIN for the store_user
  r = await req('POST', `/users/${testStoreUserId}/reset-pin`, { newPin: '4321' }, adminToken);
  check('Reset PIN succeeds', r.status === 200, `status=${r.status}`);

  // 2h: login as store_user with new PIN
  r = await req('POST', '/auth/login', { name: 'StoreUser1', pin: '4321' });
  check('Store user logs in with reset PIN', r.status === 200, `status=${r.status}`);
  check('Store user role is store_user', r.data?.user?.role === 'store_user', `role=${r.data?.user?.role}`);
  check('Store user scoped to correct store', r.data?.user?.storeId === testStoreId, `storeId=${r.data?.user?.storeId}`);
  storeUserToken = r.data?.token ?? '';

  // 2i: old PIN rejected
  r = await req('POST', '/auth/login', { name: 'StoreUser1', pin: '5678' });
  check('Old PIN rejected after reset', r.status === 401, `status=${r.status}`);
}

async function testNotificationDevices() {
  section('FLOW 3 — Push device registration and secure backup events');

  let r = await req('GET', '/notifications/devices', null);
  check('Push registrations require authentication', r.status === 401, `status=${r.status}`);

  r = await req('GET', '/notifications/devices', null, adminToken);
  check(
    'Admin can read device list and browser capability',
    r.status === 200 &&
      Array.isArray(r.data?.devices) &&
      typeof r.data?.capabilities?.webPushConfigured === 'boolean',
    `status=${r.status}`,
  );

  const validRegistration = (endpoint) => ({
    platform: 'web',
    subscription: {
      endpoint,
      keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
    },
    preferences: { backupEnabled: true, inventoryEnabled: true },
  });

  r = await req(
    'POST',
    '/notifications/devices',
    validRegistration('https://127.0.0.1/push/ssrf'),
    adminToken,
  );
  check('Reject untrusted browser push endpoints', r.status === 400, `status=${r.status}`);

  r = await req(
    'POST',
    '/notifications/devices',
    validRegistration('https://fcm.googleapis.com/fcm/send/e2e-admin-registration'),
    adminToken,
  );
  testAdminDeviceId = r.data?.device?.id ?? null;
  check('Register admin browser push device', r.status === 201 && testAdminDeviceId, `status=${r.status}`);
  check(
    'Admin device can opt into backup alerts',
    r.status === 201 && r.data?.device?.backupEnabled === true,
  );
  check(
    'Registration response excludes endpoint and encryption keys',
    !JSON.stringify(r.data).includes('fcm.googleapis.com') &&
      !JSON.stringify(r.data).includes('p256dh') &&
      !JSON.stringify(r.data).includes('expoPushToken'),
  );

  r = await req(
    'POST',
    '/notifications/devices',
    validRegistration('https://fcm.googleapis.com/fcm/send/e2e-store-registration'),
    storeUserToken,
  );
  testStoreDeviceId = r.data?.device?.id ?? null;
  check('Register store-user browser push device', r.status === 201 && testStoreDeviceId, `status=${r.status}`);
  check(
    'Store-user backup preference is forced off',
    r.status === 201 && r.data?.device?.backupEnabled === false,
  );

  r = await req(
    'PATCH',
    `/notifications/devices/${testStoreDeviceId}`,
    { preferences: { backupEnabled: true, inventoryEnabled: true } },
    storeUserToken,
  );
  check(
    'Store users cannot enable admin-only backup alerts',
    r.status === 200 &&
      r.data?.device?.backupEnabled === false &&
      r.data?.device?.inventoryEnabled === true,
    `status=${r.status}`,
  );

  r = await req(
    'DELETE',
    `/notifications/devices/${testAdminDeviceId}`,
    null,
    storeUserToken,
  );
  check('Store user cannot remove another user device', r.status === 404, `status=${r.status}`);

  r = await req(
    'PATCH',
    `/notifications/devices/${testAdminDeviceId}`,
    { preferences: { backupEnabled: false, inventoryEnabled: true } },
    adminToken,
  );
  check(
    'Update device preferences',
    r.status === 200 &&
      r.data?.device?.backupEnabled === false &&
      r.data?.device?.inventoryEnabled === true,
    `status=${r.status}`,
  );
  await req(
    'PATCH',
    `/notifications/devices/${testAdminDeviceId}`,
    { preferences: { backupEnabled: true, inventoryEnabled: true } },
    adminToken,
  );

  const callbackToken = process.env.BACKUP_PUSH_TOKEN;
  const callbackHeaders = { 'X-Backup-Push-Token': callbackToken ?? '' };
  r = await req(
    'POST',
    '/backup/events',
    { issue: 'backup_run', state: 'alert' },
    null,
    10_000,
    { 'X-Backup-Push-Token': 'incorrect-backup-push-token' },
  );
  check('Reject invalid backup event token', r.status === 401, `status=${r.status}`);

  r = await req(
    'POST',
    '/backup/events',
    { issue: 'unknown', state: 'alert' },
    null,
    10_000,
    callbackHeaders,
  );
  check('Reject invalid backup event fields', r.status === 400, `status=${r.status}`);

  const backupCountBefore = testAdminDeviceId
    ? Number(await runPsqlScalar(
        `SELECT count(*) FROM push_outbox WHERE category='backup' AND device_id=${testAdminDeviceId}`,
      ))
    : 0;
  r = await req(
    'POST',
    '/backup/events',
    { issue: 'backup_run', state: 'alert' },
    null,
    10_000,
    callbackHeaders,
  );
  check('Accept authenticated backup alert event', r.status === 202, `status=${r.status}`);
  await req(
    'POST',
    '/backup/events',
    { issue: 'backup_run', state: 'alert' },
    null,
    10_000,
    callbackHeaders,
  );
  const backupCountAfterDuplicate = testAdminDeviceId
    ? Number(await runPsqlScalar(
        `SELECT count(*) FROM push_outbox WHERE category='backup' AND device_id=${testAdminDeviceId}`,
      ))
    : 0;
  check(
    'Repeated backup alert is deduplicated',
    backupCountAfterDuplicate === backupCountBefore + 1,
    `outbox=${backupCountBefore}->${backupCountAfterDuplicate}`,
  );
  await req(
    'POST',
    '/backup/events',
    { issue: 'backup_run', state: 'healthy' },
    null,
    10_000,
    callbackHeaders,
  );
  await req(
    'POST',
    '/backup/events',
    { issue: 'backup_run', state: 'alert' },
    null,
    10_000,
    callbackHeaders,
  );
  const backupCountAfterReentry = testAdminDeviceId
    ? Number(await runPsqlScalar(
        `SELECT count(*) FROM push_outbox WHERE category='backup' AND device_id=${testAdminDeviceId}`,
      ))
    : 0;
  check(
    'Backup alert can notify again after recovery',
    backupCountAfterReentry === backupCountBefore + 2,
    `outbox=${backupCountAfterReentry}`,
  );
  await req(
    'POST',
    '/backup/events',
    { issue: 'backup_run', state: 'healthy' },
    null,
    10_000,
    callbackHeaders,
  );
}

async function testInventoryPushTransitions() {
  section('FLOW 4 — Inventory push alert transitions');
  if (!testStoreId || !testProductId || !testAdminDeviceId || !testStoreDeviceId) {
    fail('Inventory push transitions require seeded store, product, and device registrations');
    return;
  }

  await runPsqlScript(
    `UPDATE products SET min_level = '5', max_level = '20' WHERE id = ${testProductId};`,
  );

  const createFinalizedCount = async (quantity) => {
    const created = await req(
      'POST',
      '/inventory-sessions',
      { storeId: testStoreId, notes: 'push-alert-transition-test' },
      adminToken,
    );
    const sessionId = created.data?.id;
    if (created.status !== 201 || !sessionId) {
      throw new Error(`Could not create transition count: ${created.status}`);
    }
    const items = await req(
      'PUT',
      `/inventory-sessions/${sessionId}/items`,
      {
        items: [{
          productId: testProductId,
          fullContainers: quantity,
          partialContainers: 0,
          estimatedGallons: String(quantity),
        }],
      },
      adminToken,
    );
    if (items.status !== 200) throw new Error(`Could not save count items: ${items.status}`);
    const finalized = await req(
      'POST',
      `/inventory-sessions/${sessionId}/finalize`,
      {},
      adminToken,
    );
    if (finalized.status !== 200) throw new Error(`Could not finalize count: ${finalized.status}`);
  };

  const countInventoryPushes = async (condition) => Number(await runPsqlScalar(
    `SELECT count(*) FROM push_outbox WHERE category='inventory' AND title LIKE '%${condition}%' AND device_id IN (${testAdminDeviceId},${testStoreDeviceId})`,
  ));

  await createFinalizedCount(5);
  const baseline = await countInventoryPushes('below minimum');
  await createFinalizedCount(4);
  const firstAlertCount = await countInventoryPushes('below minimum');
  check(
    'Below-minimum entry reaches admin and assigned store user',
    firstAlertCount === baseline + 2,
    `outbox=${baseline}->${firstAlertCount}`,
  );

  await createFinalizedCount(3);
  const duplicateAlertCount = await countInventoryPushes('below minimum');
  check(
    'Staying below minimum does not resend',
    duplicateAlertCount === firstAlertCount,
    `outbox=${firstAlertCount}->${duplicateAlertCount}`,
  );

  await createFinalizedCount(5);
  await createFinalizedCount(4);
  const reentryAlertCount = await countInventoryPushes('below minimum');
  check(
    'Re-entering below minimum after recovery sends again',
    reentryAlertCount === firstAlertCount + 2,
    `outbox=${firstAlertCount}->${reentryAlertCount}`,
  );

  await createFinalizedCount(20);
  const overBaseline = await countInventoryPushes('above maximum');
  await createFinalizedCount(21);
  const firstOverAlertCount = await countInventoryPushes('above maximum');
  check(
    'Overstock entry reaches admin and assigned store user',
    firstOverAlertCount === overBaseline + 2,
    `outbox=${overBaseline}->${firstOverAlertCount}`,
  );

  await createFinalizedCount(22);
  const duplicateOverAlertCount = await countInventoryPushes('above maximum');
  check(
    'Staying over maximum does not resend',
    duplicateOverAlertCount === firstOverAlertCount,
    `outbox=${firstOverAlertCount}->${duplicateOverAlertCount}`,
  );

  await createFinalizedCount(20);
  await createFinalizedCount(21);
  const overReentryCount = await countInventoryPushes('above maximum');
  check(
    'Re-entering overstock after recovery sends again',
    overReentryCount === firstOverAlertCount + 2,
    `outbox=${firstOverAlertCount}->${overReentryCount}`,
  );

  await req('DELETE', `/notifications/devices/${testAdminDeviceId}`, null, adminToken);
  await req('DELETE', `/notifications/devices/${testStoreDeviceId}`, null, storeUserToken);
}

// ─── FLOW 3: Warehouses — CRUD, validation, soft delete, and access control ────

async function testWarehouses() {
  section('FLOW 3 — Warehouse management');

  // 3a: required fields are validated for admin writes.
  let r = await req('POST', '/warehouses', { name: 'Missing Number Warehouse' }, adminToken);
  check(
    'Reject warehouse create without warehouseNumber',
    r.status === 400,
    `status=${r.status} error=${r.data?.error}`,
  );

  r = await req(
    'POST',
    '/warehouses',
    { name: 'E2E Warehouse', warehouseNumber: 'WH-E2E-001', city: 'Portland', state: 'OR' },
    adminToken,
  );
  check('Admin can create warehouse', r.status === 201, `status=${r.status} id=${r.data?.id}`);
  testWarehouseId = r.data?.id;

  if (!testWarehouseId) {
    fail('Warehouse CRUD checks skipped', 'create warehouse did not return an id');
    return;
  }

  // 3b: list and detail endpoints expose the new warehouse.
  r = await req('GET', '/warehouses', null, adminToken);
  check(
    'List warehouses includes new warehouse',
    r.status === 200 && r.data?.some((warehouse) => warehouse.id === testWarehouseId),
    `status=${r.status} count=${r.data?.length}`,
  );

  r = await req('GET', `/warehouses/${testWarehouseId}`, null, adminToken);
  check(
    'Get warehouse by id',
    r.status === 200 && r.data?.warehouseNumber === 'WH-E2E-001',
    `status=${r.status} number=${r.data?.warehouseNumber}`,
  );

  // 3c: updates work and reject empty required fields.
  r = await req(
    'PATCH',
    `/warehouses/${testWarehouseId}`,
    { name: 'E2E Updated Warehouse', manager: 'E2E Manager', status: 'inactive' },
    adminToken,
  );
  check(
    'Admin can update warehouse',
    r.status === 200 && r.data?.name === 'E2E Updated Warehouse' && r.data?.status === 'inactive',
    `status=${r.status} name=${r.data?.name} statusValue=${r.data?.status}`,
  );

  r = await req('GET', `/warehouses/${testWarehouseId}`, null, adminToken);
  check(
    'Warehouse update is persisted',
    r.status === 200 &&
      r.data?.name === 'E2E Updated Warehouse' &&
      r.data?.status === 'inactive',
    `status=${r.status} name=${r.data?.name} statusValue=${r.data?.status}`,
  );

  r = await req('PATCH', `/warehouses/${testWarehouseId}`, { name: '   ' }, adminToken);
  check(
    'Reject warehouse update with empty name',
    r.status === 400,
    `status=${r.status} error=${r.data?.error}`,
  );

  // 3d: store users may read warehouses but cannot mutate them.
  r = await req('GET', '/warehouses', null, storeUserToken);
  check('Non-admin can list warehouses', r.status === 200 && Array.isArray(r.data), `status=${r.status}`);

  r = await req(
    'POST',
    '/warehouses',
    { name: 'Unauthorized Warehouse', warehouseNumber: 'WH-E2E-UNAUTHORIZED' },
    storeUserToken,
  );
  check('Non-admin cannot create warehouses', r.status === 403, `status=${r.status}`);

  r = await req(
    'PATCH',
    `/warehouses/${testWarehouseId}`,
    { name: 'Unauthorized Update' },
    storeUserToken,
  );
  check('Non-admin cannot update warehouses', r.status === 403, `status=${r.status}`);

  r = await req('DELETE', `/warehouses/${testWarehouseId}`, null, storeUserToken);
  check('Non-admin cannot delete warehouses', r.status === 403, `status=${r.status}`);

  // 3e: admin deletion is a soft delete: the row is hidden from lists and
  // detail access, but remains available for teardown/audit inspection.
  r = await req('DELETE', `/warehouses/${testWarehouseId}`, null, adminToken);
  check('Admin can delete warehouse', r.status === 204, `status=${r.status}`);

  r = await req('GET', '/warehouses', null, adminToken);
  check(
    'Soft-deleted warehouse is absent from list',
    r.status === 200 && !r.data?.some((warehouse) => warehouse.id === testWarehouseId),
    `status=${r.status} count=${r.data?.length}`,
  );

  r = await req('GET', `/warehouses/${testWarehouseId}`, null, adminToken);
  check('Soft-deleted warehouse is absent from detail endpoint', r.status === 404, `status=${r.status}`);
}

// ─── FLOW 4: Products (create via admin for inventory tests) ──────────────────

async function testProducts() {
  section('FLOW 4 — Products');

  // Create a test category first
  let r = await req('GET', '/categories', null, adminToken);
  // If no categories, create via direct SQL — categories endpoint may be read-only
  // Just use products directly
  r = await req('GET', '/products', null, adminToken);
  check('List products returns array', r.status === 200 && Array.isArray(r.data), `count=${r.data?.length}`);

  // Try to create a product
  r = await req('POST', '/products', { name: 'Test Chemical A', unit: 'gallon', productNumber: 'TC-001', activeOnly: true }, adminToken);
  if (r.status === 201) {
    testProductId = r.data?.id;
    check('Create product', true, `id=${testProductId}`);
  } else if (r.status === 404 || r.status === 405) {
    // Products may be read-only; use first existing product
    r = await req('GET', '/products', null, adminToken);
    testProductId = r.data?.[0]?.id ?? null;
    pass('Products endpoint available (read)', `count=${r.data?.length}`);
  } else {
    check('Create product or list products', r.status < 500, `status=${r.status} body=${JSON.stringify(r.data)}`);
  }
}

// ─── FLOW 4b: Warehouse ledger auditability ──────────────────────────────────

async function testWarehouseLedgerFlow() {
  section('FLOW 4b — Warehouse ledger and report coverage');

  if (!testStoreId) {
    fail('Warehouse ledger tests skipped — missing store id');
    return;
  }

  // Keep report assertions independent from products shared by other flows.
  let r = await req(
    'POST',
    '/products',
    {
      name: 'Warehouse Report E2E Product',
      productNumber: 'WRP-E2E-001',
      unit: 'gallon',
      minLevel: '4.000',
      maxLevel: '6.000',
      cost: '4.00',
    },
    adminToken,
  );
  check(
    'Create dedicated warehouse report product',
    r.status === 201 && Number.isInteger(r.data?.id),
    `status=${r.status} id=${r.data?.id}`,
  );
  const reportProductId = r.data?.id;
  if (!reportProductId) {
    fail('Warehouse report checks skipped', 'dedicated report product could not be created');
    return;
  }

  // Keep these separate from the CRUD flow's soft-deleted warehouse. Teardown
  // removes all warehouses whose number starts with WH-E2E.
  r = await req(
    'POST',
    '/warehouses',
    { name: 'E2E Receipt Warehouse', warehouseNumber: 'WH-E2E-RECEIPT' },
    adminToken,
  );
  check('Create warehouse for receipt audit', r.status === 201, `status=${r.status} id=${r.data?.id}`);
  const receiptWarehouseId = r.data?.id;

  r = await req(
    'POST',
    '/warehouses',
    { name: 'E2E Transfer Source', warehouseNumber: 'WH-E2E-SOURCE' },
    adminToken,
  );
  check('Create source warehouse for transfer audit', r.status === 201, `status=${r.status} id=${r.data?.id}`);
  const sourceWarehouseId = r.data?.id;

  r = await req(
    'POST',
    '/warehouses',
    { name: 'E2E Transfer Destination', warehouseNumber: 'WH-E2E-DEST' },
    adminToken,
  );
  check('Create destination warehouse for transfer audit', r.status === 201, `status=${r.status} id=${r.data?.id}`);
  const destinationWarehouseId = r.data?.id;

  if (!receiptWarehouseId || !sourceWarehouseId || !destinationWarehouseId) {
    fail('Warehouse ledger checks skipped', 'one or more audit warehouses could not be created');
    return;
  }

  // A warehouse-linked receipt must point back to its receiving record.
  r = await req(
    'POST',
    '/receiving-records',
    {
      storeId: testStoreId,
      warehouseId: receiptWarehouseId,
      vendor: 'Warehouse Audit Supplier',
      invoiceNumber: 'INV-E2E-WAREHOUSE',
      notes: 'E2E test warehouse-linked receipt',
      items: [{ productId: reportProductId, quantityReceived: '7.500', lotNumber: 'LOT-E2E-WAREHOUSE' }],
    },
    adminToken,
  );
  check('Create warehouse-linked receiving record', r.status === 201, `status=${r.status} id=${r.data?.id}`);
  const linkedReceivingId = r.data?.id;

  r = await req(
    'POST',
    '/receiving-records',
    {
      warehouseId: receiptWarehouseId,
      vendor: 'Warehouse-Only Supplier',
      items: [{ productId: reportProductId, quantityReceived: '1.000' }],
    },
    adminToken,
  );
  check('Create warehouse-only receiving record', r.status === 201 && r.data?.storeId === null,
    `status=${r.status} storeId=${r.data?.storeId}`);
  r = await req('GET', `/warehouses/${receiptWarehouseId}/stock`, null, adminToken);
  const warehouseReceiptStock = (r.data ?? []).find(
    (line) => line.productId === reportProductId,
  );
  check(
    'Warehouse stock includes linked and warehouse-only receipts once',
    r.status === 200 && parseFloat(warehouseReceiptStock?.quantity ?? 'NaN') === 8.5,
    `status=${r.status} quantity=${warehouseReceiptStock?.quantity}`,
  );

  r = await req('GET', `/receiving-records/${linkedReceivingId}`, null, adminToken);
  check(
    'Warehouse-linked receiving record preserves warehouse',
    r.status === 200 && r.data?.warehouseId === receiptWarehouseId,
    `status=${r.status} warehouseId=${r.data?.warehouseId}`,
  );

  r = await req('POST', '/warehouse-transfers', {
    sourceWarehouseId,
    destinationStoreId: testStoreId,
    items: [{ productId: reportProductId, quantity: '999999' }],
  }, adminToken);
  check('Reject warehouse transfer with insufficient stock', r.status === 409, `status=${r.status}`);
  r = await req('POST', '/warehouse-transfers', {
    sourceWarehouseId,
    destinationStoreId: testStoreId,
    items: [{ productId: -1, quantity: '1' }],
  }, adminToken);
  check('Reject warehouse transfer with invalid product', r.status === 400, `status=${r.status}`);
  r = await req('POST', '/warehouse-transfers', {
    sourceWarehouseId: -1,
    destinationStoreId: testStoreId,
    items: [{ productId: reportProductId, quantity: '1' }],
  }, adminToken);
  check('Reject warehouse transfer with invalid warehouse target', r.status === 404, `status=${r.status}`);
  r = await req('POST', '/warehouse-transfers', {
    sourceWarehouseId,
    destinationStoreId: testStoreId,
    items: [{ productId: reportProductId, quantity: '1' }],
  }, storeUserToken);
  check('Reject warehouse transfer for store user', r.status === 403, `status=${r.status}`);

  r = await req(
    'GET',
    `/warehouses/${receiptWarehouseId}/movements?productId=${reportProductId}&movementType=receipt`,
    null,
    adminToken,
  );
  const receiptMovements = Array.isArray(r.data) ? r.data : [];
  const receiptMovement = receiptMovements.find((movement) => movement.receivingRecordId === linkedReceivingId);
  check(
    'Warehouse-linked receipt creates an auditable receipt movement',
    r.status === 200 &&
      receiptMovement?.warehouseId === receiptWarehouseId &&
      receiptMovement?.productId === reportProductId &&
      receiptMovement?.movementType === 'receipt' &&
      parseFloat(receiptMovement?.quantity ?? '-1') === 7.5,
    `status=${r.status} movementCount=${receiptMovements.length} linkedId=${receiptMovement?.receivingRecordId}`,
  );

  // Store-only legacy receipts must not add a warehouse ledger row.
  const receiptCountBeforeLegacy = receiptMovements.length;
  r = await req(
    'POST',
    '/receiving-records',
    {
      storeId: testStoreId,
      vendor: 'Legacy Store-Only Supplier',
      invoiceNumber: 'INV-E2E-LEGACY',
      notes: 'E2E test legacy store-only receipt',
      items: [{ productId: reportProductId, quantityReceived: '2.000' }],
    },
    adminToken,
  );
  const legacyReceivingId = r.data?.id;
  check('Create legacy store-only receiving record', r.status === 201, `status=${r.status} id=${legacyReceivingId}`);

  r = await req(
    'GET',
    `/warehouses/${receiptWarehouseId}/movements?productId=${reportProductId}&movementType=receipt`,
    null,
    adminToken,
  );
  const receiptMovementsAfterLegacy = Array.isArray(r.data) ? r.data : [];
  check(
    'Legacy store-only receiving creates no warehouse movement',
    r.status === 200 &&
      receiptMovementsAfterLegacy.length === receiptCountBeforeLegacy &&
      !receiptMovementsAfterLegacy.some((movement) => movement.receivingRecordId === legacyReceivingId),
    `status=${r.status} before=${receiptCountBeforeLegacy} after=${receiptMovementsAfterLegacy.length}`,
  );

  // Transfers remain auditable as a signed pair sharing one transfer group.
  r = await req(
    'POST',
    `/warehouses/${destinationWarehouseId}/movements`,
    {
      productId: reportProductId,
      quantity: '3.25',
      movementType: 'transfer',
      fromWarehouseId: sourceWarehouseId,
      toWarehouseId: destinationWarehouseId,
      notes: 'E2E test warehouse transfer audit',
    },
    adminToken,
  );
  const transferRows = r.data?.movements;
  const transferGroupId = r.data?.transferGroupId;
  const sourceTransfer = Array.isArray(transferRows)
    ? transferRows.find((movement) => movement.warehouseId === sourceWarehouseId)
    : null;
  const destinationTransfer = Array.isArray(transferRows)
    ? transferRows.find((movement) => movement.warehouseId === destinationWarehouseId)
    : null;
  check(
    'Create transfer returns a signed source and destination pair',
    r.status === 201 &&
      typeof transferGroupId === 'string' &&
      transferRows?.length === 2 &&
      sourceTransfer?.movementType === 'transfer' &&
      destinationTransfer?.movementType === 'transfer' &&
      parseFloat(sourceTransfer?.quantity ?? '0') === -3.25 &&
      parseFloat(destinationTransfer?.quantity ?? '0') === 3.25 &&
      sourceTransfer?.transferGroupId === transferGroupId &&
      destinationTransfer?.transferGroupId === transferGroupId,
    `status=${r.status} group=${transferGroupId} rows=${transferRows?.length}`,
  );

  r = await req(
    'GET',
    `/warehouses/${sourceWarehouseId}/movements?productId=${reportProductId}&movementType=transfer`,
    null,
    adminToken,
  );
  const sourceMovements = Array.isArray(r.data) ? r.data : [];
  const sourceLedgerRow = sourceMovements.find((movement) => movement.transferGroupId === transferGroupId);
  check(
    'Source warehouse ledger keeps the negative transfer row',
    r.status === 200 &&
      sourceLedgerRow?.warehouseId === sourceWarehouseId &&
      parseFloat(sourceLedgerRow?.quantity ?? '0') === -3.25 &&
      sourceLedgerRow?.fromWarehouseId === sourceWarehouseId &&
      sourceLedgerRow?.toWarehouseId === destinationWarehouseId,
    `status=${r.status} rows=${sourceMovements.length}`,
  );

  r = await req(
    'GET',
    `/warehouses/${destinationWarehouseId}/movements?productId=${reportProductId}&movementType=transfer`,
    null,
    adminToken,
  );
  const destinationMovements = Array.isArray(r.data) ? r.data : [];
  const destinationLedgerRow = destinationMovements.find((movement) => movement.transferGroupId === transferGroupId);
  check(
    'Destination warehouse ledger keeps the positive transfer row',
    r.status === 200 &&
      destinationLedgerRow?.warehouseId === destinationWarehouseId &&
      parseFloat(destinationLedgerRow?.quantity ?? '0') === 3.25 &&
      destinationLedgerRow?.fromWarehouseId === sourceWarehouseId &&
      destinationLedgerRow?.toWarehouseId === destinationWarehouseId &&
      destinationLedgerRow?.transferGroupId === sourceLedgerRow?.transferGroupId,
    `status=${r.status} rows=${destinationMovements.length}`,
  );

  // Fail only the destination insert to simulate a persistence error after the
  // source row has been attempted. PostgreSQL must roll back the complete pair.
  const { randomUUID } = await import('node:crypto');
  const failureSuffix = randomUUID().replaceAll('-', '');
  const failureNotes = `E2E forced transfer write failure ${failureSuffix}`;
  const failureFunction = `e2e_transfer_failure_${failureSuffix}_fn`;
  const failureTrigger = `e2e_transfer_failure_${failureSuffix}_trigger`;
  let failureResponse = null;
  let triggerInstalled = false;
  try {
    await runPsqlScript(`
      CREATE FUNCTION ${failureFunction}() RETURNS trigger LANGUAGE plpgsql AS $e2e$
      BEGIN
        IF NEW.warehouse_id = ${destinationWarehouseId}
          AND NEW.product_id = ${reportProductId}
          AND NEW.movement_type = 'transfer'
          AND NEW.notes = '${failureNotes}' THEN
          RAISE EXCEPTION 'intentional E2E destination transfer write failure';
        END IF;
        RETURN NEW;
      END;
      $e2e$;
      CREATE TRIGGER ${failureTrigger}
      BEFORE INSERT ON warehouse_inventory_movements
      FOR EACH ROW EXECUTE FUNCTION ${failureFunction}();
    `);
    triggerInstalled = true;
    failureResponse = await req(
      'POST',
      `/warehouses/${destinationWarehouseId}/movements`,
      {
        productId: reportProductId,
        quantity: '1.25',
        movementType: 'transfer',
        fromWarehouseId: sourceWarehouseId,
        toWarehouseId: destinationWarehouseId,
        notes: failureNotes,
      },
      adminToken,
    );
  } catch {
    fail('Prepare deterministic transfer write failure', 'trigger setup or transfer request failed');
  } finally {
    try {
      await runPsqlScript(`
        DROP TRIGGER IF EXISTS ${failureTrigger} ON warehouse_inventory_movements;
        DROP FUNCTION IF EXISTS ${failureFunction}();
      `);
    } catch {
      fail('Clean up deterministic transfer write failure trigger', 'database cleanup failed');
    }
  }

  check(
    'Transfer write failure returns a clear API error without a transfer group',
    triggerInstalled &&
      failureResponse?.status === 500 &&
      failureResponse.data?.error === 'Unable to create warehouse transfer' &&
      !failureResponse.data?.transferGroupId,
    `status=${failureResponse?.status} error=${failureResponse?.data?.error ?? 'none'}`,
  );

  r = await req(
    'GET',
    `/warehouses/${sourceWarehouseId}/movements?productId=${reportProductId}&movementType=transfer`,
    null,
    adminToken,
  );
  const sourceRowsAfterFailedTransfer = Array.isArray(r.data) ? r.data : [];
  const failedSourceRow = sourceRowsAfterFailedTransfer.find((movement) => movement.notes === failureNotes);
  check(
    'Failed transfer leaves no negative source row',
    r.status === 200 && !failedSourceRow,
    `status=${r.status} row=${failedSourceRow?.id ?? 'absent'}`,
  );

  r = await req(
    'GET',
    `/warehouses/${destinationWarehouseId}/movements?productId=${reportProductId}&movementType=transfer`,
    null,
    adminToken,
  );
  const destinationRowsAfterFailedTransfer = Array.isArray(r.data) ? r.data : [];
  const failedDestinationRow = destinationRowsAfterFailedTransfer.find((movement) => movement.notes === failureNotes);
  check(
    'Failed transfer leaves no positive destination row or orphaned group',
    r.status === 200 && !failedDestinationRow,
    `status=${r.status} row=${failedDestinationRow?.id ?? 'absent'}`,
  );

  // Report consumers must apply the receipt and both signed transfer rows to
  // warehouse stock, valuation, and threshold alerts.
  async function assertWarehouseValuation(warehouseId, expectedQuantity, expectedValue) {
    const report = await req(
      'GET',
      `/reports/inventory-valuation?warehouseId=${warehouseId}`,
      null,
      adminToken,
    );
    const line = Array.isArray(report.data)
      ? report.data.find((row) => row.warehouseId === warehouseId && row.productId === reportProductId)
      : report.data?.lines?.find((row) => row.warehouseId === warehouseId && row.productId === reportProductId);
    check(
      `Inventory valuation includes ${expectedQuantity} gallons at warehouse ${warehouseId}`,
      report.status === 200 &&
        parseFloat(line?.currentQuantity ?? 'NaN') === expectedQuantity &&
        parseFloat(line?.totalValue ?? 'NaN') === expectedValue,
      `status=${report.status} quantity=${line?.currentQuantity} value=${line?.totalValue}`,
    );
  }

  await assertWarehouseValuation(receiptWarehouseId, 7.5, 30);
  await assertWarehouseValuation(sourceWarehouseId, -3.25, -13);
  await assertWarehouseValuation(destinationWarehouseId, 3.25, 13);

  async function assertWarehouseAlert(endpoint, warehouseId, expectedLevel, label) {
    const report = await req(
      'GET',
      `/reports/${endpoint}?warehouseId=${warehouseId}`,
      null,
      adminToken,
    );
    const alerts = Array.isArray(report.data) ? report.data : [];
    const alert = alerts.find(
      (row) => row.productId === reportProductId && row.warehouseId === warehouseId,
    );
    check(
      label,
      report.status === 200 &&
        (expectedLevel === null
          ? !alert
          : parseFloat(alert?.currentLevel ?? 'NaN') === expectedLevel),
      `status=${report.status} currentLevel=${alert?.currentLevel ?? 'no alert'}`,
    );
  }

  await assertWarehouseAlert(
    'below-minimum',
    receiptWarehouseId,
    null,
    'Receipt keeps warehouse stock above the minimum threshold',
  );
  await assertWarehouseAlert(
    'below-minimum',
    sourceWarehouseId,
    -3.25,
    'Source transfer reduction appears in below-minimum stock alerts',
  );
  await assertWarehouseAlert(
    'below-minimum',
    destinationWarehouseId,
    3.25,
    'Destination transfer increase appears in below-minimum stock alerts',
  );
  await assertWarehouseAlert(
    'overstocked',
    receiptWarehouseId,
    8.5,
    'Warehouse-only and linked receipts appear together in overstocked alerts',
  );
  await assertWarehouseAlert(
    'overstocked',
    sourceWarehouseId,
    null,
    'Source transfer reduction is not reported as overstocked',
  );
  await assertWarehouseAlert(
    'overstocked',
    destinationWarehouseId,
    null,
    'Destination transfer remains below the overstock threshold',
  );

  // The warehouse-to-store API uses the source warehouse's current balance.
  // Seed that balance here so this successful transfer does not alter the
  // earlier warehouse-to-warehouse expectations above.
  r = await req('POST', '/receiving-records', {
    warehouseId: sourceWarehouseId,
    vendor: 'E2E Store Transfer Supplier',
    items: [{ productId: reportProductId, quantityReceived: '5.000' }],
  }, adminToken);
  check('Seed source stock for warehouse-to-store transfer', r.status === 201, `status=${r.status}`);

  const beforeSourceStockResponse = await req(
    'GET', `/warehouses/${sourceWarehouseId}/stock`, null, adminToken,
  );
  const beforeSourceStockLine = (beforeSourceStockResponse.data ?? []).find(
    (line) => line.productId === reportProductId,
  );
  const beforeStoreValuation = await req(
    'GET', `/reports/inventory-valuation?storeId=${testStoreId}`, null, adminToken,
  );
  const beforeStoreLine = (beforeStoreValuation.data?.lines ?? []).find(
    (line) => line.storeId === testStoreId && line.productId === reportProductId,
  );
  r = await req('POST', '/warehouse-transfers', {
    sourceWarehouseId: sourceWarehouseId,
    destinationStoreId: testStoreId,
    notes: 'E2E warehouse-to-store transfer',
    items: [{ productId: reportProductId, quantity: '1.250' }],
  }, adminToken);
  const storeTransferGroupId = r.data?.transferGroupId;
  const storeTransferHeader = r.data?.header;
  const storeTransferReceipt = r.data?.receipt;
  check(
    'Create successful warehouse-to-store transfer',
    r.status === 201 &&
      typeof storeTransferGroupId === 'string' &&
      storeTransferHeader?.transferGroupId === storeTransferGroupId &&
      storeTransferReceipt?.id,
    `status=${r.status} group=${storeTransferGroupId}`,
  );
  const sourceStoreTransfer = (r.data?.movements ?? []).find(
    (movement) => movement.warehouseId === sourceWarehouseId,
  );
  check(
    'Warehouse-to-store transfer records negative source movement and destination store',
    sourceStoreTransfer?.transferGroupId === storeTransferGroupId &&
      parseFloat(sourceStoreTransfer?.quantity ?? '0') === -1.25 &&
      sourceStoreTransfer?.destinationStoreId === testStoreId,
    `group=${sourceStoreTransfer?.transferGroupId} quantity=${sourceStoreTransfer?.quantity}`,
  );
  r = await req('GET', `/receiving-records/${storeTransferReceipt?.id}`, null, adminToken);
  check(
    'Warehouse-to-store transfer creates a receipt for the destination store',
    r.status === 200 &&
      r.data?.storeId === testStoreId &&
      r.data?.warehouseId === null,
    `status=${r.status} storeId=${r.data?.storeId} warehouseId=${r.data?.warehouseId}`,
  );
  const afterSourceStockResponse = await req(
    'GET', `/warehouses/${sourceWarehouseId}/stock`, null, adminToken,
  );
  const afterSourceStockLine = (afterSourceStockResponse.data ?? []).find(
    (line) => line.productId === reportProductId,
  );
  check(
    'Warehouse stock decreases by the transferred quantity',
    afterSourceStockResponse.status === 200 &&
      Math.round(parseFloat(beforeSourceStockLine?.quantity ?? '0') * 1000) -
        Math.round(parseFloat(afterSourceStockLine?.quantity ?? '0') * 1000) === 1250,
    `before=${beforeSourceStockLine?.quantity} after=${afterSourceStockLine?.quantity}`,
  );
  const afterStoreValuation = await req(
    'GET', `/reports/inventory-valuation?storeId=${testStoreId}`, null, adminToken,
  );
  const afterStoreLine = (afterStoreValuation.data?.lines ?? []).find(
    (line) => line.storeId === testStoreId && line.productId === reportProductId,
  );
  check(
    'Store valuation reflects warehouse-to-store transfer quantity',
    afterStoreValuation.status === 200 &&
      parseFloat(afterStoreLine?.currentQuantity ?? 'NaN') ===
        parseFloat(beforeStoreLine?.currentQuantity ?? '0') + 1.25,
    `before=${beforeStoreLine?.currentQuantity} after=${afterStoreLine?.currentQuantity}`,
  );
  r = await req('POST', '/receiving-records', {
    warehouseId: receiptWarehouseId,
    items: [{ productId: reportProductId, quantityReceived: '1.000' }],
  }, storeUserToken);
  check('Store user cannot create warehouse-only receiving record', r.status === 403, `status=${r.status}`);
}

// ─── FLOW 4: Inventory Count (start → items → finalize) ──────────────────────

async function testInventoryFlow() {
  section('FLOW 4 — Inventory Count: start → enter quantities → finalize');

  if (!testStoreId) { fail('Inventory test skipped — no store id'); return; }

  // 4a: create inventory session (admin)
  let r = await req('POST', '/inventory-sessions', { storeId: testStoreId, notes: 'E2E test run' }, adminToken);
  check('Create inventory session', r.status === 201, `status=${r.status} id=${r.data?.id}`);
  testSessionId = r.data?.id;

  // 4b: create session as store_user
  r = await req('POST', '/inventory-sessions', { storeId: testStoreId }, storeUserToken);
  check('Store user can create session for own store', r.status === 201, `status=${r.status}`);
  const storeUserSessionId = r.data?.id;

  // 4c: store_user cannot create session for different store
  r = await req('POST', '/inventory-sessions', { storeId: testStoreId + 1 }, storeUserToken);
  check('Store user blocked from other-store session', r.status === 403, `status=${r.status}`);

  // 4d: get session
  r = await req('GET', `/inventory-sessions/${testSessionId}`, null, adminToken);
  check('Get session by id', r.status === 200 && r.data?.status === 'open', `status=${r.data?.status}`);

  // 4e: list sessions
  r = await req('GET', '/inventory-sessions', null, adminToken);
  check('List inventory sessions', r.status === 200 && r.data?.some(s => s.id === testSessionId), `count=${r.data?.length}`);

  // 4f: add items to session (if we have a product)
  if (testProductId) {
    r = await req('PUT', `/inventory-sessions/${testSessionId}/items`, {
      items: [{ productId: testProductId, fullContainers: 3, partialContainers: 1, estimatedPercentage: '50', comments: 'Test count' }]
    }, adminToken);
    check('Save inventory items', r.status === 200 && Array.isArray(r.data), `count=${r.data?.length}`);

    // 4g: verify items persisted
    r = await req('GET', `/inventory-sessions/${testSessionId}`, null, adminToken);
    check('Items persisted on session fetch', (r.data?.items?.length ?? 0) > 0, `itemCount=${r.data?.items?.length}`);
  } else {
    pass('Skip items save — no products in DB');
  }

  // 4h: finalize session
  r = await req('POST', `/inventory-sessions/${testSessionId}/finalize`, {}, adminToken);
  check('Finalize session', r.status === 200, `status=${r.status} finalStatus=${r.data?.status}`);

  // 4i: verify finalized status
  r = await req('GET', `/inventory-sessions/${testSessionId}`, null, adminToken);
  check('Session status is finalized', r.data?.status === 'finalized', `status=${r.data?.status}`);

  // 4j: cannot re-finalize
  r = await req('POST', `/inventory-sessions/${testSessionId}/finalize`, {}, adminToken);
  check('Cannot re-finalize session', r.status === 400 || r.status === 409, `status=${r.status}`);
}

// ─── FLOW 5: Log Delivery (receiving record) ──────────────────────────────────

async function testDeliveryFlow() {
  section('FLOW 5 — Log Delivery: create receiving record');

  if (!testStoreId) { fail('Delivery test skipped — no store id'); return; }

  const items = testProductId
    ? [{ productId: testProductId, quantityReceived: '10', lotNumber: 'LOT-2026-01', cost: '25.50' }]
    : null;

  if (!items) {
    // Try with a fake product id and check it fails gracefully or check if a product exists
    pass('Delivery test skipped — no products in DB to receive');
    return;
  }

  // 5a: create receiving record
  let r = await req('POST', '/receiving-records', {
    storeId: testStoreId,
    vendor: 'Acme Chemical Co.',
    invoiceNumber: 'INV-2026-001',
    items,
  }, adminToken);
  check('Create receiving record', r.status === 201, `status=${r.status} id=${r.data?.id}`);
  testReceivingId = r.data?.id;

  // 5b: get record with items
  r = await req('GET', `/receiving-records/${testReceivingId}`, null, adminToken);
  check('Get receiving record by id', r.status === 200, `status=${r.status}`);
  check('Receiving record has items', (r.data?.items?.length ?? 0) > 0, `itemCount=${r.data?.items?.length}`);
  check('Item quantity correct', parseFloat(r.data?.items?.[0]?.quantityReceived) === 10, `qty=${r.data?.items?.[0]?.quantityReceived}`);

  // 5c: list receiving records for store
  r = await req('GET', `/receiving-records?storeId=${testStoreId}`, null, adminToken);
  check('List receiving records', r.status === 200 && r.data?.some(rec => rec.id === testReceivingId), `count=${r.data?.length}`);

  // 5d: store user can access their own records
  r = await req('GET', `/receiving-records/${testReceivingId}`, null, storeUserToken);
  check('Store user can access own store receiving record', r.status === 200, `status=${r.status}`);
}

// ─── FLOW 6: Dashboard ────────────────────────────────────────────────────────

async function testDashboard() {
  section('FLOW 6 — Dashboard summary');

  // 6a: admin dashboard
  let r = await req('GET', '/dashboard/summary', null, adminToken);
  check('Dashboard returns 200', r.status === 200, `status=${r.status}`);
  check('Dashboard has storesTotal', typeof r.data?.storesTotal === 'number', `storesTotal=${r.data?.storesTotal}`);
  check('Dashboard has recentSessions', Array.isArray(r.data?.recentSessions), `recentSessions count=${r.data?.recentSessions?.length}`);

  // 6b: store user dashboard (scoped)
  r = await req('GET', '/dashboard/summary', null, storeUserToken);
  check('Store user dashboard returns 200', r.status === 200, `status=${r.status}`);
  check('Store user dashboard scoped to 1 store', r.data?.storesTotal <= 1, `storesTotal=${r.data?.storesTotal}`);
}

// ─── FLOW 7: AI Chat ──────────────────────────────────────────────────────────

async function testAiChat() {
  section('FLOW 7 — AI Chat');

  // 7a: chat with no AI config → 503
  let r = await req('POST', '/ai/chat', {
    messages: [{ role: 'user', content: 'What is the current inventory status?' }],
    storeId: testStoreId,
  }, adminToken);
  // If AI is not configured we expect 503; if configured we expect 200
  if (r.status === 503) {
    check('AI chat: 503 when not configured (expected)', true, `error=${r.data?.error}`);
    pass('AI config absent — correctly blocks chat until admin configures API key');
  } else if (r.status === 200) {
    check('AI chat returns response', typeof r.data?.message === 'string', `reply="${r.data?.message?.slice(0, 60)}…"`);
  } else if (r.status === 502) {
    pass('AI chat: 502 from provider (API key set but provider error)', `error=${r.data?.error}`);
  } else {
    fail('AI chat unexpected status', `status=${r.status} body=${JSON.stringify(r.data)}`);
  }

  // 7b: AI chat requires auth
  r = await req('POST', '/ai/chat', { messages: [{ role: 'user', content: 'hello' }] }, null);
  check('AI chat requires auth', r.status === 401, `status=${r.status}`);

  // 7c: AI config endpoint (admin only)
  r = await req('GET', '/ai/config', null, adminToken);
  check('GET /ai/config admin access', r.status === 200, `status=${r.status} hasApiKey=${r.data?.hasApiKey}`);
  const originalAiConfig = {
    id: r.data?.id,
    hasApiKey: r.data?.hasApiKey,
    provider: r.data?.provider,
    systemPrompt: r.data?.systemPrompt,
    updatedAt: r.data?.updatedAt,
  };

  // 7d: non-admin blocked from AI config
  r = await req('GET', '/ai/config', null, storeUserToken);
  check('GET /ai/config blocked for non-admin', r.status === 403, `status=${r.status}`);

  // 7e: streaming disconnect — connect to a controllable delayed mock upstream,
  //     drop the client after 500 ms, then verify that the server's AbortController
  //     actually cancelled the upstream fetch (mock recorded an early close).
  //     The X-Test-Ai-Url header redirects the streaming route to the mock when
  //     NODE_ENV=test; this is a no-op in production.
  {
    // Snapshot the complete row before provisioning a test key.  This preserves
    // provider, prompt, and the encrypted key blob without ever exposing or
    // decrypting a configured key.  The restore runs even when a request or
    // assertion fails so this flow is safe to run against a configured database.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const execFileAsync = promisify(execFile);
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const tsx = join(scriptsDir, 'node_modules', '.bin', 'tsx');
    const snapshotScript = join(scriptsDir, 'snapshot-ai-config.ts');
    const restoreScript = join(scriptsDir, 'restore-ai-config.ts');
    const snapshotDir = mkdtempSync(join(tmpdir(), 'e2e-ai-stream-'));
    const snapshotFile = join(snapshotDir, 'ai-config-snapshot.json');
    const emptySnapshotFile = join(snapshotDir, 'empty-ai-config-snapshot.json');
    let snapshotReady = false;
    let emptySnapshotReady = false;
    let testRowId = 0;
    let forcedRestoreFailureObserved = false;
    let defaultAiConfig = null;
    const controlledStreamingFailure = new Error(
      'controlled streaming-check failure after temporary AI config setup',
    );
    let controlledStreamingFailureObserved = false;

    try {
      await execFileAsync(tsx, [snapshotScript, snapshotFile]);
      snapshotReady = true;

      // Preserve the real starting state, then remove its row by exact ID so
      // this streaming cleanup check starts from a genuinely empty config.
      writeFileSync(emptySnapshotFile, JSON.stringify({ exists: false, row: null }), 'utf8');
      const originalSnapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
      if (originalSnapshot.exists && originalSnapshot.row?.id) {
        await execFileAsync(
          tsx,
          [restoreScript, emptySnapshotFile, String(originalSnapshot.row.id)],
        );
      }
      await execFileAsync(tsx, [snapshotScript, emptySnapshotFile]);
      emptySnapshotReady = true;
      const emptySnapshot = JSON.parse(readFileSync(emptySnapshotFile, 'utf8'));
      const configBeforeStreamingSetup = await req('GET', '/ai/config', null, adminToken);
      defaultAiConfig = configBeforeStreamingSetup.data;
      check(
        'Streaming endpoint: no AI config row exists before temporary setup',
        emptySnapshot.exists === false &&
          emptySnapshot.row === null &&
          configBeforeStreamingSetup.status === 200 &&
          configBeforeStreamingSetup.data?.id === 0,
        `snapshotExists=${emptySnapshot.exists} adminStatus=${configBeforeStreamingSetup.status} adminId=${configBeforeStreamingSetup.data?.id}`,
      );
      check(
        'Streaming endpoint: empty config exposes built-in admin defaults before setup',
        configBeforeStreamingSetup.status === 200 &&
          configBeforeStreamingSetup.data?.provider === 'openai' &&
          typeof configBeforeStreamingSetup.data?.systemPrompt === 'string' &&
          configBeforeStreamingSetup.data.systemPrompt.length > 0 &&
          configBeforeStreamingSetup.data?.hasApiKey === false,
        `provider=${configBeforeStreamingSetup.data?.provider} promptPresent=${typeof configBeforeStreamingSetup.data?.systemPrompt === 'string' && configBeforeStreamingSetup.data.systemPrompt.length > 0} hasApiKey=${configBeforeStreamingSetup.data?.hasApiKey}`,
      );

      // Seed a known configured row for the disconnect checks.  The key is sent
      // through the normal encrypted config endpoint and is never returned,
      // logged, or compared in plaintext.  The snapshot restore below returns
      // any pre-existing row exactly as it was.
      const seededProvider = 'grok';
      const seededPrompt = 'Streaming disconnect preservation test prompt.';
      const putResult = await req(
        'PUT',
        '/ai/config',
        {
          provider: seededProvider,
          systemPrompt: seededPrompt,
          apiKey: 'e2e-streaming-preservation-test-key',
        },
        adminToken,
      );
      testRowId = putResult.data?.id ?? 0;
      check(
        'Streaming endpoint: seeded temporary AI config',
        putResult.status === 200 &&
          putResult.data?.hasApiKey === true &&
          putResult.data?.provider === seededProvider &&
          putResult.data?.systemPrompt === seededPrompt,
        `status=${putResult.status} hasApiKey=${putResult.data?.hasApiKey} provider=${putResult.data?.provider}`,
      );

      await startMockAiServer();

      // 7e-complete: consume a deterministic upstream response to completion.
      // This verifies that the route forwards content chunks, emits the
      // terminal [DONE] event, and closes the client stream without relying on
      // live provider availability.
      {
        let completionStatus = null;
        let completionBody = '';
        let completionError = null;
        const completionStartedAt = Date.now();
        try {
          const completionRes = await fetch(`${BASE}/ai/chat/stream`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${adminToken}`,
              'X-Test-Ai-Url': `http://localhost:${MOCK_AI_PORT}/stream-complete`,
            },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'complete normally' }] }),
            signal: AbortSignal.timeout(5_000),
          });
          completionStatus = completionRes.status;
          completionBody = await completionRes.text();
        } catch (err) {
          completionError = err;
        }
        const completionElapsedMs = Date.now() - completionStartedAt;

        check(
          'Streaming endpoint: deterministic completion returns 200',
          completionStatus === 200,
          `status=${completionStatus}`,
        );
        check(
          'Streaming endpoint: forwards deterministic content chunk',
          completionBody.includes('data: {"chunk":"deterministic stream chunk"}'),
          `body=${JSON.stringify(completionBody)}`,
        );
        check(
          'Streaming endpoint: forwards [DONE] and closes the client stream',
          completionError === null && completionBody.trim().endsWith('data: [DONE]'),
          `elapsedMs=${completionElapsedMs} body=${JSON.stringify(completionBody)}`,
        );
        check(
          'Streaming endpoint: deterministic completion stays within timeout',
          completionError === null && completionElapsedMs < 5_000,
          completionError?.message ?? `elapsedMs=${completionElapsedMs}`,
        );
      }

      const abortsBefore = _mockAborts;
      const totalBefore = _mockTotal;
      _streamObservedSystemPrompt = '';

      const streamController = new AbortController();
      let streamStatus = null;
      // Abort after 500 ms — well before the mock's 10-second delay fires.
      // The signal must be aborted WHILE reader.read() is still pending so that
      // the AbortError propagates and undici closes the underlying TCP socket.
      // Using Promise.race with a timer resolves BEFORE the abort and causes
      // reader.cancel() to be called instead, which does not close the socket
      // (undici keeps it in the connection pool), so the mock never sees the close.
      const abortTimer = setTimeout(() => streamController.abort(), 500);
      try {
        const streamRes = await fetch(`${BASE}/ai/chat/stream`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken}`,
            // Redirect the API server's upstream fetch to the controllable mock.
            'X-Test-Ai-Url': `http://localhost:${MOCK_AI_PORT}`,
          },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] }),
          signal: streamController.signal,
        });
        streamStatus = streamRes.status;
        if (streamRes.status === 200 && streamRes.body) {
          const reader = streamRes.body.getReader();
          // Block on read() — when abortTimer fires, the signal is aborted,
          // reader.read() throws AbortError, and undici closes the socket.
          await reader.read();
        }
      } catch (err) {
        if (err.name !== 'AbortError') fail('Streaming endpoint — unexpected error', err.message);
      } finally {
        clearTimeout(abortTimer);
        streamController.abort(); // idempotent — safe after timer fires
      }

      check(
        'Streaming endpoint: connect + early-drop returns expected status',
        streamStatus === 200 || streamStatus === 503 || streamStatus === 400,
        `status=${streamStatus}`,
      );

      // Allow time for the server-side close handler and reader.cancel() to
      // propagate through the OS TCP stack to the mock server.
      await new Promise(resolve => setTimeout(resolve, 1500));

      // The test always reaches the mock because we provisioned a key above.
      // A 200 is expected; guard defensively in case of a transient issue.
      const newTotal = _mockTotal - totalBefore;
      const newAborts = _mockAborts - abortsBefore;
      check(
        'Mock upstream received request from server',
        newTotal > 0,
        `mockRequests=${newTotal}`,
      );
      check(
        'Upstream fetch aborted when client disconnected (server AbortController works)',
        newAborts > 0,
        `mockAborts=${newAborts}`,
      );
      check(
        'Streaming endpoint: upstream system message includes saved custom prompt',
        _streamObservedSystemPrompt.includes(seededPrompt),
        `systemPromptContainsSeededPrompt=${_streamObservedSystemPrompt.includes(seededPrompt)}`,
      );

      // Distinct connection-phase case: wait only for the route's test observer to
      // confirm Express accepted the request, then abort synchronously before the
      // route proceeds to config/context work or starts its upstream AI request.
      const observedBefore = _mockObserved;
      const upstreamBeforeImmediateAbort = _mockTotal;
      const immediateController = new AbortController();
      const immediateFetch = fetch(`${BASE}/ai/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`,
          'X-Test-Ai-Url': `http://localhost:${MOCK_AI_PORT}`,
          'X-Test-Ai-Observe-Url': `http://localhost:${MOCK_AI_PORT}/observe`,
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'abort immediately' }] }),
        signal: immediateController.signal,
      });

      const observationDeadline = Date.now() + 2_000;
      while (_mockObserved === observedBefore && Date.now() < observationDeadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      check(
        'Streaming endpoint: immediate-disconnect request reached the server',
        _mockObserved > observedBefore,
        `observations=${_mockObserved - observedBefore}`,
      );
      immediateController.abort();

      let immediateAbortWasClean = false;
      try {
        await immediateFetch;
      } catch (err) {
        immediateAbortWasClean = err.name === 'AbortError';
        if (!immediateAbortWasClean) {
          fail('Streaming endpoint — immediate disconnect returned unexpected error', err.message);
        }
      }
      check(
        'Streaming endpoint: immediate disconnect aborts cleanly before first chunk',
        immediateAbortWasClean,
      );

      // Give the route time to observe the closed request and finish cleanup.
      await new Promise(resolve => setTimeout(resolve, 250));
      check(
        'Streaming endpoint: immediate disconnect skips upstream AI request',
        _mockTotal === upstreamBeforeImmediateAbort,
        `upstreamRequests=${_mockTotal - upstreamBeforeImmediateAbort}`,
      );

      // Confirm the API remains responsive immediately after the connection-phase
      // abort. Expected AbortError handling must not crash or poison the server.
      const configAfterImmediateAbort = await req('GET', '/ai/config', null, adminToken);
      check(
        'Server healthy after immediate streaming disconnect',
        configAfterImmediateAbort.status === 200,
        `status=${configAfterImmediateAbort.status}`,
      );
      check(
        'Streaming endpoint: saved AI key remains configured after disconnects',
        configAfterImmediateAbort.data?.hasApiKey === true,
        `hasApiKey=${configAfterImmediateAbort.data?.hasApiKey}`,
      );
      check(
        'Streaming endpoint: provider and custom prompt survive disconnects',
        configAfterImmediateAbort.data?.provider === seededProvider &&
          configAfterImmediateAbort.data?.systemPrompt === seededPrompt,
        `provider=${configAfterImmediateAbort.data?.provider} promptMatches=${configAfterImmediateAbort.data?.systemPrompt === seededPrompt}`,
      );
      // Exercise the failure path after the temporary row has been seeded and
      // the streaming checks have run.  The expected error is caught below so
      // the suite can verify that finally still restores the saved row.
      throw controlledStreamingFailure;
    } catch (streamingErr) {
      if (streamingErr === controlledStreamingFailure) {
        controlledStreamingFailureObserved = true;
        pass('Streaming endpoint: controlled failure reached cleanup');
      } else {
        fail(
          'Streaming endpoint: unexpected streaming-check failure',
          streamingErr?.message?.slice(0, 150) ?? String(streamingErr),
        );
      }
    } finally {
      if (emptySnapshotReady) {
        try {
          await execFileAsync(tsx, [restoreScript, emptySnapshotFile, String(testRowId)]);
          pass('Streaming endpoint: removed temporary AI config and restored empty state');
        } catch (restoreErr) {
          fail(
            'Streaming endpoint: failed to restore empty AI configuration',
            restoreErr?.message?.slice(0, 150) ?? String(restoreErr),
          );
        }

        // The real restore above leaves the database safe before this
        // deliberate failure.  The missing file exercises the failure branch
        // without leaving the temporary encrypted test key behind.
        try {
          await execFileAsync(
            tsx,
            [restoreScript, join(snapshotDir, 'missing-ai-config-snapshot.json'), String(testRowId)],
          );
          fail('Streaming endpoint: forced restore failure unexpectedly succeeded');
        } catch (forcedRestoreErr) {
          forcedRestoreFailureObserved = true;
          pass(
            'Streaming endpoint: forced restore failure was reported before snapshot cleanup',
            forcedRestoreErr?.message?.slice(0, 150) ?? String(forcedRestoreErr),
          );
        }
      }
    }

    check(
      'Streaming endpoint: failed check exercised restoration cleanup',
      controlledStreamingFailureObserved,
    );
    check(
      'Streaming endpoint: forced restore failure exercised cleanup handling',
      emptySnapshotReady && forcedRestoreFailureObserved,
    );
    try {
      const configAfterFailedStreamingCheck = await req('GET', '/ai/config', null, adminToken);
      check(
        'Streaming endpoint: temporary AI config row is gone after failed-check cleanup',
        configAfterFailedStreamingCheck.status === 200 &&
          configAfterFailedStreamingCheck.data?.id === 0,
        `status=${configAfterFailedStreamingCheck.status} id=${configAfterFailedStreamingCheck.data?.id}`,
      );
      check(
        'Streaming endpoint: default masked API key state restored after failure',
        configAfterFailedStreamingCheck.status === 200 &&
          configAfterFailedStreamingCheck.data?.hasApiKey === false &&
          configAfterFailedStreamingCheck.data?.hasApiKey === defaultAiConfig?.hasApiKey,
        `expectedDefault=${defaultAiConfig?.hasApiKey} actual=${configAfterFailedStreamingCheck.data?.hasApiKey}`,
      );
      check(
        'Streaming endpoint: default provider restored after failure',
        configAfterFailedStreamingCheck.status === 200 &&
          configAfterFailedStreamingCheck.data?.provider === 'openai' &&
          configAfterFailedStreamingCheck.data?.provider === defaultAiConfig?.provider,
        `expectedDefault=${defaultAiConfig?.provider} actual=${configAfterFailedStreamingCheck.data?.provider}`,
      );
      check(
        'Streaming endpoint: default prompt restored after failure',
        configAfterFailedStreamingCheck.status === 200 &&
          typeof defaultAiConfig?.systemPrompt === 'string' &&
          configAfterFailedStreamingCheck.data?.systemPrompt === defaultAiConfig.systemPrompt,
        `promptMatchesDefault=${configAfterFailedStreamingCheck.data?.systemPrompt === defaultAiConfig?.systemPrompt}`,
      );
    } finally {
      try {
        if (snapshotReady) {
          await execFileAsync(tsx, [restoreScript, snapshotFile, String(testRowId)]);
          pass('Streaming endpoint: restored original AI configuration');
          const configAfterOriginalRestore = await req('GET', '/ai/config', null, adminToken);
          check(
            'Streaming endpoint: original AI config row identity restored',
            configAfterOriginalRestore.status === 200 &&
              configAfterOriginalRestore.data?.id === originalAiConfig.id,
            `expected=${originalAiConfig.id} actual=${configAfterOriginalRestore.data?.id}`,
          );
          check(
            'Streaming endpoint: original masked API key state restored',
            configAfterOriginalRestore.status === 200 &&
              configAfterOriginalRestore.data?.hasApiKey === originalAiConfig.hasApiKey,
            `expected=${originalAiConfig.hasApiKey} actual=${configAfterOriginalRestore.data?.hasApiKey}`,
          );
          check(
            'Streaming endpoint: original provider restored',
            configAfterOriginalRestore.status === 200 &&
              configAfterOriginalRestore.data?.provider === originalAiConfig.provider,
            `expected=${originalAiConfig.provider} actual=${configAfterOriginalRestore.data?.provider}`,
          );
          check(
            'Streaming endpoint: original prompt restored',
            configAfterOriginalRestore.status === 200 &&
              configAfterOriginalRestore.data?.systemPrompt === originalAiConfig.systemPrompt,
            `promptMatchesOriginal=${configAfterOriginalRestore.data?.systemPrompt === originalAiConfig.systemPrompt}`,
          );
          check(
            'Streaming endpoint: original config update time restored',
            configAfterOriginalRestore.status === 200 &&
              (originalAiConfig.id === 0 ||
                configAfterOriginalRestore.data?.updatedAt === originalAiConfig.updatedAt),
            `expected=${originalAiConfig.updatedAt} actual=${configAfterOriginalRestore.data?.updatedAt}`,
          );
        }
      } catch (restoreErr) {
        fail(
          'Streaming endpoint: failed to restore original AI configuration',
          restoreErr?.message?.slice(0, 150) ?? String(restoreErr),
        );
      } finally {
        rmSync(snapshotDir, { recursive: true, force: true });
      }
    }

    check(
      'Streaming endpoint: temporary snapshot file removed after restore failure',
      !existsSync(snapshotFile),
      `exists=${existsSync(snapshotFile)}`,
    );
    check(
      'Streaming endpoint: temporary snapshot directory removed after restore failure',
      !existsSync(snapshotDir),
      `exists=${existsSync(snapshotDir)}`,
    );
  }

  // Brief pause so any in-flight server cleanup finishes before health check.
  await new Promise(resolve => setTimeout(resolve, 150));

  // 7f: server must still be healthy after the dropped stream connection
  r = await req('GET', '/ai/config', null, adminToken);
  check('Server healthy after dropped stream connection', r.status === 200, `status=${r.status}`);

  // 7g: AI chat — store with NO recent sessions (empty inventory context)
  //
  // Scenario: a brand-new store has never had a finalized session in the last
  // 14 days.  buildChatContext() must not throw, the endpoint must not 500,
  // and when the AI is configured it must return a coherent answer that
  // acknowledges the data gap rather than fabricating stock levels.
  {
    r = await req('POST', '/stores', {
      name: 'No-Data AI Test Store',
      storeNumber: 'NDT-E2E',
      city: 'Portland',
      state: 'OR',
    }, adminToken);
    const ndtStoreId = r.data?.id;
    check(
      '7g: create fresh store with no sessions',
      r.status === 201 && typeof ndtStoreId === 'number',
      `status=${r.status} id=${ndtStoreId}`,
    );

    if (ndtStoreId) {
      // Send a chat message scoped to the empty store.  The test provider
      // inspects the generated system context so this verifies the route does
      // not turn missing stock data into a positive alert result.
      await startMockAiServer();
      r = await req('POST', '/ai/chat', {
        messages: [{ role: 'user', content: 'What is the current inventory status at this store?' }],
        storeId: ndtStoreId,
      }, adminToken, 60_000, {
        'X-Test-Ai-Url': `http://localhost:${MOCK_AI_PORT}/chat`,
      });

      check(
        '7g: empty-store chat does not return a 500 (context build succeeds)',
        r.status !== 500,
        `status=${r.status}`,
      );

      if (r.status === 200) {
        const reply = r.data?.message ?? '';
        check(
          '7g: AI reply is a non-empty string',
          typeof reply === 'string' && reply.trim().length > 0,
          `replyLength=${reply.length}`,
        );
        // The system prompt instructs the AI to say so when data is unavailable.
        // We accept any response that does NOT appear to invent specific stock
        // numbers while acknowledging the absence of sessions.  A lightweight
        // heuristic: the reply must not claim there is data when the context
        // explicitly contains "None found in the last 14 days".
        //
        // We check for common "no-data" signals rather than an exact phrase
        // because different AI providers word their refusals differently.
        const lower = reply.toLowerCase();
        const mentionsNoData =
          lower.includes('no session') ||
          lower.includes('no recent') ||
          lower.includes('no inventory') ||
          lower.includes('no data') ||
          lower.includes('no finalized') ||
          lower.includes('unavailable') ||
          lower.includes('not available') ||
          lower.includes('no records') ||
          lower.includes("haven't") ||
          lower.includes('have not') ||
          lower.includes('none') ||
          lower.includes('cannot find') ||
          lower.includes("can't find") ||
          lower.includes('no information');
        check(
          '7g: AI reply acknowledges missing data (does not hallucinate stock levels)',
          mentionsNoData,
          `replySnippet="${reply.slice(0, 120)}"`,
        );
      } else if (r.status === 503) {
        pass('7g: AI not configured — empty-store chat correctly blocked (503)', `error=${r.data?.error}`);
      } else if (r.status === 502) {
        pass('7g: provider error on empty-store chat (502) — context build itself succeeded', `error=${r.data?.error}`);
      } else {
        fail('7g: unexpected status for empty-store chat', `status=${r.status} body=${JSON.stringify(r.data)}`);
      }

      // 7h: the streaming endpoint must also handle a store with no recent
      // finalized sessions.  Use a bounded fetch so a regression after
      // flushHeaders() cannot hang the entire e2e suite.
      {
        const streamController = new AbortController();
        const streamTimeout = setTimeout(() => streamController.abort(), 15_000);
        let streamStatus = null;
        try {
          const streamRes = await fetch(`${BASE}/ai/chat/stream`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              messages: [{ role: 'user', content: 'What is the current inventory status at this store?' }],
              storeId: ndtStoreId,
            }),
            signal: streamController.signal,
          });
          streamStatus = streamRes.status;

          // The status and headers are the assertion for this SSE smoke test.
          // Cancel the body immediately so a configured provider cannot make
          // the test wait for a complete AI response.
          if (streamRes.body) await streamRes.body.cancel();
        } catch (err) {
          if (err.name === 'AbortError') {
            fail('7h: empty-store streaming chat did not respond before timeout');
          } else {
            fail('7h: empty-store streaming chat request failed', err.message);
          }
        } finally {
          clearTimeout(streamTimeout);
        }

        check(
          '7h: empty-store streaming chat returns 200 or expected 503',
          streamStatus === 200 || streamStatus === 503,
          `status=${streamStatus}`,
        );
        if (streamStatus === 200) {
          pass('7h: streaming chat connected for store with no recent sessions');
        } else if (streamStatus === 503) {
          pass('7h: AI not configured — empty-store streaming chat correctly blocked (503)');
        }
      }
    }
  }
}

async function testAiChatStaleSession() {
  section('FLOW 7i — AI Chat: historical data outside the 14-day window');

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const execFileAsync = promisify(execFile);
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const tsx = join(scriptsDir, 'node_modules', '.bin', 'tsx');
  const snapshotScript = join(scriptsDir, 'snapshot-ai-config.ts');
  const restoreScript = join(scriptsDir, 'restore-ai-config.ts');
  const snapshotDir = mkdtempSync(join(tmpdir(), 'e2e-ai-stale-'));
  const snapshotFile = join(snapshotDir, 'ai-config-snapshot.json');
  let snapshotReady = false;
  let testRowId = 0;

  try {
    // The stale context assertions must run even when the test environment has
    // no provider credentials. Preserve the exact encrypted config row, then
    // use a harmless dummy key with the local mock provider endpoint.
    await execFileAsync(tsx, [snapshotScript, snapshotFile]);
    snapshotReady = true;
    pass('7i: original AI configuration snapshotted');

    const putResult = await req(
      'PUT',
      '/ai/config',
      {
        provider: 'grok',
        systemPrompt: 'Stale-session E2E context validation prompt.',
        apiKey: 'e2e-stale-session-test-key',
      },
      adminToken,
    );
    testRowId = putResult.data?.id ?? 0;
    check(
      '7i: seeded temporary AI config for stale-session checks',
      putResult.status === 200 &&
        putResult.data?.hasApiKey === true &&
        putResult.data?.provider === 'grok',
      `status=${putResult.status} hasApiKey=${putResult.data?.hasApiKey}`,
    );

    let r;

    // Scenario: a store has a finalized session with a real inventory item, but
    // that session was finalized 21 days ago. buildChatContext() must exclude
    // it from the live snapshot rather than presenting stale stock as current.
    {
      r = await req('POST', '/stores', {
        name: 'Stale Data AI Test Store',
        storeNumber: 'STL-E2E',
        city: 'Portland',
        state: 'OR',
      }, adminToken);
      const staleStoreId = r.data?.id;
      check(
        '7i: create store for stale-session chat',
        r.status === 201 && typeof staleStoreId === 'number',
        `status=${r.status} id=${staleStoreId}`,
      );

      if (staleStoreId && testProductId) {
        r = await req('POST', '/inventory-sessions', {
          storeId: staleStoreId,
          notes: 'E2E test stale AI session',
        }, adminToken);
        const staleSessionId = r.data?.id;
        check(
          '7i: create historical inventory session',
          r.status === 201 && typeof staleSessionId === 'number',
          `status=${r.status} id=${staleSessionId}`,
        );

        if (staleSessionId) {
          r = await req('PUT', `/inventory-sessions/${staleSessionId}/items`, {
            items: [{
              productId: testProductId,
              fullContainers: 4,
              partialContainers: 0,
              estimatedGallons: '42.000',
              comments: 'Historical-only stock for stale AI context test',
            }],
          }, adminToken);
          check(
            '7i: save item in historical session before backdating',
            r.status === 200 && r.data?.some(item => item.productId === testProductId),
            `status=${r.status} itemCount=${r.data?.length}`,
          );

          r = await req('POST', `/inventory-sessions/${staleSessionId}/finalize`, {}, adminToken);
          check(
            '7i: finalize historical inventory session',
            r.status === 200 && r.data?.status === 'finalized',
            `status=${r.status} finalStatus=${r.data?.status}`,
          );

          await execFileAsync(
            tsx,
            [join(scriptsDir, 'backdate-e2e-session.ts'), String(staleSessionId)],
            { env: process.env },
          );

          r = await req('GET', `/inventory-sessions/${staleSessionId}`, null, adminToken);
          const backdatedAt = r.data?.finalizedAt ? new Date(r.data.finalizedAt).getTime() : NaN;
          check(
            '7i: historical session is outside the 14-day chat window',
            r.status === 200 && Number.isFinite(backdatedAt) &&
              backdatedAt < Date.now() - 14 * 86_400_000,
            `status=${r.status} finalizedAt=${r.data?.finalizedAt}`,
          );

          await startMockAiServer();
          r = await req('POST', '/ai/chat', {
            messages: [{
              role: 'user',
              content: 'What is the current inventory status at this store? Only use counts from the last 14 days.',
            }],
            storeId: staleStoreId,
          }, adminToken, 60_000, {
            'X-Test-Ai-Url': `http://localhost:${MOCK_AI_PORT}/chat`,
          });

          check(
            '7i: stale-session chat returns the deterministic mock response',
            r.status === 200,
            `status=${r.status}`,
          );

          if (r.status === 200) {
            const reply = r.data?.message ?? '';
            check(
              '7i: AI reply is a non-empty string',
              typeof reply === 'string' && reply.trim().length > 0,
              `replyLength=${reply.length}`,
            );

            const lower = reply.toLowerCase();
            const acknowledgesStaleWindow =
              lower.includes('last 14') ||
              lower.includes('14-day') ||
              lower.includes('14 day') ||
              lower.includes('no recent') ||
              lower.includes('no session') ||
              lower.includes('no data') ||
              lower.includes('unavailable') ||
              lower.includes('not available') ||
              lower.includes('no records') ||
              lower.includes('cannot find') ||
              lower.includes("can't find") ||
              lower.includes('historical') ||
              lower.includes('stale');
            check(
              '7i: AI acknowledges stale/missing 14-day data instead of presenting old stock as current',
              acknowledgesStaleWindow,
              `replySnippet="${reply.slice(0, 160)}"`,
            );
          } else {
            fail('7i: unexpected status for stale-session chat', `status=${r.status} body=${JSON.stringify(r.data)}`);
          }

          // The streaming route builds the same inventory context through a
          // separate request path. Read the complete SSE response so the test
          // verifies both that the request is store-scoped and that stale stock
          // is not presented as current in the streamed content.
          let streamStatus = null;
          let streamBody = '';
          let streamError = null;
          try {
            const streamRes = await fetch(`${BASE}/ai/chat/stream`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${adminToken}`,
                'X-Test-Ai-Url': `http://localhost:${MOCK_AI_PORT}/stream-stale-chat`,
              },
              body: JSON.stringify({
                messages: [{
                  role: 'user',
                  content: 'What is the current inventory status at this store? Only use counts from the last 14 days.',
                }],
                storeId: staleStoreId,
              }),
              signal: AbortSignal.timeout(15_000),
            });
            streamStatus = streamRes.status;
            streamBody = await streamRes.text();
          } catch (err) {
            streamError = err;
          }

          check(
            '7i: stale-session streaming chat returns 200',
            streamStatus === 200,
            `status=${streamStatus}`,
          );
          check(
            '7i: stale-session streaming chat completes without timing out',
            streamError === null && streamBody.trim().endsWith('data: [DONE]'),
            streamError?.message ?? `body=${JSON.stringify(streamBody)}`,
          );
          const streamedLower = streamBody.toLowerCase();
          const streamedAcknowledgesUnavailable =
            streamedLower.includes('unavailable') ||
            streamedLower.includes('no finalized') ||
            streamedLower.includes('no recent') ||
            streamedLower.includes('no data') ||
            streamedLower.includes('not available');
          check(
            '7i: streaming chat acknowledges missing 14-day data',
            streamStatus === 200 && streamedAcknowledgesUnavailable,
            `body=${JSON.stringify(streamBody.slice(0, 240))}`,
          );
          check(
            '7i: streaming chat does not present stale stock as current',
            streamStatus === 200 &&
              !streamedLower.includes('current stock data is available') &&
              !streamedLower.includes('42.0'),
            `body=${JSON.stringify(streamBody.slice(0, 240))}`,
          );

          // Scenario: two stores both have recent finalized inventory, but the
          // streaming request is scoped to only one of them. The deterministic
          // provider inspects the generated system prompt and echoes a leak if
          // the other store's product or stock value is present.
          {
            const scopedTargetProductName = 'Scoped Target Chemical';
            const scopedOtherProductName = 'Scoped Other Store Chemical';
            const scopedTargetStock = '17.250';
            const scopedOtherStock = '987.650';
            _scopedTargetProductName = scopedTargetProductName;
            _scopedOtherProductName = scopedOtherProductName;
            _scopedTargetStock = scopedTargetStock;
            _scopedOtherStock = scopedOtherStock;
            _scopedObservedContext = '';

            r = await req('POST', '/stores', {
              name: 'Scoped Chat Target Store',
              storeNumber: 'SCP-A-E2E',
              city: 'Portland',
              state: 'OR',
            }, adminToken);
            const scopedTargetStoreId = r.data?.id;
            check(
              '7i: create target store for scoped streaming chat',
              r.status === 201 && typeof scopedTargetStoreId === 'number',
              `status=${r.status} id=${scopedTargetStoreId}`,
            );

            r = await req('POST', '/stores', {
              name: 'Scoped Chat Other Store',
              storeNumber: 'SCP-B-E2E',
              city: 'Portland',
              state: 'OR',
            }, adminToken);
            const scopedOtherStoreId = r.data?.id;
            check(
              '7i: create other store for scoped streaming chat',
              r.status === 201 && typeof scopedOtherStoreId === 'number',
              `status=${r.status} id=${scopedOtherStoreId}`,
            );

            r = await req('POST', '/products', {
              name: scopedTargetProductName,
              productNumber: 'SCP-TARGET-E2E',
              unit: 'gallon',
            }, adminToken);
            const scopedTargetProductId = r.data?.id;
            check(
              '7i: create target product for scoped streaming chat',
              r.status === 201 && typeof scopedTargetProductId === 'number',
              `status=${r.status} id=${scopedTargetProductId}`,
            );

            r = await req('POST', '/products', {
              name: scopedOtherProductName,
              productNumber: 'SCP-OTHER-E2E',
              unit: 'gallon',
            }, adminToken);
            const scopedOtherProductId = r.data?.id;
            check(
              '7i: create other-store product for scoped streaming chat',
              r.status === 201 && typeof scopedOtherProductId === 'number',
              `status=${r.status} id=${scopedOtherProductId}`,
            );

            if (
              scopedTargetStoreId &&
              scopedOtherStoreId &&
              scopedTargetProductId &&
              scopedOtherProductId
            ) {
              for (const [storeId, productId, stock, label] of [
                [scopedTargetStoreId, scopedTargetProductId, scopedTargetStock, 'target'],
                [scopedOtherStoreId, scopedOtherProductId, scopedOtherStock, 'other'],
              ]) {
                r = await req('POST', '/inventory-sessions', {
                  storeId,
                  notes: `E2E test scoped stream ${label} session`,
                }, adminToken);
                const sessionId = r.data?.id;
                check(
                  `7i: create ${label} recent inventory session`,
                  r.status === 201 && typeof sessionId === 'number',
                  `status=${r.status} id=${sessionId}`,
                );

                if (sessionId) {
                  r = await req('PUT', `/inventory-sessions/${sessionId}/items`, {
                    items: [{
                      productId,
                      fullContainers: 1,
                      partialContainers: 0,
                      estimatedGallons: stock,
                    }],
                  }, adminToken);
                  check(
                    `7i: save ${label} recent inventory item`,
                    r.status === 200 && r.data?.some(item => item.productId === productId),
                    `status=${r.status} itemCount=${r.data?.length}`,
                  );

                  r = await req('POST', `/inventory-sessions/${sessionId}/finalize`, {}, adminToken);
                  check(
                    `7i: finalize ${label} recent inventory session`,
                    r.status === 200 && r.data?.status === 'finalized',
                    `status=${r.status} finalStatus=${r.data?.status}`,
                  );
                }
              }

              await startMockAiServer();
              let scopedStreamStatus = null;
              let scopedStreamBody = '';
              let scopedStreamError = null;
              try {
                const scopedStreamRes = await fetch(`${BASE}/ai/chat/stream`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${adminToken}`,
                    'X-Test-Ai-Url': `http://localhost:${MOCK_AI_PORT}/stream-scoped-chat`,
                  },
                  body: JSON.stringify({
                    messages: [{
                      role: 'user',
                      content: 'What is the current inventory for this store?',
                    }],
                    storeId: scopedTargetStoreId,
                  }),
                  signal: AbortSignal.timeout(15_000),
                });
                scopedStreamStatus = scopedStreamRes.status;
                scopedStreamBody = await scopedStreamRes.text();
              } catch (err) {
                scopedStreamError = err;
              }

              const scopedResponseHasOtherStoreData =
                scopedStreamBody.includes(scopedOtherProductName) ||
                scopedStreamBody.includes(scopedOtherStock);
              check(
                '7i: scoped streaming chat returns 200',
                scopedStreamStatus === 200,
                `status=${scopedStreamStatus}`,
              );
              check(
                '7i: scoped streaming provider observed only target inventory',
                scopedStreamError === null &&
                  _scopedObservedContext.includes(scopedTargetProductName) &&
                  _scopedObservedContext.includes(scopedTargetStock) &&
                  !_scopedObservedContext.includes(scopedOtherProductName) &&
                  !_scopedObservedContext.includes(scopedOtherStock),
                scopedStreamError?.message ?? `context=${JSON.stringify(_scopedObservedContext.slice(0, 320))}`,
              );
              check(
                '7i: scoped streaming response excludes other store inventory',
                scopedStreamStatus === 200 &&
                  !scopedResponseHasOtherStoreData &&
                  scopedStreamBody.trim().endsWith('data: [DONE]'),
                `body=${JSON.stringify(scopedStreamBody.slice(0, 320))}`,
              );

              // A store with no recent finalized sessions must not inherit the
              // catalog or stock from either populated store in its context.
              r = await req('POST', '/stores', {
                name: 'Scoped Chat Empty Store',
                storeNumber: 'SCP-EMPTY-E2E',
                city: 'Portland',
                state: 'OR',
              }, adminToken);
              const scopedEmptyStoreId = r.data?.id;
              check(
                '7i: create empty store alongside stores with recent inventory',
                r.status === 201 && typeof scopedEmptyStoreId === 'number',
                `status=${r.status} id=${scopedEmptyStoreId}`,
              );

              if (scopedEmptyStoreId) {
                _scopedObservedContext = '';
                let emptyScopedStreamStatus = null;
                let emptyScopedStreamBody = '';
                let emptyScopedStreamError = null;
                try {
                  const emptyScopedStreamRes = await fetch(`${BASE}/ai/chat/stream`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${adminToken}`,
                      'X-Test-Ai-Url': `http://localhost:${MOCK_AI_PORT}/stream-empty-scoped-chat`,
                    },
                    body: JSON.stringify({
                      messages: [{
                        role: 'user',
                        content: 'What is the current inventory for this store?',
                      }],
                      storeId: scopedEmptyStoreId,
                    }),
                    signal: AbortSignal.timeout(15_000),
                  });
                  emptyScopedStreamStatus = emptyScopedStreamRes.status;
                  emptyScopedStreamBody = await emptyScopedStreamRes.text();
                } catch (err) {
                  emptyScopedStreamError = err;
                }

                const populatedStoreValues = [
                  scopedTargetProductName,
                  scopedTargetStock,
                  scopedOtherProductName,
                  scopedOtherStock,
                ];
                const emptyScopedStreamContainsPopulatedStoreData =
                  populatedStoreValues.some((value) =>
                    _scopedObservedContext.includes(value) || emptyScopedStreamBody.includes(value),
                  );
                check(
                  '7i: empty-store streaming provider sees unavailable inventory and no populated-store data',
                  emptyScopedStreamStatus === 200 &&
                    emptyScopedStreamError === null &&
                    _scopedObservedContext.includes('STOCK ALERTS: Unavailable — no current stock snapshot exists') &&
                    _scopedObservedContext.includes('RECENT SESSIONS: None found in the last 14 days.') &&
                    !emptyScopedStreamContainsPopulatedStoreData,
                  emptyScopedStreamError?.message ??
                    `status=${emptyScopedStreamStatus} context=${JSON.stringify(_scopedObservedContext.slice(0, 360))}`,
                );
                check(
                  '7i: empty-store streamed answer contains no populated-store product or stock values',
                  emptyScopedStreamStatus === 200 &&
                    emptyScopedStreamBody.includes('current stock is unavailable') &&
                    !emptyScopedStreamContainsPopulatedStoreData &&
                    emptyScopedStreamBody.trim().endsWith('data: [DONE]'),
                  `status=${emptyScopedStreamStatus} body=${JSON.stringify(emptyScopedStreamBody.slice(0, 360))}`,
                );
              }

              // An admin chat request without storeId must keep the intentional
              // all-store context. The local provider captures the actual system
              // message so this checks prompt contents, not just the API response.
              _unscopedObservedContext = '';
              const unscopedChat = await req('POST', '/ai/chat', {
                messages: [{
                  role: 'user',
                  content: 'Summarize current stock across all stores.',
                }],
              }, adminToken, 60_000, {
                'X-Test-Ai-Url': `http://localhost:${MOCK_AI_PORT}/chat-unscoped`,
              });
              check(
                '7i: unscoped admin chat returns the deterministic mock response',
                unscopedChat.status === 200 &&
                  unscopedChat.data?.message === 'Deterministic unscoped inventory context received.',
                `status=${unscopedChat.status} message=${unscopedChat.data?.message}`,
              );
              check(
                '7i: unscoped chat provider observes both stores and their distinct stock',
                _unscopedObservedContext.includes('Scope: all stores') &&
                  _unscopedObservedContext.includes('Scoped Chat Target Store') &&
                  _unscopedObservedContext.includes('Scoped Chat Other Store') &&
                  _unscopedObservedContext.includes(`${scopedTargetProductName}: 17.3 gallon`) &&
                  _unscopedObservedContext.includes(`${scopedOtherProductName}: 987.6 gallon`),
                `context=${JSON.stringify(_unscopedObservedContext.slice(0, 600))}`,
              );
            }
          }
        }
      } else if (!testProductId) {
        fail('7i: stale-session chat skipped — no product available for historical item');
      }
    }
  } finally {
    try {
      if (snapshotReady) {
        try {
          await execFileAsync(tsx, [restoreScript, snapshotFile, String(testRowId)]);
          pass('7i: restored original AI configuration');
        } catch (restoreErr) {
          fail(
            '7i: failed to restore original AI configuration',
            restoreErr?.message?.slice(0, 150) ?? String(restoreErr),
          );
        }
      }
    } finally {
      rmSync(snapshotDir, { recursive: true, force: true });
    }
  }
}

// ─── FLOW 7a: AI snapshot helper failure paths ───────────────────────────────
//
// These child-process checks deliberately break each kind of snapshot-helper
// I/O involved in cleanup.  A helper that leaves its pg pool open would cause
// execFileAsync to hit the timeout instead of returning the expected failure,
// which would otherwise hang the E2E cleanup path.

async function testAiSnapshotFailureExit() {
  section('FLOW 7a — AI snapshot helpers: failure paths exit cleanly');

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const { existsSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const execFileAsync = promisify(execFile);
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const tsx = join(scriptsDir, 'node_modules', '.bin', 'tsx');
  const snapshotScript = join(scriptsDir, 'snapshot-ai-config.ts');
  const restoreScript = join(scriptsDir, 'restore-ai-config.ts');
  const snapshotDir = mkdtempSync(join(tmpdir(), 'e2e-ai-failure-'));
  const snapshotFile = join(snapshotDir, 'snapshot.json');
  const validSnapshotFile = join(snapshotDir, 'valid-snapshot.json');
  const failingDatabaseUrl = 'postgresql://127.0.0.1:1/task156-failure';
  const childEnv = { ...process.env, NODE_ENV: 'test' };

  async function expectPromptFailure(label, script, args, env = childEnv) {
    const startedAt = Date.now();
    try {
      await execFileAsync(tsx, [script, ...args], {
        env,
        timeout: 5_000,
        killSignal: 'SIGKILL',
      });
      fail(`${label}: exits with failure status`, 'helper unexpectedly succeeded');
      return;
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const timedOut = error?.code === 'ETIMEDOUT' || error?.killed === true;
      check(
        `${label}: exits with failure status`,
        !timedOut && typeof error?.code === 'number' && error.code !== 0,
        `status=${error?.code ?? error?.signal ?? 'unknown'} elapsedMs=${elapsedMs}`,
      );
      check(
        `${label}: exits before cleanup timeout`,
        !timedOut && elapsedMs < 5_000,
        `elapsedMs=${elapsedMs}`,
      );
    }
  }

  try {
    await expectPromptFailure(
      'Snapshot query failure',
      snapshotScript,
      [snapshotFile],
      { ...childEnv, DATABASE_URL: failingDatabaseUrl },
    );
    check(
      'Snapshot query failure: no partial snapshot was written',
      !existsSync(snapshotFile),
      `exists=${existsSync(snapshotFile)}`,
    );

    await expectPromptFailure(
      'Snapshot write failure',
      snapshotScript,
      [join(snapshotDir, 'missing-parent', 'snapshot.json')],
    );

    writeFileSync(validSnapshotFile, JSON.stringify({ exists: false, row: null }), 'utf8');
    await expectPromptFailure(
      'Restore query failure',
      restoreScript,
      [validSnapshotFile, '123'],
      { ...childEnv, DATABASE_URL: failingDatabaseUrl },
    );

    await expectPromptFailure(
      'Restore file-read failure',
      restoreScript,
      [join(snapshotDir, 'missing-snapshot.json'), '123'],
    );
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
}

// ─── FLOW 8: Usage summary — no-prior-session and with-prior-session ─────────

async function testUsageSummaryFlow() {
  section('FLOW 8 — Usage summary: no-prior-session and with-prior-session');

  if (!testProductId) { fail('Usage summary test skipped — no product id'); return; }

  // Create a dedicated store with no history so the first session is truly the
  // first-ever finalized session for that store.
  let r = await req('POST', '/stores', {
    name: 'Usage Test Store',
    storeNumber: 'USG-E2E',
    city: 'Test City',
    state: 'OR',
  }, adminToken);
  check('Create usage test store', r.status === 201, `status=${r.status}`);
  const usageStoreId = r.data?.id;
  if (!usageStoreId) { fail('Cannot run usage tests — store creation failed'); return; }

  // ── Case A: No prior finalized session ──────────────────────────────────────

  // Create the very first session for this store
  r = await req('POST', '/inventory-sessions', {
    storeId: usageStoreId,
    notes: 'E2E test usage A',
  }, adminToken);
  check('Case A: create first session (no prior)', r.status === 201, `status=${r.status}`);
  const sessionAId = r.data?.id;
  if (!sessionAId) { fail('Cannot continue — session A creation failed'); return; }

  // Count: 5 full containers, no estimatedGallons → currentCount = "5"
  r = await req('PUT', `/inventory-sessions/${sessionAId}/items`, {
    items: [{ productId: testProductId, fullContainers: 5, partialContainers: 0 }],
  }, adminToken);
  check('Case A: save items (5 full containers)', r.status === 200, `count=${r.data?.length}`);

  // Receive 8 units *after* session start (receivedAt = now > startedAt)
  r = await req('POST', '/receiving-records', {
    storeId: usageStoreId,
    vendor: 'Acme Chemical Co.',
    invoiceNumber: 'USG-INV-A',
    items: [{ productId: testProductId, quantityReceived: '8', lotNumber: 'LOT-USG-A', cost: '20.00' }],
  }, adminToken);
  check('Case A: log delivery (8 units)', r.status === 201, `status=${r.status}`);

  // Finalize — usage = max(0, 0 + 8 - 5) = 3.000
  r = await req('POST', `/inventory-sessions/${sessionAId}/finalize`, {}, adminToken);
  check('Case A: finalize first session', r.status === 200, `status=${r.status}`);

  const summaryA = r.data?.usageSummary;
  const itemA = summaryA?.find(i => i.productId === testProductId);
  const expectedUsageA = Math.max(0, 0 + 8 - 5).toFixed(3);

  check(
    'Case A (no-prior): previousCount is "0"',
    itemA?.previousCount === '0',
    `previousCount=${itemA?.previousCount}`,
  );
  check(
    'Case A (no-prior): received equals delivered quantity',
    parseFloat(itemA?.received ?? '-1') === 8,
    `received=${itemA?.received}`,
  );
  check(
    'Case A (no-prior): usage = 0 + received − currentCount',
    itemA?.usage === expectedUsageA,
    `usage=${itemA?.usage} expected=${expectedUsageA}`,
  );

  // Also verify the GET endpoint returns the same figures after finalization
  r = await req('GET', `/inventory-sessions/${sessionAId}`, null, adminToken);
  const getItemA = r.data?.usageSummary?.find(i => i.productId === testProductId);
  check(
    'Case A (no-prior): GET returns consistent usageSummary',
    getItemA?.usage === expectedUsageA && getItemA?.previousCount === '0',
    `usage=${getItemA?.usage} previousCount=${getItemA?.previousCount}`,
  );

  // ── Case B: Prior finalized session exists ───────────────────────────────────
  // Session A is now the most-recent finalized session; its finalizedAt is the
  // new window start.  Any receiving records created BEFORE session A was
  // finalized (i.e., the case-A delivery) must NOT appear in session B's totals.

  r = await req('POST', '/inventory-sessions', {
    storeId: usageStoreId,
    notes: 'E2E test usage B',
  }, adminToken);
  check('Case B: create second session (has prior)', r.status === 201, `status=${r.status}`);
  const sessionBId = r.data?.id;
  if (!sessionBId) { fail('Cannot continue — session B creation failed'); return; }

  // Count: 2 full containers
  r = await req('PUT', `/inventory-sessions/${sessionBId}/items`, {
    items: [{ productId: testProductId, fullContainers: 2, partialContainers: 0 }],
  }, adminToken);
  check('Case B: save items (2 full containers)', r.status === 200, `count=${r.data?.length}`);

  // Receive 4 units *after* session A was finalized (receivedAt = now > finalizedAt of A)
  r = await req('POST', '/receiving-records', {
    storeId: usageStoreId,
    vendor: 'Acme Chemical Co.',
    invoiceNumber: 'USG-INV-B',
    items: [{ productId: testProductId, quantityReceived: '4', lotNumber: 'LOT-USG-B', cost: '10.00' }],
  }, adminToken);
  check('Case B: log delivery (4 units)', r.status === 201, `status=${r.status}`);

  // Finalize — previousCount = 5 (from session A), received = 4 (only post-A delivery)
  // usage = max(0, 5 + 4 - 2) = 7.000
  r = await req('POST', `/inventory-sessions/${sessionBId}/finalize`, {}, adminToken);
  check('Case B: finalize second session', r.status === 200, `status=${r.status}`);

  const summaryB = r.data?.usageSummary;
  const itemB = summaryB?.find(i => i.productId === testProductId);
  const expectedPrevB = 5;   // fullContainers from session A
  const expectedRecvB = 4;   // only the post-A delivery
  const expectedUsageB = Math.max(0, expectedPrevB + expectedRecvB - 2).toFixed(3);

  check(
    'Case B (with-prior): previousCount matches prior session',
    parseFloat(itemB?.previousCount ?? '-1') === expectedPrevB,
    `previousCount=${itemB?.previousCount} expected=${expectedPrevB}`,
  );
  check(
    'Case B (with-prior): received excludes pre-prior deliveries',
    parseFloat(itemB?.received ?? '-1') === expectedRecvB,
    `received=${itemB?.received} expected=${expectedRecvB}`,
  );
  check(
    'Case B (with-prior): usage = prev + received − currentCount',
    itemB?.usage === expectedUsageB,
    `usage=${itemB?.usage} expected=${expectedUsageB}`,
  );
}

// ─── FLOW 10: Usage summary panel — >5 products, zero-usage filtering ────────
//
// Verifies that the data returned by the API is structurally correct for the
// mobile usage summary panel logic in artifacts/mobile/app/inventory/[id].tsx:
//   • nonZero  = usageSummary.filter(u => parseFloat(u.usage) > 0)
//   • zeroItems = usageSummary.filter(u => parseFloat(u.usage) <= 0)
//   • hasMore  = nonZero.length > 5  → "Show all" button appears
//
// We cannot drive the React Native UI from a shell script, so we assert the
// *API response shape* that the mobile component depends on.

async function testUsageSummaryPanelFlow() {
  section('FLOW 10 — Usage summary panel: >5 products, zero-usage filtering');

  // Create an isolated store so session history is clean.
  let r = await req('POST', '/stores', {
    name: 'Panel Test Store',
    storeNumber: 'PNL-E2E',
    city: 'Panel City',
    state: 'OR',
  }, adminToken);
  check('Create panel test store', r.status === 201, `status=${r.status}`);
  const panelStoreId = r.data?.id;
  if (!panelStoreId) { fail('Cannot run panel tests — store creation failed'); return; }

  // Create 6 products that will have non-zero usage + 1 product with zero usage.
  // 6 non-zero > PREVIEW(5) → the "Show all" button must appear in the UI.
  const NON_ZERO_COUNT = 6;
  const nonZeroProductIds = [];
  for (let i = 1; i <= NON_ZERO_COUNT; i++) {
    r = await req('POST', '/products', {
      name: `Panel Chemical ${i}`,
      unit: 'gallon',
      productNumber: `PNL-${String(i).padStart(3, '0')}`,
    }, adminToken);
    if (r.status === 201) {
      nonZeroProductIds.push(r.data.id);
    } else {
      fail(`Create panel product ${i}`, `status=${r.status} body=${JSON.stringify(r.data)}`);
    }
  }
  check(
    `Created ${NON_ZERO_COUNT} non-zero-usage products`,
    nonZeroProductIds.length === NON_ZERO_COUNT,
    `created=${nonZeroProductIds.length}`,
  );

  // Create 1 product that will have zero usage (high starting stock, no delivery consumed).
  r = await req('POST', '/products', {
    name: 'Panel Zero Usage Chemical',
    unit: 'gallon',
    productNumber: 'PNL-ZERO',
  }, adminToken);
  check('Create zero-usage product', r.status === 201, `status=${r.status}`);
  const zeroProductId = r.data?.id;

  if (nonZeroProductIds.length === 0 || !zeroProductId) {
    fail('Panel test aborted — product creation failed');
    return;
  }

  // Create the inventory session.
  r = await req('POST', '/inventory-sessions', {
    storeId: panelStoreId,
    notes: 'E2E panel test',
  }, adminToken);
  check('Create panel session', r.status === 201, `status=${r.status}`);
  const panelSessionId = r.data?.id;
  if (!panelSessionId) { fail('Cannot continue — panel session creation failed'); return; }

  // Build items: 6 non-zero products with 2 full containers each.
  // Zero-usage product: 5 full containers (heavily stocked, no delivery → usage = 0).
  const items = [
    ...nonZeroProductIds.map(id => ({ productId: id, fullContainers: 2, partialContainers: 0 })),
    { productId: zeroProductId, fullContainers: 5, partialContainers: 0 },
  ];
  r = await req('PUT', `/inventory-sessions/${panelSessionId}/items`, { items }, adminToken);
  check('Save items for all 7 products', r.status === 200, `count=${r.data?.length}`);

  // Log a delivery of 5 units each for the 6 non-zero products only.
  // usage = max(0, prevCount=0 + received=5 − currentCount=2) = 3.000 each.
  // Zero product: no delivery → usage = max(0, 0 + 0 − 5) = 0.000.
  for (const pid of nonZeroProductIds) {
    r = await req('POST', '/receiving-records', {
      storeId: panelStoreId,
      vendor: 'Panel Supplier',
      invoiceNumber: `PNL-INV-${pid}`,
      items: [{ productId: pid, quantityReceived: '5', lotNumber: `LOT-PNL-${pid}`, cost: '10.00' }],
    }, adminToken);
    check(`Log delivery for product ${pid}`, r.status === 201, `status=${r.status}`);
  }

  // Finalize the session.
  r = await req('POST', `/inventory-sessions/${panelSessionId}/finalize`, {}, adminToken);
  check('Finalize panel session', r.status === 200, `status=${r.status}`);

  const summary = r.data?.usageSummary ?? [];

  // ── Assert: total entries in summary ────────────────────────────────────────
  check(
    'usageSummary contains all 7 products',
    summary.length === 7,
    `length=${summary.length}`,
  );

  // ── Assert: non-zero vs zero split ──────────────────────────────────────────
  const nonZero = summary.filter(u => parseFloat(u.usage) > 0);
  const zeroItems = summary.filter(u => parseFloat(u.usage) <= 0);

  check(
    `${NON_ZERO_COUNT} products have usage > 0 (panel shows them by default)`,
    nonZero.length === NON_ZERO_COUNT,
    `nonZero=${nonZero.length} expected=${NON_ZERO_COUNT}`,
  );

  check(
    'Zero-usage product is filtered into zeroItems (excluded from main panel)',
    zeroItems.length === 1 && zeroItems[0]?.productId === zeroProductId,
    `zeroCount=${zeroItems.length} zeroProductId=${zeroItems[0]?.productId}`,
  );

  // ── Assert: "Show all" threshold ────────────────────────────────────────────
  const PREVIEW = 5;
  check(
    `Non-zero count (${nonZero.length}) exceeds PREVIEW(${PREVIEW}) — "Show all" button must appear`,
    nonZero.length > PREVIEW,
    `nonZero=${nonZero.length} PREVIEW=${PREVIEW}`,
  );

  // ── Assert: each non-zero product has expected usage ────────────────────────
  const expectedUsage = (0 + 5 - 2).toFixed(3); // '3.000'
  const allUsageCorrect = nonZero.every(u => u.usage === expectedUsage);
  check(
    `All non-zero products report usage=${expectedUsage}`,
    allUsageCorrect,
    `usages=[${nonZero.map(u => u.usage).join(', ')}]`,
  );

  // ── Assert: zero-usage product usage value ───────────────────────────────────
  const zeroEntry = zeroItems.find(u => u.productId === zeroProductId);
  check(
    'Zero-usage product has usage=0.000 in summary',
    parseFloat(zeroEntry?.usage ?? '1') === 0,
    `usage=${zeroEntry?.usage}`,
  );

  // ── Assert: same results returned by GET after finalization ─────────────────
  r = await req('GET', `/inventory-sessions/${panelSessionId}`, null, adminToken);
  const getSummary = r.data?.usageSummary ?? [];
  const getNonZero = getSummary.filter(u => parseFloat(u.usage) > 0);
  check(
    'GET endpoint returns same non-zero count after finalization',
    getNonZero.length === NON_ZERO_COUNT,
    `getNonZero=${getNonZero.length}`,
  );
}

// ─── FLOW 11: Usage summary — estimatedGallons path ──────────────────────────
//
// computeUsageSummary uses  `estimatedGallons ?? fullContainers`  for both
// currentCount and previousCount.  These cases confirm that a regression in
// the estimatedGallons branch is caught even when fullContainers is also set.

async function testUsageSummaryEstimatedGallonsFlow() {
  section('FLOW 11 — Usage summary: estimatedGallons branch');

  if (!testProductId) { fail('Gallon-estimate test skipped — no product id'); return; }

  // Create a dedicated store so session history is clean.
  let r = await req('POST', '/stores', {
    name: 'Gallon Estimate Test Store',
    storeNumber: 'GAL-E2E',
    city: 'Gallon City',
    state: 'OR',
  }, adminToken);
  check('Create gallon-estimate test store', r.status === 201, `status=${r.status}`);
  const galStoreId = r.data?.id;
  if (!galStoreId) { fail('Cannot run gallon-estimate tests — store creation failed'); return; }

  // ── Case C: estimatedGallons drives currentCount ────────────────────────────
  // First-ever session for this store (no prior), item has BOTH fullContainers
  // and estimatedGallons set — estimatedGallons must win.

  r = await req('POST', '/inventory-sessions', {
    storeId: galStoreId,
    notes: 'E2E gallon-estimate C',
  }, adminToken);
  check('Case C: create first session (estimatedGallons)', r.status === 201, `status=${r.status}`);
  const sessionCId = r.data?.id;
  if (!sessionCId) { fail('Cannot continue — session C creation failed'); return; }

  // fullContainers=10 is a decoy; estimatedGallons="3.500" must win.
  r = await req('PUT', `/inventory-sessions/${sessionCId}/items`, {
    items: [{
      productId: testProductId,
      fullContainers: 10,
      partialContainers: 0,
      estimatedGallons: '3.500',
    }],
  }, adminToken);
  check('Case C: save item with estimatedGallons="3.500" (fullContainers=10 decoy)', r.status === 200, `count=${r.data?.length}`);

  // Receive 6 units after session start.
  r = await req('POST', '/receiving-records', {
    storeId: galStoreId,
    vendor: 'Acme Chemical Co.',
    invoiceNumber: 'GAL-INV-C',
    items: [{ productId: testProductId, quantityReceived: '6', lotNumber: 'LOT-GAL-C', cost: '18.00' }],
  }, adminToken);
  check('Case C: log delivery (6 units)', r.status === 201, `status=${r.status}`);

  // Finalize — currentCount = "3.500", prev = 0, received = 6
  // usage = max(0, 0 + 6 − 3.5) = 2.500
  r = await req('POST', `/inventory-sessions/${sessionCId}/finalize`, {}, adminToken);
  check('Case C: finalize session', r.status === 200, `status=${r.status}`);

  const summaryC = r.data?.usageSummary;
  const itemC = summaryC?.find(i => i.productId === testProductId);
  const expectedCurrentC = '3.500';
  const expectedUsageC = Math.max(0, 0 + 6 - 3.5).toFixed(3); // '2.500'

  check(
    'Case C: currentCount uses estimatedGallons ("3.500"), not fullContainers (10)',
    itemC?.currentCount === expectedCurrentC,
    `currentCount=${itemC?.currentCount} expected=${expectedCurrentC}`,
  );
  check(
    'Case C: previousCount is "0" (no prior session)',
    itemC?.previousCount === '0',
    `previousCount=${itemC?.previousCount}`,
  );
  check(
    'Case C: received = 6',
    parseFloat(itemC?.received ?? '-1') === 6,
    `received=${itemC?.received}`,
  );
  check(
    'Case C: usage = 0 + 6 − 3.5 = 2.500',
    itemC?.usage === expectedUsageC,
    `usage=${itemC?.usage} expected=${expectedUsageC}`,
  );

  // Also confirm GET returns the same figures.
  r = await req('GET', `/inventory-sessions/${sessionCId}`, null, adminToken);
  const getItemC = r.data?.usageSummary?.find(i => i.productId === testProductId);
  check(
    'Case C: GET returns consistent currentCount and usage',
    getItemC?.currentCount === expectedCurrentC && getItemC?.usage === expectedUsageC,
    `currentCount=${getItemC?.currentCount} usage=${getItemC?.usage}`,
  );

  // ── Case D: estimatedGallons drives previousCount ────────────────────────────
  // Session C is now the most-recent finalized session.  Session D's item
  // also sets estimatedGallons; the previousCount must come from session C's
  // estimatedGallons ("3.500"), NOT from session C's fullContainers (10).

  r = await req('POST', '/inventory-sessions', {
    storeId: galStoreId,
    notes: 'E2E gallon-estimate D',
  }, adminToken);
  check('Case D: create second session (prior has estimatedGallons)', r.status === 201, `status=${r.status}`);
  const sessionDId = r.data?.id;
  if (!sessionDId) { fail('Cannot continue — session D creation failed'); return; }

  // fullContainers=99 is a decoy; estimatedGallons="2.000" must win for currentCount.
  r = await req('PUT', `/inventory-sessions/${sessionDId}/items`, {
    items: [{
      productId: testProductId,
      fullContainers: 99,
      partialContainers: 0,
      estimatedGallons: '2.000',
    }],
  }, adminToken);
  check('Case D: save item with estimatedGallons="2.000" (fullContainers=99 decoy)', r.status === 200, `count=${r.data?.length}`);

  // Receive 5 units after session C was finalized.
  r = await req('POST', '/receiving-records', {
    storeId: galStoreId,
    vendor: 'Acme Chemical Co.',
    invoiceNumber: 'GAL-INV-D',
    items: [{ productId: testProductId, quantityReceived: '5', lotNumber: 'LOT-GAL-D', cost: '15.00' }],
  }, adminToken);
  check('Case D: log delivery (5 units)', r.status === 201, `status=${r.status}`);

  // Finalize — previousCount = "3.500" (session C's estimatedGallons), NOT "10" (fullContainers)
  // currentCount = "2.000", received = 5
  // usage = max(0, 3.5 + 5 − 2) = 6.500
  r = await req('POST', `/inventory-sessions/${sessionDId}/finalize`, {}, adminToken);
  check('Case D: finalize session', r.status === 200, `status=${r.status}`);

  const summaryD = r.data?.usageSummary;
  const itemD = summaryD?.find(i => i.productId === testProductId);
  const expectedPrevD = '3.500'; // from session C's estimatedGallons
  const expectedCurrentD = '2.000';
  const expectedUsageD = Math.max(0, 3.5 + 5 - 2).toFixed(3); // '6.500'

  check(
    'Case D: previousCount = "3.500" (prior session\'s estimatedGallons, not fullContainers=10)',
    itemD?.previousCount === expectedPrevD,
    `previousCount=${itemD?.previousCount} expected=${expectedPrevD}`,
  );
  check(
    'Case D: currentCount = "2.000" (estimatedGallons, not fullContainers=99)',
    itemD?.currentCount === expectedCurrentD,
    `currentCount=${itemD?.currentCount} expected=${expectedCurrentD}`,
  );
  check(
    'Case D: received = 5 (only post-session-C deliveries)',
    parseFloat(itemD?.received ?? '-1') === 5,
    `received=${itemD?.received}`,
  );
  check(
    'Case D: usage = 3.5 + 5 − 2 = 6.500',
    itemD?.usage === expectedUsageD,
    `usage=${itemD?.usage} expected=${expectedUsageD}`,
  );

  // Confirm GET endpoint is consistent.
  r = await req('GET', `/inventory-sessions/${sessionDId}`, null, adminToken);
  const getItemD = r.data?.usageSummary?.find(i => i.productId === testProductId);
  check(
    'Case D: GET returns consistent previousCount and usage',
    getItemD?.previousCount === expectedPrevD && getItemD?.usage === expectedUsageD,
    `previousCount=${getItemD?.previousCount} usage=${getItemD?.usage}`,
  );
}

// ─── FLOW 15: Mixed estimatedGallons/fullContainers across sessions ───────────
//
// computeUsageSummary uses  `estimatedGallons ?? fullContainers`  for both
// currentCount and previousCount.  These cases confirm that a cross-mode
// transition is handled correctly in both directions:
//
//   Case E: Session 1 stored estimatedGallons → Session 2 records only
//           fullContainers (estimatedGallons omitted/null).
//           Session 2's previousCount must equal session 1's estimatedGallons.
//
//   Case F: Session 1 stored only fullContainers (no estimatedGallons) →
//           Session 2 records estimatedGallons.
//           Session 2's previousCount must equal String(session 1's fullContainers).

async function testMixedEstimatedGallonsFlow() {
  section('FLOW 15 — Mixed estimatedGallons/fullContainers across sessions');

  if (!testProductId) { fail('Mixed-gallons test skipped — no product id'); return; }

  // Dedicated store so session history is clean.
  let r = await req('POST', '/stores', {
    name: 'Mixed Gallons Test Store',
    storeNumber: 'MXG-E2E',
    city: 'Mixed City',
    state: 'OR',
  }, adminToken);
  check('Create mixed-gallons test store', r.status === 201, `status=${r.status}`);
  const mxgStoreId = r.data?.id;
  if (!mxgStoreId) { fail('Cannot run mixed-gallons tests — store creation failed'); return; }

  // ── Case E: estimatedGallons in session 1 → fullContainers only in session 2 ─
  // Session 1: fullContainers=10 (decoy), estimatedGallons="4.500"
  // Session 2: fullContainers=3, estimatedGallons omitted (null)
  // Expected for session 2: previousCount="4.500" (not "10")

  r = await req('POST', '/inventory-sessions', {
    storeId: mxgStoreId,
    notes: 'E2E mixed gallons E-1',
  }, adminToken);
  check('Case E: create session 1 (has estimatedGallons)', r.status === 201, `status=${r.status}`);
  const sessionE1Id = r.data?.id;
  if (!sessionE1Id) { fail('Cannot continue — session E-1 creation failed'); return; }

  // fullContainers=10 is a decoy; estimatedGallons="4.500" must win for previousCount.
  r = await req('PUT', `/inventory-sessions/${sessionE1Id}/items`, {
    items: [{
      productId: testProductId,
      fullContainers: 10,
      partialContainers: 0,
      estimatedGallons: '4.500',
    }],
  }, adminToken);
  check('Case E: save session 1 items (estimatedGallons="4.500", fullContainers=10 decoy)', r.status === 200, `count=${r.data?.length}`);

  // Receive 3 units before finalizing session 1.
  r = await req('POST', '/receiving-records', {
    storeId: mxgStoreId,
    vendor: 'Acme Chemical Co.',
    invoiceNumber: 'MXG-INV-E1',
    items: [{ productId: testProductId, quantityReceived: '3', lotNumber: 'LOT-MXG-E1', cost: '9.00' }],
  }, adminToken);
  check('Case E: log delivery to session 1 (3 units)', r.status === 201, `status=${r.status}`);

  r = await req('POST', `/inventory-sessions/${sessionE1Id}/finalize`, {}, adminToken);
  check('Case E: finalize session 1', r.status === 200, `status=${r.status}`);

  // ── Session 2: no estimatedGallons — only fullContainers ────────────────────
  r = await req('POST', '/inventory-sessions', {
    storeId: mxgStoreId,
    notes: 'E2E mixed gallons E-2',
  }, adminToken);
  check('Case E: create session 2 (fullContainers only, no estimatedGallons)', r.status === 201, `status=${r.status}`);
  const sessionE2Id = r.data?.id;
  if (!sessionE2Id) { fail('Cannot continue — session E-2 creation failed'); return; }

  // Intentionally omit estimatedGallons to exercise the cross-mode path.
  r = await req('PUT', `/inventory-sessions/${sessionE2Id}/items`, {
    items: [{
      productId: testProductId,
      fullContainers: 3,
      partialContainers: 0,
      // estimatedGallons deliberately omitted
    }],
  }, adminToken);
  check('Case E: save session 2 items (fullContainers=3, estimatedGallons omitted)', r.status === 200, `count=${r.data?.length}`);

  // Receive 5 units after session 1 was finalized.
  r = await req('POST', '/receiving-records', {
    storeId: mxgStoreId,
    vendor: 'Acme Chemical Co.',
    invoiceNumber: 'MXG-INV-E2',
    items: [{ productId: testProductId, quantityReceived: '5', lotNumber: 'LOT-MXG-E2', cost: '15.00' }],
  }, adminToken);
  check('Case E: log delivery to session 2 (5 units)', r.status === 201, `status=${r.status}`);

  // Finalize session 2.
  // previousCount must be "4.500" (session 1's estimatedGallons), NOT "10" (fullContainers).
  // currentCount = String(3) = "3"
  // usage = max(0, 4.5 + 5 − 3) = 6.500
  r = await req('POST', `/inventory-sessions/${sessionE2Id}/finalize`, {}, adminToken);
  check('Case E: finalize session 2', r.status === 200, `status=${r.status}`);

  const summaryE2 = r.data?.usageSummary;
  const itemE2 = summaryE2?.find(i => i.productId === testProductId);
  const expectedPrevE = '4.500'; // from session 1's estimatedGallons
  const expectedUsageE = Math.max(0, 4.5 + 5 - 3).toFixed(3); // '6.500'

  check(
    'Case E: previousCount = session 1 estimatedGallons ("4.500"), not fullContainers ("10")',
    itemE2?.previousCount === expectedPrevE,
    `previousCount=${itemE2?.previousCount} expected=${expectedPrevE}`,
  );
  check(
    'Case E: currentCount = "3" (fullContainers, since estimatedGallons omitted)',
    itemE2?.currentCount === '3',
    `currentCount=${itemE2?.currentCount} expected=3`,
  );
  check(
    'Case E: received = 5 (only post-session-1 deliveries)',
    parseFloat(itemE2?.received ?? '-1') === 5,
    `received=${itemE2?.received}`,
  );
  check(
    'Case E: usage = 4.5 + 5 − 3 = 6.500',
    itemE2?.usage === expectedUsageE,
    `usage=${itemE2?.usage} expected=${expectedUsageE}`,
  );

  // Confirm GET is consistent.
  r = await req('GET', `/inventory-sessions/${sessionE2Id}`, null, adminToken);
  const getItemE2 = r.data?.usageSummary?.find(i => i.productId === testProductId);
  check(
    'Case E: GET returns consistent previousCount and usage',
    getItemE2?.previousCount === expectedPrevE && getItemE2?.usage === expectedUsageE,
    `previousCount=${getItemE2?.previousCount} usage=${getItemE2?.usage}`,
  );

  // ── Case F: fullContainers only in session 3 → estimatedGallons in session 4 ─
  // Session 3: fullContainers=7, no estimatedGallons
  // Session 4: fullContainers=99 (decoy), estimatedGallons="1.500"
  // Expected for session 4: previousCount="7" (String(session 3's fullContainers))

  // Use a new isolated store for Case F so session E history doesn't interfere.
  r = await req('POST', '/stores', {
    name: 'Mixed Gallons Test Store F',
    storeNumber: 'MXG-F-E2E',
    city: 'Mixed City F',
    state: 'OR',
  }, adminToken);
  check('Case F: create dedicated store', r.status === 201, `status=${r.status}`);
  const mxgFStoreId = r.data?.id;
  if (!mxgFStoreId) { fail('Cannot run Case F — store creation failed'); return; }

  r = await req('POST', '/inventory-sessions', {
    storeId: mxgFStoreId,
    notes: 'E2E mixed gallons F-1',
  }, adminToken);
  check('Case F: create session 3 (fullContainers only, no estimatedGallons)', r.status === 201, `status=${r.status}`);
  const sessionF1Id = r.data?.id;
  if (!sessionF1Id) { fail('Cannot continue — session F-1 creation failed'); return; }

  r = await req('PUT', `/inventory-sessions/${sessionF1Id}/items`, {
    items: [{
      productId: testProductId,
      fullContainers: 7,
      partialContainers: 0,
      // estimatedGallons deliberately omitted
    }],
  }, adminToken);
  check('Case F: save session 3 items (fullContainers=7, estimatedGallons omitted)', r.status === 200, `count=${r.data?.length}`);

  // Receive 2 units before finalizing session 3.
  r = await req('POST', '/receiving-records', {
    storeId: mxgFStoreId,
    vendor: 'Acme Chemical Co.',
    invoiceNumber: 'MXG-INV-F1',
    items: [{ productId: testProductId, quantityReceived: '2', lotNumber: 'LOT-MXG-F1', cost: '6.00' }],
  }, adminToken);
  check('Case F: log delivery to session 3 (2 units)', r.status === 201, `status=${r.status}`);

  r = await req('POST', `/inventory-sessions/${sessionF1Id}/finalize`, {}, adminToken);
  check('Case F: finalize session 3', r.status === 200, `status=${r.status}`);

  // ── Session 4: estimatedGallons wins over fullContainers ────────────────────
  r = await req('POST', '/inventory-sessions', {
    storeId: mxgFStoreId,
    notes: 'E2E mixed gallons F-2',
  }, adminToken);
  check('Case F: create session 4 (has estimatedGallons, prior has none)', r.status === 201, `status=${r.status}`);
  const sessionF2Id = r.data?.id;
  if (!sessionF2Id) { fail('Cannot continue — session F-2 creation failed'); return; }

  // fullContainers=99 is a decoy; estimatedGallons="1.500" must win for currentCount.
  r = await req('PUT', `/inventory-sessions/${sessionF2Id}/items`, {
    items: [{
      productId: testProductId,
      fullContainers: 99,
      partialContainers: 0,
      estimatedGallons: '1.500',
    }],
  }, adminToken);
  check('Case F: save session 4 items (estimatedGallons="1.500", fullContainers=99 decoy)', r.status === 200, `count=${r.data?.length}`);

  // Receive 4 units after session 3 was finalized.
  r = await req('POST', '/receiving-records', {
    storeId: mxgFStoreId,
    vendor: 'Acme Chemical Co.',
    invoiceNumber: 'MXG-INV-F2',
    items: [{ productId: testProductId, quantityReceived: '4', lotNumber: 'LOT-MXG-F2', cost: '12.00' }],
  }, adminToken);
  check('Case F: log delivery to session 4 (4 units)', r.status === 201, `status=${r.status}`);

  // Finalize session 4.
  // previousCount must be "7" (String(session 3's fullContainers), no estimatedGallons).
  // currentCount = "1.500" (estimatedGallons wins over fullContainers=99).
  // usage = max(0, 7 + 4 − 1.5) = 9.500
  r = await req('POST', `/inventory-sessions/${sessionF2Id}/finalize`, {}, adminToken);
  check('Case F: finalize session 4', r.status === 200, `status=${r.status}`);

  const summaryF2 = r.data?.usageSummary;
  const itemF2 = summaryF2?.find(i => i.productId === testProductId);
  const expectedPrevF = '7'; // String(session 3's fullContainers)
  const expectedCurrentF = '1.500'; // estimatedGallons of session 4
  const expectedUsageF = Math.max(0, 7 + 4 - 1.5).toFixed(3); // '9.500'

  check(
    'Case F: previousCount = "7" (prior session\'s fullContainers, since estimatedGallons was absent)',
    itemF2?.previousCount === expectedPrevF,
    `previousCount=${itemF2?.previousCount} expected=${expectedPrevF}`,
  );
  check(
    'Case F: currentCount = "1.500" (estimatedGallons wins over fullContainers=99)',
    itemF2?.currentCount === expectedCurrentF,
    `currentCount=${itemF2?.currentCount} expected=${expectedCurrentF}`,
  );
  check(
    'Case F: received = 4 (only post-session-3 deliveries)',
    parseFloat(itemF2?.received ?? '-1') === 4,
    `received=${itemF2?.received}`,
  );
  check(
    'Case F: usage = 7 + 4 − 1.5 = 9.500',
    itemF2?.usage === expectedUsageF,
    `usage=${itemF2?.usage} expected=${expectedUsageF}`,
  );

  // Confirm GET is consistent.
  r = await req('GET', `/inventory-sessions/${sessionF2Id}`, null, adminToken);
  const getItemF2 = r.data?.usageSummary?.find(i => i.productId === testProductId);
  check(
    'Case F: GET returns consistent previousCount and usage',
    getItemF2?.previousCount === expectedPrevF && getItemF2?.usage === expectedUsageF,
    `previousCount=${getItemF2?.previousCount} usage=${getItemF2?.usage}`,
  );
}

// ─── FLOW 12: Finalized-session snapshot is frozen after back-dated delivery ──
//
// Verifies that a receiving record posted AFTER a session is finalized does not
// change the usageSummary returned by GET /inventory-sessions/:id.
// The finalize handler stores a snapshot; the GET handler must serve that
// snapshot rather than recomputing from live receiving records.

async function testFinalizedSessionSnapshotFlow() {
  section('FLOW 12 — Finalized session snapshot: back-dated delivery must not alter GET figures');

  if (!testProductId) { fail('Snapshot test skipped — no product id'); return; }

  // Use an isolated store so session history is clean.
  let r = await req('POST', '/stores', {
    name: 'Snapshot Test Store',
    storeNumber: 'SNP-E2E',
    city: 'Snapshot City',
    state: 'OR',
  }, adminToken);
  check('Create snapshot test store', r.status === 201, `status=${r.status}`);
  const snpStoreId = r.data?.id;
  if (!snpStoreId) { fail('Cannot run snapshot tests — store creation failed'); return; }

  // Create and populate a session.
  r = await req('POST', '/inventory-sessions', {
    storeId: snpStoreId,
    notes: 'E2E snapshot test',
  }, adminToken);
  check('Create snapshot session', r.status === 201, `status=${r.status}`);
  const snpSessionId = r.data?.id;
  if (!snpSessionId) { fail('Cannot continue — session creation failed'); return; }

  r = await req('PUT', `/inventory-sessions/${snpSessionId}/items`, {
    items: [{ productId: testProductId, fullContainers: 4, partialContainers: 0 }],
  }, adminToken);
  check('Save items (4 full containers)', r.status === 200, `count=${r.data?.length}`);

  // Log a delivery before finalizing — 6 units received.
  r = await req('POST', '/receiving-records', {
    storeId: snpStoreId,
    vendor: 'Snapshot Supplier',
    invoiceNumber: 'SNP-INV-PRE',
    items: [{ productId: testProductId, quantityReceived: '6', lotNumber: 'LOT-SNP-PRE', cost: '15.00' }],
  }, adminToken);
  check('Log pre-finalization delivery (6 units)', r.status === 201, `status=${r.status}`);

  // Finalize — expected usage = max(0, 0 + 6 − 4) = 2.000
  r = await req('POST', `/inventory-sessions/${snpSessionId}/finalize`, {}, adminToken);
  check('Finalize session', r.status === 200, `status=${r.status}`);

  const finalizeUsage = r.data?.usageSummary?.find(i => i.productId === testProductId);
  const frozenUsage = finalizeUsage?.usage;
  const frozenReceived = finalizeUsage?.received;
  check(
    'Finalize response shows expected usage (2.000)',
    frozenUsage === '2.000',
    `usage=${frozenUsage}`,
  );

  // Now post a SECOND delivery after finalization.  Because receivedAt defaults
  // to now (which is after finalizedAt), this record falls inside the usage
  // window [prevSession.finalizedAt, session.finalizedAt] if we naively
  // recompute — the snapshot must prevent that.
  r = await req('POST', '/receiving-records', {
    storeId: snpStoreId,
    vendor: 'Snapshot Supplier',
    invoiceNumber: 'SNP-INV-POST',
    items: [{ productId: testProductId, quantityReceived: '99', lotNumber: 'LOT-SNP-POST', cost: '200.00' }],
  }, adminToken);
  check('Log post-finalization delivery (99 units)', r.status === 201, `status=${r.status}`);

  // GET the finalized session — figures must be identical to the finalize response.
  r = await req('GET', `/inventory-sessions/${snpSessionId}`, null, adminToken);
  check('GET finalized session returns 200', r.status === 200, `status=${r.status}`);
  const getItem = r.data?.usageSummary?.find(i => i.productId === testProductId);

  check(
    'GET usage matches finalize snapshot (not inflated by post-finalization delivery)',
    getItem?.usage === frozenUsage,
    `GET usage=${getItem?.usage} expected=${frozenUsage}`,
  );
  check(
    'GET received matches finalize snapshot (not inflated by post-finalization delivery)',
    getItem?.received === frozenReceived,
    `GET received=${getItem?.received} expected=${frozenReceived}`,
  );
}

// ─── FLOW 13: Usage panel — re-finalized (admin-edit) session ────────────────
//
// Verifies that the usageSummary panel shape (all-products count, non-zero /
// zero split, "Show all" threshold) is still correct after an admin edits item
// counts on an already-finalized session.  The admin-edit endpoint recomputes
// the usageSummary and updates the snapshot; the panel must reflect the updated
// figures without losing any products or collapsing the zero section.

async function testUsagePanelAfterAdminEditFlow() {
  section('FLOW 13 — Usage panel: shape stays correct after admin-edit on finalized session');

  // Create an isolated store so session history is clean.
  let r = await req('POST', '/stores', {
    name: 'Reopen Panel Test Store',
    storeNumber: 'RPL-E2E',
    city: 'Reopen City',
    state: 'OR',
  }, adminToken);
  check('Create reopen-panel test store', r.status === 201, `status=${r.status}`);
  const rplStoreId = r.data?.id;
  if (!rplStoreId) { fail('Cannot run reopen-panel tests — store creation failed'); return; }

  // Create 6 products that will have non-zero usage (> the PREVIEW=5 threshold).
  const RPL_NON_ZERO = 6;
  const rplNonZeroIds = [];
  for (let i = 1; i <= RPL_NON_ZERO; i++) {
    r = await req('POST', '/products', {
      name: `Reopen Panel Chemical ${i}`,
      unit: 'gallon',
      productNumber: `RPL-${String(i).padStart(3, '0')}`,
    }, adminToken);
    if (r.status === 201) {
      rplNonZeroIds.push(r.data.id);
    } else {
      fail(`Create reopen panel product ${i}`, `status=${r.status}`);
    }
  }
  check(
    `Created ${RPL_NON_ZERO} non-zero-usage products`,
    rplNonZeroIds.length === RPL_NON_ZERO,
    `created=${rplNonZeroIds.length}`,
  );

  // Create 1 zero-usage product (heavily stocked, no delivery).
  r = await req('POST', '/products', {
    name: 'Reopen Panel Zero Usage Chemical',
    unit: 'gallon',
    productNumber: 'RPL-ZERO',
  }, adminToken);
  check('Create reopen-panel zero-usage product', r.status === 201, `status=${r.status}`);
  const rplZeroId = r.data?.id;

  if (rplNonZeroIds.length === 0 || !rplZeroId) {
    fail('Reopen panel test aborted — product creation failed');
    return;
  }

  // Create the inventory session.
  r = await req('POST', '/inventory-sessions', {
    storeId: rplStoreId,
    notes: 'E2E reopen panel test',
  }, adminToken);
  check('Create reopen-panel session', r.status === 201, `status=${r.status}`);
  const rplSessionId = r.data?.id;
  if (!rplSessionId) { fail('Cannot continue — reopen-panel session creation failed'); return; }

  // Items: 6 non-zero products × 2 full containers; zero product × 5 full containers.
  const rplItems = [
    ...rplNonZeroIds.map(id => ({ productId: id, fullContainers: 2, partialContainers: 0 })),
    { productId: rplZeroId, fullContainers: 5, partialContainers: 0 },
  ];
  r = await req('PUT', `/inventory-sessions/${rplSessionId}/items`, { items: rplItems }, adminToken);
  check('Save items for all 7 products', r.status === 200, `count=${r.data?.length}`);

  // Deliver 5 units each for the 6 non-zero products only.
  // usage per non-zero = max(0, 0 + 5 − 2) = 3.000
  // zero product: no delivery → usage = max(0, 0 + 0 − 5) = 0.000
  for (const pid of rplNonZeroIds) {
    r = await req('POST', '/receiving-records', {
      storeId: rplStoreId,
      vendor: 'Reopen Panel Supplier',
      invoiceNumber: `RPL-INV-${pid}`,
      items: [{ productId: pid, quantityReceived: '5', lotNumber: `LOT-RPL-${pid}`, cost: '10.00' }],
    }, adminToken);
    check(`Deliver 5 units for product ${pid}`, r.status === 201, `status=${r.status}`);
  }

  // ── First finalization ──────────────────────────────────────────────────────
  r = await req('POST', `/inventory-sessions/${rplSessionId}/finalize`, {}, adminToken);
  check('First finalize succeeds', r.status === 200, `status=${r.status}`);

  const firstSummary = r.data?.usageSummary ?? [];
  check(
    'First finalize: usageSummary contains all 7 products',
    firstSummary.length === 7,
    `length=${firstSummary.length}`,
  );
  const firstNonZero = firstSummary.filter(u => parseFloat(u.usage) > 0);
  const firstZero = firstSummary.filter(u => parseFloat(u.usage) <= 0);
  check(
    'First finalize: 6 non-zero, 1 zero',
    firstNonZero.length === RPL_NON_ZERO && firstZero.length === 1,
    `nonZero=${firstNonZero.length} zero=${firstZero.length}`,
  );
  check(
    'First finalize: non-zero count > PREVIEW(5) — "Show all" would appear',
    firstNonZero.length > 5,
    `nonZero=${firstNonZero.length}`,
  );

  // ── Admin edits one non-zero product on the finalized session ───────────────
  // Change the first non-zero product from 2 → 4 full containers.
  // New usage for that product = max(0, 0 + 5 − 4) = 1.000 (still > 0).
  // All other non-zero products remain at 3.000.
  const editedProductId = rplNonZeroIds[0];
  r = await req(
    'PUT',
    `/inventory-sessions/${rplSessionId}/items/admin-edit`,
    { items: [{ productId: editedProductId, fullContainers: 4, partialContainers: 0 }] },
    adminToken,
  );
  check('Admin-edit on finalized session succeeds', r.status === 200, `status=${r.status}`);

  const editSummary = r.data?.usageSummary ?? [];

  // ── Assert: total products unchanged ────────────────────────────────────────
  check(
    'After admin-edit: usageSummary still contains all 7 products',
    editSummary.length === 7,
    `length=${editSummary.length}`,
  );

  // ── Assert: non-zero / zero split is preserved ───────────────────────────────
  const editNonZero = editSummary.filter(u => parseFloat(u.usage) > 0);
  const editZero = editSummary.filter(u => parseFloat(u.usage) <= 0);
  check(
    'After admin-edit: still 6 non-zero products',
    editNonZero.length === RPL_NON_ZERO,
    `nonZero=${editNonZero.length} expected=${RPL_NON_ZERO}`,
  );
  check(
    'After admin-edit: still 1 zero-usage product',
    editZero.length === 1 && editZero[0]?.productId === rplZeroId,
    `zeroCount=${editZero.length} zeroProductId=${editZero[0]?.productId}`,
  );

  // ── Assert: "Show all" threshold still satisfied ─────────────────────────────
  check(
    'After admin-edit: non-zero count still > PREVIEW(5) — "Show all" button still appears',
    editNonZero.length > 5,
    `nonZero=${editNonZero.length}`,
  );

  // ── Assert: edited product has updated usage ─────────────────────────────────
  const editedEntry = editSummary.find(u => u.productId === editedProductId);
  const expectedEditedUsage = (0 + 5 - 4).toFixed(3); // '1.000'
  check(
    `After admin-edit: edited product usage updated to ${expectedEditedUsage}`,
    editedEntry?.usage === expectedEditedUsage,
    `usage=${editedEntry?.usage} expected=${expectedEditedUsage}`,
  );

  // ── Assert: unedited non-zero products retain their original usage ────────────
  const uneditedNonZero = editNonZero.filter(u => u.productId !== editedProductId);
  const expectedUnchangedUsage = (0 + 5 - 2).toFixed(3); // '3.000'
  const allUneditedCorrect = uneditedNonZero.every(u => u.usage === expectedUnchangedUsage);
  check(
    `After admin-edit: unedited products still show usage=${expectedUnchangedUsage}`,
    allUneditedCorrect,
    `usages=[${uneditedNonZero.map(u => u.usage).join(', ')}]`,
  );

  // ── Assert: GET returns the same updated figures ──────────────────────────────
  r = await req('GET', `/inventory-sessions/${rplSessionId}`, null, adminToken);
  const getSummary = r.data?.usageSummary ?? [];
  const getEditedEntry = getSummary.find(u => u.productId === editedProductId);
  const getEditNonZero = getSummary.filter(u => parseFloat(u.usage) > 0);
  check(
    'After admin-edit: GET usageSummary still has all 7 products',
    getSummary.length === 7,
    `length=${getSummary.length}`,
  );
  check(
    'After admin-edit: GET shows updated usage for edited product',
    getEditedEntry?.usage === expectedEditedUsage,
    `GET usage=${getEditedEntry?.usage} expected=${expectedEditedUsage}`,
  );
  check(
    'After admin-edit: GET non-zero count still > PREVIEW(5)',
    getEditNonZero.length > 5,
    `getNonZero=${getEditNonZero.length}`,
  );

  // ── Cross-store guard: store_user for a different store is blocked ────────────
  // storeUserToken is scoped to testStoreId (store A).  rplSessionId belongs to
  // rplStoreId (store B).  A store_user from store A must not be able to call
  // admin-edit on store B's session — the endpoint must respond 403.
  r = await req(
    'PUT',
    `/inventory-sessions/${rplSessionId}/items/admin-edit`,
    { items: [{ productId: editedProductId, fullContainers: 1, partialContainers: 0 }] },
    storeUserToken,
  );
  check(
    'Cross-store admin-edit blocked: store_user from different store gets 403',
    r.status === 403,
    `status=${r.status}`,
  );
}

// ─── FLOW 14: Deactivated product between sessions ────────────────────────────
//
// Verifies that a product deactivated (isActive=false) between two finalized
// sessions does not appear in the second session's usageSummary.  The mobile
// usage panel only renders products whose usage entries are in the summary, so
// a deactivated product that bleeds in from the previous session's data would
// show a stale name and wrong usage figure.
//
// Scenario:
//   Session X  — product DCT-001 counted (5 containers), finalized.
//   Admin deactivates DCT-001 (PATCH /products/:id { isActive: false }).
//   Session Y  — DCT-001 no longer appears in the active product list; a
//               second product DCT-002 is counted instead.  Session Y is
//               finalized.
//   Assert: DCT-001 is absent from session Y's usageSummary (or, at minimum,
//           reported with usage=0 if it somehow appears).

async function testDeactivatedProductFlow() {
  section('FLOW 14 — Deactivated product: absent from next session usageSummary');

  // Create an isolated store so session history is clean.
  let r = await req('POST', '/stores', {
    name: 'Deactivate Test Store',
    storeNumber: 'DCT-E2E',
    city: 'Test City',
    state: 'OR',
  }, adminToken);
  check('Create deactivate test store', r.status === 201, `status=${r.status}`);
  const dctStoreId = r.data?.id;
  if (!dctStoreId) { fail('Cannot run deactivation tests — store creation failed'); return; }

  // Create the product that will later be deactivated.
  r = await req('POST', '/products', {
    name: 'Deactivate Chemical',
    unit: 'gallon',
    productNumber: 'DCT-001',
  }, adminToken);
  check('Create product DCT-001 (to be deactivated)', r.status === 201, `status=${r.status}`);
  const dctProductId = r.data?.id;
  if (!dctProductId) { fail('Cannot run deactivation tests — product DCT-001 creation failed'); return; }

  // Create a second product that stays active throughout.
  r = await req('POST', '/products', {
    name: 'Active Chemical',
    unit: 'gallon',
    productNumber: 'DCT-002',
  }, adminToken);
  check('Create product DCT-002 (stays active)', r.status === 201, `status=${r.status}`);
  const dctActiveProductId = r.data?.id;
  if (!dctActiveProductId) { fail('Cannot run deactivation tests — product DCT-002 creation failed'); return; }

  // ── Session X: both products active, count DCT-001 only ─────────────────────

  r = await req('POST', '/inventory-sessions', {
    storeId: dctStoreId,
    notes: 'E2E test deactivate X',
  }, adminToken);
  check('Create session X (DCT-001 still active)', r.status === 201, `status=${r.status}`);
  const sessionXId = r.data?.id;
  if (!sessionXId) { fail('Cannot continue — session X creation failed'); return; }

  r = await req('PUT', `/inventory-sessions/${sessionXId}/items`, {
    items: [{ productId: dctProductId, fullContainers: 5, partialContainers: 0 }],
  }, adminToken);
  check('Session X: save 5 full containers of DCT-001', r.status === 200, `count=${r.data?.length}`);

  r = await req('POST', `/inventory-sessions/${sessionXId}/finalize`, {}, adminToken);
  check('Session X: finalized successfully', r.status === 200, `status=${r.status}`);

  const summaryX = r.data?.usageSummary ?? [];
  check(
    'Session X: DCT-001 present in summary',
    summaryX.some(u => u.productId === dctProductId),
    `summaryProductIds=[${summaryX.map(u => u.productId).join(', ')}]`,
  );

  // ── Deactivate DCT-001 between sessions ─────────────────────────────────────

  r = await req('PATCH', `/products/${dctProductId}`, { isActive: false }, adminToken);
  check('Deactivate DCT-001 (PATCH isActive=false)', r.status === 200 && r.data?.isActive === false, `status=${r.status} isActive=${r.data?.isActive}`);

  // Verify the product no longer appears in the active-only product list (as
  // used by the mobile session screen: useListProducts({ activeOnly: true })).
  r = await req('GET', '/products?activeOnly=true', null, adminToken);
  check(
    'DCT-001 absent from activeOnly product list after deactivation',
    Array.isArray(r.data) && !r.data.some(p => p.id === dctProductId),
    `found=${r.data?.some(p => p.id === dctProductId)}`,
  );

  // ── Session Y: only DCT-002 (still active) is counted ───────────────────────

  r = await req('POST', '/inventory-sessions', {
    storeId: dctStoreId,
    notes: 'E2E test deactivate Y',
  }, adminToken);
  check('Create session Y (DCT-001 deactivated)', r.status === 201, `status=${r.status}`);
  const sessionYId = r.data?.id;
  if (!sessionYId) { fail('Cannot continue — session Y creation failed'); return; }

  // Only count the still-active product (DCT-002).
  // DCT-001 would not appear in the active product list on the mobile screen
  // so no count is entered for it.
  r = await req('PUT', `/inventory-sessions/${sessionYId}/items`, {
    items: [{ productId: dctActiveProductId, fullContainers: 3, partialContainers: 0 }],
  }, adminToken);
  check('Session Y: save 3 full containers of DCT-002 (no entry for deactivated DCT-001)', r.status === 200, `count=${r.data?.length}`);

  r = await req('POST', `/inventory-sessions/${sessionYId}/finalize`, {}, adminToken);
  check('Session Y: finalized successfully', r.status === 200, `status=${r.status}`);

  const summaryY = r.data?.usageSummary ?? [];

  // ── Core assertion: deactivated product must not appear in session Y ─────────

  const deactivatedInY = summaryY.find(u => u.productId === dctProductId);
  check(
    'Deactivated DCT-001 absent from session Y usageSummary',
    deactivatedInY === undefined,
    deactivatedInY
      ? `FAIL — found entry: productName=${deactivatedInY.productName} usage=${deactivatedInY.usage}`
      : 'absent (correct)',
  );

  // ── If it does appear, it must not have a non-zero or misleading usage ───────
  if (deactivatedInY !== undefined) {
    check(
      'If deactivated product appears, its usage must be 0 (not stale/wrong)',
      parseFloat(deactivatedInY.usage ?? '1') === 0,
      `usage=${deactivatedInY.usage}`,
    );
  }

  // ── The active product (DCT-002) must be present with correct figures ────────
  const activeInY = summaryY.find(u => u.productId === dctActiveProductId);
  check(
    'Active DCT-002 present in session Y usageSummary',
    activeInY !== undefined,
    `summaryProductIds=[${summaryY.map(u => u.productId).join(', ')}]`,
  );

  // ── GET the finalized session — same invariant must hold ────────────────────
  r = await req('GET', `/inventory-sessions/${sessionYId}`, null, adminToken);
  const getSummaryY = r.data?.usageSummary ?? [];
  const deactivatedInGet = getSummaryY.find(u => u.productId === dctProductId);
  check(
    'GET session Y: deactivated DCT-001 absent from stored usageSummary',
    deactivatedInGet === undefined,
    deactivatedInGet
      ? `FAIL — found entry: productName=${deactivatedInGet.productName} usage=${deactivatedInGet.usage}`
      : 'absent (correct)',
  );
}

// ─── FLOW 16: Invalid estimatedGallons is rejected with 400 ──────────────────
//
// The PUT /inventory-sessions/:id/items handler must validate estimatedGallons
// before writing to the DB.  A malformed value (empty string, "N/A", "NaN",
// negative number) must return HTTP 400 with a descriptive error so the mobile
// app gets an actionable error instead of silently storing a value that would
// produce NaN in computeUsageSummary.

async function testInvalidEstimatedGallons() {
  section('FLOW 16 — Invalid estimatedGallons rejected with 400');

  if (!testStoreId || !testProductId) {
    fail('Invalid-gallons test skipped — missing store or product id');
    return;
  }

  // Create a fresh open session for this flow.
  let r = await req('POST', '/inventory-sessions', {
    storeId: testStoreId,
    notes: 'E2E invalid-gallons test',
  }, adminToken);
  check('Create session for invalid-gallons test', r.status === 201, `status=${r.status}`);
  const igSessionId = r.data?.id;
  if (!igSessionId) { fail('Cannot continue — session creation failed'); return; }

  const badValues = ['', 'N/A', 'NaN', 'abc', '1abc', '-1', '-0.5', 'Infinity'];

  for (const bad of badValues) {
    r = await req('PUT', `/inventory-sessions/${igSessionId}/items`, {
      items: [{ productId: testProductId, fullContainers: 1, partialContainers: 0, estimatedGallons: bad }],
    }, adminToken);
    check(
      `PUT items: estimatedGallons="${bad}" rejected with 400`,
      r.status === 400,
      `status=${r.status} error=${JSON.stringify(r.data?.error)}`,
    );
  }

  // A valid value must still be accepted.
  const validValues = ['0', '3.500', '10', '0.001'];
  for (const good of validValues) {
    r = await req('PUT', `/inventory-sessions/${igSessionId}/items`, {
      items: [{ productId: testProductId, fullContainers: 1, partialContainers: 0, estimatedGallons: good }],
    }, adminToken);
    check(
      `PUT items: estimatedGallons="${good}" accepted (status 200)`,
      r.status === 200,
      `status=${r.status}`,
    );
  }

  // Omitting estimatedGallons entirely must also be accepted.
  r = await req('PUT', `/inventory-sessions/${igSessionId}/items`, {
    items: [{ productId: testProductId, fullContainers: 2, partialContainers: 0 }],
  }, adminToken);
  check('PUT items: omitted estimatedGallons accepted (status 200)', r.status === 200, `status=${r.status}`);

  // ── Malformed prior-session data: guard in computeUsageSummary ─────────────
  // Create a session, set estimatedGallons to a valid value via API, finalize
  // it, then directly inject -1 into the DB (a numeric value that passes
  // PostgreSQL's type check but is negative — simulating pre-validation-era
  // bad data).  The next session's computeUsageSummary must fall back to
  // fullContainers rather than carrying forward -1 as previousCount.

  // Isolated store so history is clean.
  r = await req('POST', '/stores', {
    name: 'Malformed Gallons Prior Store',
    storeNumber: 'MLD-E2E',
    city: 'Malformed City',
    state: 'OR',
  }, adminToken);
  check('Malformed prior: create isolated store', r.status === 201, `status=${r.status}`);
  const mldStoreId = r.data?.id;
  if (!mldStoreId) {
    fail('Malformed prior: cannot continue — store creation failed');
    return;
  }

  // Session 1: save valid estimatedGallons ("5.000", fullContainers=3).
  r = await req('POST', '/inventory-sessions', {
    storeId: mldStoreId,
    notes: 'E2E malformed prior session 1',
  }, adminToken);
  check('Malformed prior: create session 1', r.status === 201, `status=${r.status}`);
  const mldSession1Id = r.data?.id;
  if (!mldSession1Id) { fail('Malformed prior: session 1 creation failed'); return; }

  r = await req('PUT', `/inventory-sessions/${mldSession1Id}/items`, {
    items: [{ productId: testProductId, fullContainers: 3, partialContainers: 0, estimatedGallons: '5.000' }],
  }, adminToken);
  check('Malformed prior: save session 1 items (estimatedGallons="5.000")', r.status === 200, `status=${r.status}`);

  r = await req('POST', `/inventory-sessions/${mldSession1Id}/finalize`, {}, adminToken);
  check('Malformed prior: finalize session 1', r.status === 200, `status=${r.status}`);

  // Directly inject -1 into estimated_gallons (simulates pre-validation era bad data).
  // PostgreSQL accepts -1 as a valid numeric but it is negative, so
  // computeUsageSummary's guard must fall back to fullContainers=3.
  {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    try {
      await execAsync(
        `psql "$DATABASE_URL" -c "UPDATE inventory_session_items SET estimated_gallons = -1 WHERE session_id = ${mldSession1Id} AND product_id = ${testProductId}"`,
      );
      check('Malformed prior: injected -1 into prior session estimated_gallons via psql', true, '');
    } catch (e) {
      fail('Malformed prior: psql injection failed', e.message);
      return;
    }
  }

  // Session 2: new count for the same store.
  r = await req('POST', '/inventory-sessions', {
    storeId: mldStoreId,
    notes: 'E2E malformed prior session 2',
  }, adminToken);
  check('Malformed prior: create session 2', r.status === 201, `status=${r.status}`);
  const mldSession2Id = r.data?.id;
  if (!mldSession2Id) { fail('Malformed prior: session 2 creation failed'); return; }

  r = await req('PUT', `/inventory-sessions/${mldSession2Id}/items`, {
    items: [{ productId: testProductId, fullContainers: 2, partialContainers: 0 }],
  }, adminToken);
  check('Malformed prior: save session 2 items (fullContainers=2)', r.status === 200, `status=${r.status}`);

  r = await req('POST', `/inventory-sessions/${mldSession2Id}/finalize`, {}, adminToken);
  check('Malformed prior: finalize session 2', r.status === 200, `status=${r.status}`);

  const mldSummary = r.data?.usageSummary;
  const mldItem = mldSummary?.find(i => i.productId === testProductId);

  // previousCount must NOT be "-1" (the malformed value); the guard must have
  // fallen back to fullContainers=3 from session 1.
  check(
    'Malformed prior: previousCount falls back to fullContainers (not malformed -1)',
    mldItem?.previousCount === '3' && mldItem?.previousCount !== '-1',
    `previousCount=${mldItem?.previousCount}`,
  );
  // usage must be a valid number — not "NaN".
  check(
    'Malformed prior: usage is a valid number (not NaN)',
    mldItem?.usage !== 'NaN' && mldItem?.usage !== undefined && isFinite(parseFloat(mldItem?.usage ?? 'NaN')),
    `usage=${mldItem?.usage}`,
  );
}

// ─── FLOW 17: admin-edit on open session must not write a snapshot ────────────
//
// The admin-edit route only writes a new usageSummarySnapshot when the session
// status is "finalized".  Calling it on an *open* session must:
//   (a) leave usageSummarySnapshot null (no partial snapshot written),
//   (b) return usageSummary=null in the response,
//   (c) still allow the session to be finalized normally, producing a correct
//       snapshot at that point.
//
// Without this guard a partial snapshot written during an open session would be
// served by GET once the session is finalized, potentially overriding the real
// finalization snapshot.

async function testAdminEditOpenSessionSnapshotFlow() {
  section('FLOW 17 — admin-edit on open session: snapshot must stay null');

  if (!testProductId) { fail('Open-session snapshot test skipped — no product id'); return; }

  // Isolated store so session history is clean.
  let r = await req('POST', '/stores', {
    name: 'Open Snapshot Test Store',
    storeNumber: 'OSS-E2E',
    city: 'Open City',
    state: 'OR',
  }, adminToken);
  check('Create open-snapshot test store', r.status === 201, `status=${r.status}`);
  const ossStoreId = r.data?.id;
  if (!ossStoreId) { fail('Cannot run open-snapshot tests — store creation failed'); return; }

  // Create an open session and add items.
  r = await req('POST', '/inventory-sessions', {
    storeId: ossStoreId,
    notes: 'E2E open-snapshot test',
  }, adminToken);
  check('Create open session', r.status === 201, `status=${r.status}`);
  const ossSessionId = r.data?.id;
  if (!ossSessionId) { fail('Cannot continue — open session creation failed'); return; }

  r = await req('PUT', `/inventory-sessions/${ossSessionId}/items`, {
    items: [{ productId: testProductId, fullContainers: 3, partialContainers: 0 }],
  }, adminToken);
  check('Save items on open session (3 full containers)', r.status === 200, `count=${r.data?.length}`);

  // Log a delivery before admin-edit (so there is something to compute).
  r = await req('POST', '/receiving-records', {
    storeId: ossStoreId,
    vendor: 'OSS Supplier',
    invoiceNumber: 'OSS-INV-PRE',
    items: [{ productId: testProductId, quantityReceived: '5', lotNumber: 'LOT-OSS-PRE', cost: '12.00' }],
  }, adminToken);
  check('Log delivery on open session (5 units)', r.status === 201, `status=${r.status}`);

  // Call admin-edit on the open session — must succeed (200) and return usageSummary=null.
  r = await req(
    'PUT',
    `/inventory-sessions/${ossSessionId}/items/admin-edit`,
    { items: [{ productId: testProductId, fullContainers: 4, partialContainers: 0 }] },
    adminToken,
  );
  check('admin-edit on open session succeeds (200)', r.status === 200, `status=${r.status}`);
  check(
    'admin-edit response: usageSummary is null for open session',
    r.data?.usageSummary === null || r.data?.usageSummary === undefined,
    `usageSummary=${JSON.stringify(r.data?.usageSummary)}`,
  );

  // GET the session immediately after admin-edit — usageSummary must still be null.
  r = await req('GET', `/inventory-sessions/${ossSessionId}`, null, adminToken);
  check('GET open session after admin-edit: status is still open', r.data?.status === 'open', `status=${r.data?.status}`);
  check(
    'GET open session after admin-edit: usageSummary is null (no premature snapshot)',
    r.data?.usageSummary === null || r.data?.usageSummary === undefined,
    `usageSummary=${JSON.stringify(r.data?.usageSummary)}`,
  );

  // Verify the item update from admin-edit was persisted (fullContainers now 4).
  const ossItem = r.data?.items?.find(i => i.productId === testProductId);
  check(
    'admin-edit item update persisted on open session (fullContainers=4)',
    ossItem?.fullContainers === 4,
    `fullContainers=${ossItem?.fullContainers}`,
  );

  // Finalize the session normally — must produce a correct snapshot.
  // items: fullContainers=4 (admin-edit value); received=5; no prior session → previousCount=0
  // usage = max(0, 0 + 5 − 4) = 1.000
  r = await req('POST', `/inventory-sessions/${ossSessionId}/finalize`, {}, adminToken);
  check('Finalize open-snapshot session succeeds', r.status === 200, `status=${r.status}`);
  check('Finalized session status is "finalized"', r.data?.status === 'finalized', `status=${r.data?.status}`);

  const finalSummary = r.data?.usageSummary;
  const finalItem = finalSummary?.find(i => i.productId === testProductId);
  const expectedFinalUsage = Math.max(0, 0 + 5 - 4).toFixed(3); // '1.000'

  check(
    'Finalize: usageSummary is present (not null)',
    Array.isArray(finalSummary) && finalSummary.length > 0,
    `summaryLength=${finalSummary?.length}`,
  );
  check(
    `Finalize: usage reflects admin-edited count (expected ${expectedFinalUsage})`,
    finalItem?.usage === expectedFinalUsage,
    `usage=${finalItem?.usage} expected=${expectedFinalUsage}`,
  );
  check(
    'Finalize: previousCount is "0" (no prior finalized session)',
    finalItem?.previousCount === '0',
    `previousCount=${finalItem?.previousCount}`,
  );

  // GET the finalized session — snapshot must match finalize response.
  r = await req('GET', `/inventory-sessions/${ossSessionId}`, null, adminToken);
  const getItem = r.data?.usageSummary?.find(i => i.productId === testProductId);
  check(
    'GET finalized session: usageSummary snapshot matches finalize response',
    getItem?.usage === expectedFinalUsage && getItem?.previousCount === '0',
    `GET usage=${getItem?.usage} previousCount=${getItem?.previousCount}`,
  );
}

// ─── FLOW 9: Store scoping / access control ───────────────────────────────────

async function testAccessControl() {
  section('FLOW 9 — Access control & store scoping');

  // 8a: store user cannot see other stores
  const otherStoreId = testStoreId + 999;
  let r = await req('GET', `/stores/${otherStoreId}`, null, storeUserToken);
  // store user can list stores (read-only) but inventory/records are scoped
  // GET /stores is not restricted; GET /inventory-sessions enforces scoping
  
  // 8b: store user inventory sessions scoped to own store
  r = await req('GET', '/inventory-sessions', null, storeUserToken);
  check('Store user inventory list scoped', r.status === 200 && r.data?.every(s => s.storeId === testStoreId), `count=${r.data?.length}`);

  // 8c: store user cannot create for other store
  r = await req('POST', '/inventory-sessions', { storeId: otherStoreId }, storeUserToken);
  check('Store user blocked from creating session for other store', r.status === 403, `status=${r.status}`);

  // 8d: store user cannot access admin routes
  r = await req('POST', '/stores', { name: 'Hack', storeNumber: 'H-001' }, storeUserToken);
  check('Store user cannot create stores', r.status === 403, `status=${r.status}`);

  r = await req('POST', '/users', { name: 'Hack', pin: '0000', role: 'admin' }, storeUserToken);
  check('Store user cannot create users', r.status === 403, `status=${r.status}`);

  // 8e: store_user is blocked from the admin-edit endpoint on a finalized session (must be 403)
  if (testSessionId && testProductId) {
    r = await req(
      'PUT',
      `/inventory-sessions/${testSessionId}/items/admin-edit`,
      { items: [{ productId: testProductId, fullContainers: 1, partialContainers: 0 }] },
      storeUserToken,
    );
    check(
      'Store user blocked from admin-edit on finalized session (403)',
      r.status === 403,
      `status=${r.status}`,
    );

    // 8f: admin token succeeds on the same endpoint (must be 200)
    r = await req(
      'PUT',
      `/inventory-sessions/${testSessionId}/items/admin-edit`,
      { items: [{ productId: testProductId, fullContainers: 1, partialContainers: 0 }] },
      adminToken,
    );
    check(
      'Admin can use admin-edit on finalized session (200)',
      r.status === 200,
      `status=${r.status}`,
    );
  } else {
    pass('Admin-edit access-control checks skipped — no finalized session or product available');
  }

  // 8g: store_user cannot finalize a session belonging to a different store (cross-store scoping)
  //     The finalize route enforces canAccessStore, which compares the session's storeId to the
  //     store_user's assigned storeId.  A session in any other store must return 403.
  {
    // Create a second store that the store_user has no access to
    r = await req('POST', '/stores', { name: 'Other Store AC', storeNumber: 'AC-E2E', city: 'Salem', state: 'OR' }, adminToken);
    check('Create other-store for cross-store finalize test', r.status === 201, `status=${r.status}`);
    const otherAcStoreId = r.data?.id;

    if (otherAcStoreId) {
      // Admin creates an open session in that other store
      r = await req('POST', '/inventory-sessions', { storeId: otherAcStoreId, notes: 'AC cross-store test' }, adminToken);
      check('Create other-store open session (admin)', r.status === 201, `status=${r.status}`);
      const otherAcSessionId = r.data?.id;

      if (otherAcSessionId) {
        // store_user (scoped to testStoreId) tries to finalize a session in the other store
        r = await req('POST', `/inventory-sessions/${otherAcSessionId}/finalize`, {}, storeUserToken);
        check(
          'Store user cannot finalize session from another store — cross-store scoping returns 403',
          r.status === 403,
          `status=${r.status}`,
        );
      } else {
        fail('Cross-store finalize test skipped — other-store session creation failed');
      }
    } else {
      fail('Cross-store finalize test skipped — other-store creation failed');
    }
  }

  // 8h: same-store ownership — admin creates a session in the store_user's own store;
  //     the store_user is blocked from finalizing it because they are not the creator (403).
  //     This confirms that canAccessStore (store scoping) and per-creator ownership are both
  //     enforced on the finalize route: a store_user needs BOTH store membership AND authorship.
  {
    r = await req('POST', '/inventory-sessions', { storeId: testStoreId, notes: 'AC same-store ownership test' }, adminToken);
    check('Create same-store open session (admin) for ownership test', r.status === 201, `status=${r.status}`);
    const sameStoreAcSessionId = r.data?.id;

    if (sameStoreAcSessionId) {
      // store_user tries to finalize a session in their own store that was created by admin —
      // must be denied because the store_user is not the session creator.
      r = await req('POST', `/inventory-sessions/${sameStoreAcSessionId}/finalize`, {}, storeUserToken);
      check(
        'Store user cannot finalize same-store session they did not create (403)',
        r.status === 403,
        `status=${r.status}`,
      );

      // Admin can still finalize that same session (admins bypass creator check).
      r = await req('POST', `/inventory-sessions/${sameStoreAcSessionId}/finalize`, {}, adminToken);
      check(
        'Admin can finalize any same-store session regardless of creator (200)',
        r.status === 200,
        `status=${r.status}`,
      );
    } else {
      fail('Same-store ownership test skipped — session creation failed');
    }
  }
}

// ─── FLOW 18: AI Report — encrypted-key path and response-shape validation ────
//
// Sub-scenarios run against an isolated child server on port 9001 that has
// XAI_API_KEY removed from its environment.  The test-only provider mock makes
// the configured-key, response-shape, and quota-error assertions deterministic:
//
//   18d–e — DB has an encrypted dummy key, env has no XAI_API_KEY, and the
//           provider request is redirected to the local mock. A 200 proves the
//           encrypted key was resolved and the response shape is preserved.
//   18e-error — the mock returns a quota-style 429 and the API must return 502.
//   18f — DB key cleared, child still has no XAI_API_KEY → 503 proves the
//         no-key guard fires and does not hang.
//
// A snapshot/restore pair preserves the exact original DB row (including the
// encrypted key blob) without ever decrypting it, so the suite is safe to run
// against a configured production database.

async function testAiReport() {
  section('FLOW 18 — AI Report: encrypted-key path + response-shape validation');

  const { spawn } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { exec } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const { existsSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const execAsync = promisify(exec);

  // Derive portable paths from this file's location (works on any checkout)
  const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
  const WORKSPACE_DIR = dirname(SCRIPTS_DIR);
  const TSX          = join(SCRIPTS_DIR, 'node_modules', '.bin', 'tsx');
  const API_BUNDLE   = join(WORKSPACE_DIR, 'artifacts', 'api-server', 'dist', 'index.mjs');
  const SNAP_SCRIPT  = join(SCRIPTS_DIR, 'snapshot-ai-config.ts');
  const REST_SCRIPT  = join(SCRIPTS_DIR, 'restore-ai-config.ts');
  const CLEAR_SCRIPT = join(SCRIPTS_DIR, 'clear-ai-config-key.ts');

  // ── 18a: auth guard — no token ────────────────────────────────────────────
  let r = await req('POST', '/ai/report', { query: 'Executive summary', days: 7 }, null);
  check('AI report: 401 without auth token', r.status === 401, `status=${r.status}`);

  // ── 18b: auth guard — non-admin ───────────────────────────────────────────
  r = await req('POST', '/ai/report', { query: 'Executive summary', days: 7 }, storeUserToken);
  check('AI report: 403 for non-admin (store_user)', r.status === 403, `status=${r.status}`);

  const SNAPSHOT_DIR = mkdtempSync(join(tmpdir(), 'e2e-ai-'));
  const SNAP_FILE    = join(SNAPSHOT_DIR, 'ai-config-snapshot.json');
  let childProc = null;
  let putRowId = 0; // id returned by PUT /ai/config — used by restore to target only this row
  let snapshotReady = false;
  let forcedRestoreFailureObserved = false;

  try {
    // ── 18c: snapshot original config row (preserves encrypted blob as-is) ───
    await execAsync(`${TSX} ${SNAP_SCRIPT} ${SNAP_FILE}`);
    snapshotReady = true;
    pass('AI report 18c: original AI config snapshotted');

    // ── 18d: store test key encrypted in DB via PUT /ai/config ───────────
    await startMockAiServer();
    const testApiKey = 'e2e-report-test-key';
    const putR = await req('PUT', '/ai/config', { provider: 'grok', apiKey: testApiKey }, adminToken);
    putRowId = putR.data?.id ?? 0;
    check('PUT /ai/config: hasApiKey=true after storing key', putR.data?.hasApiKey === true, `hasApiKey=${putR.data?.hasApiKey}`);

    // ── 18e: child server WITHOUT XAI_API_KEY proves decrypt() path ───────
    // DB has apiKeyEncrypted set; child has no env-var fallback.
    // A 200 response from the local mock means decrypt() produced a usable key
    // (env fallback absent) and the route preserved the report response shape.
    // A 503 would mean the code fell through to the "no key" branch — a bug.
    const childEnv = { ...process.env };
    delete childEnv.XAI_API_KEY;
    childEnv.PORT = '9001';

    childProc = spawn('node', ['--enable-source-maps', API_BUNDLE], { env: childEnv, stdio: 'pipe' });

    // Wait up to 12 s for the child to open its health endpoint
    let childReady = false;
    for (let i = 0; i < 24 && !childReady; i++) {
      await new Promise(res => setTimeout(res, 500));
      try {
        const probe = await fetch('http://localhost:9001/api/healthz', { signal: AbortSignal.timeout(1000) });
        if (probe.ok) childReady = true;
      } catch { /* not yet */ }
    }

    if (!childReady) {
      fail('AI report 18e: child server did not start — encrypted-key test skipped');
    } else {
      // Login on child (same DB, same admin credentials)
      const loginRes = await fetch('http://localhost:9001/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'TestAdmin', pin: '1234' }),
        signal: AbortSignal.timeout(5000),
      });
      const { token: childToken } = await loginRes.json();
      check('AI report 18e: child server login returns token', typeof childToken === 'string' && childToken.length > 0, `len=${childToken?.length}`);

      // POST /ai/report — decrypt() is the only available key source
      const encR = await fetch('http://localhost:9001/api/ai/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${childToken}`,
          'X-Test-Ai-Url': `http://localhost:${MOCK_AI_PORT}/report`,
        },
        body: JSON.stringify({ query: 'Generate an executive inventory summary', days: 7 }),
        signal: AbortSignal.timeout(90_000),
      });

      if (encR.status === 200) {
        // ── 18e-200: full response-shape validation ───────────────────────
        const rep = await encR.json();
        check('AI report 200: decrypt() path produced a real report', true, 'status=200');
        check('AI report 200: title (non-empty string)', typeof rep?.title === 'string' && rep.title.length > 0, `title="${rep?.title}"`);
        check('AI report 200: overview (string)', typeof rep?.overview === 'string', `type ok`);
        check('AI report 200: keyFindings (array)', Array.isArray(rep?.keyFindings), `type=${typeof rep?.keyFindings}`);
        check('AI report 200: anomalies (array)', Array.isArray(rep?.anomalies), `type=${typeof rep?.anomalies}`);
        check('AI report 200: recommendations (array)', Array.isArray(rep?.recommendations), `type=${typeof rep?.recommendations}`);
        check('AI report 200: risks (array)', Array.isArray(rep?.risks), `type=${typeof rep?.risks}`);
        check('AI report 200: confidence 0–1', typeof rep?.confidence === 'number' && rep.confidence >= 0 && rep.confidence <= 1, `confidence=${rep?.confidence}`);
        check('AI report 200: dataQuality valid enum', ['complete', 'partial', 'insufficient'].includes(rep?.dataQuality), `dataQuality=${rep?.dataQuality}`);
        check('AI report 200: dataQualityNote is string', typeof rep?.dataQualityNote === 'string', `dataQualityNote="${rep?.dataQualityNote}"`);
        check('AI report 200: generatedAt ISO string', typeof rep?.generatedAt === 'string' && !isNaN(Date.parse(rep.generatedAt)), `generatedAt=${rep?.generatedAt}`);
        check('AI report 200: periodDays=7 echoed', rep?.periodDays === 7, `periodDays=${rep?.periodDays}`);
        check('AI report 200: storeCount number', typeof rep?.storeCount === 'number', `storeCount=${rep?.storeCount}`);
        check('AI report 200: sessionCount number', typeof rep?.sessionCount === 'number', `sessionCount=${rep?.sessionCount}`);
        check('AI report 200: alertCount number', typeof rep?.alertCount === 'number', `alertCount=${rep?.alertCount}`);
        check('AI report 200: reorderForecasts array', Array.isArray(rep?.reorderForecasts), `type=${typeof rep?.reorderForecasts}`);
        const forecastStatuses = (rep?.reorderForecasts ?? []).every((forecast) =>
          ['calculated', 'partial', 'unavailable'].includes(forecast?.status) &&
          typeof forecast?.statusReason === 'string' &&
          typeof forecast?.inputs?.verifiedSnapshotCount === 'number' &&
          typeof forecast?.inputs?.basisDays === 'number' &&
          typeof forecast?.inputs?.receivedDuringBasis === 'number',
        );
        check('AI report 200: forecasts expose evidence status and inputs', forecastStatuses, `count=${rep?.reorderForecasts?.length ?? 0}`);
        const calculatedForecasts = (rep?.reorderForecasts ?? []).filter((forecast) => forecast?.status === 'calculated');
        const calculatedFieldsAreComplete = calculatedForecasts.every((forecast) =>
          typeof forecast?.consumptionRatePerDay === 'number' &&
          typeof forecast?.daysOfSupply === 'number' &&
          typeof forecast?.daysUntilReorder === 'number' &&
          typeof forecast?.suggestedQuantity === 'number',
        );
        check('AI report 200: calculated forecasts include reorder timing and quantity', calculatedFieldsAreComplete, `calculated=${calculatedForecasts.length}`);
      } else {
        const body = await encR.json().catch(() => ({}));
        fail('AI report 18e: encrypted key did not produce a report', `status=${encR.status} error=${body?.error ?? ''}`);
      }

      // ── 18e-error: quota/provider errors remain visible as 502 ─────────
      // This validates the provider-error path without depending on a real
      // provider or consuming credits.
      const providerErrorRes = await fetch('http://localhost:9001/api/ai/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${childToken}`,
          'X-Test-Ai-Url': `http://localhost:${MOCK_AI_PORT}/report-error`,
        },
        body: JSON.stringify({ query: 'Generate an executive inventory summary', days: 7 }),
        signal: AbortSignal.timeout(15_000),
      });
      check(
        'AI report 18e-error: provider quota error returns 502',
        providerErrorRes.status === 502,
        `status=${providerErrorRes.status}`,
      );
      if (providerErrorRes.status === 502) {
        const body = await providerErrorRes.json().catch(() => ({}));
        check(
          'AI report 18e-error: 502 preserves provider error details',
          typeof body?.error === 'string' && body.error.includes('insufficient_quota'),
          `error="${body?.error}"`,
        );
      }

      // ── 18f: 503 guard — clear DB key, same child (still no env var) ────
      // After clearing: child has no apiKeyEncrypted in DB AND no XAI_API_KEY
      // in env → POST /ai/report must return 503, not hang.
      await execAsync(`${TSX} ${CLEAR_SCRIPT} ${putRowId}`);
      pass('AI report 18f: cleared stored key from DB (row-scoped)');

      const noKeyRes = await fetch('http://localhost:9001/api/ai/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${childToken}` },
        body: JSON.stringify({ query: 'Summary', days: 7 }),
        signal: AbortSignal.timeout(15_000),
      });
      check('AI report 18f: no stored key + no XAI_API_KEY → 503', noKeyRes.status === 503, `status=${noKeyRes.status}`);
      if (noKeyRes.status === 503) {
        const body = await noKeyRes.json().catch(() => ({}));
        check('AI report 18f: 503 body has error string', typeof body?.error === 'string' && body.error.length > 0, `error="${body?.error}"`);
      }
    }
  } catch (err) {
    fail('AI report FLOW 18: unexpected error', err?.message?.slice(0, 150) ?? String(err));
  } finally {
    // Kill child server and drain port 9001
    if (childProc) {
      childProc.kill();
      await new Promise(res => setTimeout(res, 600));
    }
    try {
      // Restore the exact original AI config row from the snapshot (including
      // the original encrypted key blob — never decrypted).
      // Pass putRowId so the restore script can delete that specific row when
      // no row existed before the test (avoiding unqualified deletes).
      if (snapshotReady) {
        try {
          await execAsync(`${TSX} ${REST_SCRIPT} ${SNAP_FILE} ${putRowId}`);
          pass('AI report 18: restored original AI configuration');
        } catch (restoreErr) {
          fail(
            'AI report 18: failed to restore original AI configuration',
            restoreErr?.message?.slice(0, 150) ?? String(restoreErr),
          );
        }

        // Restore once successfully before deliberately using a missing
        // snapshot. This forces the cleanup error path without leaving the
        // temporary encrypted report-test key in the database.
        try {
          await execAsync(`${TSX} ${REST_SCRIPT} ${join(SNAPSHOT_DIR, 'missing-ai-config-snapshot.json')} ${putRowId}`);
          fail('AI report 18: forced restore failure unexpectedly succeeded');
        } catch (forcedRestoreErr) {
          forcedRestoreFailureObserved = true;
          pass(
            'AI report 18: forced restore failure was reported before snapshot cleanup',
            forcedRestoreErr?.message?.slice(0, 150) ?? String(forcedRestoreErr),
          );
        }
      }
    } catch (restoreErr) {
      fail(
        'AI report 18: cleanup failed unexpectedly',
        restoreErr?.message?.slice(0, 150) ?? String(restoreErr),
      );
    } finally {
      rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
    }
  }

  check(
    'AI report 18: forced restore failure exercised cleanup handling',
    snapshotReady && forcedRestoreFailureObserved,
  );
  check(
    'AI report 18: temporary snapshot file removed after restore failure',
    !existsSync(SNAP_FILE),
    `exists=${existsSync(SNAP_FILE)}`,
  );
  check(
    'AI report 18: temporary snapshot directory removed after restore failure',
    !existsSync(SNAPSHOT_DIR),
    `exists=${existsSync(SNAPSHOT_DIR)}`,
  );
}

// ─── Summary ──────────────────────────────────────────────────────────────────

async function printSummary() {
  const passed = RESULTS.filter(r => r.ok).length;
  const failed = RESULTS.filter(r => !r.ok).length;
  const total = RESULTS.length;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  RESULTS: ${passed}/${total} passed  (${failed} failed)`);
  console.log('═'.repeat(60));

  if (failed > 0) {
    console.log('\n  FAILURES:');
    RESULTS.filter(r => !r.ok).forEach(r => {
      console.error(`  ❌ ${r.label}: ${r.detail}`);
    });
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

// ─── Teardown: delete all test artefacts created during this run ──────────────

async function teardown() {
  // Stop the mock AI server if it was started during this run.
  stopMockAiServer();

  section('TEARDOWN — Remove test artefacts');
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);
  try {
    const { stdout } = await execAsync(
      '/home/runner/workspace/scripts/node_modules/.bin/tsx /home/runner/workspace/scripts/seed-test-user.ts',
      { env: { ...process.env, CLEANUP_ONLY: '1' } },
    );
    console.log(stdout.split('\n').map(l => '  ' + l).join('\n'));
    console.log('  ✅ Teardown complete');
  } catch (e) {
    // Log but do not re-throw — a teardown failure must not suppress the real
    // test results that are about to be printed / have already been printed.
    console.error('  ⚠️  Teardown encountered an error (test results above are still valid)');
    console.error('  ' + e.message);
  }

  // ── Verify the cleanup actually removed all test rows ─────────────────────
  // A teardown that logs "✅" but leaves orphaned rows will corrupt the next
  // run.  Run the verification script and record a pass/fail so the suite
  // exits non-zero when the DB is not clean.
  section('TEARDOWN VERIFICATION — Confirm zero orphaned rows');
  try {
    const { stdout: verifyOut } = await execAsync(
      '/home/runner/workspace/scripts/node_modules/.bin/tsx /home/runner/workspace/scripts/verify-teardown.ts',
    );
    console.log(verifyOut.split('\n').map(l => '  ' + l).join('\n'));
    pass('Teardown verification: all test rows wiped from DB');
  } catch (verifyErr) {
    // execAsync rejects when the child process exits non-zero.
    // stdout is still populated with the per-table counts; show it so the
    // developer can see exactly which table still has rows.
    const output = verifyErr.stdout ?? '';
    if (output) {
      console.error(output.split('\n').map(l => '  ' + l).join('\n'));
    }
    console.error('  ' + (verifyErr.stderr ?? verifyErr.message ?? ''));
    fail('Teardown verification: orphaned test data remains in the DB', 'see row counts above');
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  Synthetic Solutions — E2E Integration Tests');
  console.log('═'.repeat(60));

  await seedAdmin();
  try {
    for (const [flowName, flowFn] of [
      ['testAuth', testAuth],
      ['testAdmin', testAdmin],
      ['testWarehouses', testWarehouses],
      ['testProducts', testProducts],
      ['testNotificationDevices', testNotificationDevices],
      ['testInventoryPushTransitions', testInventoryPushTransitions],
      ['testWarehouseLedgerFlow', testWarehouseLedgerFlow],
      ['testInventoryFlow', testInventoryFlow],
      ['testUsageSummaryFlow', testUsageSummaryFlow],
      ['testUsageSummaryPanelFlow', testUsageSummaryPanelFlow],
      ['testUsageSummaryEstimatedGallonsFlow', testUsageSummaryEstimatedGallonsFlow],
      ['testMixedEstimatedGallonsFlow', testMixedEstimatedGallonsFlow],
      ['testFinalizedSessionSnapshotFlow', testFinalizedSessionSnapshotFlow],
      ['testUsagePanelAfterAdminEditFlow', testUsagePanelAfterAdminEditFlow],
      ['testDeactivatedProductFlow', testDeactivatedProductFlow],
      ['testAdminEditOpenSessionSnapshotFlow', testAdminEditOpenSessionSnapshotFlow],
      ['testInvalidEstimatedGallons', testInvalidEstimatedGallons],
      ['testDeliveryFlow', testDeliveryFlow],
      ['testDashboard', testDashboard],
      ['testAiSnapshotFailureExit', testAiSnapshotFailureExit],
      ['testAiChat', testAiChat],
      ['testAiChatStaleSession', testAiChatStaleSession],
      ['testAiReport', testAiReport],
      ['testAccessControl', testAccessControl],
    ]) {
      try {
        await flowFn();
      } catch (err) {
        // A hung request throws a timeout error from req(); catch it here so the
        // summary table stays accurate and the run doesn't freeze with a raw FATAL.
        const msg = err?.message ?? String(err);
        fail(`${flowName} — unexpected error`, msg);
        console.error(`  ⚠️  ${flowName} aborted: ${msg}`);
      }
    }
  } finally {
    // Always clean up and print results, whether the suite passed, failed, or
    // a flow threw mid-run.
    await teardown();
    await printSummary();
  }
}

// ─── Signal handlers: ensure teardown runs on Ctrl-C / kill ──────────────────
// Node exits immediately on SIGINT/SIGTERM without running finally blocks, so
// we intercept the signals, run the same teardown, then re-exit with the
// conventional code (130 for SIGINT, 143 for SIGTERM).

let _tearingDown = false;

async function handleSignal(signal) {
  if (_tearingDown) return; // prevent double-teardown if both signals arrive
  _tearingDown = true;
  const code = signal === 'SIGINT' ? 130 : 143;
  console.error(`\n\n  ⚠️  ${signal} received — running teardown before exit …`);
  try {
    await teardown();
  } catch {
    // teardown() already swallows its own errors; this is a last-resort guard
  }
  process.exit(code);
}

process.on('SIGINT',  () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

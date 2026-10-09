const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");

process.env.JWT_SECRET = "api-test-jwt-secret-that-is-long-enough";
process.env.RESULTS_INTEGRATION_KEY = "api-test-integration-key-that-is-long-enough";
process.env.AFRICASTALKING_DELIVERY_TOKEN = "api-test-delivery-token-that-is-long-enough";
process.env.SMS_DELIVERY_ENABLED = "false";

const fakePool = {
  async testConnection() {
    return { ok: true, host: "test-db", database: "test-results" };
  },
};
const smsStub = {
  deliveryReportsConfigured: true,
  deliveryTokenMatches: (candidate) => candidate === process.env.AFRICASTALKING_DELIVERY_TOKEN,
  processDeliveryReport: async () => ({ accepted: true, duplicate: false }),
  smsDeliveryConfigured: false,
  startSmsWorker() {},
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "./config/db" && parent?.filename.endsWith("server.js")) return fakePool;
  if (request === "./smsDelivery" && parent?.filename.endsWith("server.js")) return smsStub;
  return originalLoad.call(this, request, parent, isMain);
};

const { app, integrationKeyMatches, validateResultsBatch, validateStudentRecord } = require("../server");
Module._load = originalLoad;

let server;
let baseUrl;
test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server?.listening) {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

const validBatch = {
  sourceSystem: "school-results",
  batchId: "api-contract-test-2026",
  examName: "Term 1",
  term: "Term 1",
  year: 2026,
  status: "APPROVED",
  students: [{
    admissionNumber: "API-TEST-1",
    name: "Test Learner",
    className: "Form 1",
    guardians: [{ name: "Test Guardian", phone: "+263771234567", isPrimary: true }],
    results: [{ externalResultId: "api-test-result-1", subject: "Maths", score: 80 }],
  }],
};

test("validates an approved results batch and rejects unapproved or invalid contacts", () => {
  assert.equal(validateResultsBatch(validBatch), null);
  assert.match(validateResultsBatch({ ...validBatch, status: "DRAFT" }), /Only batches with status APPROVED/);
  assert.match(validateResultsBatch({
    ...validBatch,
    students: [{ ...validBatch.students[0], guardians: [{ name: "Guardian", phone: "0771234567" }] }],
  }), /international format/);
  assert.match(validateResultsBatch({
    ...validBatch,
    students: [{ ...validBatch.students[0], results: [{ ...validBatch.students[0].results[0], score: 101 }] }],
  }), /score from 0 to 100/);
});

test("validates learner registrations and guardian phone and primary-contact rules", () => {
  const learner = {
    name: "Test Learner",
    admissionNumber: "MS-2026-001",
    className: "Form 1",
    year: 2026,
    guardians: [{ name: "Test Guardian", phone: "+255712345678", isPrimary: true }],
  };

  assert.equal(validateStudentRecord(learner), null);
  assert.equal(validateStudentRecord({ ...learner, guardians: [] }), null);
  assert.match(validateStudentRecord({ ...learner, guardians: [{ ...learner.guardians[0], isPrimary: false }] }), /exactly one primary guardian/);
  assert.match(validateStudentRecord({
    ...learner,
    guardians: [
      learner.guardians[0],
      { name: "Second Guardian", phone: "+255712345678", isPrimary: false },
    ],
  }), /same guardian phone number more than once/);
  assert.match(validateStudentRecord({ ...learner, year: 1999 }), /Enrollment year/);
});

test("checks the integration key using fixed-length digest comparison", () => {
  assert.equal(integrationKeyMatches(process.env.RESULTS_INTEGRATION_KEY), true);
  assert.equal(integrationKeyMatches("wrong-key"), false);
  assert.equal(integrationKeyMatches(undefined), false);
});

test("reports backend dependency readiness without exposing secrets", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.dbConnected, true);
  assert.equal(body.resultsIntegrationConfigured, true);
  assert.equal(body.smsDeliveryConfigured, false);
  assert.equal(body.smsDeliveryReportsConfigured, true);
  assert.equal(JSON.stringify(body).includes(process.env.RESULTS_INTEGRATION_KEY), false);
  assert.equal(JSON.stringify(body).includes(process.env.AFRICASTALKING_DELIVERY_TOKEN), false);
});

test("rejects unauthenticated, malformed, or unapproved results integration calls", async () => {
  const noKeyResponse = await fetch(`${baseUrl}/api/integrations/results/batches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Integration-Dry-Run": "true",
    },
    body: JSON.stringify(validBatch),
  });
  assert.equal(noKeyResponse.status, 401);

  const draftResponse = await fetch(`${baseUrl}/api/integrations/results/batches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Integration-Key": process.env.RESULTS_INTEGRATION_KEY,
    },
    body: JSON.stringify({ ...validBatch, status: "DRAFT" }),
  });
  assert.equal(draftResponse.status, 400);
  assert.match((await draftResponse.json()).message, /Only batches with status APPROVED/);

  const badPhoneResponse = await fetch(`${baseUrl}/api/integrations/results/batches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Integration-Key": process.env.RESULTS_INTEGRATION_KEY,
    },
    body: JSON.stringify({
      ...validBatch,
      students: [{ ...validBatch.students[0], guardians: [{ name: "Guardian", phone: "0771234567" }] }],
    }),
  });
  assert.equal(badPhoneResponse.status, 400);
  assert.match((await badPhoneResponse.json()).message, /international format/);
});

test("validates integration batches in dry-run mode without importing results", async () => {
  const response = await fetch(`${baseUrl}/api/integrations/results/batches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Integration-Key": process.env.RESULTS_INTEGRATION_KEY,
      "X-Integration-Dry-Run": "true",
    },
    body: JSON.stringify(validBatch),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    dryRun: true,
    message: "Batch validated. No results were imported and no SMS messages were queued.",
    data: {
      batchId: "api-contract-test-2026",
      studentCount: 1,
      resultCount: 1,
      guardianCount: 1,
    },
  });

  const invalidResponse = await fetch(`${baseUrl}/api/integrations/results/batches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Integration-Key": process.env.RESULTS_INTEGRATION_KEY,
      "X-Integration-Dry-Run": "true",
    },
    body: JSON.stringify({ ...validBatch, status: "DRAFT" }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.match((await invalidResponse.json()).message, /Only batches with status APPROVED/);
});

test("returns safe JSON errors for malformed or oversized API bodies", async () => {
  const malformed = await fetch(`${baseUrl}/api/integrations/results/batches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Integration-Key": process.env.RESULTS_INTEGRATION_KEY,
    },
    body: "{not-json",
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), {
    success: false,
    message: "Request body is not valid JSON or form data.",
  });

  const oversized = await fetch(`${baseUrl}/api/integrations/results/batches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Integration-Key": process.env.RESULTS_INTEGRATION_KEY,
    },
    body: JSON.stringify({ data: "x".repeat(1024 * 1024 + 1) }),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), {
    success: false,
    message: "Request body exceeds the allowed size.",
  });
});

test("protects staff APIs and delivery-report callbacks", async () => {
  const outbox = await fetch(`${baseUrl}/api/sms/outbox`);
  assert.equal(outbox.status, 401);

  const invalidTokenReport = await fetch(
    `${baseUrl}/api/integrations/sms/delivery-reports?token=wrong-token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "provider-id", phoneNumber: "+263771234567", status: "Success" }),
    }
  );
  assert.equal(invalidTokenReport.status, 401);

  const validTokenReport = await fetch(
    `${baseUrl}/api/integrations/sms/delivery-reports?token=${encodeURIComponent(process.env.AFRICASTALKING_DELIVERY_TOKEN)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id: "provider-id", phoneNumber: "+263771234567", status: "Success" }),
    }
  );
  assert.equal(validTokenReport.status, 200);
  assert.deepEqual(await validTokenReport.json(), { success: true, duplicate: false });
});

test("returns a JSON not-found response for unknown API routes", async () => {
  const response = await fetch(`${baseUrl}/api/not-a-route`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { success: false, message: "API endpoint not found." });
});

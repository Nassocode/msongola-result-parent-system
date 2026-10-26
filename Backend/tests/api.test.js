const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "api-test-jwt-secret-that-is-long-enough";
process.env.RESULTS_INTEGRATION_KEY = "api-test-integration-key-that-is-long-enough";
process.env.AFRICASTALKING_DELIVERY_TOKEN = "api-test-delivery-token-that-is-long-enough";
process.env.SMS_DELIVERY_ENABLED = "false";

let requeueFixture = null;
const fakePool = {
  lastBatchQuery: "",
  async getConnection() {
    if (!requeueFixture) throw new Error("SMS requeue fixture was not configured.");

    const fixture = requeueFixture;
    return {
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() {},
      async execute(query, parameters = []) {
        if (query.includes("FROM result_import_batches") && query.includes("FOR UPDATE")) {
          return [fixture.batchId === Number(parameters[0]) ? [fixture.batch] : [], []];
        }
        if (query.includes("FROM result_records r") && query.includes("JOIN students s")) {
          return [fixture.results, []];
        }
        if (query.includes("SELECT DISTINCT ps.student_id")) {
          return [fixture.guardians, []];
        }
        if (query.includes("FROM sms_outbox") && query.includes("FOR UPDATE")) {
          return [fixture.messages.map(({ parentId, studentId }) => ({ parentId, studentId })), []];
        }
        if (query.includes("INSERT IGNORE INTO sms_outbox")) {
          const [batchId, parentId, studentId, phone, messageText] = parameters;
          const exists = fixture.messages.some(
            (message) => message.parentId === parentId && message.studentId === studentId
          );
          if (exists) return [{ affectedRows: 0 }, []];
          fixture.messages.push({
            batchId,
            parentId,
            studentId,
            phone,
            messageText,
            status: "PENDING",
          });
          return [{ affectedRows: 1 }, []];
        }
        if (query.includes("UPDATE result_import_batches")) {
          fixture.batch.queuedMessages = fixture.messages.length;
          fixture.batch.missingContacts = parameters[1];
          return [{ affectedRows: 1 }, []];
        }
        if (query.includes("SELECT COUNT(*) AS totalQueuedMessages")) {
          const countStatus = (status) => fixture.messages.filter((message) => message.status === status).length;
          return [[{
            totalQueuedMessages: fixture.messages.length,
            pendingSmsCount: countStatus("PENDING"),
            processingSmsCount: countStatus("PROCESSING"),
            sentSmsCount: countStatus("SENT"),
            deliveredSmsCount: countStatus("DELIVERED"),
            failedSmsCount: countStatus("FAILED"),
          }], []];
        }
        throw new Error("Unexpected SMS requeue database query in API test.");
      },
    };
  },
  async execute(query, parameters = []) {
    if (query.includes("FROM users WHERE id = ?")) {
      const users = {
        "1": { id: 1, name: "Test Admin", email: "admin@test.local", role: "ADMIN" },
        "2": { id: 2, name: "Test Academic Master", email: "academic@test.local", role: "ACADEMIC_MASTER" },
      };
      const user = users[String(parameters[0])];
      return [user ? [user] : [], []];
    }
    throw new Error("Unexpected database query in API test.");
  },
  async query(query) {
    if (!query.includes("FROM result_import_batches b")) {
      throw new Error("Unexpected database query in API test.");
    }
    fakePool.lastBatchQuery = query;
    return [[{
      id: 7,
      sourceSystem: "school-results",
      sourceBatchId: "api-test-batch-2026",
      examName: "Term 1",
      term: "Term 1",
      year: 2026,
      status: "COMPLETED",
      receivedRecords: 3,
      importedRecords: 3,
      duplicateRecords: 0,
      queuedMessages: 3,
      missingContacts: 0,
      receivedAt: "2026-10-13 09:00:00",
      completedAt: "2026-10-13 09:01:00",
      pendingSmsCount: 0,
      processingSmsCount: 0,
      sentSmsCount: 2,
      deliveredSmsCount: 1,
      failedSmsCount: 0,
    }], []];
  },
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
  assert.equal(validateResultsBatch({
    ...validBatch,
    students: [{ ...validBatch.students[0], totalPoints: 18 }],
  }), null);
  assert.match(validateResultsBatch({ ...validBatch, status: "DRAFT" }), /Only batches with status APPROVED/);
  assert.match(validateResultsBatch({
    ...validBatch,
    students: [{ ...validBatch.students[0], guardians: [{ name: "Guardian", phone: "0771234567" }] }],
  }), /international format/);
  assert.match(validateResultsBatch({
    ...validBatch,
    students: [{ ...validBatch.students[0], results: [{ ...validBatch.students[0].results[0], score: 101 }] }],
  }), /score from 0 to 100/);
  assert.match(validateResultsBatch({
    ...validBatch,
    students: [{ ...validBatch.students[0], totalPoints: 18.5 }],
  }), /Total points/);
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

test("shows aggregate SMS status counts to both staff roles without exposing message details", async () => {
  for (const userId of [1, 2]) {
    const token = jwt.sign({ id: userId }, process.env.JWT_SECRET);
    const response = await fetch(`${baseUrl}/api/integrations/batches?limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.length, 1);
    assert.deepEqual(
      {
        pendingSmsCount: body.data[0].pendingSmsCount,
        processingSmsCount: body.data[0].processingSmsCount,
        sentSmsCount: body.data[0].sentSmsCount,
        deliveredSmsCount: body.data[0].deliveredSmsCount,
        failedSmsCount: body.data[0].failedSmsCount,
      },
      {
        pendingSmsCount: 0,
        processingSmsCount: 0,
        sentSmsCount: 2,
        deliveredSmsCount: 1,
        failedSmsCount: 0,
      }
    );
    assert.doesNotMatch(JSON.stringify(body), /recipientPhone|parentName|studentName|messageText/);
  }

  assert.match(fakePool.lastBatchQuery, /SUM\(status = 'PENDING'\)/);
  assert.match(fakePool.lastBatchQuery, /SUM\(status = 'DELIVERED'\)/);
  assert.doesNotMatch(fakePool.lastBatchQuery, /recipient_phone|message_text|full_name/i);
});

test("admin can queue a completed batch for newly added guardians without duplicating messages", async () => {
  requeueFixture = {
    batchId: 7,
    batch: { id: 7, status: "COMPLETED", examName: "Term 1", term: "Term 1", year: 2026 },
    results: [
      { studentId: 101, studentName: "Learner One", className: "Form 1", division: "II", totalPoints: 18, subject: "Maths", score: 80, grade: "B" },
      { studentId: 101, studentName: "Learner One", className: "Form 1", division: "II", totalPoints: 18, subject: "English", score: 90, grade: "A" },
      { studentId: 102, studentName: "Learner Two", className: "Form 1", subject: "Maths", score: 75, grade: "B" },
      { studentId: 102, studentName: "Learner Two", subject: "Science", score: 75, grade: "B" },
    ],
    guardians: [
      { studentId: 101, parentId: 11, parentName: "Existing Guardian", phone: "+255712345678" },
      { studentId: 101, parentId: 12, parentName: "New Guardian", phone: "+255713456789" },
      { studentId: 102, parentId: 13, parentName: "Invalid Contact", phone: "0712345678" },
    ],
    messages: [{ parentId: 11, studentId: 101, status: "SENT" }],
  };

  const token = jwt.sign({ id: 1 }, process.env.JWT_SECRET);
  try {
    const firstResponse = await fetch(`${baseUrl}/api/integrations/batches/7/queue-sms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const firstBody = await firstResponse.json();
    assert.equal(firstResponse.status, 200);
    assert.deepEqual(firstBody.data, {
      batchId: 7,
      newQueuedMessages: 1,
      totalQueuedMessages: 2,
      missingContacts: 1,
      pendingSmsCount: 1,
      processingSmsCount: 0,
      sentSmsCount: 1,
      deliveredSmsCount: 0,
      failedSmsCount: 0,
    });
    assert.doesNotMatch(
      JSON.stringify(firstBody),
      /recipientPhone|phoneNumber|messageText|Existing Guardian|\+255712345678|\+255713456789/
    );
    assert.equal(requeueFixture.messages.length, 2);
    const queuedMessage = requeueFixture.messages.find((message) => message.parentId === 12).messageText;
    assert.match(queuedMessage, /Mzazi New Guardian, matokeo ya Learner One/);
    assert.match(queuedMessage, /Learner One - Term 1 2026:/);
    assert.match(queuedMessage, /Maths: 80% \(B\), English: 90% \(A\)/);
    assert.match(queuedMessage, /Jumla ya alama: 170; wastani: 85\.0%; Division: II \(18 points\); nafasi darasani: 1 kati ya 2\./);
    assert.doesNotMatch(queuedMessage, /Science|Computer Studies|divisheni:/);

    const secondResponse = await fetch(`${baseUrl}/api/integrations/batches/7/queue-sms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const secondBody = await secondResponse.json();
    assert.equal(secondResponse.status, 200);
    assert.equal(secondBody.data.newQueuedMessages, 0);
    assert.equal(secondBody.data.totalQueuedMessages, 2);
    assert.equal(requeueFixture.messages.length, 2);
  } finally {
    requeueFixture = null;
  }
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

  const academicToken = jwt.sign({ id: 2 }, process.env.JWT_SECRET);
  const academicOutbox = await fetch(`${baseUrl}/api/sms/outbox`, {
    headers: { Authorization: `Bearer ${academicToken}` },
  });
  assert.equal(academicOutbox.status, 403);
  const academicQueue = await fetch(`${baseUrl}/api/integrations/batches/7/queue-sms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${academicToken}` },
  });
  assert.equal(academicQueue.status, 403);

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

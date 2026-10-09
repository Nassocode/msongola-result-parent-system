const assert = require("node:assert/strict");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Module = require("node:module");

const jwtSecret = "admin-account-tests-jwt-secret-minimum-length";
process.env.JWT_SECRET = jwtSecret;
process.env.RESULTS_INTEGRATION_KEY = "admin-account-tests-results-key-minimum-length";
process.env.SMS_DELIVERY_ENABLED = "false";
process.env.AFRICASTALKING_DELIVERY_TOKEN = "";

let users = [
  { id: 1, name: "Main Admin", email: "admin@school.test", role: "admin", password_hash: "hash-1", createdAt: "2026-01-01" },
  { id: 2, name: "Academic Staff", email: "academic@school.test", role: "academic_master", password_hash: "hash-2", createdAt: "2026-02-01" },
  { id: 3, name: "Second Admin", email: "second-admin@school.test", role: "admin", password_hash: "hash-3", createdAt: "2026-03-01" },
];
let nextId = 4;
let lastResultsReportParameters = null;

const pool = {
  async testConnection() {
    return { ok: true };
  },
  async query(sql, parameters = []) {
    if (sql.includes("AS importBatchCount")) {
      const adminMetrics = {
        importBatchCount: 6,
        pendingSmsCount: 7,
        failedSmsCount: 3,
        staffCount: 2,
      };
      const academicMetrics = {
        studentCount: 12,
        learnersWithGuardiansCount: 9,
        learnersMissingGuardiansCount: 3,
        resultCount: 34,
        subjectCount: 5,
        importBatchCount: 6,
        missingContactsCount: 2,
      };
      return [[sql.includes("AS staffCount") ? adminMetrics : academicMetrics]];
    }
    if (sql.includes("FROM result_records r") && sql.includes("INNER JOIN students s")) {
      lastResultsReportParameters = parameters;
      return [[{
        studentName: "Asha Moyo",
        admissionNumber: "ST-101",
        className: "Grade 8",
        subject: "Mathematics",
        score: "87.50",
        grade: "B",
        term: "Term 1",
        year: 2026,
        comment: null,
      }]];
    }
    if (sql.includes("FROM sms_outbox o")) return [[]];
    if (sql.includes("FROM users") && sql.includes("ORDER BY role ASC")) {
      return [[...users]
        .filter(({ role }) => ["admin", "academic_master"].includes(role))
        .sort((left, right) => left.role.localeCompare(right.role) || left.name.localeCompare(right.name))
        .map(({ id, name, email, role, createdAt }) => ({
          id, name, email, role, createdAt,
        }))];
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  },
  async execute(sql, parameters) {
    if (sql.startsWith("SELECT id, name, email, role FROM users")) {
      const user = users.find((entry) => String(entry.id) === String(parameters[0]));
      return [user ? [{ id: user.id, name: user.name, email: user.email, role: user.role }] : []];
    }
    if (sql.startsWith("INSERT INTO users")) {
      const [, email] = parameters;
      if (users.some((entry) => entry.email === email)) {
        const error = new Error("Duplicate email");
        error.code = "ER_DUP_ENTRY";
        throw error;
      }
      const [name, accountEmail, password_hash, role] = parameters;
      const id = nextId++;
      users.push({ id, name, email: accountEmail, password_hash, role, createdAt: "2026-10-08" });
      return [{ insertId: id }];
    }
    throw new Error(`Unexpected pool execute: ${sql}`);
  },
  async getConnection() {
    let snapshot;
    return {
      async beginTransaction() {
        snapshot = structuredClone(users);
      },
      async execute(sql, parameters) {
        if (sql.startsWith("SELECT id, role FROM users")) {
          const user = users.find((entry) => String(entry.id) === String(parameters[0]));
          return [user ? [{ id: user.id, role: user.role }] : []];
        }
        if (sql.startsWith("UPDATE users SET name")) {
          const user = users.find((entry) => String(entry.id) === String(parameters[parameters.length - 1]));
          if (!user) return [{ affectedRows: 0 }];
          if (users.some((entry) => entry.email === parameters[1] && entry.id !== user.id)) {
            const error = new Error("Duplicate email");
            error.code = "ER_DUP_ENTRY";
            throw error;
          }
          user.name = parameters[0];
          user.email = parameters[1];
          user.role = parameters[2];
          if (parameters.length === 5) user.password_hash = parameters[3];
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("DELETE FROM users")) {
          const before = users.length;
          users = users.filter((entry) => String(entry.id) !== String(parameters[0]));
          return [{ affectedRows: before - users.length }];
        }
        throw new Error(`Unexpected connection execute: ${sql}`);
      },
      async query(sql) {
        if (sql.includes("FROM users WHERE role = 'admin'")) {
          return [users.filter((entry) => entry.role === "admin").map(({ id }) => ({ id }))];
        }
        throw new Error(`Unexpected connection query: ${sql}`);
      },
      async commit() {},
      async rollback() {
        if (snapshot) users = snapshot;
      },
      release() {},
    };
  },
};

const smsStub = {
  deliveryReportsConfigured: false,
  deliveryTokenMatches: () => false,
  processDeliveryReport: async () => ({ accepted: false }),
  smsDeliveryConfigured: false,
  startSmsWorker() {},
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "./config/db" && parent?.filename.endsWith("server.js")) return pool;
  if (request === "./smsDelivery" && parent?.filename.endsWith("server.js")) return smsStub;
  return originalLoad.call(this, request, parent, isMain);
};
const { app } = require("../server");
Module._load = originalLoad;

function tokenFor(id, role) {
  return jwt.sign({ id, name: "Token Name", email: "token@school.test", role }, jwtSecret, { expiresIn: "5m" });
}

async function request(baseUrl, path, token, method = "GET", body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, body: await response.json() };
}

test("administrator manages staff accounts while academic master cannot administer accounts", async (t) => {
  users = [
    { id: 1, name: "Main Admin", email: "admin@school.test", role: "admin", password_hash: "hash-1", createdAt: "2026-01-01" },
    { id: 2, name: "Academic Staff", email: "academic@school.test", role: "academic_master", password_hash: "hash-2", createdAt: "2026-02-01" },
    { id: 3, name: "Second Admin", email: "second-admin@school.test", role: "admin", password_hash: "hash-3", createdAt: "2026-03-01" },
    { id: 4, name: "Legacy Parent Login", email: "parent@school.test", role: "parent", password_hash: "hash-4", createdAt: "2026-04-01" },
  ];
  nextId = 5;
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const adminToken = tokenFor(1, "admin");
  const academicToken = tokenFor(2, "academic_master");

  const adminDashboard = await request(baseUrl, "/api/dashboard/summary", adminToken);
  assert.equal(adminDashboard.response.status, 200);
  assert.deepEqual(adminDashboard.body.data, {
    staffCount: 2,
    pendingSmsCount: 7,
    failedSmsCount: 3,
    importBatchCount: 6,
  });
  for (const path of [
    "/api/students",
    "/api/reports/summary",
    "/api/results?studentId=1",
    "/api/results/1",
    "/api/students/1/results",
    "/api/students/1/contact",
  ]) {
    const deniedAcademicData = await request(baseUrl, path, adminToken);
    assert.equal(deniedAcademicData.response.status, 403, `${path} should be restricted to Academic Master`);
  }

  const academicDashboard = await request(baseUrl, "/api/dashboard/summary", academicToken);
  assert.equal(academicDashboard.response.status, 200);
  assert.deepEqual(academicDashboard.body.data, {
    studentCount: 12,
    learnersWithGuardiansCount: 9,
    learnersMissingGuardiansCount: 3,
    resultCount: 34,
    subjectCount: 5,
    importBatchCount: 6,
    missingContactsCount: 2,
  });

  const resultsReport = await request(
    baseUrl,
    "/api/reports/results?year=2026&className=Grade%208&subject=Mathematics&term=Term%201",
    academicToken
  );
  assert.equal(resultsReport.response.status, 200);
  assert.deepEqual(resultsReport.body.data, [{
    studentName: "Asha Moyo",
    admissionNumber: "ST-101",
    className: "Grade 8",
    subject: "Mathematics",
    score: 87.5,
    grade: "B",
    term: "Term 1",
    year: 2026,
    comment: null,
  }]);
  assert.deepEqual(lastResultsReportParameters, [2026, "Grade 8", "Mathematics", "Term 1"]);
  const adminResultsReport = await request(baseUrl, "/api/reports/results", adminToken);
  assert.equal(adminResultsReport.response.status, 403);
  const invalidResultsReport = await request(baseUrl, "/api/reports/results?year=not-a-year", academicToken);
  assert.equal(invalidResultsReport.response.status, 400);

  const academicOutbox = await request(baseUrl, "/api/sms/outbox", academicToken);
  assert.equal(academicOutbox.response.status, 403);
  const academicRetry = await request(baseUrl, "/api/sms/outbox/1/retry", academicToken, "POST");
  assert.equal(academicRetry.response.status, 403);
  const adminOutbox = await request(baseUrl, "/api/sms/outbox", adminToken);
  assert.equal(adminOutbox.response.status, 200);
  const adminRetry = await request(baseUrl, "/api/sms/outbox/1/retry", adminToken, "POST");
  assert.equal(adminRetry.response.status, 503);

  const denied = await request(baseUrl, "/api/admin/users", academicToken);
  assert.equal(denied.response.status, 403);

  const list = await request(baseUrl, "/api/admin/users", adminToken);
  assert.equal(list.response.status, 200);
  assert.equal(list.body.data.length, 3);
  assert.equal(list.body.data.some((account) => account.role === "parent"), false);
  assert.equal(JSON.stringify(list.body).includes("password_hash"), false);

  const legacyParentProfile = await request(baseUrl, "/api/profile", tokenFor(4, "parent"));
  assert.equal(legacyParentProfile.response.status, 403);

  const invalidAccount = await request(baseUrl, "/api/admin/users", adminToken, "POST", {
    name: "Short Password",
    email: "new@school.test",
    role: "academic_master",
    password: "too-short",
  });
  assert.equal(invalidAccount.response.status, 400);

  const created = await request(baseUrl, "/api/admin/users", adminToken, "POST", {
    name: "New Academic Master",
    email: "new-academic@school.test",
    role: "academic_master",
    password: "secure-temporary-password",
  });
  assert.equal(created.response.status, 201);
  assert.equal(users.find((entry) => entry.id === created.body.data.id).role, "academic_master");
  assert.notEqual(users.find((entry) => entry.id === created.body.data.id).password_hash, "secure-temporary-password");

  const edited = await request(baseUrl, `/api/admin/users/${created.body.data.id}`, adminToken, "PUT", {
    name: "Updated Staff Name",
    email: "new-academic@school.test",
    role: "admin",
    password: "",
  });
  assert.equal(edited.response.status, 200);
  assert.equal(users.find((entry) => entry.id === created.body.data.id).role, "admin");

  const selfDemotion = await request(baseUrl, "/api/admin/users/1", adminToken, "PUT", {
    name: "Main Admin",
    email: "admin@school.test",
    role: "academic_master",
  });
  assert.equal(selfDemotion.response.status, 409);

  const selfDelete = await request(baseUrl, "/api/admin/users/1", adminToken, "DELETE");
  assert.equal(selfDelete.response.status, 409);

  const duplicateEmail = await request(baseUrl, "/api/admin/users/2", adminToken, "PUT", {
    name: "Academic Staff",
    email: "admin@school.test",
    role: "academic_master",
  });
  assert.equal(duplicateEmail.response.status, 409);

  const deleted = await request(baseUrl, "/api/admin/users/2", adminToken, "DELETE");
  assert.equal(deleted.response.status, 200);
  const revokedSession = await request(baseUrl, "/api/profile", academicToken);
  assert.equal(revokedSession.response.status, 401);
  assert.equal(await bcrypt.compare("secure-temporary-password", users.find((entry) => entry.id === created.body.data.id).password_hash), true);
});

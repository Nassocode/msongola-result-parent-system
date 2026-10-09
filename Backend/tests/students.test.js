const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const Module = require("node:module");

const jwtSecret = "student-record-tests-jwt-secret-minimum-length";
process.env.JWT_SECRET = jwtSecret;
process.env.RESULTS_INTEGRATION_KEY = "student-record-tests-results-key-minimum-length";
process.env.SMS_DELIVERY_ENABLED = "false";
process.env.AFRICASTALKING_DELIVERY_TOKEN = "";

const users = [
  { id: 1, name: "Academic Master", email: "academic@school.test", role: "academic_master" },
  { id: 2, name: "Administrator", email: "admin@school.test", role: "admin" },
];
let students = [{
  id: 1,
  name: "Asha Moyo",
  admission_number: "ST-101",
  class_name: "Form 1",
  year: 2026,
}];
let parents = [];
let parentStudents = [];
let nextStudentId = 2;
let nextParentId = 1;
let admissionSequences = {};

const pool = {
  async query(sql) {
    if (sql.includes("FROM students s")) {
      return [[...students]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((student) => ({
          id: student.id,
          name: student.name,
          admissionNumber: student.admission_number,
          className: student.class_name,
          year: student.year,
          resultCount: 0,
          guardianCount: parentStudents.filter((entry) => entry.student_id === student.id).length,
        }))];
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  },
  async execute(sql, parameters = []) {
    if (sql.startsWith("SELECT id, name, email, role FROM users")) {
      const user = users.find((entry) => entry.id === Number(parameters[0]));
      return [user ? [user] : []];
    }
    if (sql.startsWith("SELECT id, name, admission_number AS admissionNumber")) {
      const student = students.find((entry) => entry.id === Number(parameters[0]));
      return [student ? [{
        id: student.id,
        name: student.name,
        admissionNumber: student.admission_number,
        className: student.class_name,
        year: student.year,
      }] : []];
    }
    if (sql.includes("FROM parent_students ps") && sql.includes("JOIN parents p")) {
      const guardians = parentStudents
        .filter((entry) => entry.student_id === Number(parameters[0]))
        .map((entry) => {
          const parent = parents.find((candidate) => candidate.id === entry.parent_id);
          return {
            name: parent.full_name,
            phone: parent.phone_number,
            relationship: entry.relationship,
            isPrimary: entry.is_primary,
          };
        })
        .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary));
      return [guardians];
    }
    throw new Error(`Unexpected pool execute: ${sql}`);
  },
  async getConnection() {
    let snapshot;
    return {
      async beginTransaction() {
        snapshot = structuredClone({ students, parents, parentStudents, nextStudentId, nextParentId, admissionSequences });
      },
      async execute(sql, parameters = []) {
        if (sql.startsWith("INSERT INTO admission_number_sequences")) {
          const academicYear = Number(parameters[0]);
          admissionSequences[academicYear] = Math.max(admissionSequences[academicYear] || 0, Number(parameters[1] || 0));
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("UPDATE admission_number_sequences")) {
          admissionSequences[Number(parameters[0])] += 1;
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("SELECT last_number FROM admission_number_sequences")) {
          return [[{ last_number: admissionSequences[Number(parameters[0])] }]];
        }
        if (sql.startsWith("SELECT id, admission_number FROM students WHERE id = ? FOR UPDATE")) {
          const student = students.find((entry) => entry.id === Number(parameters[0]));
          return [student ? [{ id: student.id, admission_number: student.admission_number }] : []];
        }
        if (sql.includes("UPDATE students")) {
          const student = students.find((entry) => entry.id === Number(parameters[3]));
          if (!student) return [{ affectedRows: 0 }];
          [student.name, student.class_name, student.year] = parameters;
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("INSERT INTO students")) {
          const admissionNumber = parameters[1];
          if (students.some((entry) => entry.admission_number === admissionNumber)) {
            const error = new Error("Duplicate admission number");
            error.code = "ER_DUP_ENTRY";
            throw error;
          }
          const student = {
            id: nextStudentId++,
            name: parameters[0],
            admission_number: admissionNumber,
            class_name: parameters[2],
            year: parameters[3],
          };
          students.push(student);
          return [{ insertId: student.id }];
        }
        if (sql.startsWith("DELETE FROM parent_students")) {
          const before = parentStudents.length;
          parentStudents = parentStudents.filter((entry) => entry.student_id !== Number(parameters[0]));
          return [{ affectedRows: before - parentStudents.length }];
        }
        if (sql.startsWith("INSERT INTO parents")) {
          let parent = parents.find((entry) => entry.phone_number_normalized === parameters[2]);
          if (parent) {
            parent.full_name = parameters[0];
            parent.phone_number = parameters[1];
            parent.status = "active";
          } else {
            parent = {
              id: nextParentId++,
              full_name: parameters[0],
              phone_number: parameters[1],
              phone_number_normalized: parameters[2],
              status: "active",
            };
            parents.push(parent);
          }
          return [{ insertId: parent.id }];
        }
        if (sql.startsWith("INSERT INTO parent_students")) {
          parentStudents.push({
            parent_id: Number(parameters[0]),
            student_id: Number(parameters[1]),
            relationship: parameters[2],
            is_primary: parameters[3],
          });
          return [{ insertId: parentStudents.length }];
        }
        throw new Error(`Unexpected connection execute: ${sql}`);
      },
      async commit() {},
      async rollback() {
        if (snapshot) ({ students, parents, parentStudents, nextStudentId, nextParentId, admissionSequences } = snapshot);
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

function tokenFor(id) {
  return jwt.sign({ id }, jwtSecret, { expiresIn: "5m" });
}

async function request(baseUrl, route, token, method = "GET", body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, body: await response.json() };
}

test("Academic Master can register and update learner and guardian records", async (t) => {
  students = [{
    id: 1,
    name: "Asha Moyo",
    admission_number: "ST-101",
    class_name: "Form 1",
    year: 2026,
  }];
  parents = [];
  parentStudents = [];
  nextStudentId = 2;
  nextParentId = 1;
  admissionSequences = {};

  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const academicToken = tokenFor(1);
  const adminToken = tokenFor(2);

  const learner = {
    name: "Rehema Nyerere",
    admissionNumber: "",
    className: "Form 2",
    year: 2026,
    guardians: [
      { name: "Neema Nyerere", phone: "+255712345678", relationship: "Mother", isPrimary: true },
      { name: "Juma Nyerere", phone: "+255713456789", relationship: "Father", isPrimary: false },
    ],
  };

  const denied = await request(baseUrl, "/api/students", adminToken, "POST", learner);
  assert.equal(denied.response.status, 403);

  const invalidPhone = await request(baseUrl, "/api/students", academicToken, "POST", {
    ...learner,
    guardians: [{ ...learner.guardians[0], phone: "0712345678" }],
  });
  assert.equal(invalidPhone.response.status, 400);
  assert.match(invalidPhone.body.message, /international format/);

  const created = await request(baseUrl, "/api/students", academicToken, "POST", learner);
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.studentId, 2);
  assert.equal(created.body.data.admissionNumber, "MSS-2026-0001");

  const details = await request(baseUrl, "/api/students/2", academicToken);
  assert.equal(details.response.status, 200);
  assert.equal(details.body.data.name, learner.name);
  assert.equal(details.body.data.guardians.length, 2);
  assert.equal(details.body.data.guardians[0].isPrimary, true);

  const duplicate = await request(baseUrl, "/api/students", academicToken, "POST", {
    ...learner,
    admissionNumber: "MSS-2026-0001",
  });
  assert.equal(duplicate.response.status, 409);

  const updated = await request(baseUrl, "/api/students/2", academicToken, "PUT", {
    ...learner,
    name: "Rehema John Nyerere",
    className: "Form 3",
    guardians: [learner.guardians[0]],
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.data.studentId, 2);
  assert.equal(updated.body.data.admissionNumber, "MSS-2026-0001");
  assert.equal(students[1].admission_number, "MSS-2026-0001");

  const updatedDetails = await request(baseUrl, "/api/students/2", academicToken);
  assert.equal(updatedDetails.body.data.name, "Rehema John Nyerere");
  assert.equal(updatedDetails.body.data.className, "Form 3");
  assert.equal(updatedDetails.body.data.guardians.length, 1);

  const list = await request(baseUrl, "/api/students", academicToken);
  const savedLearner = list.body.data.find((entry) => entry.id === 2);
  assert.equal(savedLearner.guardianCount, 1);
  assert.equal(savedLearner.year, 2026);
});

test("bulk learner import validates the complete file and rolls back on existing admissions", async (t) => {
  students = [{
    id: 1,
    name: "Asha Moyo",
    admission_number: "ST-101",
    class_name: "Form 1",
    year: 2026,
  }];
  parents = [];
  parentStudents = [];
  nextStudentId = 2;
  nextParentId = 1;
  admissionSequences = {};

  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const academicToken = tokenFor(1);
  const adminToken = tokenFor(2);
  const guardian = { name: "Shared Parent", phone: "+255712345678", relationship: "Parent", isPrimary: true };
  const firstLearner = {
    name: "First Import",
    admissionNumber: "CSV-001",
    className: "Form 1",
    year: 2026,
    guardians: [guardian],
  };
  const secondLearner = {
    name: "Second Import",
    admissionNumber: "CSV-002",
    className: "Form 1",
    year: 2026,
    guardians: [guardian],
  };

  const denied = await request(baseUrl, "/api/students/import", adminToken, "POST", { students: [firstLearner] });
  assert.equal(denied.response.status, 403);

  const invalidBatch = await request(baseUrl, "/api/students/import", academicToken, "POST", {
    students: [firstLearner, { ...secondLearner, guardians: [{ ...guardian, phone: "0712345678" }] }],
  });
  assert.equal(invalidBatch.response.status, 400);
  assert.equal(invalidBatch.body.errors[0].row, 3);
  assert.equal(students.length, 1);

  const repeatedAdmissions = await request(baseUrl, "/api/students/import", academicToken, "POST", {
    students: [firstLearner, { ...secondLearner, admissionNumber: "csv-001" }],
  });
  assert.equal(repeatedAdmissions.response.status, 400);
  assert.match(repeatedAdmissions.body.errors[0].message, /Duplicate admission number/);

  const databaseConflict = await request(baseUrl, "/api/students/import", academicToken, "POST", {
    students: [firstLearner, { ...secondLearner, admissionNumber: "ST-101" }],
  });
  assert.equal(databaseConflict.response.status, 409);
  assert.equal(databaseConflict.body.data, undefined);
  assert.deepEqual(students.map((student) => student.admission_number), ["ST-101"]);
  assert.equal(parentStudents.length, 0);

  const imported = await request(baseUrl, "/api/students/import", academicToken, "POST", {
    students: [{ ...firstLearner, admissionNumber: "MSS-2026-0007" }, { ...secondLearner, admissionNumber: "" }],
  });
  assert.equal(imported.response.status, 201);
  assert.equal(imported.body.data.importedCount, 2);
  assert.deepEqual(imported.body.data.generatedAdmissionNumbers, ["MSS-2026-0008"]);
  assert.equal(students.length, 3);
  assert.deepEqual(students.slice(1).map((student) => student.admission_number), ["MSS-2026-0007", "MSS-2026-0008"]);
  assert.equal(parents.length, 1);
  assert.equal(parentStudents.length, 2);

  const nextYear = await request(baseUrl, "/api/students", academicToken, "POST", {
    name: "Next Year Learner",
    admissionNumber: "",
    className: "Form 1",
    year: 2027,
    guardians: [],
  });
  assert.equal(nextYear.response.status, 201);
  assert.equal(nextYear.body.data.admissionNumber, "MSS-2027-0001");
});

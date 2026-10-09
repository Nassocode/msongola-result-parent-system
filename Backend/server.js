const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const path = require("path");
require("dotenv").config();

const pool = require("./config/db");
const { isConfiguredSecret } = require("./config/secrets");
const {
  deliveryReportsConfigured,
  deliveryTokenMatches,
  processDeliveryReport,
  smsDeliveryConfigured,
  startSmsWorker,
} = require("./smsDelivery");

const app = express();
const PORT = process.env.PORT || 5000;
const configuredJwtSecret = process.env.JWT_SECRET || "";
const jwtSecretConfigured = isConfiguredSecret(configuredJwtSecret);
const JWT_SECRET = jwtSecretConfigured
  ? configuredJwtSecret
  : crypto.randomBytes(32).toString("hex");
const RESULTS_INTEGRATION_KEY = process.env.RESULTS_INTEGRATION_KEY || "";
const resultsIntegrationKeyConfigured = isConfiguredSecret(RESULTS_INTEGRATION_KEY);

if (process.env.NODE_ENV === "production" && !jwtSecretConfigured) {
  throw new Error("Set a private JWT_SECRET of at least 32 characters in production.");
}

function gradeFromScore(score) {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizeString(value) {
  return String(value || "").trim();
}

function normalizePhoneNumber(value) {
  const phone = sanitizeString(value);
  const normalized = phone.replace(/[^\d+]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(normalized) ? normalized : null;
}

function validateResultsBatch(payload) {
  const sourceSystem = sanitizeString(payload?.sourceSystem);
  const batchId = sanitizeString(payload?.batchId);
  const examName = sanitizeString(payload?.examName);
  const term = sanitizeString(payload?.term);
  const year = Number(payload?.year);
  const students = payload?.students;

  if (!sourceSystem || sourceSystem.length > 100) return "sourceSystem is required and must be 100 characters or fewer.";
  if (!batchId || batchId.length > 150) return "batchId is required and must be 150 characters or fewer.";
  if (!examName || examName.length > 150) return "examName is required and must be 150 characters or fewer.";
  if (!term || term.length > 50) return "term is required and must be 50 characters or fewer.";
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return "year must be a valid four-digit academic year.";
  if (String(payload?.status || "").toUpperCase() !== "APPROVED") {
    return "Only batches with status APPROVED can be imported.";
  }
  if (!Array.isArray(students) || students.length === 0 || students.length > 1000) {
    return "students must contain between 1 and 1000 learners.";
  }

  const admissionNumbers = new Set();
  const externalResultIds = new Set();
  let totalResults = 0;

  for (const student of students) {
    if (!student || typeof student !== "object" || Array.isArray(student)) {
      return "Every students entry must be a learner object.";
    }

    const externalStudentId = sanitizeString(student?.externalStudentId);
    const admissionNumber = sanitizeString(student?.admissionNumber);
    const name = sanitizeString(student?.name);
    const className = sanitizeString(student?.className);

    if (externalStudentId.length > 100) return "externalStudentId must be 100 characters or fewer.";
    if (!admissionNumber || admissionNumber.length > 50) return "Every learner must have an admissionNumber of 50 characters or fewer.";
    if (!name || name.length > 120) return "Every learner must have a name of 120 characters or fewer.";
    if (!className || className.length > 80) return "Every learner must have a className of 80 characters or fewer.";
    if (admissionNumbers.has(admissionNumber)) return `Duplicate learner admissionNumber in batch: ${admissionNumber}.`;
    admissionNumbers.add(admissionNumber);

    if (!Array.isArray(student.results) || student.results.length === 0 || student.results.length > 50) {
      return `Learner ${admissionNumber} must have between 1 and 50 subject results.`;
    }

    totalResults += student.results.length;
    if (totalResults > 5000) return "A batch cannot contain more than 5000 subject results.";

    for (const result of student.results) {
      const externalResultId = sanitizeString(result?.externalResultId);
      const subject = sanitizeString(result?.subject);
      const score = Number(result?.score);
      const grade = sanitizeString(result?.grade);
      const comment = sanitizeString(result?.comment);

      if (!externalResultId || externalResultId.length > 150) return "Every subject result must have an externalResultId of 150 characters or fewer.";
      if (externalResultIds.has(externalResultId)) return `Duplicate externalResultId in batch: ${externalResultId}.`;
      externalResultIds.add(externalResultId);
      if (!subject || subject.length > 120) return "Every subject result must have a subject of 120 characters or fewer.";
      if (!Number.isFinite(score) || score < 0 || score > 100) return `Result ${externalResultId} must have a score from 0 to 100.`;
      if (grade.length > 10) return `Grade for result ${externalResultId} must be 10 characters or fewer.`;
      if (comment.length > 5000) return `Comment for result ${externalResultId} is too long.`;
    }

    const guardians = student.guardians;
    if (!Array.isArray(guardians) || guardians.length > 10) {
      return `Learner ${admissionNumber} must have no more than 10 guardians.`;
    }

    let primaryGuardianCount = 0;
    for (const guardian of guardians) {
      if (!guardian || typeof guardian !== "object" || Array.isArray(guardian)) {
        return `Every guardian for ${admissionNumber} must be a guardian object.`;
      }
      const guardianName = sanitizeString(guardian?.name);
      if (!guardianName || guardianName.length > 120) return `Every guardian for ${admissionNumber} must have a name of 120 characters or fewer.`;
      if (!normalizePhoneNumber(guardian?.phone)) return `Guardian phone number for ${admissionNumber} must use international format, such as +263771234567.`;
      if (guardian.isPrimary !== undefined && typeof guardian.isPrimary !== "boolean") {
        return `isPrimary for guardians of ${admissionNumber} must be true or false.`;
      }
      if (guardian.isPrimary === true) primaryGuardianCount += 1;
    }
    if (primaryGuardianCount > 1) {
      return `Learner ${admissionNumber} may have only one primary guardian.`;
    }
  }

  return null;
}

function integrationKeyMatches(candidate) {
  if (!resultsIntegrationKeyConfigured || !candidate) {
    return false;
  }

  const expectedDigest = crypto.createHash("sha256").update(RESULTS_INTEGRATION_KEY).digest();
  const candidateDigest = crypto.createHash("sha256").update(candidate).digest();
  return crypto.timingSafeEqual(expectedDigest, candidateDigest);
}

function buildStudentPayload(rows) {
  const first = rows[0];

  return {
    studentId: first.studentId,
    studentName: first.studentName,
    admissionNumber: first.admissionNumber,
    className: first.className,
    results: rows
      .filter((row) => row.subject)
      .map((row) => ({
        subject: row.subject,
        score: row.score,
        grade: row.grade,
        term: row.term,
        year: row.year,
        comment: row.comment || "Great effort",
      })),
  };
}

function buildAuthToken(user) {
  return jwt.sign(
    {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function normalizeRole(role) {
  return String(role || "").trim().toUpperCase();
}

async function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
    });
  }

  try {
    const tokenPayload = jwt.verify(token, JWT_SECRET);
    const [users] = await pool.execute(
      "SELECT id, name, email, role FROM users WHERE id = ? LIMIT 1",
      [tokenPayload.id]
    );
    if (!users.length) {
      return res.status(401).json({
        success: false,
        message: "This staff account is no longer active. Please sign in again.",
      });
    }
    const role = normalizeRole(users[0].role);
    if (role !== "ADMIN" && role !== "ACADEMIC_MASTER") {
      return res.status(403).json({
        success: false,
        message: "This account does not have access to the administration dashboard.",
      });
    }
    req.user = {
      id: users[0].id,
      name: users[0].name,
      email: users[0].email,
      role,
    };
    return next();
  } catch (error) {
    if (error.name !== "JsonWebTokenError" && error.name !== "TokenExpiredError" && error.name !== "NotBeforeError") {
      console.error("Staff authentication lookup failed:", error.message);
      return res.status(503).json({
        success: false,
        message: "Unable to verify the staff account. Please try again.",
      });
    }
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token.",
    });
  }
}

function requireAdmin(req, res, next) {
  const role = normalizeRole(req.user?.role || "");

  if (role !== "ADMIN" && role !== "ACADEMIC_MASTER") {
    return res.status(403).json({
      success: false,
      message: "Access denied. This area is restricted to administrators.",
    });
  }

  return next();
}

function requireSystemAdmin(req, res, next) {
  if (normalizeRole(req.user?.role || "") !== "ADMIN") {
    return res.status(403).json({
      success: false,
      message: "Only the system administrator can perform this operation.",
    });
  }
  return next();
}

function requireAcademicMaster(req, res, next) {
  if (normalizeRole(req.user?.role || "") !== "ACADEMIC_MASTER") {
    return res.status(403).json({
      success: false,
      message: "Learner and result records are restricted to the Academic Master.",
    });
  }
  return next();
}

function validateStaffAccount(payload, includePassword = true) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "A staff account object is required.";
  }
  if (typeof payload.name !== "string" || typeof payload.email !== "string") {
    return "Name and email must be text values.";
  }
  if (payload.password !== undefined && typeof payload.password !== "string") {
    return "Password must be a text value.";
  }
  const name = sanitizeString(payload?.name);
  const email = sanitizeString(payload?.email).toLowerCase();
  const role = normalizeRole(payload?.role);
  const password = String(payload?.password || "");

  if (!name || name.length > 120) return "Name is required and must be 120 characters or fewer.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) {
    return "Enter a valid staff email address of 150 characters or fewer.";
  }
  if (!["ADMIN", "ACADEMIC_MASTER"].includes(role)) {
    return "Role must be ADMIN or ACADEMIC_MASTER.";
  }
  if (includePassword && (password.length < 12 || password.length > 128)) {
    return "Password must contain between 12 and 128 characters.";
  }
  if (password && (password.length < 12 || password.length > 128)) {
    return "Password must contain between 12 and 128 characters.";
  }

  return null;
}

function validateStudentRecord(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "A learner record is required.";
  }

  const name = sanitizeString(payload.name);
  const admissionNumber = sanitizeString(payload.admissionNumber);
  const className = sanitizeString(payload.className);
  const year = Number(payload.year);
  const guardians = payload.guardians;

  if (!name || name.length > 120) return "Learner name is required and must be 120 characters or fewer.";
  if (admissionNumber.length > 50) return "Admission number must be 50 characters or fewer.";
  if (!className || className.length > 80) return "Class is required and must be 80 characters or fewer.";
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return "Enrollment year must be a valid year from 2000 to 2100.";
  if (!Array.isArray(guardians) || guardians.length > 10) return "Guardians must be a list containing no more than 10 contacts.";

  const guardianPhones = new Set();
  let primaryGuardianCount = 0;
  for (const guardian of guardians) {
    if (!guardian || typeof guardian !== "object" || Array.isArray(guardian)) {
      return "Every guardian entry must be a contact object.";
    }
    const guardianName = sanitizeString(guardian.name);
    const relationship = sanitizeString(guardian.relationship);
    const phone = normalizePhoneNumber(guardian.phone);
    if (!guardianName || guardianName.length > 120) return "Every guardian must have a name of 120 characters or fewer.";
    if (!phone) return "Every guardian phone number must use international format, such as +255712345678.";
    if (relationship.length > 50) return "Guardian relationship must be 50 characters or fewer.";
    if (guardianPhones.has(phone)) return "A learner cannot have the same guardian phone number more than once.";
    guardianPhones.add(phone);
    if (guardian.isPrimary !== undefined && typeof guardian.isPrimary !== "boolean") {
      return "isPrimary for guardians must be true or false.";
    }
    if (guardian.isPrimary === true) primaryGuardianCount += 1;
  }
  if (guardians.length && primaryGuardianCount !== 1) {
    return "Choose exactly one primary guardian, or remove all guardian contacts.";
  }

  return null;
}

async function saveStudentRecord(connection, payload, studentId = null) {
  const [studentRows] = studentId
    ? await connection.execute("SELECT id, admission_number FROM students WHERE id = ? FOR UPDATE", [studentId])
    : [[]];
  if (studentId && !studentRows.length) {
    const error = new Error("Learner not found.");
    error.statusCode = 404;
    throw error;
  }

  if (studentId) {
    const admissionNumber = studentRows[0].admission_number;
    await connection.execute(
      `UPDATE students
       SET name = ?, class_name = ?, year = ?
       WHERE id = ?`,
      [
        sanitizeString(payload.name),
        sanitizeString(payload.className),
        Number(payload.year),
        studentId,
      ]
    );
    await saveStudentGuardians(connection, payload.guardians, studentId);
    return { studentId, admissionNumber };
  } else {
    const suppliedAdmissionNumber = sanitizeString(payload.admissionNumber);
    const admissionNumber = suppliedAdmissionNumber
      || await generateAdmissionNumber(connection, Number(payload.year));
    if (suppliedAdmissionNumber) {
      await syncAdmissionNumberSequence(connection, suppliedAdmissionNumber);
    }
    const [studentInsert] = await connection.execute(
      `INSERT INTO students (name, admission_number, class_name, year)
       VALUES (?, ?, ?, ?)`,
      [
        sanitizeString(payload.name),
        admissionNumber,
        sanitizeString(payload.className),
        Number(payload.year),
      ]
    );
    studentId = studentInsert.insertId;
    await saveStudentGuardians(connection, payload.guardians, studentId);
    return { studentId, admissionNumber };
  }
}

async function saveStudentGuardians(connection, guardians, studentId) {
  await connection.execute("DELETE FROM parent_students WHERE student_id = ?", [studentId]);
  for (const guardian of guardians) {
    const phone = normalizePhoneNumber(guardian.phone);
    const [parentInsert] = await connection.execute(
      `INSERT INTO parents (full_name, phone_number, phone_number_normalized)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id),
                               full_name = VALUES(full_name),
                               phone_number = VALUES(phone_number),
                               status = 'active'`,
      [sanitizeString(guardian.name), phone, phone]
    );
    await connection.execute(
      `INSERT INTO parent_students (parent_id, student_id, relationship, is_primary)
       VALUES (?, ?, ?, ?)`,
      [
        parentInsert.insertId,
        studentId,
        sanitizeString(guardian.relationship) || "Parent",
        guardian.isPrimary === true,
      ]
    );
  }
}

async function generateAdmissionNumber(connection, academicYear) {
  await connection.execute(
    `INSERT INTO admission_number_sequences (academic_year, last_number)
     VALUES (?, 0)
     ON DUPLICATE KEY UPDATE academic_year = VALUES(academic_year)`,
    [academicYear]
  );
  await connection.execute(
    `UPDATE admission_number_sequences
     SET last_number = last_number + 1
     WHERE academic_year = ?`,
    [academicYear]
  );
  const [rows] = await connection.execute(
    "SELECT last_number FROM admission_number_sequences WHERE academic_year = ? FOR UPDATE",
    [academicYear]
  );
  const sequence = Number(rows[0]?.last_number);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`Unable to allocate an admission number for ${academicYear}.`);
  }
  return `MSS-${academicYear}-${String(sequence).padStart(4, "0")}`;
}

async function syncAdmissionNumberSequence(connection, admissionNumber) {
  const match = /^MSS-(\d{4})-(\d{4,})$/.exec(admissionNumber);
  if (!match) return;
  const academicYear = Number(match[1]);
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence > 4294967295) return;
  await connection.execute(
    `INSERT INTO admission_number_sequences (academic_year, last_number)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE last_number = GREATEST(last_number, VALUES(last_number))`,
    [academicYear, sequence]
  );
}

app.use(helmet());
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(
  express.json({
    limit: "1mb",
  })
);
app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many login attempts. Please try again later.",
  },
});

app.get("/api/health", async (req, res) => {
  try {
    const dbState = await pool.testConnection();
    return res.json({
      success: true,
      service: "Msongola Result-Parent System API",
      dbConnected: true,
      database: dbState.database,
      host: dbState.host,
      resultsIntegrationConfigured: resultsIntegrationKeyConfigured,
      smsDeliveryConfigured,
      smsDeliveryReportsConfigured: deliveryReportsConfigured,
    });
  } catch (error) {
    return res.json({
      success: true,
      service: "Msongola Result-Parent System API",
      dbConnected: false,
      message: "Unable to connect to the configured MySQL database.",
      nextStep: "Start MySQL and apply the schema.sql file for a new database or migration_result_integration.sql for an existing database.",
      resultsIntegrationConfigured: resultsIntegrationKeyConfigured,
      smsDeliveryConfigured,
      smsDeliveryReportsConfigured: deliveryReportsConfigured,
    });
  }
});

app.get("/api/dashboard/summary", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const isSystemAdmin = normalizeRole(req.user?.role || "") === "ADMIN";
    const [rows] = await pool.query(isSystemAdmin
      ? `SELECT
           (SELECT COUNT(*) FROM result_import_batches) AS importBatchCount,
           (SELECT COUNT(*) FROM sms_outbox WHERE status IN ('PENDING', 'PROCESSING')) AS pendingSmsCount,
           (SELECT COUNT(*) FROM sms_outbox WHERE status = 'FAILED') AS failedSmsCount,
           (SELECT COUNT(*) FROM users WHERE role IN ('admin', 'academic_master')) AS staffCount`
      : `SELECT
           (SELECT COUNT(*) FROM students) AS studentCount,
           (SELECT COUNT(*) FROM students s
            WHERE EXISTS (SELECT 1 FROM parent_students ps WHERE ps.student_id = s.id)) AS learnersWithGuardiansCount,
           (SELECT COUNT(*) FROM students s
            WHERE NOT EXISTS (SELECT 1 FROM parent_students ps WHERE ps.student_id = s.id)) AS learnersMissingGuardiansCount,
           (SELECT COUNT(*) FROM result_records) AS resultCount,
           (SELECT COUNT(DISTINCT subject) FROM result_records) AS subjectCount,
           (SELECT COUNT(*) FROM result_import_batches) AS importBatchCount,
           (SELECT COALESCE(SUM(missing_contacts), 0) FROM result_import_batches) AS missingContactsCount`
    );

    return res.json({
      success: true,
      data: rows[0],
    });
  } catch (error) {
    console.error("Dashboard summary query failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load the administration summary.",
    });
  }
});

app.get("/api/students", authenticateToken, requireAcademicMaster, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT s.id, s.name, s.admission_number AS admissionNumber, s.class_name AS className,
              s.year, (SELECT COUNT(*) FROM result_records rr WHERE rr.student_id = s.id) AS resultCount,
              (SELECT COUNT(*) FROM parent_students ps WHERE ps.student_id = s.id) AS guardianCount
       FROM students s
       ORDER BY s.name ASC`
    );

    return res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("Student list query failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load the learner list.",
    });
  }
});

app.post("/api/students", authenticateToken, requireAcademicMaster, async (req, res) => {
  const validationError = validateStudentRecord(req.body);
  if (validationError) {
    return res.status(400).json({ success: false, message: validationError });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const savedStudent = await saveStudentRecord(connection, req.body);
    await connection.commit();
    return res.status(201).json({
      success: true,
      message: "Learner and guardian contacts saved.",
      data: savedStudent,
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Learner registration rollback failed:", rollbackError.message);
      }
    }
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        message: "That admission number is already registered. Check the learner record and try again.",
      });
    }
    if (error.statusCode === 404) {
      return res.status(404).json({ success: false, message: error.message });
    }
    console.error("Learner registration failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to save the learner record." });
  } finally {
    if (connection) connection.release();
  }
});

app.post("/api/students/import", authenticateToken, requireAcademicMaster, async (req, res) => {
  const records = req.body?.students;
  if (!Array.isArray(records) || records.length === 0 || records.length > 500) {
    return res.status(400).json({
      success: false,
      message: "students must contain between 1 and 500 learner records.",
    });
  }

  const errors = [];
  const admissionNumbers = new Set();
  for (const [index, record] of records.entries()) {
    const validationError = validateStudentRecord(record);
    if (validationError) {
      errors.push({ row: index + 2, message: validationError });
    }
    const admissionNumber = sanitizeString(record?.admissionNumber).toLowerCase();
    if (admissionNumber && admissionNumbers.has(admissionNumber)) {
      errors.push({ row: index + 2, message: `Duplicate admission number in this file: ${sanitizeString(record.admissionNumber)}.` });
    }
    if (admissionNumber) admissionNumbers.add(admissionNumber);
  }
  if (errors.length) {
    return res.status(400).json({
      success: false,
      message: "The learner file contains invalid or duplicate records. Correct them and upload the file again.",
      errors: errors.slice(0, 100),
      errorCount: errors.length,
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const studentIds = [];
    const generatedAdmissionNumbers = [];
    for (const record of records) {
      const savedStudent = await saveStudentRecord(connection, record);
      studentIds.push(savedStudent.studentId);
      if (!sanitizeString(record.admissionNumber)) generatedAdmissionNumbers.push(savedStudent.admissionNumber);
    }
    await connection.commit();
    return res.status(201).json({
      success: true,
      message: `${studentIds.length} learner records and guardian contacts imported.`,
      data: { importedCount: studentIds.length, generatedAdmissionNumbers },
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Learner import rollback failed:", rollbackError.message);
      }
    }
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        message: "An admission number in this file is already registered. No records were imported.",
      });
    }
    console.error("Learner file import failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to import learner records. No records were saved.",
    });
  } finally {
    if (connection) connection.release();
  }
});

app.get("/api/students/:studentId", authenticateToken, requireAcademicMaster, async (req, res) => {
  const studentId = parsePositiveInteger(req.params.studentId, null);
  if (!studentId) {
    return res.status(400).json({ success: false, message: "A valid learner ID is required." });
  }

  try {
    const [studentsFound] = await pool.execute(
      `SELECT id, name, admission_number AS admissionNumber, class_name AS className, year
       FROM students
       WHERE id = ?
       LIMIT 1`,
      [studentId]
    );
    if (!studentsFound.length) {
      return res.status(404).json({ success: false, message: "Learner not found." });
    }
    const [guardians] = await pool.execute(
      `SELECT p.full_name AS name, p.phone_number AS phone,
              ps.relationship, ps.is_primary AS isPrimary
       FROM parent_students ps
       JOIN parents p ON p.id = ps.parent_id
       WHERE ps.student_id = ?
       ORDER BY ps.is_primary DESC, p.full_name ASC`,
      [studentId]
    );
    return res.json({
      success: true,
      data: { ...studentsFound[0], guardians },
    });
  } catch (error) {
    console.error("Learner record query failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load the learner record." });
  }
});

app.put("/api/students/:studentId", authenticateToken, requireAcademicMaster, async (req, res) => {
  const studentId = parsePositiveInteger(req.params.studentId, null);
  if (!studentId) {
    return res.status(400).json({ success: false, message: "A valid learner ID is required." });
  }
  const validationError = validateStudentRecord(req.body);
  if (validationError) {
    return res.status(400).json({ success: false, message: validationError });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const savedStudent = await saveStudentRecord(connection, req.body, studentId);
    await connection.commit();
    return res.json({
      success: true,
      message: "Learner and guardian contacts updated.",
      data: savedStudent,
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Learner update rollback failed:", rollbackError.message);
      }
    }
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        message: "That admission number is already registered to another learner.",
      });
    }
    if (error.statusCode === 404) {
      return res.status(404).json({ success: false, message: error.message });
    }
    console.error("Learner update failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to update the learner record." });
  } finally {
    if (connection) connection.release();
  }
});

app.get("/api/profile", authenticateToken, async (req, res) => {
  return res.json({
    success: true,
    user: req.user,
  });
});

app.get("/api/admin/users", authenticateToken, requireSystemAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, email, role, created_at AS createdAt
       FROM users
       WHERE role IN ('admin', 'academic_master')
       ORDER BY role ASC, name ASC`
    );
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error("Staff account list query failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load staff accounts." });
  }
});

app.post("/api/admin/users", authenticateToken, requireSystemAdmin, async (req, res) => {
  const validationError = validateStaffAccount(req.body);
  if (validationError) {
    return res.status(400).json({ success: false, message: validationError });
  }

  try {
    const passwordHash = await bcrypt.hash(String(req.body.password), 12);
    const [result] = await pool.execute(
      "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)",
      [
        sanitizeString(req.body.name),
        sanitizeString(req.body.email).toLowerCase(),
        passwordHash,
        normalizeRole(req.body.role).toLowerCase(),
      ]
    );
    return res.status(201).json({
      success: true,
      message: "Staff account created.",
      data: { id: result.insertId },
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "A staff account already uses that email address." });
    }
    console.error("Staff account creation failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to create the staff account." });
  }
});

app.put("/api/admin/users/:id", authenticateToken, requireSystemAdmin, async (req, res) => {
  const userId = parsePositiveInteger(req.params.id, null);
  if (!userId) {
    return res.status(400).json({ success: false, message: "A valid staff account ID is required." });
  }
  const validationError = validateStaffAccount(req.body, false);
  if (validationError) {
    return res.status(400).json({ success: false, message: validationError });
  }
  if (String(req.user.id) === String(userId) && normalizeRole(req.body.role) !== "ADMIN") {
    return res.status(409).json({ success: false, message: "You cannot remove your own administrator role." });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [users] = await connection.execute(
      "SELECT id, role FROM users WHERE id = ? FOR UPDATE",
      [userId]
    );
    if (!users.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: "Staff account not found." });
    }

    const previousRole = normalizeRole(users[0].role);
    const newRole = normalizeRole(req.body.role);
    if (previousRole === "ADMIN" && newRole !== "ADMIN") {
      const [administrators] = await connection.query(
        "SELECT id FROM users WHERE role = 'admin' FOR UPDATE"
      );
      if (administrators.length <= 1) {
        await connection.rollback();
        return res.status(409).json({ success: false, message: "The system must keep at least one administrator account." });
      }
    }

    const password = String(req.body.password || "");
    if (password) {
      const passwordHash = await bcrypt.hash(password, 12);
      await connection.execute(
        "UPDATE users SET name = ?, email = ?, role = ?, password_hash = ? WHERE id = ?",
        [
          sanitizeString(req.body.name),
          sanitizeString(req.body.email).toLowerCase(),
          newRole.toLowerCase(),
          passwordHash,
          userId,
        ]
      );
    } else {
      await connection.execute(
        "UPDATE users SET name = ?, email = ?, role = ? WHERE id = ?",
        [
          sanitizeString(req.body.name),
          sanitizeString(req.body.email).toLowerCase(),
          newRole.toLowerCase(),
          userId,
        ]
      );
    }

    await connection.commit();
    return res.json({ success: true, message: "Staff account updated." });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "A staff account already uses that email address." });
    }
    console.error("Staff account update failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to update the staff account." });
  } finally {
    if (connection) connection.release();
  }
});

app.delete("/api/admin/users/:id", authenticateToken, requireSystemAdmin, async (req, res) => {
  const userId = parsePositiveInteger(req.params.id, null);
  if (!userId) {
    return res.status(400).json({ success: false, message: "A valid staff account ID is required." });
  }
  if (String(req.user.id) === String(userId)) {
    return res.status(409).json({ success: false, message: "You cannot delete your own administrator account." });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [users] = await connection.execute(
      "SELECT id, role FROM users WHERE id = ? FOR UPDATE",
      [userId]
    );
    if (!users.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: "Staff account not found." });
    }
    if (normalizeRole(users[0].role) === "ADMIN") {
      const [administrators] = await connection.query(
        "SELECT id FROM users WHERE role = 'admin' FOR UPDATE"
      );
      if (administrators.length <= 1) {
        await connection.rollback();
        return res.status(409).json({ success: false, message: "The system must keep at least one administrator account." });
      }
    }

    await connection.execute("DELETE FROM users WHERE id = ?", [userId]);
    await connection.commit();
    return res.json({ success: true, message: "Staff account deleted." });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error("Staff account deletion failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to delete the staff account." });
  } finally {
    if (connection) connection.release();
  }
});

app.post("/api/auth/login", loginRateLimit, async (req, res) => {
  const email = sanitizeString(req.body?.email).toLowerCase();
  const password = String(req.body?.password || "");

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: "Email and password are required.",
    });
  }

  try {
    const [rows] = await pool.query(
      "SELECT id, name, email, password_hash, role FROM users WHERE email = ? LIMIT 1",
      [email]
    );

    if (!rows.length) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    const userRow = rows[0];
    const normalizedRole = normalizeRole(userRow.role);
    const allowedRoles = new Set(["ADMIN", "ACADEMIC_MASTER"]);

    if (!allowedRoles.has(normalizedRole)) {
      return res.status(403).json({
        success: false,
        message: "This account does not have access to the administration dashboard.",
      });
    }

    const isValidPassword = await bcrypt.compare(password, userRow.password_hash);

    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    const user = {
      id: userRow.id,
      name: userRow.name,
      email: userRow.email,
      role: normalizedRole,
    };

    return res.json({
      success: true,
      user,
      token: buildAuthToken(user),
    });
  } catch (error) {
    return res.status(503).json({
      success: false,
      message: "Database unavailable. Please check the MySQL connection.",
    });
  }
});

app.post("/api/integrations/results/batches", async (req, res) => {
  const suppliedKey = req.get("x-integration-key");
  if (!resultsIntegrationKeyConfigured) {
    return res.status(503).json({
      success: false,
      message: "Results integration is not configured. Set a 32-character RESULTS_INTEGRATION_KEY.",
    });
  }
  if (!integrationKeyMatches(suppliedKey)) {
    return res.status(401).json({
      success: false,
      message: "Invalid integration credentials.",
    });
  }

  const validationError = validateResultsBatch(req.body);
  if (validationError) {
    return res.status(400).json({
      success: false,
      message: validationError,
    });
  }

  const batch = req.body;
  if (req.get("x-integration-dry-run")?.toLowerCase() === "true") {
    const resultCount = batch.students.reduce((total, student) => total + student.results.length, 0);
    const guardianCount = batch.students.reduce((total, student) => total + student.guardians.length, 0);
    return res.json({
      success: true,
      dryRun: true,
      message: "Batch validated. No results were imported and no SMS messages were queued.",
      data: {
        batchId: sanitizeString(batch.batchId),
        studentCount: batch.students.length,
        resultCount,
        guardianCount,
      },
    });
  }

  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    let batchId;
    try {
      const [batchInsert] = await connection.execute(
        `INSERT INTO result_import_batches
           (source_system, source_batch_id, exam_name, term, year, status, received_records)
         VALUES (?, ?, ?, ?, ?, 'PROCESSING', ?)`,
        [
          sanitizeString(batch.sourceSystem),
          sanitizeString(batch.batchId),
          sanitizeString(batch.examName),
          sanitizeString(batch.term),
          Number(batch.year),
          batch.students.reduce((total, student) => total + student.results.length, 0),
        ]
      );
      batchId = batchInsert.insertId;
    } catch (error) {
      if (error.code !== "ER_DUP_ENTRY") {
        throw error;
      }

      await connection.rollback();
      const [existingBatches] = await connection.execute(
        `SELECT id, source_system AS sourceSystem, source_batch_id AS batchId,
                status, imported_records AS importedRecords,
                duplicate_records AS duplicateRecords, queued_messages AS queuedMessages
         FROM result_import_batches
         WHERE source_batch_id = ?
         LIMIT 1`,
        [sanitizeString(batch.batchId)]
      );

      if (!existingBatches.length) {
        throw error;
      }

      return res.status(200).json({
        success: true,
        duplicate: true,
        message: "This result batch was already processed.",
        data: existingBatches[0],
      });
    }

    const studentGroups = new Map();
    let importedRecords = 0;
    let duplicateRecords = 0;

    for (const incomingStudent of batch.students) {
      const admissionNumber = sanitizeString(incomingStudent.admissionNumber);
      const externalStudentId = sanitizeString(incomingStudent.externalStudentId) || null;
      const [matchingStudents] = await connection.execute(
        `SELECT id, admission_number AS admissionNumber, external_student_id AS externalStudentId
         FROM students
         WHERE admission_number = ?
            OR (? IS NOT NULL AND external_student_id = ?)
         LIMIT 2
         FOR UPDATE`,
        [admissionNumber, externalStudentId, externalStudentId]
      );

      if (matchingStudents.length > 1) {
        const conflict = new Error(`Learner identifiers conflict for admission number ${admissionNumber}.`);
        conflict.statusCode = 409;
        throw conflict;
      }

      let studentId;
      if (matchingStudents.length) {
        const existingStudent = matchingStudents[0];
        if (
          (existingStudent.admissionNumber !== admissionNumber &&
            (!externalStudentId || existingStudent.externalStudentId !== externalStudentId)) ||
          (existingStudent.externalStudentId && externalStudentId &&
            existingStudent.externalStudentId !== externalStudentId)
        ) {
          const conflict = new Error(`Learner identifiers conflict for admission number ${admissionNumber}.`);
          conflict.statusCode = 409;
          throw conflict;
        }

        studentId = existingStudent.id;
        await connection.execute(
          `UPDATE students
           SET external_student_id = COALESCE(external_student_id, ?),
               admission_number = ?, name = ?, class_name = ?, year = ?
           WHERE id = ?`,
          [
            externalStudentId,
            admissionNumber,
            sanitizeString(incomingStudent.name),
            sanitizeString(incomingStudent.className),
            Number(batch.year),
            studentId,
          ]
        );
      } else {
        const [studentInsert] = await connection.execute(
          `INSERT INTO students (external_student_id, name, admission_number, class_name, year)
           VALUES (?, ?, ?, ?, ?)`,
          [
            externalStudentId,
            sanitizeString(incomingStudent.name),
            admissionNumber,
            sanitizeString(incomingStudent.className),
            Number(batch.year),
          ]
        );
        studentId = studentInsert.insertId;
      }

      let studentGroup = studentGroups.get(studentId);
      if (!studentGroup) {
        studentGroup = {
          studentId,
          studentName: sanitizeString(incomingStudent.name),
          guardians: new Map(),
          importedResults: [],
        };
        studentGroups.set(studentId, studentGroup);
      }

      await connection.execute("DELETE FROM parent_students WHERE student_id = ?", [studentId]);
      for (const [guardianIndex, guardian] of incomingStudent.guardians.entries()) {
        const phone = normalizePhoneNumber(guardian.phone);
        const [parentInsert] = await connection.execute(
          `INSERT INTO parents (full_name, phone_number, phone_number_normalized)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id),
                                   full_name = VALUES(full_name),
                                   phone_number = VALUES(phone_number),
                                   status = 'active'`,
          [sanitizeString(guardian.name), sanitizeString(guardian.phone), phone]
        );
        const parentId = parentInsert.insertId;
        await connection.execute(
          `INSERT INTO parent_students (parent_id, student_id, relationship, is_primary)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE relationship = VALUES(relationship),
                                   is_primary = VALUES(is_primary)`,
          [
            parentId,
            studentId,
            sanitizeString(guardian.relationship) || "Parent",
            guardian.isPrimary === undefined ? guardianIndex === 0 : guardian.isPrimary,
          ]
        );
        studentGroup.guardians.set(phone, {
          id: parentId,
          name: sanitizeString(guardian.name),
          phone,
        });
      }

      for (const result of incomingStudent.results) {
        const score = Number(result.score);
        const [insertResult] = await connection.execute(
          `INSERT IGNORE INTO result_records
             (external_result_id, import_batch_id, student_id, subject, score, grade, term, year, comment)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sanitizeString(result.externalResultId),
            batchId,
            studentId,
            sanitizeString(result.subject),
            score,
            sanitizeString(result.grade) || gradeFromScore(score),
            sanitizeString(batch.term),
            Number(batch.year),
            sanitizeString(result.comment) || null,
          ]
        );

        if (insertResult.affectedRows !== 1) {
          duplicateRecords += 1;
          continue;
        }

        importedRecords += 1;
        studentGroup.importedResults.push({
          subject: sanitizeString(result.subject),
          score,
          grade: sanitizeString(result.grade) || gradeFromScore(score),
        });
      }
    }

    let queuedMessages = 0;
    let missingContacts = 0;

    for (const studentGroup of studentGroups.values()) {
      if (!studentGroup.importedResults.length) {
        continue;
      }

      const [savedGuardians] = await connection.execute(
        `SELECT p.id, p.full_name AS name, p.phone_number AS phone
         FROM parent_students ps
         JOIN parents p ON p.id = ps.parent_id
         WHERE ps.student_id = ? AND p.status = 'active'`,
        [studentGroup.studentId]
      );

      for (const guardian of savedGuardians) {
        const phone = normalizePhoneNumber(guardian.phone);
        if (phone && !studentGroup.guardians.has(phone)) {
          studentGroup.guardians.set(phone, {
            id: guardian.id,
            name: guardian.name,
            phone,
          });
        }
      }

      if (!studentGroup.guardians.size) {
        missingContacts += 1;
        continue;
      }

      const messageText =
        `Hello {guardian}, results for ${studentGroup.studentName} — ${sanitizeString(batch.examName)} ` +
        `(${sanitizeString(batch.term)} ${Number(batch.year)}): ` +
        studentGroup.importedResults
          .map((result) => `${result.subject} ${result.grade} (${result.score}%)`)
          .join(", ") +
        ".";

      for (const guardian of studentGroup.guardians.values()) {
        await connection.execute(
          `INSERT INTO sms_outbox
             (import_batch_id, parent_id, student_id, recipient_phone, message_text, status)
           VALUES (?, ?, ?, ?, ?, 'PENDING')`,
          [
            batchId,
            guardian.id,
            studentGroup.studentId,
            guardian.phone,
            messageText.replace("{guardian}", guardian.name || "Parent/Guardian"),
          ]
        );
        queuedMessages += 1;
      }
    }

    await connection.execute(
      `UPDATE result_import_batches
       SET status = 'COMPLETED', imported_records = ?, duplicate_records = ?,
           queued_messages = ?, missing_contacts = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [importedRecords, duplicateRecords, queuedMessages, missingContacts, batchId]
    );
    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Approved results imported and guardian SMS messages added to the outbox.",
      data: {
        batchId,
        sourceBatchId: sanitizeString(batch.batchId),
        receivedRecords: batch.students.reduce((total, student) => total + student.results.length, 0),
        importedRecords,
        duplicateRecords,
        queuedMessages,
        missingContacts,
        deliveryStatus: smsDeliveryConfigured ? "QUEUED_FOR_DELIVERY" : "PENDING_PROVIDER",
      },
    });
  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => {});
    }

    if (error.code === "ER_DUP_ENTRY" && batch?.batchId) {
      try {
        const [existingBatches] = await pool.query(
          `SELECT id, source_system AS sourceSystem, source_batch_id AS batchId,
                  status, imported_records AS importedRecords,
                  duplicate_records AS duplicateRecords, queued_messages AS queuedMessages
           FROM result_import_batches
           WHERE source_batch_id = ?
           LIMIT 1`,
          [sanitizeString(batch.batchId)]
        );
        if (existingBatches.length) {
          return res.status(200).json({
            success: true,
            duplicate: true,
            message: "This result batch was already processed.",
            data: existingBatches[0],
          });
        }
      } catch (lookupError) {
        console.error("Could not look up duplicate result batch:", lookupError.message);
      }
    }

    console.error("Result batch import failed:", error.message);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : "Unable to import the result batch.",
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

app.get("/api/reports/summary", authenticateToken, requireAcademicMaster, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT subject, AVG(score) AS averageScore, MIN(score) AS lowestScore, MAX(score) AS highestScore,
              COUNT(*) AS entries
       FROM result_records
       GROUP BY subject
       ORDER BY averageScore DESC`
    );

    return res.json({
      success: true,
      data: rows.map((row) => ({
        subject: row.subject,
        averageScore: Number(row.averageScore).toFixed(1),
        lowestScore: row.lowestScore,
        highestScore: row.highestScore,
        entries: row.entries,
      })),
    });
  } catch (error) {
    console.error("Result summary query failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load the result summary.",
    });
  }
});

app.get("/api/reports/results", authenticateToken, requireAcademicMaster, async (req, res) => {
  const year = req.query.year === undefined ? null : parsePositiveInteger(req.query.year, null);
  const className = sanitizeString(req.query.className);
  const subject = sanitizeString(req.query.subject);
  const term = sanitizeString(req.query.term);
  if ((req.query.year !== undefined && !year)
    || className.length > 80
    || subject.length > 120
    || term.length > 50) {
    return res.status(400).json({
      success: false,
      message: "Report filters contain an invalid year, class, subject, or term.",
    });
  }

  const conditions = [];
  const parameters = [];
  if (year) {
    conditions.push("r.year = ?");
    parameters.push(year);
  }
  if (className) {
    conditions.push("s.class_name = ?");
    parameters.push(className);
  }
  if (subject) {
    conditions.push("r.subject = ?");
    parameters.push(subject);
  }
  if (term) {
    conditions.push("r.term = ?");
    parameters.push(term);
  }

  try {
    const [rows] = await pool.query(
      `SELECT s.name AS studentName, s.admission_number AS admissionNumber,
              s.class_name AS className, r.subject, r.score, r.grade, r.term, r.year, r.comment
       FROM result_records r
       INNER JOIN students s ON s.id = r.student_id
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY s.class_name ASC, s.name ASC, r.year DESC, r.term ASC, r.subject ASC`,
      parameters
    );
    return res.json({
      success: true,
      data: rows.map((row) => ({ ...row, score: Number(row.score) })),
    });
  } catch (error) {
    console.error("Academic results report query failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load the academic results report.",
    });
  }
});

app.get("/api/results", authenticateToken, requireAcademicMaster, async (req, res) => {
  const studentId = parsePositiveInteger(req.query.studentId, null);
  if (!studentId) {
    return res.status(400).json({
      success: false,
      message: "A valid studentId query parameter is required.",
    });
  }

  try {
    const [rows] = await pool.query(
      `SELECT s.id AS studentId, s.name AS studentName, s.admission_number AS admissionNumber, s.class_name AS className,
              r.subject, r.score, r.grade, r.term, r.year, r.comment
       FROM students s
       LEFT JOIN result_records r ON r.student_id = s.id
       WHERE s.id = ?
       ORDER BY r.year DESC, r.term ASC`,
      [studentId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    return res.json({
      success: true,
      data: buildStudentPayload(rows),
    });
  } catch (error) {
    console.error("Result query failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load student results.",
    });
  }
});

app.get("/api/results/:studentId", authenticateToken, requireAcademicMaster, async (req, res) => {
  const studentId = parsePositiveInteger(req.params.studentId, null);
  if (!studentId) {
    return res.status(400).json({
      success: false,
      message: "A valid student ID is required.",
    });
  }

  try {
    const [rows] = await pool.query(
      `SELECT s.id AS studentId, s.name AS studentName, s.admission_number AS admissionNumber, s.class_name AS className,
              r.subject, r.score, r.grade, r.term, r.year, r.comment
       FROM students s
       LEFT JOIN result_records r ON r.student_id = s.id
       WHERE s.id = ?
       ORDER BY r.year DESC, r.term ASC`,
      [studentId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    return res.json({
      success: true,
      data: buildStudentPayload(rows),
    });
  } catch (error) {
    console.error("Result query failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load student results.",
    });
  }
});

app.get("/api/students/:studentId/results", authenticateToken, requireAcademicMaster, async (req, res) => {
  const studentId = parsePositiveInteger(req.params.studentId, null);
  if (!studentId) {
    return res.status(400).json({
      success: false,
      message: "A valid student ID is required.",
    });
  }

  try {
    const [rows] = await pool.query(
      `SELECT s.id AS studentId, s.name AS studentName, s.admission_number AS admissionNumber, s.class_name AS className,
              r.subject, r.score, r.grade, r.term, r.year, r.comment
       FROM students s
       LEFT JOIN result_records r ON r.student_id = s.id
       WHERE s.id = ?
       ORDER BY r.year DESC, r.term ASC`,
      [studentId]
    );

    if (rows.length) {
      return res.json({
        success: true,
        data: buildStudentPayload(rows),
      });
    }

    return res.status(404).json({
      success: false,
      message: "Student results not found.",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Unable to load student results.",
    });
  }
});

app.get("/api/students/:studentId/contact", authenticateToken, requireAcademicMaster, async (req, res) => {
  const studentId = parsePositiveInteger(req.params.studentId, null);

  if (!studentId) {
    return res.status(400).json({
      success: false,
      message: "A valid student ID is required.",
    });
  }

  try {
    const [rows] = await pool.query(
      `SELECT s.id, s.name AS studentName, s.admission_number AS admissionNumber, s.class_name AS className,
              p.full_name AS parentName, p.phone_number AS parentPhone
       FROM students s
       LEFT JOIN parent_students ps ON ps.student_id = s.id
       LEFT JOIN parents p ON p.id = ps.parent_id
       WHERE s.id = ?
       ORDER BY ps.is_primary DESC, p.id ASC
       LIMIT 1`,
      [studentId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    return res.json({
      success: true,
      data: {
        studentId: rows[0].id,
        studentName: rows[0].studentName,
        admissionNumber: rows[0].admissionNumber,
        className: rows[0].className,
        parentName: rows[0].parentName || null,
        parentPhone: rows[0].parentPhone || null,
      },
    });
  } catch (error) {
    console.error("Parent contact query failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load the learner's parent contact.",
    });
  }
});

app.get("/api/integrations/batches", authenticateToken, requireAdmin, async (req, res) => {
  const limit = Math.min(parsePositiveInteger(req.query.limit, 20), 100);

  try {
    const [rows] = await pool.query(
      `SELECT id, source_system AS sourceSystem, source_batch_id AS sourceBatchId,
              exam_name AS examName, term, year, status, received_records AS receivedRecords,
              imported_records AS importedRecords, duplicate_records AS duplicateRecords,
              queued_messages AS queuedMessages, missing_contacts AS missingContacts,
              received_at AS receivedAt, completed_at AS completedAt
       FROM result_import_batches
       ORDER BY received_at DESC
       LIMIT ?`,
      [limit]
    );

    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error("Result import batch query failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load result import history.",
    });
  }
});

app.get("/api/sms/outbox", authenticateToken, requireSystemAdmin, async (req, res) => {
  const limit = Math.min(parsePositiveInteger(req.query.limit, 50), 100);
  const requestedStatus = sanitizeString(req.query.status).toUpperCase();
  const allowedStatuses = new Set(["PENDING", "PROCESSING", "SENT", "DELIVERED", "FAILED"]);

  if (requestedStatus && !allowedStatuses.has(requestedStatus)) {
    return res.status(400).json({
      success: false,
      message: "status must be PENDING, PROCESSING, SENT, DELIVERED, or FAILED.",
    });
  }

  try {
    const statusClause = requestedStatus ? "WHERE o.status = ?" : "";
    const parameters = requestedStatus ? [requestedStatus, limit] : [limit];
    const [rows] = await pool.query(
      `SELECT o.id, o.status, o.recipient_phone AS recipientPhone,
              o.message_text AS messageText, o.attempts, o.last_error AS lastError,
              o.created_at AS createdAt, o.processing_started_at AS processingStartedAt,
              o.sent_at AS sentAt, o.delivered_at AS deliveredAt,
              p.full_name AS parentName, s.name AS studentName,
              s.admission_number AS admissionNumber, b.exam_name AS examName,
              b.term, b.year
       FROM sms_outbox o
       JOIN parents p ON p.id = o.parent_id
       JOIN students s ON s.id = o.student_id
       JOIN result_import_batches b ON b.id = o.import_batch_id
       ${statusClause}
       ORDER BY o.created_at DESC
       LIMIT ?`,
      parameters
    );

    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error("SMS outbox query failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load the SMS outbox.",
    });
  }
});

app.post("/api/integrations/sms/delivery-reports", async (req, res) => {
  if (!deliveryReportsConfigured) {
    return res.status(503).json({
      success: false,
      message: "SMS delivery reports are not configured. Set AFRICASTALKING_DELIVERY_TOKEN.",
    });
  }
  if (!deliveryTokenMatches(req.query.token)) {
    return res.status(401).json({ success: false, message: "Invalid delivery report credentials." });
  }

  try {
    const result = await processDeliveryReport(req.body);
    if (!result.accepted && result.notFound) {
      console.warn(`Ignored unmatched Africa's Talking delivery report for provider message ${String(req.body?.id || "").slice(0, 150)}.`);
      return res.status(404).json({ success: false, message: result.message });
    }
    if (!result.accepted) {
      return res.status(400).json({ success: false, message: result.message });
    }
    return res.json({
      success: true,
      duplicate: result.duplicate,
      ...(result.status ? { status: result.status } : {}),
    });
  } catch (error) {
    console.error("Africa's Talking delivery report update failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to process the delivery report." });
  }
});

app.post("/api/sms/outbox/:id/retry", authenticateToken, requireSystemAdmin, async (req, res) => {
  if (!smsDeliveryConfigured) {
    return res.status(503).json({
      success: false,
      message: "Enable Africa's Talking SMS delivery before retrying queued messages.",
    });
  }

  const messageId = parsePositiveInteger(req.params.id, null);
  if (!messageId) {
    return res.status(400).json({ success: false, message: "A valid SMS outbox message ID is required." });
  }

  try {
    const [result] = await pool.execute(
      `UPDATE sms_outbox
       SET status = 'PENDING', last_error = NULL, processing_started_at = NULL
       WHERE id = ? AND status = 'FAILED'`,
      [messageId]
    );
    if (result.affectedRows) {
      return res.json({ success: true, message: "Failed SMS message queued for another delivery attempt." });
    }

    const [rows] = await pool.execute("SELECT status FROM sms_outbox WHERE id = ?", [messageId]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "SMS outbox message not found." });
    }
    return res.status(409).json({
      success: false,
      message: `Only failed SMS messages can be retried. Current status: ${rows[0].status}.`,
    });
  } catch (error) {
    console.error("SMS retry request failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to retry this SMS message." });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../Frontend/index.html"));
});

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found.",
  });
});

app.use(express.static(path.join(__dirname, "../Frontend")));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "../Frontend/index.html"));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  const isApiRequest = req.path.startsWith("/api/");
  if (isApiRequest) {
    const statusCode = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
    if (statusCode === 500) {
      console.error("Unhandled API request error:", error.message);
    }
    return res.status(statusCode).json({
      success: false,
      message: statusCode === 413
        ? "Request body exceeds the allowed size."
        : statusCode === 400
          ? "Request body is not valid JSON or form data."
          : "Unable to process the API request.",
    });
  }

  console.error("Unhandled request error:", error.message);
  return res.status(500).send("Unable to process the request.");
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Msongola Result-Parent API running on http://localhost:${PORT}`);
    startSmsWorker();
  });
}

module.exports = {
  app,
  integrationKeyMatches,
  validateStudentRecord,
  validateResultsBatch,
};
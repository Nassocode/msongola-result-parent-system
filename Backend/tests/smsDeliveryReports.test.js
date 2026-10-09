const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");

process.env.SMS_DELIVERY_ENABLED = "false";
process.env.AFRICASTALKING_DELIVERY_TOKEN = "delivery-report-token-for-tests-12345";

const databaseCalls = [];
let nextUpdateAffectedRows = 1;
let existingMessageStatus = "DELIVERED";
const fakePool = {
  async execute(sql, parameters) {
    databaseCalls.push({ sql, parameters });
    if (sql.startsWith("UPDATE sms_outbox")) {
      return [{ affectedRows: nextUpdateAffectedRows }];
    }
    return [existingMessageStatus ? [{ status: existingMessageStatus }] : []];
  },
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "./config/db" && parent?.filename.endsWith("smsDelivery.js")) {
    return fakePool;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  deliveryReportsConfigured,
  deliveryTokenMatches,
  processDeliveryReport,
} = require("../smsDelivery");
Module._load = originalLoad;

const { isConfiguredSecret } = require("../config/secrets");
const report = {
  id: "AT-message-101",
  phoneNumber: "+263771234567",
  status: "Success",
};

test("delivery report tokens require the configured secret", () => {
  assert.equal(deliveryReportsConfigured, true);
  assert.equal(deliveryTokenMatches(process.env.AFRICASTALKING_DELIVERY_TOKEN), true);
  assert.equal(deliveryTokenMatches("incorrect-delivery-token"), false);
  assert.equal(deliveryTokenMatches(undefined), false);
});

test("environment example placeholders are not accepted as secrets", () => {
  assert.equal(isConfiguredSecret("replace-with-a-random-secret-at-least-32-characters"), false);
  assert.equal(isConfiguredSecret("your-private-random-token-at-least-32-characters"), false);
  assert.equal(isConfiguredSecret("a-real-random-secret-of-more-than-32-characters"), true);
});

test("matches a successful provider report by message ID and recipient", async () => {
  databaseCalls.length = 0;
  nextUpdateAffectedRows = 1;

  assert.deepEqual(await processDeliveryReport(report), { accepted: true, duplicate: false });
  assert.match(databaseCalls[0].sql, /status = 'SENT'/);
  assert.match(databaseCalls[0].sql, /delivered_at = CURRENT_TIMESTAMP/);
  assert.deepEqual(databaseCalls[0].parameters, ["DELIVERED", null, report.id, report.phoneNumber]);
});

test("records a failed provider report without hiding the provider reason", async () => {
  databaseCalls.length = 0;
  nextUpdateAffectedRows = 1;

  const result = await processDeliveryReport({
    ...report,
    status: "Failed",
    failureReason: "Rejected by recipient network",
  });

  assert.deepEqual(result, { accepted: true, duplicate: false });
  assert.match(databaseCalls[0].sql, /delivered_at = NULL/);
  assert.deepEqual(databaseCalls[0].parameters, ["FAILED", "Rejected by recipient network", report.id, report.phoneNumber]);
});

test("accepts repeated known reports without applying them twice", async () => {
  databaseCalls.length = 0;
  nextUpdateAffectedRows = 0;
  existingMessageStatus = "DELIVERED";

  assert.deepEqual(await processDeliveryReport(report), {
    accepted: true,
    duplicate: true,
    status: "DELIVERED",
  });
  assert.equal(databaseCalls.length, 2);
});

test("rejects malformed reports and unknown provider messages", async () => {
  assert.equal((await processDeliveryReport({ ...report, phoneNumber: "0771234567" })).accepted, false);
  assert.equal((await processDeliveryReport({ ...report, status: "Processing" })).accepted, false);
  assert.equal((await processDeliveryReport({ ...report, id: "" })).accepted, false);

  nextUpdateAffectedRows = 0;
  existingMessageStatus = undefined;
  assert.deepEqual(await processDeliveryReport(report), {
    accepted: false,
    notFound: true,
    message: "No matching SMS outbox message was found.",
  });
});

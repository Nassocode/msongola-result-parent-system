const crypto = require("crypto");
const pool = require("./config/db");
const { isConfiguredSecret } = require("./config/secrets");

const environment = String(process.env.AFRICASTALKING_ENVIRONMENT || "sandbox").trim().toLowerCase();
const username = String(process.env.AFRICASTALKING_USERNAME || "").trim();
const apiKey = String(process.env.AFRICASTALKING_API_KEY || "").trim();
const senderId = String(process.env.AFRICASTALKING_SENDER_ID || "").trim();
const deliveryToken = String(process.env.AFRICASTALKING_DELIVERY_TOKEN || "").trim();
const enabled = String(process.env.SMS_DELIVERY_ENABLED || "").trim().toLowerCase() === "true";
const credentialsConfigured = Boolean(username && apiKey);

if (!["sandbox", "production"].includes(environment)) {
  throw new Error("AFRICASTALKING_ENVIRONMENT must be sandbox or production.");
}
if (enabled && !credentialsConfigured) {
  throw new Error("Set AFRICASTALKING_USERNAME and AFRICASTALKING_API_KEY before enabling SMS_DELIVERY_ENABLED.");
}

const apiUrl = environment === "production"
  ? "https://api.africastalking.com/version1/messaging"
  : "https://api.sandbox.africastalking.com/version1/messaging";
const smsDeliveryConfigured = enabled && credentialsConfigured;
const deliveryReportsConfigured = isConfiguredSecret(deliveryToken);
const staleProcessingMinutes = 10;
let workerRunning = false;

function deliveryTokenMatches(candidate) {
  if (!deliveryReportsConfigured || typeof candidate !== "string" || !candidate) {
    return false;
  }
  const expectedDigest = crypto.createHash("sha256").update(deliveryToken).digest();
  const candidateDigest = crypto.createHash("sha256").update(candidate).digest();
  return crypto.timingSafeEqual(expectedDigest, candidateDigest);
}

async function processDeliveryReport(report) {
  const providerMessageId = String(report?.id || "").trim();
  const recipientPhone = String(report?.phoneNumber || "").trim().replace(/[^\d+]/g, "");
  const providerStatus = String(report?.status || "").trim().toLowerCase();
  const failureReason = String(report?.failureReason || "").trim().slice(0, 1000);

  if (!providerMessageId || providerMessageId.length > 150) {
    return { accepted: false, message: "A valid provider message ID is required." };
  }
  if (!/^\+[1-9]\d{6,14}$/.test(recipientPhone)) {
    return { accepted: false, message: "A valid international phone number is required." };
  }
  if (!["success", "failed"].includes(providerStatus)) {
    return { accepted: false, message: "Delivery status must be Success or Failed." };
  }

  const delivered = providerStatus === "success";
  const [update] = await pool.execute(
    `UPDATE sms_outbox
     SET status = ?, delivered_at = ${delivered ? "CURRENT_TIMESTAMP" : "NULL"},
         last_error = ?
     WHERE provider_message_id = ? AND recipient_phone = ? AND status = 'SENT'`,
    [delivered ? "DELIVERED" : "FAILED", delivered ? null : failureReason || "Africa's Talking reported delivery failure.", providerMessageId, recipientPhone]
  );
  if (update.affectedRows) {
    return { accepted: true, duplicate: false };
  }

  const [existing] = await pool.execute(
    "SELECT status FROM sms_outbox WHERE provider_message_id = ? AND recipient_phone = ? LIMIT 1",
    [providerMessageId, recipientPhone]
  );
  if (!existing.length) {
    return { accepted: false, notFound: true, message: "No matching SMS outbox message was found." };
  }
  return { accepted: true, duplicate: true, status: existing[0].status };
}

function getProviderError(error) {
  if (error.name === "AbortError" || error.name === "TimeoutError" || error.code === "ETIMEDOUT") {
    return "Africa's Talking did not respond before the request timed out.";
  }
  return "Could not connect to Africa's Talking.";
}

async function sendSms(message) {
  const body = new URLSearchParams({
    username,
    to: message.recipient_phone,
    message: message.message_text,
  });
  if (senderId) body.set("from", senderId);

  let response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new Error(getProviderError(error));
  }

  if (!response.ok) {
    throw new Error(`Africa's Talking request failed with HTTP ${response.status}.`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error("Africa's Talking returned an unexpected SMS response.");
  }

  const recipients = payload?.SMSMessageData?.Recipients;
  if (!Array.isArray(recipients) || recipients.length !== 1) {
    throw new Error("Africa's Talking returned an unexpected SMS response.");
  }

  const recipient = recipients[0];
  const statusCode = Number(recipient.statusCode);
  const status = String(recipient.status || "").toLowerCase();
  if (![100, 101, 102].includes(statusCode) && status !== "success") {
    throw new Error(`Africa's Talking rejected the SMS (status ${Number.isFinite(statusCode) ? statusCode : "unknown"}).`);
  }

  return String(recipient.messageId || "").slice(0, 150) || null;
}

async function claimNextMessage() {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const [messages] = await connection.query(
      `SELECT id, recipient_phone, message_text
       FROM sms_outbox
       WHERE status = 'PENDING'
       ORDER BY created_at ASC, id ASC
       LIMIT 1
       FOR UPDATE`
    );

    if (!messages.length) {
      await connection.commit();
      return null;
    }

    const message = messages[0];
    await connection.execute(
      `UPDATE sms_outbox
       SET status = 'PROCESSING', attempts = attempts + 1,
           processing_started_at = CURRENT_TIMESTAMP, last_error = NULL
       WHERE id = ? AND status = 'PENDING'`,
      [message.id]
    );
    await connection.commit();
    return message;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function deliverMessage(message) {
  let providerMessageId;
  try {
    providerMessageId = await sendSms(message);
  } catch (error) {
    const failure = error instanceof Error ? error.message : "Unexpected SMS delivery failure.";
    try {
      await pool.execute(
        `UPDATE sms_outbox
         SET status = 'FAILED', last_error = ?, processing_started_at = NULL
         WHERE id = ? AND status = 'PROCESSING'`,
        [failure, message.id]
      );
    } catch (databaseError) {
      console.error(`Could not record failure for SMS outbox message ${message.id}:`, databaseError.message);
      throw databaseError;
    }
    console.error(`SMS outbox message ${message.id} failed: ${failure}`);
    return;
  }

  await pool.execute(
    `UPDATE sms_outbox
     SET status = 'SENT', provider_message_id = ?, last_error = NULL,
         processing_started_at = NULL, sent_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'PROCESSING'`,
    [providerMessageId, message.id]
  );
  console.info(`SMS outbox message ${message.id} was accepted by Africa's Talking.`);
}

async function processOutbox() {
  if (!smsDeliveryConfigured || workerRunning) return;
  workerRunning = true;

  try {
    const [recovered] = await pool.execute(
      `UPDATE sms_outbox
       SET status = 'PENDING', processing_started_at = NULL,
           last_error = 'Delivery outcome unknown after worker interruption; retry may send a duplicate SMS.'
       WHERE status = 'PROCESSING'
         AND processing_started_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? MINUTE)`,
      [staleProcessingMinutes]
    );
    if (recovered.affectedRows) {
      console.warn(`Recovered ${recovered.affectedRows} interrupted SMS outbox message(s); a duplicate delivery is possible.`);
    }

    for (let count = 0; count < 10; count += 1) {
      const message = await claimNextMessage();
      if (!message) break;
      await deliverMessage(message);
    }
  } finally {
    workerRunning = false;
  }
}

function startSmsWorker() {
  if (!smsDeliveryConfigured) {
    console.info("Africa's Talking SMS delivery is disabled. Set credentials and SMS_DELIVERY_ENABLED=true to enable it.");
    return;
  }

  console.info(`Africa's Talking SMS worker enabled (${environment}).`);
  processOutbox().catch((error) => {
    console.error("SMS outbox worker failed:", error.message);
  });
  const timer = setInterval(() => {
    processOutbox().catch((error) => {
      console.error("SMS outbox worker failed:", error.message);
    });
  }, 15000);
  timer.unref();
}

module.exports = {
  deliveryReportsConfigured,
  deliveryTokenMatches,
  processDeliveryReport,
  smsDeliveryConfigured,
  sendSms,
  startSmsWorker,
};

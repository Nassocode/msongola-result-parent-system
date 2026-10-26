
const assert = require("node:assert/strict");
const test = require("node:test");

process.env.SMS_DELIVERY_ENABLED = "true";
process.env.AFRICASTALKING_ENVIRONMENT = "sandbox";
process.env.AFRICASTALKING_USERNAME = "sandbox";
process.env.AFRICASTALKING_API_KEY = "unit-test-api-key";
process.env.AFRICASTALKING_SENDER_ID = "MSONGOLA";

const { sendSms, smsDeliveryConfigured } = require("../smsDelivery");

const message = {
  recipient_phone: "+263771234567",
  message_text: "Results for Asha: Mathematics A (92%).",
};

test("posts a form-encoded SMS to the Africa's Talking sandbox", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let request;
  global.fetch = async (...args) => {
    request = args;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
        SMSMessageData: {
          Recipients: [{ statusCode: 101, messageId: "AT-sandbox-101" }],
        },
        };
      },
    };
  };

  assert.equal(smsDeliveryConfigured, true);
  assert.equal(await sendSms(message), "AT-sandbox-101");
  assert.equal(request[0], "https://api.sandbox.africastalking.com/version1/messaging");
  assert.equal(request[1].method, "POST");
  assert.equal(request[1].headers.apiKey, "unit-test-api-key");
  assert.equal(request[1].signal instanceof AbortSignal, true);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request[1].body)), {
    username: "sandbox",
    to: message.recipient_phone,
    message: message.message_text,
    from: "MSONGOLA",
  });
});

test("accepts Africa's Talking's success status response", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
      SMSMessageData: {
        Recipients: [{ status: "Success", messageId: "AT-sandbox-success" }],
      },
      };
    },
  });

  assert.equal(await sendSms(message), "AT-sandbox-success");
});

test("rejects provider-declined and malformed responses", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
      SMSMessageData: {
        Recipients: [{ statusCode: 403, status: "InsufficientBalance" }],
      },
      };
    },
  });
  await assert.rejects(() => sendSms(message), /rejected the SMS/);

  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { SMSMessageData: { Recipients: [] } };
    },
  });
  await assert.rejects(() => sendSms(message), /unexpected SMS response/);
});

test("does not expose provider credentials in HTTP error messages", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () => ({ ok: false, status: 401 });

  await assert.rejects(
    () => sendSms(message),
    (error) => {
      assert.equal(error.message, "Africa's Talking request failed with HTTP 401.");
      assert.equal(error.message.includes(process.env.AFRICASTALKING_API_KEY), false);
      return true;
    }
  );
});

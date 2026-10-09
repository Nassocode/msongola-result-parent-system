const assert = require("node:assert/strict");
const test = require("node:test");
const axios = require("axios");

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
  const originalPost = axios.post;
  t.after(() => {
    axios.post = originalPost;
  });
  let request;
  axios.post = async (...args) => {
    request = args;
    return {
      data: {
        SMSMessageData: {
          Recipients: [{ statusCode: 101, messageId: "AT-sandbox-101" }],
        },
      },
    };
  };

  assert.equal(smsDeliveryConfigured, true);
  assert.equal(await sendSms(message), "AT-sandbox-101");
  assert.equal(request[0], "https://api.sandbox.africastalking.com/version1/messaging");
  assert.equal(request[2].headers.apiKey, "unit-test-api-key");
  assert.equal(request[2].timeout, 20000);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request[1])), {
    username: "sandbox",
    to: message.recipient_phone,
    message: message.message_text,
    from: "MSONGOLA",
  });
});

test("accepts Africa's Talking's success status response", async (t) => {
  const originalPost = axios.post;
  t.after(() => {
    axios.post = originalPost;
  });
  axios.post = async () => ({
    data: {
      SMSMessageData: {
        Recipients: [{ status: "Success", messageId: "AT-sandbox-success" }],
      },
    },
  });

  assert.equal(await sendSms(message), "AT-sandbox-success");
});

test("rejects provider-declined and malformed responses", async (t) => {
  const originalPost = axios.post;
  t.after(() => {
    axios.post = originalPost;
  });
  axios.post = async () => ({
    data: {
      SMSMessageData: {
        Recipients: [{ statusCode: 403, status: "InsufficientBalance" }],
      },
    },
  });
  await assert.rejects(() => sendSms(message), /rejected the SMS/);

  axios.post = async () => ({ data: { SMSMessageData: { Recipients: [] } } });
  await assert.rejects(() => sendSms(message), /unexpected SMS response/);
});

test("does not expose provider credentials in HTTP error messages", async (t) => {
  const originalPost = axios.post;
  t.after(() => {
    axios.post = originalPost;
  });
  axios.post = async () => {
    const error = new Error("request rejected");
    error.response = { status: 401, data: { message: "private provider response" } };
    throw error;
  };

  await assert.rejects(
    () => sendSms(message),
    (error) => {
      assert.equal(error.message, "Africa's Talking request failed with HTTP 401.");
      assert.equal(error.message.includes(process.env.AFRICASTALKING_API_KEY), false);
      return true;
    }
  );
});

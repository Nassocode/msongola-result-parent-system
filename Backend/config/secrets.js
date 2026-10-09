function isConfiguredSecret(value) {
  if (typeof value !== "string") return false;
  const secret = value.trim();
  return secret.length >= 32 && !/^(replace|your|change[-_ ]?me|example|placeholder)/i.test(secret);
}

module.exports = {
  isConfiguredSecret,
};

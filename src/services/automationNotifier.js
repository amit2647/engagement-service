const EMAIL_SERVICE_URL =
  process.env.EMAIL_SERVICE_URL || "http://email-service:4006";

const MAX_ATTEMPTS = 2;
const TIMEOUT_MS = 3000;

/*
 * Tells email-service that something happened, so it can run any matching
 * automation.
 *
 * Deliberately fire-and-forget and never throws: creating a lead must not fail,
 * or even slow down, because an automation could not be queued. email-service
 * queues the event durably and retries delivery from there, so the only gap this
 * covers is the HTTP call itself — hence the small bounded retry.
 *
 * Retrying is safe because every call carries a dedupe_key: email-service
 * collides on it rather than queueing a second email.
 */
async function notifyAutomation({ event, dedupeKey, payload, authorizationToken }) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(
        `${EMAIL_SERVICE_URL}/emails/automations/trigger`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authorizationToken}`,
          },
          body: JSON.stringify({
            event,
            dedupe_key: dedupeKey,
            payload,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );

      if (response.ok) {
        return true;
      }

      // A 4xx will not fix itself on a retry — bad payload, unknown event, an
      // expired token. Log it and stop rather than burning a second attempt.
      if (response.status < 500) {
        console.error(
          `[Automation] ${event} rejected by email-service (${response.status})`,
        );

        return false;
      }
    } catch (error) {
      console.error(
        `[Automation] ${event} attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
        error.message,
      );
    }
  }

  console.error(`[Automation] ${event} could not be queued for ${dedupeKey}`);

  return false;
}

module.exports = {
  notifyAutomation,
};

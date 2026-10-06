const express = require("express");

const authenticate = require("../middleware/authenticate");
const requirePermission = require("../middleware/requirePermission");
const requireBundle = require("../middleware/requireBundle");
const typeService = require("../services/typeService");
const engagementService = require("../services/engagementService");
const { notifyAutomation } = require("../services/automationNotifier");
const { choicesOf } = require("../services/bundleSync");

const OBLIGATION_SERVICE_URL = process.env.OBLIGATION_SERVICE_URL || "http://obligation-service:4010";

/*
 * Deadlines follow the services engaged: after every engagement change,
 * obligation-service regenerates that engagement's deadlines (idempotent).
 * Awaited so the Compliance tab is current on the next screen, but a failure
 * never undoes the engagement — regenerating later catches up.
 */
async function regenerateDeadlines(engagementId, token) {
  try {
    const response = await fetch(`${OBLIGATION_SERVICE_URL}/obligations/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ engagementId }),
      signal: AbortSignal.timeout(10 * 1000),
    });

    if (!response.ok) console.error(`[Engagements] Deadline generation for ${engagementId} answered ${response.status}`);
  } catch (error) {
    console.error(`[Engagements] Deadline generation for ${engagementId} failed: ${error.message}`);
  }
}

const router = express.Router();

/*
 * Engagements and fees (CD-06, CD-08, CD-09). Every route but the install
 * step answers only an organization with a profession bundle.
 */

const KEY = /^[a-z][a-z0-9-]{1,59}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

function respond(handler) {
  return async (req, res) => {
    try {
      const result = await handler(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (error) {
      if (!error.statusCode) console.error("[Engagements]", error);
      res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : "The engagement request failed",
        ...(error.details ? { details: error.details } : {}),
      });
    }
  };
}

function id(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    const error = new Error("Invalid id");
    error.statusCode = 400;
    throw error;
  }
  return number;
}

const auth = (req) => ({ organizationId: req.auth.organizationId, userId: req.auth.userId, permissions: req.auth.permissions });
const withFees = (req) => req.auth.permissions.includes("fees.read");
const gated = (permission) => [authenticate, requirePermission(permission), requireBundle];

// The engagement-types step of a bundle install. It runs while the install
// is still in progress, so it cannot require an installed bundle.
router.put(
  "/engagements/bundles/:key/:version",
  authenticate,
  requirePermission("bundles.manage"),
  respond((req) => {
    const { key, version } = req.params;

    if (!KEY.test(key) || !VERSION.test(version)) {
      const error = new Error("Invalid bundle key or version");
      error.statusCode = 400;
      throw error;
    }

    return typeService.installTypes(req.auth.organizationId, key, version, req.body?.engagementTypes || [], choicesOf(req));
  }),
);

router.get("/engagements/types", ...gated("engagements.read"), respond((req) => typeService.listTypes(req.auth.organizationId)));

// Periods generated from today, never a hard-coded list (FIX-21).
router.get("/engagements/periods", ...gated("engagements.read"), respond((req) => engagementService.periods(req.auth.organizationId, String(req.query.type || ""))));

router.get(
  "/engagements",
  ...gated("engagements.read"),
  respond((req) =>
    engagementService.list(
      req.auth.organizationId,
      { customerId: req.query.customerId ? id(req.query.customerId) : null, period: req.query.period || null },
      { withFees: withFees(req) },
    ),
  ),
);

router.get(
  "/engagements/:id",
  ...gated("engagements.read"),
  respond(async (req) => {
    const [engagement] = await engagementService.list(req.auth.organizationId, { engagementId: id(req.params.id) }, { withFees: withFees(req) });

    if (!engagement) {
      const error = new Error("Engagement not found");
      error.statusCode = 404;
      throw error;
    }

    return engagement;
  }),
);

router.post(
  "/engagements",
  ...gated("engagements.update"),
  respond(async (req, res) => {
    const created = await engagementService.create(auth(req), req.bundle, req.body || {});

    // Not awaited, as everywhere: an automation must never slow the write.
    notifyAutomation({
      event: "engagement.created",
      dedupeKey: `engagement.created:${created.id}`,
      payload: {
        engagement: { id: created.id, type: created.type.name, period_label: created.period.label },
        client: { id: created.client.id, name: created.client.name, email: created.client.email },
        userId: req.auth.userId,
      },
      authorizationToken: req.headers.authorization.split(" ")[1],
    });

    await regenerateDeadlines(created.id, req.headers.authorization.split(" ")[1]);

    res.status(201);
    const [engagement] = await engagementService.list(req.auth.organizationId, { engagementId: created.id }, { withFees: withFees(req) });
    return engagement;
  }),
);

router.put(
  "/engagements/:id",
  ...gated("engagements.update"),
  respond(async (req) => {
    await engagementService.update(auth(req), req.bundle, id(req.params.id), req.body || {});
    await regenerateDeadlines(id(req.params.id), req.headers.authorization.split(" ")[1]);
    const [engagement] = await engagementService.list(req.auth.organizationId, { engagementId: id(req.params.id) }, { withFees: withFees(req) });
    return engagement;
  }),
);

router.get("/engagements/:id/payments", ...gated("fees.read"), respond((req) => engagementService.payments(req.auth.organizationId, id(req.params.id))));

router.post(
  "/engagements/:id/payments",
  ...gated("fees.update"),
  respond(async (req, res) => {
    res.status(201);
    return engagementService.recordPayment(auth(req), id(req.params.id), req.body || {});
  }),
);

module.exports = router;

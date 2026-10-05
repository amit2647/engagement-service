const { describe, test, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

/*
 * Engagements and fees against an in-memory stand-in for the database and a
 * fake bundle-service (CD-06, CD-08, CD-09, FIX-21).
 */

process.env.JWT_SECRET = "unit-test-secret";
process.env.JWT_ISSUER = "unit-test-issuer";
process.env.BUNDLE_SERVICE_URL = "http://bundle-service.test";
process.env.EMAIL_SERVICE_URL = "http://email-service.test";

const BUNDLE = {
  key: "ca-practice",
  profiles: {
    engagement: {
      annual: { version: 1, schema: { type: "object", properties: { agm_on: { type: "string", format: "date", title: "AGM date" } } } },
    },
  },
};

const TYPE = { id: 1, key: "annual", name: "Annual engagement", period_kind: "financial_year", period_start_month: 4, stages: [{ key: "planning", label: "Planning" }, { key: "fieldwork", label: "Fieldwork" }] };

let installed;
let statements;
let state;

const realFetch = global.fetch;

global.fetch = async (url, options) => {
  if (String(url).startsWith("http://bundle-service.test")) return new Response(JSON.stringify({ bundle: installed }), { status: 200 });
  if (String(url).startsWith("http://email-service.test")) return new Response("{}", { status: 202 });
  return realFetch(url, options);
};

function query(text, params = []) {
  const sql = text.replace(/\s+/g, " ").trim();
  statements.push({ sql, params });

  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || /access_grants/.test(sql)) return { rows: [] };
  if (/^SELECT time_zone FROM organizations/.test(sql)) return { rows: [{ time_zone: "Asia/Kolkata" }] };
  if (/^SELECT \* FROM engagement_types WHERE organization_id = \$1 AND key = \$2 AND retired_at IS NULL/.test(sql)) return { rows: params[1] === "annual" ? [TYPE] : [] };
  if (/^SELECT id, name, email, locked_at, archived_at FROM customers/.test(sql)) return { rows: state.client ? [state.client] : [] };
  if (/^SELECT id FROM services/.test(sql)) return { rows: params[1].filter((id) => id < 100).map((id) => ({ id })) };
  if (/^INSERT INTO engagements/.test(sql)) {
    if (state.duplicate) throw Object.assign(new Error("duplicate"), { code: "23505" });
    return { rows: [{ id: 7 }] };
  }
  if (/FROM engagements e JOIN engagement_types t ON t.id = e.engagement_type_id WHERE e.id = \$1/.test(sql)) return { rows: state.engagement ? [state.engagement] : [] };
  if (/^SELECT e\.id, e\.customer_id/.test(sql)) return { rows: state.listed };
  if (/^SELECT id, engagement_id, service_id, fee_amount/.test(sql)) return { rows: state.lines };
  if (/^SELECT engagement_id, SUM\(amount\)/.test(sql)) return { rows: state.received };
  if (/^SELECT service_id, fee_amount, expenses_amount FROM engagement_lines/.test(sql)) return { rows: state.lines.map((line) => ({ service_id: line.service_id, fee_amount: line.fee_amount, expenses_amount: line.expenses_amount })) };
  if (/^INSERT INTO engagement_payments/.test(sql)) return { rows: [{ id: 11 }] };
  return { rows: [], rowCount: 1 };
}

const pool = require("../src/config/database");

pool.query = async (text, params) => query(text, params);
pool.connect = async () => ({ query: async (text, params) => query(text, params), release() {} });

const engagements = require("../src/services/engagementService");
const { forget } = require("../src/services/bundleContext");

beforeEach(() => {
  installed = BUNDLE;
  statements = [];
  forget(3);
  state = {
    client: { id: 5, name: "Acme Pvt Ltd", email: "a@acme.example", locked_at: null, archived_at: null },
    duplicate: false,
    engagement: { id: 7, customer_id: 5, type_key: "annual", stages: TYPE.stages },
    listed: [{ id: 7, customer_id: 5, customer_name: "Acme Pvt Ltd", period_label: "2025-26", type_key: "annual", type_name: "Annual engagement", stages: TYPE.stages, attributes: {} }],
    lines: [
      { id: 1, engagement_id: 7, service_id: 2, fee_amount: "50000.00", expenses_amount: "2500.50" },
      { id: 2, engagement_id: 7, service_id: 3, fee_amount: "15000.00", expenses_amount: "0.00" },
    ],
    received: [{ engagement_id: 7, total: "30000.00" }],
  };
});

after(() => {
  global.fetch = realFetch;
});

const partner = { organizationId: 3, userId: 1, permissions: ["engagements.update", "fees.update", "fees.read"] };
const assistant = { organizationId: 3, userId: 2, permissions: ["engagements.update"] };

describe("periods (FIX-21)", () => {
  test("are generated around today in the firm's time zone", async () => {
    const { current, periods } = await engagements.periods(3, "annual");

    assert.match(current, /^\d{4}-\d{2}$/);
    assert.equal(periods.length, 5);
    assert.equal(periods[3].label, current);
    assert.equal(periods[0].start.slice(5), "04-01");
  });
});

describe("create (CD-09)", () => {
  const body = (overrides = {}) => ({ customerId: 5, typeKey: "annual", period: "2025-26", appointmentOn: "2025-09-15", lines: [{ serviceId: 2, feeAmount: 50000 }], ...overrides });

  test("one engagement per client per financial year, explained", async () => {
    state.duplicate = true;

    await assert.rejects(engagements.create(partner, BUNDLE, body()), (error) => error.statusCode === 409 && error.message === "Acme Pvt Ltd already has annual engagement for 2025-26");
  });

  test("records the period's dates from its label", async () => {
    await engagements.create(partner, BUNDLE, body());

    const insert = statements.find((s) => /^INSERT INTO engagements/.test(s.sql));

    assert.deepEqual(insert.params.slice(3, 7), ["2025-26", "2025-04-01", "2026-03-31", "planning"]);
  });

  test("setting fees needs fees.update; engaging services alone does not", async () => {
    await assert.rejects(engagements.create(assistant, BUNDLE, body()), (error) => error.statusCode === 403);
    await engagements.create(assistant, BUNDLE, body({ lines: [{ serviceId: 2 }] }));
  });

  test("refuses services outside the catalog, a bad period and bundle fields that fail", async () => {
    await assert.rejects(engagements.create(partner, BUNDLE, body({ lines: [{ serviceId: 500 }] })), (error) => error.statusCode === 400 && /catalog/.test(error.message));
    await assert.rejects(engagements.create(partner, BUNDLE, body({ period: "2025-27" })), (error) => Boolean(error.details?.period));
    await assert.rejects(engagements.create(partner, BUNDLE, body({ attributes: { agm_on: "next week" } })), (error) => Boolean(error.details?.agm_on));
  });

  test("a locked client needs profiles.lock; an archived one is read-only", async () => {
    state.client.locked_at = "2026-10-01";
    await assert.rejects(engagements.create(partner, BUNDLE, body()), (error) => error.statusCode === 423);

    state.client.locked_at = null;
    state.client.archived_at = "2026-10-01";
    await assert.rejects(engagements.create(partner, BUNDLE, body()), (error) => error.statusCode === 409);
  });
});

describe("fees (CD-08)", () => {
  test("gross, received and balance are computed, to the paisa", async () => {
    const [engagement] = await engagements.list(3, { customerId: 5 }, { withFees: true });

    assert.deepEqual(engagement.totals, { fees: 65000, expenses: 2500.5, gross: 67500.5, received: 30000, balance: 37500.5 });
    assert.equal(engagement.lines[0].feeAmount, 50000);
  });

  test("without fees.read there are no amounts at all", async () => {
    const [engagement] = await engagements.list(3, { customerId: 5 }, { withFees: false });

    assert.equal(engagement.totals, undefined);
    assert.equal(engagement.lines[0].feeAmount, undefined);
    assert.equal(statements.some((s) => /engagement_payments/.test(s.sql)), false);
  });

  test("without fees.update, changing services keeps existing fees rather than zeroing them", async () => {
    await engagements.update(assistant, BUNDLE, 7, { lines: [{ serviceId: 2 }, { serviceId: 4 }] });

    const inserts = statements.filter((s) => /^INSERT INTO engagement_lines/.test(s.sql));

    assert.deepEqual(inserts.map((s) => [s.params[2], s.params[3]]), [[2, 50000], [4, 0]]);
  });

  test("a payment needs a positive amount and a date, and is audited", async () => {
    await assert.rejects(engagements.recordPayment(partner, 7, { amount: 0, receivedOn: "2026-10-01" }), (error) => Boolean(error.details?.amount));
    await assert.rejects(engagements.recordPayment(partner, 7, { amount: 100, receivedOn: "1/10/2026" }), (error) => Boolean(error.details?.receivedOn));

    await engagements.recordPayment(partner, 7, { amount: 20000, receivedOn: "2026-10-01", method: "NEFT" });

    const auditRow = statements.find((s) => /INSERT INTO audit_events/.test(s.sql));

    assert.deepEqual(auditRow.params.slice(0, 4), [3, 1, "7", 5]);
  });
});

describe("routes", () => {
  const app = require("../src/app");
  let server;
  let base;

  before(async () => {
    mock.method(console, "log", () => {});
    mock.method(console, "error", () => {});
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  const call = (method, path, permissions, body) =>
    realFetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt.sign({ sub: 1, organizationId: 3, role: "X", permissions }, process.env.JWT_SECRET, { issuer: process.env.JWT_ISSUER })}`,
      },
      body: body && JSON.stringify(body),
    });

  test("answer 'not enabled' without a bundle", async () => {
    installed = null;
    assert.equal((await call("GET", "/engagements?customerId=5", ["engagements.read"])).status, 404);
  });

  test("the install step works while the bundle is still installing", async () => {
    installed = null;
    const response = await call("PUT", "/engagements/bundles/ca-practice/0.3.0", ["bundles.manage"], { engagementTypes: [] });

    assert.equal(response.status, 200);
  });

  test("payments need fees permissions", async () => {
    assert.equal((await call("GET", "/engagements/7/payments", ["engagements.read"])).status, 403);
    assert.equal((await call("POST", "/engagements/7/payments", ["fees.read"], { amount: 1 })).status, 403);
  });

  test("creating an engagement answers 201 with it", async () => {
    const response = await call("POST", "/engagements", ["engagements.update", "fees.update", "fees.read"], { customerId: 5, typeKey: "annual", period: "2025-26", lines: [] });

    assert.equal(response.status, 201);
    assert.equal((await response.json()).periodLabel, "2025-26");
  });
});

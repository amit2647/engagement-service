const { profiles, schedules } = require("bundle-sdk");

const pool = require("../config/database");
const typeService = require("./typeService");

/*
 * Engagements (CD-06, CD-08, CD-09): one per client per period of a type,
 * the services engaged with their fees, and the payments received.
 *
 * Fee amounts are part of an engagement only for those who hold fees.read,
 * and change only with fees.update. Balances are computed, never stored.
 * Like every other client write, a locked client needs profiles.lock and an
 * archived one is read-only.
 */

function httpError(statusCode, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const money = (value) => (value === undefined || value === null || value === "" ? 0 : Number(value));
const round = (value) => Math.round(value * 100) / 100;

// "Today" where the firm is, so the current financial year is right at
// midnight in Pune, not in UTC (FIX-08).
async function today(organizationId) {
  const result = await pool.query("SELECT time_zone FROM organizations WHERE id = $1", [organizationId]);
  return schedules.todayIn(result.rows[0]?.time_zone || "UTC");
}

/*
 * The periods to offer for a type, generated around today (FIX-21): three
 * back, the current one, one ahead — oldest first.
 */
async function periods(organizationId, typeKey) {
  const type = await typeService.getType(organizationId, typeKey);

  if (!type) throw httpError(404, "No such engagement type");
  if (type.period_kind === "none") return { current: null, periods: [] };

  const options = { periodKind: type.period_kind, periodStartMonth: type.period_start_month };
  const now = await today(organizationId);

  return {
    current: schedules.periodFor(now, options).label,
    periods: schedules.listPeriods(now, options).map(({ label, start, end }) => ({ label, start, end })),
  };
}

async function loadClient(organizationId, customerId, permissions, { forWrite }) {
  const result = await pool.query(
    "SELECT id, name, email, locked_at, archived_at FROM customers WHERE id = $1 AND organization_id = $2",
    [customerId, organizationId],
  );
  const client = result.rows[0];

  if (!client) throw httpError(404, "Client not found");

  if (forWrite) {
    if (client.archived_at) throw httpError(409, "This client is archived — restore it to make changes");
    if (client.locked_at && !permissions.includes("profiles.lock")) {
      throw httpError(423, "This client is locked — a person who can unlock clients must unlock it first");
    }
  }

  return client;
}

async function checkServices(organizationId, serviceIds) {
  if (serviceIds.length === 0) return;

  const found = await pool.query(
    "SELECT id FROM services WHERE organization_id = $1 AND id = ANY($2::int[])",
    [organizationId, serviceIds],
  );
  const known = new Set(found.rows.map((row) => row.id));
  const unknown = serviceIds.filter((id) => !known.has(id));

  if (unknown.length > 0) {
    throw httpError(400, "Some services are not in this organization's catalog", { lines: `Unknown service ${unknown.join(", ")}` });
  }
}

function normaliseLines(lines, canChangeFees) {
  if (!Array.isArray(lines)) {
    throw httpError(400, "lines must be a list of services", { lines: "lines must be a list" });
  }

  const seen = new Set();
  const normalised = lines.map((line, index) => {
    const serviceId = Number(line?.serviceId);
    const feeAmount = money(line?.feeAmount);
    const expensesAmount = money(line?.expensesAmount);

    if (!Number.isInteger(serviceId) || serviceId <= 0) throw httpError(400, "Each line needs a service", { [`lines[${index}].serviceId`]: "Choose a service" });
    if (seen.has(serviceId)) throw httpError(400, "A service is engaged once per engagement", { [`lines[${index}].serviceId`]: "Already engaged" });
    if (!Number.isFinite(feeAmount) || feeAmount < 0 || feeAmount >= 1e12) throw httpError(400, "Fees must be positive amounts", { [`lines[${index}].feeAmount`]: "Enter a positive amount" });
    if (!Number.isFinite(expensesAmount) || expensesAmount < 0 || expensesAmount >= 1e12) throw httpError(400, "Expenses must be positive amounts", { [`lines[${index}].expensesAmount`]: "Enter a positive amount" });

    seen.add(serviceId);

    return { serviceId, feeAmount, expensesAmount, notes: line?.notes ? String(line.notes).slice(0, 2000) : null };
  });

  if (!canChangeFees && normalised.some((line) => line.feeAmount > 0 || line.expensesAmount > 0)) {
    throw httpError(403, "Setting fees needs the fees.update permission");
  }

  return normalised;
}

function checkAttributes(bundle, typeKey, attributes) {
  const profile = bundle.profiles?.engagement?.[typeKey];

  if (!profile) return { attributes: {}, version: null };

  const result = profiles.validate(profile.schema, attributes || {});

  if (!result.valid) throw httpError(400, "Some engagement details need attention", result.errors);

  return { attributes: result.value, version: profile.version };
}

function checkStage(type, stage) {
  if (stage === undefined || stage === null || stage === "") return null;

  const stages = (type.stages || []).map((item) => item.key);

  if (!stages.includes(stage)) throw httpError(400, "Unknown stage", { stage: `stage must be one of: ${stages.join(", ")}` });

  return stage;
}

async function replaceLines(client, organizationId, engagementId, lines) {
  await client.query("DELETE FROM engagement_lines WHERE engagement_id = $1", [engagementId]);

  for (const line of lines) {
    await client.query(
      `INSERT INTO engagement_lines (organization_id, engagement_id, service_id, fee_amount, expenses_amount, notes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [organizationId, engagementId, line.serviceId, line.feeAmount, line.expensesAmount, line.notes],
    );
  }
}

async function inTransaction(work) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function create(auth, bundle, input) {
  const type = await typeService.getType(auth.organizationId, input.typeKey);

  if (!type) throw httpError(400, "Choose an engagement type", { typeKey: "Unknown engagement type" });

  const customerId = Number(input.customerId);
  const client = await loadClient(auth.organizationId, customerId, auth.permissions, { forWrite: true });

  let period = { label: null, start: null, end: null };

  if (type.period_kind !== "none") {
    try {
      period = schedules.periodFromLabel(input.period, { periodKind: type.period_kind, periodStartMonth: type.period_start_month });
    } catch {
      throw httpError(400, "Choose a period", { period: "Choose a financial year" });
    }
  }

  if (input.appointmentOn && !DATE.test(input.appointmentOn)) {
    throw httpError(400, "Appointment date must be a date", { appointmentOn: "Use YYYY-MM-DD" });
  }

  const lines = normaliseLines(input.lines || [], auth.permissions.includes("fees.update"));
  await checkServices(auth.organizationId, lines.map((line) => line.serviceId));

  const { attributes, version } = checkAttributes(bundle, type.key, input.attributes);
  const stage = checkStage(type, input.stage) || type.stages?.[0]?.key || null;

  const id = await inTransaction(async (db) => {
    let created;

    try {
      created = await db.query(
        `INSERT INTO engagements (organization_id, customer_id, engagement_type_id, period_label, period_start, period_end,
                                  stage, appointment_on, attributes, attributes_version, owner_user_id, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $11)
         RETURNING id`,
        [auth.organizationId, customerId, type.id, period.label, period.start, period.end, stage,
          input.appointmentOn || null, attributes, version, auth.userId, input.notes || null],
      );
    } catch (error) {
      if (error.code === "23505") {
        throw httpError(409, `${client.name} already has ${type.name.toLowerCase()} for ${period.label}`, { period: "Already engaged for this period" });
      }

      throw error;
    }

    await replaceLines(db, auth.organizationId, created.rows[0].id, lines);
    return created.rows[0].id;
  });

  return { id, client, type, period };
}

async function update(auth, bundle, engagementId, input) {
  const engagement = await loadEngagementRow(auth.organizationId, engagementId);
  await loadClient(auth.organizationId, engagement.customer_id, auth.permissions, { forWrite: true });

  const changes = {};

  if (input.stage !== undefined) changes.stage = checkStage(engagement, input.stage);
  if (input.status !== undefined) {
    if (!["active", "completed", "cancelled"].includes(input.status)) throw httpError(400, "Unknown status", { status: "active, completed or cancelled" });
    changes.status = input.status;
  }
  if (input.appointmentOn !== undefined) {
    if (input.appointmentOn && !DATE.test(input.appointmentOn)) throw httpError(400, "Appointment date must be a date", { appointmentOn: "Use YYYY-MM-DD" });
    changes.appointment_on = input.appointmentOn || null;
  }
  if (input.notes !== undefined) changes.notes = input.notes || null;
  if (input.attributes !== undefined) {
    const checked = checkAttributes(bundle, engagement.type_key, input.attributes);
    changes.attributes = checked.attributes;
    changes.attributes_version = checked.version;
  }

  const lines = input.lines !== undefined ? normaliseLines(input.lines, auth.permissions.includes("fees.update")) : null;

  if (lines) {
    await checkServices(auth.organizationId, lines.map((line) => line.serviceId));

    // Without fees.update, the services can change but their fees cannot:
    // existing amounts are carried over rather than zeroed.
    if (!auth.permissions.includes("fees.update")) {
      const current = await pool.query("SELECT service_id, fee_amount, expenses_amount FROM engagement_lines WHERE engagement_id = $1", [engagementId]);
      const byService = new Map(current.rows.map((row) => [row.service_id, row]));
      lines.forEach((line) => {
        const kept = byService.get(line.serviceId);
        line.feeAmount = kept ? Number(kept.fee_amount) : 0;
        line.expensesAmount = kept ? Number(kept.expenses_amount) : 0;
      });
    }
  }

  await inTransaction(async (db) => {
    const columns = Object.keys(changes);

    if (columns.length > 0) {
      await db.query(
        `UPDATE engagements SET ${columns.map((column, index) => `${column} = $${index + 1}`).join(", ")}, updated_at = NOW()
         WHERE id = $${columns.length + 1} AND organization_id = $${columns.length + 2}`,
        [...columns.map((column) => changes[column]), engagementId, auth.organizationId],
      );
    }

    if (lines) await replaceLines(db, auth.organizationId, engagementId, lines);
  });
}

async function loadEngagementRow(organizationId, engagementId) {
  const result = await pool.query(
    `SELECT e.*, t.key AS type_key, t.name AS type_name, t.period_kind, t.stages
     FROM engagements e JOIN engagement_types t ON t.id = e.engagement_type_id
     WHERE e.id = $1 AND e.organization_id = $2`,
    [engagementId, organizationId],
  );

  if (!result.rows[0]) throw httpError(404, "Engagement not found");

  return result.rows[0];
}

/*
 * Engagements with their lines and — for fees.read — amounts and totals:
 * gross = fees + expenses, received = payments, balance = gross − received.
 */
async function list(organizationId, { customerId, period, engagementId } = {}, { withFees }) {
  const values = [organizationId];
  const where = ["e.organization_id = $1"];

  if (customerId) { values.push(customerId); where.push(`e.customer_id = $${values.length}`); }
  if (period) { values.push(period); where.push(`e.period_label = $${values.length}`); }
  if (engagementId) { values.push(engagementId); where.push(`e.id = $${values.length}`); }

  const engagements = await pool.query(
    `SELECT e.id, e.customer_id, e.period_label, e.period_start, e.period_end, e.stage, e.status,
            e.appointment_on, e.attributes, e.notes, e.created_at,
            t.key AS type_key, t.name AS type_name, t.stages, c.name AS customer_name
     FROM engagements e
     JOIN engagement_types t ON t.id = e.engagement_type_id
     JOIN customers c ON c.id = e.customer_id
     WHERE ${where.join(" AND ")}
     ORDER BY e.period_start DESC NULLS LAST, e.id DESC`,
    values,
  );

  const ids = engagements.rows.map((row) => row.id);
  if (ids.length === 0) return [];

  const lines = await pool.query(
    "SELECT id, engagement_id, service_id, fee_amount, expenses_amount, notes FROM engagement_lines WHERE engagement_id = ANY($1::int[]) ORDER BY id",
    [ids],
  );
  const received = withFees
    ? await pool.query("SELECT engagement_id, SUM(amount) AS total FROM engagement_payments WHERE engagement_id = ANY($1::int[]) GROUP BY engagement_id", [ids])
    : { rows: [] };
  const receivedBy = new Map(received.rows.map((row) => [row.engagement_id, Number(row.total)]));

  return engagements.rows.map((row) => {
    const own = lines.rows.filter((line) => line.engagement_id === row.id);
    const engagement = {
      id: row.id,
      customerId: row.customer_id,
      customerName: row.customer_name,
      type: { key: row.type_key, name: row.type_name, stages: row.stages },
      periodLabel: row.period_label,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      stage: row.stage,
      status: row.status,
      appointmentOn: row.appointment_on,
      attributes: row.attributes,
      notes: row.notes,
      lines: own.map((line) => ({
        id: line.id,
        serviceId: line.service_id,
        notes: line.notes,
        ...(withFees ? { feeAmount: Number(line.fee_amount), expensesAmount: Number(line.expenses_amount) } : {}),
      })),
    };

    if (withFees) {
      const fees = round(own.reduce((sum, line) => sum + Number(line.fee_amount), 0));
      const expenses = round(own.reduce((sum, line) => sum + Number(line.expenses_amount), 0));
      const paid = round(receivedBy.get(row.id) || 0);

      engagement.totals = { fees, expenses, gross: round(fees + expenses), received: paid, balance: round(fees + expenses - paid) };
    }

    return engagement;
  });
}

async function payments(organizationId, engagementId) {
  await loadEngagementRow(organizationId, engagementId);

  const result = await pool.query(
    `SELECT id, engagement_line_id, amount, received_on, method, reference, notes, recorded_by, created_at
     FROM engagement_payments WHERE engagement_id = $1 AND organization_id = $2 ORDER BY received_on DESC, id DESC`,
    [engagementId, organizationId],
  );

  return result.rows.map((row) => ({ ...row, amount: Number(row.amount) }));
}

async function recordPayment(auth, engagementId, input) {
  const engagement = await loadEngagementRow(auth.organizationId, engagementId);
  await loadClient(auth.organizationId, engagement.customer_id, auth.permissions, { forWrite: true });

  const amount = Number(input.amount);

  if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e12) throw httpError(400, "Enter the amount received", { amount: "Enter a positive amount" });
  if (!DATE.test(input.receivedOn || "")) throw httpError(400, "Enter the date it was received", { receivedOn: "Use YYYY-MM-DD" });

  let lineId = null;

  if (input.lineId) {
    const line = await pool.query("SELECT id FROM engagement_lines WHERE id = $1 AND engagement_id = $2", [input.lineId, engagementId]);
    if (!line.rows[0]) throw httpError(400, "That service is not part of this engagement", { lineId: "Unknown service line" });
    lineId = line.rows[0].id;
  }

  return inTransaction(async (db) => {
    const created = await db.query(
      `INSERT INTO engagement_payments (organization_id, engagement_id, engagement_line_id, amount, received_on, method, reference, notes, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [auth.organizationId, engagementId, lineId, amount, input.receivedOn, input.method || null, input.reference || null, input.notes || null, auth.userId],
    );

    await db.query(
      `INSERT INTO audit_events (organization_id, actor_user_id, action, entity_type, entity_id, customer_id, details)
       VALUES ($1, $2, 'payment.recorded', 'engagement', $3, $4, $5)`,
      [auth.organizationId, auth.userId, String(engagementId), engagement.customer_id, { amount, receivedOn: input.receivedOn, paymentId: created.rows[0].id }],
    );

    return { id: created.rows[0].id };
  });
}

module.exports = { periods, create, update, list, payments, recordPayment, today };

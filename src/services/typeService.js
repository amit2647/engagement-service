const pool = require("../config/database");
const { decide } = require("./bundleSync");

/*
 * Engagement types: installed from the organization's bundle (a CA's annual
 * engagement per financial year), matched by key, kept when the firm has
 * edited them (bundleSync), retired — never deleted — when dropped.
 */

const PERIOD_KINDS = new Set(["financial_year", "calendar_year", "none"]);

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

const content = (type) => ({
  name: type.name,
  period_kind: type.period_kind ?? type.periodKind,
  period_start_month: (type.period_start_month ?? type.periodStartMonth) || null,
  stages: type.stages || [],
});

async function installTypes(organizationId, bundleKey, version, types = []) {
  for (const type of types) {
    if (!type?.key || !type.name || !PERIOD_KINDS.has(type.periodKind)) {
      throw badRequest("Each engagement type needs a key, a name and a period kind");
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const summary = { inserted: 0, updated: 0, unchanged: 0, kept: 0, retired: 0 };

    for (const type of types) {
      const shipped = content(type);
      const found = await client.query("SELECT * FROM engagement_types WHERE organization_id = $1 AND key = $2", [organizationId, type.key]);
      const row = found.rows[0];
      const { action, shippedChecksum, flag } = decide(row && { content: content(row), sourceChecksum: row.source_checksum }, shipped);

      if (action === "insert") {
        await client.query(
          `INSERT INTO engagement_types (organization_id, bundle_key, key, name, period_kind, period_start_month, stages, source_version, source_checksum)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [organizationId, bundleKey, type.key, shipped.name, shipped.period_kind, shipped.period_start_month, JSON.stringify(shipped.stages), version, shippedChecksum],
        );
        summary.inserted += 1;
        continue;
      }

      if (action === "keep") {
        await client.query(
          `UPDATE engagement_types SET bundle_key = $1, retired_at = NULL,
             update_available_version = CASE WHEN $2 THEN $3 ELSE update_available_version END
           WHERE id = $4`,
          [bundleKey, flag, version, row.id],
        );
        summary.kept += 1;
        continue;
      }

      if (action === "update") {
        await client.query(
          "UPDATE engagement_types SET name = $1, period_kind = $2, period_start_month = $3, stages = $4, updated_at = NOW() WHERE id = $5",
          [shipped.name, shipped.period_kind, shipped.period_start_month, JSON.stringify(shipped.stages), row.id],
        );
      }

      await client.query(
        `UPDATE engagement_types SET bundle_key = $1, source_version = $2, source_checksum = $3,
           update_available_version = NULL, retired_at = NULL
         WHERE id = $4`,
        [bundleKey, version, shippedChecksum, row.id],
      );
      summary[action === "update" ? "updated" : "unchanged"] += 1;
    }

    const retired = await client.query(
      `UPDATE engagement_types SET retired_at = NOW()
       WHERE organization_id = $1 AND bundle_key = $2 AND retired_at IS NULL AND key <> ALL($3::text[])`,
      [organizationId, bundleKey, types.map((type) => type.key)],
    );
    summary.retired = retired.rowCount;

    await client.query("COMMIT");
    return summary;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function listTypes(organizationId) {
  const result = await pool.query(
    `SELECT id, key, name, period_kind, period_start_month, stages FROM engagement_types
     WHERE organization_id = $1 AND retired_at IS NULL ORDER BY name`,
    [organizationId],
  );

  return result.rows;
}

async function getType(organizationId, key) {
  const result = await pool.query(
    "SELECT * FROM engagement_types WHERE organization_id = $1 AND key = $2 AND retired_at IS NULL",
    [organizationId, key],
  );

  return result.rows[0] || null;
}

module.exports = { installTypes, listTypes, getType };

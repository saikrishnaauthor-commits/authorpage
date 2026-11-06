const pool = require("./db");
const { flattenHierarchy } = require("./hierarchy");

const clean = value => String(value ?? "").trim();

// Copies SAP records into master_hierarchy and master_feeders.
// Upserts everything in one transaction. Rows SAP no longer sends are
// marked is_active = false instead of being deleted.
async function syncToDatabase(records) {
    const client = await pool.connect();
    const log = await client.query(
        "INSERT INTO sync_log (status) VALUES ('running') RETURNING id"
    );
    const logId = log.rows[0].id;

    try {
        await client.query("BEGIN");
        const startedAt = new Date();

        // 1. Hierarchy (parents come before children in this list,
        //    so the parent_code foreign key is always satisfied).
        const nodes = flattenHierarchy(records);

        await client.query(
            `INSERT INTO master_hierarchy
                 (code, name, level, parent_code, element_count, is_active, synced_at)
             SELECT * , TRUE, $6
             FROM unnest($1::varchar[], $2::varchar[], $3::varchar[],
                         $4::varchar[], $5::int[])
             ON CONFLICT (code) DO UPDATE SET
                 name          = EXCLUDED.name,
                 level         = EXCLUDED.level,
                 parent_code   = EXCLUDED.parent_code,
                 element_count = EXCLUDED.element_count,
                 is_active     = TRUE,
                 synced_at     = EXCLUDED.synced_at`,
            [
                nodes.map(n => n.code),
                nodes.map(n => n.name),
                nodes.map(n => n.level),
                nodes.map(n => n.parentCode),
                nodes.map(n => n.elementCount),
                startedAt
            ]
        );

        // 2. Feeders / elements.
        const cols = [
            "tplnr", "pltxt", "tplma", "pltxt1", "tplma1", "pltxt2",
            "tplma2", "pltxt3", "tplma3", "pltxt4", "tplma4", "pltxt5", "swerk"
        ];
        const arrays = cols.map(c =>
            records.map(r => clean(r[c.toUpperCase()]) || null)
        );
        const params = cols.map((_, i) => `$${i + 1}::varchar[]`).join(", ");

        await client.query(
            `INSERT INTO master_feeders
                 (${cols.join(", ")}, substation_code, is_active, synced_at)
             SELECT u.*, u.tplma, TRUE, $${cols.length + 1}
             FROM unnest(${params}) AS u(${cols.join(", ")})
             ON CONFLICT (tplnr) DO UPDATE SET
                 ${cols.slice(1).map(c => `${c} = EXCLUDED.${c}`).join(",\n                 ")},
                 substation_code = EXCLUDED.substation_code,
                 is_active       = TRUE,
                 synced_at       = EXCLUDED.synced_at`,
            [...arrays, startedAt]
        );

        // 3. Anything not touched in this run is no longer in SAP.
        await client.query(
            "UPDATE master_feeders   SET is_active = FALSE WHERE synced_at < $1 AND is_active",
            [startedAt]
        );
        await client.query(
            "UPDATE master_hierarchy SET is_active = FALSE WHERE synced_at < $1 AND is_active",
            [startedAt]
        );

        await client.query("COMMIT");

        await client.query(
            `UPDATE sync_log SET status = 'success', finished_at = now(),
                 feeder_count = $2, hierarchy_count = $3 WHERE id = $1`,
            [logId, records.length, nodes.length]
        );

        return { feeders: records.length, hierarchyNodes: nodes.length };
    } catch (error) {
        await client.query("ROLLBACK");
        await client.query(
            `UPDATE sync_log SET status = 'failed', finished_at = now(),
                 error_message = $2 WHERE id = $1`,
            [logId, error.message]
        );
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { syncToDatabase };

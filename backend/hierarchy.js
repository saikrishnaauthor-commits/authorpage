const express = require("express");

// SAP code prefix -> hierarchy level, top to bottom.
const LEVELS = {
    ZONE: "zone",
    CIR: "circle",
    DIV: "division",
    SD: "subdivision",
    SS: "substation"
};

// Each record carries its parents as (code, name) pairs, nearest first.
const PARENT_COLUMNS = [
    ["TPLMA", "PLTXT1"],
    ["TPLMA1", "PLTXT2"],
    ["TPLMA2", "PLTXT3"],
    ["TPLMA3", "PLTXT4"],
    ["TPLMA4", "PLTXT5"]
];

const clean = value => String(value ?? "").trim();

// Level comes from the code prefix, not the column, because some
// substations have no subdivision and every parent shifts up a column.
function levelOf(code) {
    return LEVELS[code.split("-")[0]] || "unknown";
}

function getChain(record) {
    return PARENT_COLUMNS
        .map(([codeKey, nameKey]) => ({
            code: clean(record[codeKey]),
            name: clean(record[nameKey])
        }))
        .filter(node => node.code)
        .reverse(); // zone first
}

function buildHierarchy(records) {
    const root = { children: new Map() };
    const index = new Map(); // code -> node, for /api/hierarchy/:code

    for (const record of records) {
        let parent = root;

        for (const { code, name } of getChain(record)) {
            let node = parent.children.get(code);

            if (!node) {
                node = {
                    level: levelOf(code),
                    code,
                    name,
                    parentCode: parent.code ?? null,
                    elementCount: 0,
                    children: new Map(),
                    elements: []
                };
                parent.children.set(code, node);
                index.set(code, node);
            }

            node.elementCount++;
            parent = node;
        }

        // parent is now the substation.
        parent.elements.push({
            code: clean(record.TPLNR),
            name: clean(record.PLTXT)
        });
    }

    return { roots: [...root.children.values()], index };
}

// Convert the internal Map-based node into plain JSON.
function serialize(node, includeElements) {
    const out = {
        level: node.level,
        code: node.code,
        name: node.name,
        elementCount: node.elementCount
    };

    if (node.children.size) {
        out.children = [...node.children.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(child => serialize(child, includeElements));
    }

    if (includeElements && node.elements.length) {
        out.elements = node.elements;
    }

    return out;
}

// Rebuild the tree only when the SAP cache hands back a new array.
let builtFrom = null;
let built = null;

function getHierarchy(records) {
    if (records !== builtFrom) {
        built = buildHierarchy(records);
        builtFrom = records;
    }
    return built;
}

function createHierarchyRouter(fetchSAPRecords) {
    const router = express.Router();

    async function load(res) {
        try {
            return getHierarchy(await fetchSAPRecords());
        } catch (error) {
            console.error("Hierarchy error:", error.response?.status, error.message);
            res.status(502).json({ error: "Unable to build hierarchy from SAP" });
            return null;
        }
    }

    // Full tree: zone -> circle -> division -> subdivision -> substation.
    // ?includeElements=true adds the bay/elements under each substation.
    router.get("/", async (req, res) => {
        const tree = await load(res);
        if (!tree) return;

        const includeElements = req.query.includeElements === "true";

        res.json({
            zones: tree.roots
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(node => serialize(node, includeElements))
        });
    });

    // One node and everything under it, e.g. /api/hierarchy/CIR-VSKP-OMC.
    // Substations include their elements by default.
    router.get("/:code", async (req, res) => {
        const tree = await load(res);
        if (!tree) return;

        const node = tree.index.get(clean(req.params.code));

        if (!node) {
            return res.status(404).json({ error: `No node with code ${req.params.code}` });
        }

        const includeElements =
            req.query.includeElements === "true" || node.level === "substation";

        res.json(serialize(node, includeElements));
    });

    return router;
}

// Flat list of every node, parents before children, for the database.
function flattenHierarchy(records) {
    const rows = [];
    const walk = node => {
        rows.push({
            code: node.code,
            name: node.name,
            level: node.level,
            parentCode: node.parentCode,
            elementCount: node.elementCount
        });
        node.children.forEach(walk);
    };
    getHierarchy(records).roots.forEach(walk);
    return rows;
}

module.exports = { createHierarchyRouter, buildHierarchy, flattenHierarchy };

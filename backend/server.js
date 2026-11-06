require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const { createHierarchyRouter } = require("./hierarchy");
const { syncToDatabase } = require("./sync");

const app = express();
app.use(cors({
    origin: [
        "http://127.0.0.1:5500",
        "http://localhost:5500"
    ]
}));
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve the frontend separately from the API logic.
app.use(express.static(path.join(__dirname, "public")));

let cachedRecords = null;
let cacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Extract the SAP records from the response.
function extractRecords(data) {
    const root = Array.isArray(data) ? data[0] : data;
    const items = root?.LS_OUT?.item;

    if (Array.isArray(items)) return items;
    if (items && typeof items === "object") return [items];

    throw new Error(
        "Unexpected SAP response. Expected LS_OUT.item."
    );
}

// Fetch all records from SAP.
async function fetchSAPRecords() {
    const now = Date.now();

    if (cachedRecords && now - cacheTime < CACHE_DURATION) {
        return cachedRecords;
    }

    const response = await axios.post(
        process.env.SAP_ENDPOINT,
        {
            S_TPLMA: {
                item: {
                    LOW: ""
                }
            }
        },
        {
            auth: {
                username: process.env.SAP_USERNAME,
                password: process.env.SAP_PASSWORD
            },
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            timeout: 120000
        }
    );

    const records = extractRecords(response.data);

    cachedRecords = records;
    cacheTime = now;

    return records;
}

// Health check.
app.get("/api/health", (req, res) => {
    res.json({ status: "API is running" });
});

// Return all SAP records to the frontend.
app.get("/api/records", async (req, res) => {
    try {
        const records = await fetchSAPRecords();

        res.json({
            count: records.length,
            records
        });
    } catch (error) {
        console.error(
            "SAP API error:",
            error.response?.status,
            error.message
        );

        res.status(502).json({
            error: "Unable to retrieve SAP records",
            details: error.response?.status
                ? `SAP returned HTTP ${error.response.status}`
                : "Check SAP connectivity and backend configuration."
        });
    }
});

// Hierarchy API.
app.use("/api/hierarchy", createHierarchyRouter(fetchSAPRecords));

// Save the latest SAP data into the FTC database.
// Call POST /api/sync whenever you want a fresh copy.
app.post("/api/sync", async (req, res) => {
    try {
        cachedRecords = null; // force a fresh SAP fetch
        const records = await fetchSAPRecords();
        const result = await syncToDatabase(records);
        res.json({ status: "synced", ...result });
    } catch (error) {
        console.error("Sync error:", error.message);
        res.status(500).json({ error: "Sync failed", details: error.message });
    }
});

app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);

    // Sync once on startup; the server keeps running if this fails.
    try {
        const result = await syncToDatabase(await fetchSAPRecords());
        console.log("Startup sync done:", result);
    } catch (error) {
        console.error("Startup sync failed:", error.message);
    }
});
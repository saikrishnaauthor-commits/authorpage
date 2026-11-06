-- =====================================================================
-- FTC database setup (PostgreSQL)
--
-- STEP 1: connect DBeaver to the default "postgres" database and run
--         only this line (CREATE DATABASE can't run inside a script
--         transaction):
--
--             CREATE DATABASE ftc;
--
-- STEP 2: refresh DBeaver, open a SQL editor on the new "ftc" database
--         and run everything below (Alt + X).
-- =====================================================================

-- Zone -> circle -> division -> subdivision -> substation.
-- Each row points to its parent; zones have parent_code = NULL.
CREATE TABLE IF NOT EXISTS master_hierarchy (
    code           VARCHAR(40)  PRIMARY KEY,
    name           VARCHAR(200) NOT NULL,
    level          VARCHAR(20)  NOT NULL
                   CHECK (level IN ('zone','circle','division','subdivision','substation','unknown')),
    parent_code    VARCHAR(40)  REFERENCES master_hierarchy(code),
    element_count  INTEGER      NOT NULL DEFAULT 0,
    is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    synced_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_master_hierarchy_parent ON master_hierarchy(parent_code);
CREATE INDEX IF NOT EXISTS ix_master_hierarchy_level  ON master_hierarchy(level);

-- One row per SAP element (TPLNR), same columns SAP sends,
-- plus a link to its substation in master_hierarchy.
CREATE TABLE IF NOT EXISTS master_feeders (
    tplnr            VARCHAR(40)  PRIMARY KEY,           -- element code
    pltxt            VARCHAR(200),                       -- element name
    substation_code  VARCHAR(40)  NOT NULL REFERENCES master_hierarchy(code),
    tplma            VARCHAR(40),  pltxt1 VARCHAR(200),
    tplma1           VARCHAR(40),  pltxt2 VARCHAR(200),
    tplma2           VARCHAR(40),  pltxt3 VARCHAR(200),
    tplma3           VARCHAR(40),  pltxt4 VARCHAR(200),
    tplma4           VARCHAR(40),  pltxt5 VARCHAR(200),
    swerk            VARCHAR(20),
    is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    synced_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_master_feeders_substation ON master_feeders(substation_code);

-- Log of every sync run.
CREATE TABLE IF NOT EXISTS sync_log (
    id                SERIAL       PRIMARY KEY,
    started_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    finished_at       TIMESTAMPTZ,
    status            VARCHAR(20)  NOT NULL,   -- running / success / failed
    feeder_count      INTEGER,
    hierarchy_count   INTEGER,
    error_message     TEXT
);

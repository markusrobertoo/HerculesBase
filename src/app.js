require("dotenv").config();

const debug = require("debug");
const express = require("express");
const morgan = require("morgan");

const logger = debug("hercules-base");
const db = require("./db.js");

const app = express();
// combined + response time
app.use(morgan(`:remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" - :response-time ms`));

// Parse either query string or User-Agent for baseline version
app.get("/", (req, res, next) => {
    const versionString = req.query.version || req.headers["user-agent"];
    const userAgent = versionString.match(/^EDOPRO-(WINDOWS|MAC|LINUX)-(\d+)\.(\d+)\.(\d+)$/i);
    if (userAgent) {
        logger(`Detected user agent ${userAgent[0]} from %s`, req.query.version ? "query string" : "header");
        req.userAgent = {
            os: userAgent[1].toUpperCase(),
            major: parseInt(userAgent[2]),
            minor: parseInt(userAgent[3]),
            patch: parseInt(userAgent[4])
        };
        next();
    } else {
        res.status(400).send("Missing version parameter");
    }
});

// GET a JSON of needed patch downloads
app.get("/", (req, res) => {
    const { os, major, minor, patch } = req.userAgent;
    const queryCache = db.prepare("SELECT json FROM responses WHERE os = ? AND major = ? AND minor = ? AND patch = ?");
    const cache = queryCache.all([ os, major, minor, patch ]);
    if (cache.length) {
        logger(`Cache hit for ${os}/${major}.${minor}.${patch}`);
        res.json(cache[0].json);
    } else {
        logger(`Cache miss for ${os}/${major}.${minor}.${patch}`);
        const queryPatches = db.prepare("SELECT (major || '.' || minor || '.' || patch) as name, hash as md5, url FROM urls WHERE name > ? AND os = ? ORDER BY name ASC");
        const result = queryPatches.all(`${major}.${minor}.${patch}`, os);
        res.json(result);
        const cacheInsert = db.prepare("INSERT INTO responses (os, major, minor, patch, json) VALUES (@os, @major, @minor, @patch, @json)");
        try {
            cacheInsert.run({ os, major, minor, patch, json: JSON.stringify(result) });
        } catch(err) {
            logger("Failed to cache result %o", err);
        }
    }
});

// POST metadata for a new patch
app.post("/version", express.json(), (req, res) => {
    try {
        const {
            authToken,
            url,
            os,
            major = parseInt(major),
            minor = parseInt(minor),
            patch = parseInt(minor),
            hash
        } = req.body;
        if (authToken !== process.env.HERCULES_BASE_SECRET) {
            res.sendStatus(401);
        }
        const statement = db.prepare(`INSERT INTO urls (url, os, major, minor, patch, hash, date)
            VALUES (@url, @os, @major, @minor, @patch, @hash, @date)`);
        const result = db.transaction(() => statement.run({ url, os, major, minor, patch, hash, date: Date.now() }))();
        logger("Added new entry %o", result);
        const statement_delete = db.prepare("DELETE FROM responses");
        const deleted_row = statement_delete.run();
        logger("Deleted %o entry from Cache Database", deleted_row.changes);
        res.sendStatus(201);
    } catch(e) {
        logger("Failed to add entry %o", e);
        res.sendStatus(400);
    }
});

let server = app.listen(process.env.HERCULES_BASE_PORT || 3000, () => {
    debug("hercules-base")(`Listening on ${process.env.HERCULES_BASE_PORT}.`);
});

module.exports = server;

// starred-watcher.js
// Node 18+ (uses global fetch). Stores starred Lifelogs in SQLite and posts a webhook for each new/updated star.
// ESM module: set "type":"module" in package.json.

import sqlite3 from 'sqlite3';
import 'dotenv/config';

const LIMITLESS_API_KEY = process.env.LIMITLESS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_URL_2 = process.env.WEBHOOK_URL_2;
const DB_PATH = process.env.DB_PATH || './starred.db';
const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 120);
const MAX_PAGES_PER_RUN = Number(process.env.MAX_PAGES_PER_RUN || 25); // 25*10=250 rows max/run
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const BACKFILL_SEND_WEBHOOK = (process.env.BACKFILL_SEND_WEBHOOK || '0') === '1';

if (!LIMITLESS_API_KEY) { console.error('Missing LIMITLESS_API_KEY'); process.exit(1); }
if (!WEBHOOK_URL) { console.error('Missing WEBHOOK_URL'); process.exit(1); }
if (!OPENAI_API_KEY) { console.warn('OPENAI_API_KEY missing → sentiment will be "unscored".'); }

// ---------- SQLite ----------
const db = new sqlite3.Database(DB_PATH);

// Initialize database schema
db.serialize(() => {
  db.run(`PRAGMA journal_mode = WAL`);
  db.run(`
    CREATE TABLE IF NOT EXISTS lifelogs (
      id TEXT PRIMARY KEY,
      title TEXT,
      markdown TEXT,
      startTime TEXT,
      endTime TEXT,
      updatedAt TEXT,
      isStarred INTEGER,
      analysis_json TEXT,
      webhook_last_updatedAt TEXT,
      webhook_status INTEGER,
      webhook_sent_at TEXT,
      inserted_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_lifelogs_updatedAt ON lifelogs(updatedAt);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_lifelogs_last_seen ON lifelogs(last_seen_at);`);
  db.run(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
});

// Helper functions for database operations
function kvGet(key) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT value FROM kv WHERE key = ?`, [key], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function kvSet(key, value) {
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, value], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function upsertLifelog(row) {
  return new Promise((resolve, reject) => {
    const stmt = `
      INSERT INTO lifelogs (id, title, markdown, startTime, endTime, updatedAt, isStarred, analysis_json, webhook_last_updatedAt, webhook_status, webhook_sent_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        markdown=excluded.markdown,
        startTime=excluded.startTime,
        endTime=excluded.endTime,
        updatedAt=excluded.updatedAt,
        isStarred=excluded.isStarred,
        analysis_json=COALESCE(excluded.analysis_json, lifelogs.analysis_json),
        webhook_last_updatedAt=COALESCE(excluded.webhook_last_updatedAt, lifelogs.webhook_last_updatedAt),
        webhook_status=COALESCE(excluded.webhook_status, lifelogs.webhook_status),
        webhook_sent_at=COALESCE(excluded.webhook_sent_at, lifelogs.webhook_sent_at),
        last_seen_at=datetime('now');
    `;
    db.run(stmt, [
      row.id, row.title, row.markdown, row.startTime, row.endTime, row.updatedAt, 
      row.isStarred, row.analysis_json, row.webhook_last_updatedAt, row.webhook_status, row.webhook_sent_at
    ], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function findById(id) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM lifelogs WHERE id=?`, [id], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function markWebhook(updatedAt, status, id) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE lifelogs SET webhook_last_updatedAt=?, webhook_status=?, webhook_sent_at=datetime('now') WHERE id=?`, [updatedAt, status, id], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function setAnalysis(analysisJson, id) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE lifelogs SET analysis_json=? WHERE id=?`, [analysisJson, id], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ---------- Helpers ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function clip(str, n=4000) { return !str ? str : (str.length > n ? str.slice(0, n) : str); }
function qs(params) { const u=new URLSearchParams(); for (const [k,v] of Object.entries(params)) if (v!=null) u.set(k,String(v)); return u.toString(); }

async function fetchWithRetry(url, opts={}, max=3) {
  for (let i=0;i<max;i++) {
    const r = await fetch(url, opts);
    if (r.status === 429) { const wait = 1000 * (i+1) * 2; console.warn('429 rate limited. Sleeping', wait,'ms'); await sleep(wait); continue; }
    if (r.ok) return r;
    if (r.status >= 500 && i < max-1) { await sleep(500 * (i+1)); continue; }
    throw new Error(`HTTP ${r.status} ${await r.text()}`);
  }
  throw new Error('fetchWithRetry exhausted');
}

function lifelogToRow(l) {
  return {
    id: l.id,
    title: l.title ?? null,
    markdown: l.markdown ?? null,
    startTime: l.startTime ?? null,
    endTime: l.endTime ?? null,
    updatedAt: l.updatedAt ?? null,
    isStarred: l.isStarred ? 1 : 0,
    analysis_json: null,
    webhook_last_updatedAt: null,
    webhook_status: null,
    webhook_sent_at: null
  };
}

async function callOpenAI(markdown) {
  if (!OPENAI_API_KEY) return { sentiment: "unscored", confidence: 0, summary: "" };
  const sys = `You are a precise sentiment and tone analyzer for long journal-like text.
Return strict JSON with: sentiment ("positive"|"neutral"|"negative"), confidence (0..1), emotional_valence (-1..1), urgency (0..3), summary (<=30 words).`;
  const body = {
    model: OPENAI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: `Analyze:\n"""${markdown?.slice(0,6000) ?? ''}"""` }
    ],
    temperature: 0
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content?.trim() || "{}";
  try { return JSON.parse(text); } catch { return { sentiment: "neutral", confidence: 0.5, summary: text.slice(0,120) }; }
}

async function createChatGPTSummary(summary, markdownPreview) {
  if (!OPENAI_API_KEY || !WEBHOOK_URL_2) return null;
  
  const sys = `You are a concise summarizer. Create a brief, informative summary that combines the key insights from both the analysis summary and the content preview. Keep it under 100 words and focus on the most important points.`;
  
  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: `Summarize this content:\n\nAnalysis Summary: ${summary || 'No summary available'}\n\nContent Preview: ${markdownPreview || 'No content preview available'}` }
    ],
    temperature: 0.3
  };
  
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const j = await r.json();
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.warn('ChatGPT summary failed:', e.message);
    return null;
  }
}

async function postWebhook(payload) {
  const r = await fetch(WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return r.status;
}

async function postWebhook2(payload) {
  if (!WEBHOOK_URL_2) return null;
  const r = await fetch(WEBHOOK_URL_2, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return r.status;
}

async function pageStarred(cursor=null, limit=10) {
  const p = {
    isStarred: 'true',
    limit,
    direction: 'desc',
    timezone: TIMEZONE,
    includeMarkdown: 'true',
    includeHeadings: 'true',
    includeContents: 'false',
    ...(cursor ? { cursor } : {})
  };
  const url = `https://api.limitless.ai/v1/lifelogs?${qs(p)}`;
  const r = await fetchWithRetry(url, { headers: { 'X-API-Key': LIMITLESS_API_KEY } });
  const j = await r.json();
  return { lifelogs: j?.data?.lifelogs ?? [], nextCursor: j?.meta?.lifelogs?.nextCursor ?? null };
}

async function fullBackfill() {
  console.log('Starting full backfill of starred lifelogs…');
  let cursor = null;
  let pages = 0, total = 0, inserted = 0, updated = 0, webhookSent = 0;
  do {
    pages++;
    const { lifelogs, nextCursor } = await pageStarred(cursor, 10);
    cursor = nextCursor;
    total += lifelogs.length;
    for (const l of lifelogs) {
      const existing = await findById(l.id);
      const row = lifelogToRow(l);
      if (!existing) { await upsertLifelog(row); inserted++; }
      else {
        if (existing.updatedAt !== l.updatedAt || existing.isStarred !== (l.isStarred?1:0)) { await upsertLifelog(row); updated++; }
        else { 
          await db.run(`UPDATE lifelogs SET last_seen_at=datetime('now') WHERE id=?`, [l.id]);
        }
      }
      // sentiment if missing
      const current = await findById(l.id);
      if (!current.analysis_json) {
        try { const analysis = await callOpenAI(current.markdown || ''); await setAnalysis(JSON.stringify(analysis), l.id); }
        catch (e) { console.warn('OpenAI sentiment failed for', l.id, e.message); }
      }
      if (BACKFILL_SEND_WEBHOOK) {
        const c2 = await findById(l.id);
        if (c2.webhook_last_updatedAt !== c2.updatedAt) {
          const analysis = c2.analysis_json ? JSON.parse(c2.analysis_json) : null;
          const status = await postWebhook({
            source: 'limitless-starred',
            lifelogId: c2.id,
            title: c2.title,
            startTime: c2.startTime,
            endTime: c2.endTime,
            updatedAt: c2.updatedAt,
            isStarred: !!c2.isStarred,
            analysis,
            markdownPreview: clip(c2.markdown, 4000)
          });
          
          // Send second webhook with ChatGPT summary if configured
          if (WEBHOOK_URL_2 && analysis?.summary) {
            try {
              const chatGPTSummary = await createChatGPTSummary(analysis.summary, clip(c2.markdown, 4000));
              if (chatGPTSummary) {
                await postWebhook2({
                  source: 'limitless-starred-summary',
                  lifelogId: c2.id,
                  title: c2.title,
                  startTime: c2.startTime,
                  endTime: c2.endTime,
                  updatedAt: c2.updatedAt,
                  isStarred: !!c2.isStarred,
                  chatGPTSummary,
                  originalAnalysis: analysis
                });
              }
            } catch (e) {
              console.warn('Second webhook failed for', c2.id, e.message);
            }
          }
          
          await markWebhook(c2.updatedAt, status, c2.id);
          webhookSent++;
        }
      }
    }
    console.log(`Backfill page ${pages} — got ${lifelogs.length}${cursor ? '' : ' (last page)'}…`);
  } while (cursor && pages < 1000);
  console.log(`Backfill done. pages=${pages}, total=${total}, inserted=${inserted}, updated=${updated}, webhookSent=${webhookSent}`);
  await kvSet('backfill_done', '1');
}

async function incrementalScan() {
  let cursor = null;
  let pages = 0, processed = 0, sent = 0;
  const maxPages = MAX_PAGES_PER_RUN;
  while (pages < maxPages) {
    pages++;
    const { lifelogs, nextCursor } = await pageStarred(cursor, 10);
    cursor = nextCursor;
    if (!lifelogs.length) break;

    for (const l of lifelogs) {
      const existing = await findById(l.id);
      const row = lifelogToRow(l);
      if (!existing) await upsertLifelog(row);
      else if (existing.updatedAt !== l.updatedAt || existing.isStarred !== (l.isStarred?1:0)) await upsertLifelog(row);
      else {
        await db.run(`UPDATE lifelogs SET last_seen_at=datetime('now') WHERE id=?`, [l.id]);
      }

      const current = await findById(l.id);
      if (!current.analysis_json) {
        try { const analysis = await callOpenAI(current.markdown || ''); await setAnalysis(JSON.stringify(analysis), l.id); }
        catch (e) { console.warn('OpenAI sentiment failed for', l.id, e.message); }
      }

      const c2 = await findById(l.id);
      if (c2.webhook_last_updatedAt !== c2.updatedAt) {
        const analysis = c2.analysis_json ? JSON.parse(c2.analysis_json) : null;
        const status = await postWebhook({
          source: 'limitless-starred',
          lifelogId: c2.id,
          title: c2.title,
          startTime: c2.startTime,
          endTime: c2.endTime,
          updatedAt: c2.updatedAt,
          isStarred: !!c2.isStarred,
          analysis,
          markdownPreview: clip(c2.markdown, 4000)
        });
        
        // Send second webhook with ChatGPT summary if configured
        if (WEBHOOK_URL_2 && analysis?.summary) {
          try {
            const chatGPTSummary = await createChatGPTSummary(analysis.summary, clip(c2.markdown, 4000));
            if (chatGPTSummary) {
              await postWebhook2({
                source: 'limitless-starred-summary',
                lifelogId: c2.id,
                title: c2.title,
                startTime: c2.startTime,
                endTime: c2.endTime,
                updatedAt: c2.updatedAt,
                isStarred: !!c2.isStarred,
                chatGPTSummary,
                originalAnalysis: analysis
              });
            }
          } catch (e) {
            console.warn('Second webhook failed for', c2.id, e.message);
          }
        }
        
        await markWebhook(c2.updatedAt, status, c2.id);
        sent++;
      }
      processed++;
    }

    // Early-stop heuristic after a few pages if 80% are already up-to-date & webhooked
    if (pages >= 3) {
      const upToDate = await Promise.all(lifelogs.map(async l => {
        const r = await findById(l.id);
        return r && r.updatedAt === l.updatedAt && r.webhook_last_updatedAt === r.updatedAt && r.analysis_json;
      }));
      const upToDateCount = upToDate.filter(Boolean).length;
      if (upToDateCount / lifelogs.length >= 0.8) break;
    }
    if (!cursor) break;
  }
  console.log(`Scan done. pages=${pages}, processed=${processed}, webhooksSent=${sent}`);
}

async function main() {
  const backfilled = await kvGet('backfill_done');
  if (!backfilled || backfilled.value !== '1') await fullBackfill();
  if (POLL_SECONDS <= 0) { await incrementalScan(); return; }
  console.log('Watching starred lifelogs… every', POLL_SECONDS, 'seconds');
  await incrementalScan();
  setInterval(() => incrementalScan().catch(e => console.error('scan error', e)), POLL_SECONDS*1000);
}

main().catch(e => { console.error(e); process.exit(1); });

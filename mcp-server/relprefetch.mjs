// mcp-server/relprefetch.mjs
// Generic relationship-prefetch planner/executor for Maximo OSLC queries.
//
// Supports filters like `asset.assettype="SENSOR"` even when the root OS doesn't expose
// a joinable relationship path for that field.
//
// Usage (from server.mjs):
//   const { plan } = await applyRelationshipPrefetch({ tenantId, t, os, params, defaultSite, rxId, maximoFetch, authHeaders, maximoApiBase });
//   // params may be mutated in-place; plan can be attached to response._mcp.plan

import fs from "fs";
import path from "path";

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function getOslcMembers(body) {
  if (!body || typeof body !== "object") return [];
  const m1 = body?.member;
  const m2 = body?.["rdfs:member"];
  // Some environments put `member` as a list of lists.
  const one = Array.isArray(m1) ? m1 : Array.isArray(m2) ? m2 : [];
  if (one.length === 1 && Array.isArray(one[0])) return one[0];
  return one;
}

function normalizeOp(opRaw) {
  const op = String(opRaw || "").trim().toLowerCase();
  if (op === "=") return "=";
  if (op === "!=") return "!=";
  if (op === "like") return "like";
  // treat default as equals
  return "=";
}

function escapeWhereString(v) {
  // OSLC uses double quotes for literals; escape embedded quotes.
  return String(v ?? "").replace(/"/g, "\\\"");
}

function detectRelationshipPredicates(where) {
  // Detect simple predicates of the form:
  //   rel.field = "..."
  //   rel.field != "..."
  //   rel.field like "..."
  // And also accept single quoted literals.
  const w = String(where || "");
  const preds = [];

  // Capture: rel, field, op, quote, value
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=|!=|\blike\b)\s*("([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(w))) {
    const rel = String(m[1]).trim();
    const field = String(m[2]).trim();
    const op = normalizeOp(m[3]);
    const val = (typeof m[5] === "string" ? m[5] : m[6]) ?? "";
    preds.push({ rel, field, op, value: String(val) });
  }
  return preds;
}

function buildOrBlock(rootJoinField, keys) {
  const parts = keys.map((k) => `${rootJoinField}="${escapeWhereString(k)}"`);
  return `(${parts.join(" or ")})`;
}

function loadRelationshipsConfig({ dataDir, tenantId }) {
  // Priority:
  //  1) /data/relationships/relationships.<tenantId>.json
  //  2) /data/relationships/relationships.defaults.json
  //  3) built-in defaults in this module
  const relDir = path.join(dataDir, "relationships");
  const tenantFile = path.join(relDir, `relationships.${tenantId}.json`);
  const defaultsFile = path.join(relDir, "relationships.defaults.json");

  const builtIn = {
    version: 1,
    relationships: {
      // Work Orders
      mxapiwo: {
        asset: {
          relatedOs: "mxapiasset",
          rootJoinField: "assetnum",
          relatedKeyField: "assetnum",
          relatedSiteField: "siteid",
          maxKeys: 50,
          pageSize: 200,
          select: "assetnum"
        },
        location: {
          relatedOs: "mxapilocations",
          rootJoinField: "location",
          relatedKeyField: "location",
          relatedSiteField: "siteid",
          maxKeys: 50,
          pageSize: 200,
          select: "location"
        }
      },
      // Service Requests
      mxapisr: {
        asset: {
          relatedOs: "mxapiasset",
          rootJoinField: "assetnum",
          relatedKeyField: "assetnum",
          relatedSiteField: "siteid",
          maxKeys: 50,
          pageSize: 200,
          select: "assetnum"
        }
      },
      // Purchase Orders / Purchase Reqs (vendor relationship)
      // NOTE: join fields vary by tenant; override these in relationships.<tenant>.json
      mxapipo: {
        vendor: {
          relatedOs: "mxapivendor",
          rootJoinField: "vendor",
          relatedKeyField: "vendor",
          relatedSiteField: "siteid",
          maxKeys: 50,
          pageSize: 200,
          select: "vendor"
        }
      },
      mxapipr: {
        vendor: {
          relatedOs: "mxapivendor",
          rootJoinField: "vendor",
          relatedKeyField: "vendor",
          relatedSiteField: "siteid",
          maxKeys: 50,
          pageSize: 200,
          select: "vendor"
        }
      }
    }
  };

  let defaults = null;
  let tenant = null;

  try {
    if (fs.existsSync(defaultsFile)) {
      defaults = safeJson(fs.readFileSync(defaultsFile, "utf8"));
    }
  } catch {}

  try {
    if (fs.existsSync(tenantFile)) {
      tenant = safeJson(fs.readFileSync(tenantFile, "utf8"));
    }
  } catch {}

  // Merge: builtIn <- defaults <- tenant
  const out = structuredClone(builtIn);
  if (defaults?.relationships && typeof defaults.relationships === "object") {
    out.relationships = { ...out.relationships, ...defaults.relationships };
  }
  if (tenant?.relationships && typeof tenant.relationships === "object") {
    out.relationships = { ...out.relationships, ...tenant.relationships };
  }
  return out;
}

async function prefetchKeys({
  t,
  rxId,
  apiBase,
  authHeaders,
  maximoFetch,
  relatedOs,
  relatedWhere,
  select,
  pageSize,
  relatedKeyField,
}) {
  const q = new URLSearchParams();
  q.set("lean", "1");
  q.set("oslc.pageSize", String(pageSize || 200));
  q.set("oslc.select", select || relatedKeyField);
  q.set("oslc.where", relatedWhere);

  const url = `${apiBase}/os/${encodeURIComponent(relatedOs)}?${q.toString()}`;
  const r2 = await maximoFetch(t, { method: "GET", url, headers: authHeaders(t), kind: "tx_maximo", title: `→ Maximo OS ${relatedOs} (prefetch)`, meta: { relatedId: rxId } });

  // maximoFetch returns { r, respText } in some call sites, and sometimes a parsed JSON body in others.
  // In this server, the helper in the hardcoded block treated it as already parsed.
  // Here, be defensive.
  let body = r2;
  if (r2 && typeof r2 === "object" && r2.r && typeof r2.respText === "string") {
    // Alternate shape
    body = safeJson(r2.respText) ?? { raw: r2.respText };
  }

  const members = getOslcMembers(body);
  const keys = members.map((it) => it?.[relatedKeyField]).filter(Boolean).map((x) => String(x).trim());
  return { keys, rawCount: keys.length };
}

export async function applyRelationshipPrefetch({ tenantId, t, os, params, defaultSite, rxId, maximoFetch, authHeaders, maximoApiBase }) {
  const plan = {
    mode: "none",
    detected: [],
    steps: [],
    truncated: false,
    errors: []
  };

  try {
    const where = String(params?.["oslc.where"] || "");
    if (!where) return { plan };

    const dataDir = String(process.env.DATA_DIR || "/data");
    const cfg = loadRelationshipsConfig({ dataDir, tenantId });
    const relsForOs = cfg?.relationships?.[String(os || "").toLowerCase()] || cfg?.relationships?.[String(os || "")] || null;

    const preds = detectRelationshipPredicates(where);
    if (!preds.length) return { plan };
    plan.detected = preds;

    // For safety, only rewrite predicates we have a configured relationship for.
    const apiBase = maximoApiBase(t);

    let mutatedWhere = where;

    for (const p of preds) {
      const relName = String(p.rel || "");
      const relCfg = relsForOs?.[relName];
      if (!relCfg) continue;

      const relatedOs = String(relCfg.relatedOs || "").trim();
      const rootJoinField = String(relCfg.rootJoinField || "").trim();
      const relatedKeyField = String(relCfg.relatedKeyField || "").trim();
      const relatedSiteField = String(relCfg.relatedSiteField || "").trim();
      const select = String(relCfg.select || "").trim() || relatedKeyField;
      const pageSize = Number(relCfg.pageSize || 200);
      const maxKeys = Number(relCfg.maxKeys || process.env.MAX_PREFETCH_KEYS || 50);

      if (!relatedOs || !rootJoinField || !relatedKeyField) continue;

      // Build the related where
      const val = escapeWhereString(p.value);
      const op = p.op === "like" ? "like" : (p.op === "!=" ? "!=" : "=");

      let relWhere = `${p.field} ${op} "${val}"`;
      if (defaultSite && relatedSiteField) {
        // Do not double-add if caller already filtered by siteid (best-effort)
        if (!/(^|\W)siteid\s*(=|!=|\bin\b)/i.test(relWhere)) {
          relWhere = `${relatedSiteField}="${escapeWhereString(defaultSite)}" and ${relWhere}`;
        }
      }

      plan.mode = "prefetch";
      plan.steps.push({
        kind: "prefetch",
        relationship: relName,
        relatedOs,
        relatedWhere: relWhere,
        select,
        rootJoinField,
        relatedKeyField,
        maxKeys
      });

      let keys = [];
      try {
        const out = await prefetchKeys({
          t,
          rxId,
          apiBase,
          authHeaders,
          maximoFetch,
          relatedOs,
          relatedWhere: relWhere,
          select,
          pageSize,
          relatedKeyField,
        });
        keys = (out.keys || []).slice(0, Math.max(0, maxKeys));
        if ((out.keys || []).length > keys.length) plan.truncated = true;

        plan.steps.push({
          kind: "prefetch_result",
          relationship: relName,
          keysReturned: (out.keys || []).length,
          keysUsed: keys.length
        });
      } catch (e) {
        plan.errors.push({ relationship: relName, message: String(e?.message || e) });
        continue;
      }

      if (!keys.length) {
        // No matching related rows; rewrite the predicate to something that yields no root rows.
        // Using a false clause is safer than returning everything.
        const falseClause = `${rootJoinField}="__NO_MATCH__"`;
        const clauseRe = new RegExp(`\\b${relName}\\s*\\.\\s*${p.field}\\s*(=|!=|\\blike\\b)\\s*(\"[^\"]*\"|'[^']*')`, "i");
        mutatedWhere = mutatedWhere.replace(clauseRe, falseClause);
        plan.steps.push({ kind: "rewrite", relationship: relName, replacedWith: falseClause, note: "no related matches" });
        continue;
      }

      const orBlock = buildOrBlock(rootJoinField, keys);

      // Replace ONLY this clause occurrence.
      const clauseRe = new RegExp(`\\b${relName}\\s*\\.\\s*${p.field}\\s*(=|!=|\\blike\\b)\\s*(\"[^\"]*\"|'[^']*')`, "i");
      mutatedWhere = mutatedWhere.replace(clauseRe, orBlock);

      plan.steps.push({ kind: "rewrite", relationship: relName, replacedWith: orBlock });
    }

    if (mutatedWhere !== where) {
      params["oslc.where"] = mutatedWhere;
    }

    return { plan };
  } catch (e) {
    plan.mode = "error";
    plan.errors.push({ message: String(e?.message || e) });
    return { plan };
  }
}

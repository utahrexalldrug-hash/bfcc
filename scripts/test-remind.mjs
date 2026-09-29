#!/usr/bin/env node
// Tests for api/remind.js with a fake Firestore and a fake push service.
// Run: npm run test:remind   (no network, no real notifications)
process.env.TZ = "UTC"; // start like Vercel does; the handler must switch to Denver itself
process.env.CRON_SECRET = "test-secret";
process.env.VAPID_PRIVATE_KEY = "unused-in-tests";

const { default: handler, buildMessages } = await import("../api/remind.js");
const S = await import("../src/schedule.js");

let failures = 0;
const check = (label, cond, extra = "") => { console.log(`${cond ? "✔" : "✖"} ${label}${extra ? " — " + extra : ""}`); if (!cond) failures++; };

// ---- fake Firestore (REST shape) ----
const enc = (v) => v === null ? { nullValue: null } : typeof v === "string" ? { stringValue: v } : typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === "boolean" ? { booleanValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
function fakeFirestore(docs) {
  return async (url, opts = {}) => {
    const u = new URL(url); const name = decodeURIComponent(u.pathname.split("/").pop());
    if (opts.method === "PATCH") {
      const body = JSON.parse(opts.body); const mask = u.searchParams.getAll("updateMask.fieldPaths");
      docs[name] = docs[name] || {};
      for (const k of mask) { if (body.fields[k]) docs[name][k] = body.fields[k].stringValue; else delete docs[name][k]; }
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (!docs[name]) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ fields: enc(docs[name]).mapValue.fields }) };
  };
}
function fakeRes() { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; }
const cronReq = (q = "") => ({ method: "GET", url: `/api/remind${q}`, headers: { authorization: "Bearer test-secret" } });

const sub = (endpoint) => ({ endpoint, expirationTime: null, keys: { p256dh: "x", auth: "y" } });
function baseDocs() {
  return {
    pushSubscriptions: {
      sCarter: { members: ["Carter"], parent: false, subscription: sub("https://push.example/carter") },
      sIpad: { members: ["Cole", "Finn", "Liam"], parent: false, subscription: sub("https://push.example/ipad") },
      sDad: { members: [], parent: true, subscription: sub("https://push.example/dad") },
      sGone: { members: ["Nicholas"], parent: false, subscription: sub("https://push.example/gone") },
    },
    completedChores: {}, customTasks: {}, pushState: {},
  };
}
async function run(nowISO, docs, q = "") {
  const sent = [];
  const send = async (subscription, payload) => {
    if (subscription.endpoint.endsWith("/gone")) { const e = new Error("gone"); e.statusCode = 410; throw e; }
    sent.push({ to: subscription.endpoint.split("/").pop(), ...JSON.parse(payload) });
  };
  const res = fakeRes();
  await handler(cronReq(q), res, { fetch: fakeFirestore(docs), send, now: new Date(nowISO) });
  return { res, sent };
}

// 1. Summer (MDT, UTC-6): 00:30Z = 6:30pm → send; 01:30Z = 7:30pm → skip
{
  const docs = baseDocs();
  const a = await run("2026-10-01T00:30:00Z", docs); // Wed Sep 30, 6:30pm MDT
  check("summer: 6:30pm MDT run sends", a.res.body.ok && a.sent.length > 0, `sent ${a.sent.length}`);
  check("summer: date recorded as local date", docs.pushState.lastSentDate === "2026-09-30", docs.pushState.lastSentDate);
  const b = await run("2026-10-01T01:30:00Z", docs);
  check("summer: 7:30pm run skips", b.sent.length === 0 && /not the 18/.test(b.res.body.skipped || ""), b.res.body.skipped);
  const c = await run("2026-10-01T00:45:00Z", docs);
  check("same evening again → skipped (once a day)", c.sent.length === 0 && /already sent/.test(c.res.body.skipped || ""), c.res.body.skipped);
  check("dead device (410) removed", !("sGone" in docs.pushSubscriptions));
  const carter = a.sent.filter(m => m.to === "carter");
  check("Carter gets one note with his jobs", carter.length === 1 && /^Carter: \d+ jobs? left today$/.test(carter[0].title), carter[0] && `${carter[0].title} | ${carter[0].body}`);
  const ipad = a.sent.filter(m => m.to === "ipad").map(m => m.title.split(":")[0]);
  check("iPad gets separate notes for Cole, Finn, Liam", JSON.stringify(ipad) === JSON.stringify(["Cole", "Finn", "Liam"]), ipad.join(", "));
  const dad = a.sent.find(m => m.to === "dad");
  check("parent summary lists who's not done", dad && /kids still have jobs/.test(dad.title), dad && `${dad.title} | ${dad.body}`);
  check("tapping opens that kid's card", carter[0] && carter[0].url === "/?kid=Carter");
}

// 2. Winter (MST, UTC-7): 00:30Z = 5:30pm → skip; 01:30Z = 6:30pm → send
{
  const docs = baseDocs();
  const a = await run("2026-12-03T00:30:00Z", docs);
  check("winter: 5:30pm MST run skips", a.sent.length === 0, a.res.body.skipped);
  const b = await run("2026-12-03T01:30:00Z", docs);
  check("winter: 6:30pm MST run sends", b.sent.length > 0 && docs.pushState.lastSentDate === "2026-12-02", `sent ${b.sent.length}, date ${docs.pushState.lastSentDate}`);
}

// 3. Finished kids get nothing; parent summary only names who's left
{
  const docs = baseDocs();
  const now = new Date("2026-10-01T00:30:00Z");
  process.env.TZ = "America/Denver";
  const dk = S.dateToKey(now);
  for (const c of S.buildChoreList("Carter", now, {}, {})) docs.completedChores[`${dk}_Carter_${c.id}`] = { ts: 1, pts: 1 };
  process.env.TZ = "UTC";
  const a = await run(now.toISOString(), docs);
  check("run actually sent (not skipped)", a.sent.length > 0, a.res.body.skipped || `sent ${a.sent.length}`);
  check("Carter all done → no note for Carter", !a.sent.some(m => m.to === "carter"));
  const dad = a.sent.find(m => m.to === "dad");
  check("parent summary leaves Carter out", dad && !/Carter/.test(dad.body), dad && dad.body);
}

// 4. Auth + force
{
  const res = fakeRes();
  await handler({ method: "GET", url: "/api/remind", headers: {} }, res, { fetch: fakeFirestore(baseDocs()), send: async () => {}, now: new Date() });
  check("no password → 401", res.code === 401);
  const docs = baseDocs();
  const f = await run("2026-10-01T15:00:00Z", docs, "?force=1"); // 9am, forced
  check("force=1 sends outside the hour (for testing)", f.sent.length > 0 && !docs.pushState.lastSentDate);
}

// 5. Test note to one device
{
  const docs = baseDocs(); const sent = [];
  const res = fakeRes();
  await handler({ method: "POST", url: "/api/remind", headers: {}, body: { test: "sIpad" } }, res, { fetch: fakeFirestore(docs), send: async (s, p) => sent.push(JSON.parse(p)), now: new Date() });
  check("test note reaches just that device", res.body.ok && sent.length === 1 && /Cole, Finn, Liam/.test(sent[0].body), sent[0] && sent[0].body);
}

console.log(failures ? `\n✖ ${failures} failed` : "\n✔ all reminder tests passed");
process.exit(failures ? 1 : 0);

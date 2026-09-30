// ============================================================
// Evening reminder sender — Vercel Function at /api/remind
//
// Once a day, during the 6 o'clock hour (Mountain time), every device that
// turned on reminders gets a notification for each kid it follows who still
// has jobs left today — e.g. "Carter: 3 jobs left today" / "Floor Pickup ·
// Laundry Day! · Tidy Up: Kitchen". Kids who are done get nothing. Devices
// with the parent summary on get one "who's not done" note — and on Sundays
// it also says whose turn it is for the one-on-one night out (until it's scheduled); in the
// last week of a month it adds any monthly work hours still owed (Cole).
//
// Scheduling: vercel.json runs this at 00:00 and 01:00 UTC. The free plan only
// promises "somewhere in that hour", and Denver is UTC-6 in summer / UTC-7 in
// winter, so one of the two runs always lands in the local 6pm hour — this
// function checks the local hour and only sends from that one, at most once
// per day (tracked in Firestore family/pushState).
//
// Requests:
//   GET  /api/remind            (Vercel cron, Authorization: Bearer CRON_SECRET)
//   GET  /api/remind?force=1    (same auth; send now regardless of hour/day)
//   POST /api/remind {"test": "<subscription id>"}  → test note to one device
//
// Environment variables (Vercel → Settings → Environment Variables):
//   VAPID_PRIVATE_KEY  — private half of the notification key pair
//   CRON_SECRET        — Vercel sends this with cron requests automatically
// ============================================================
import webpush from "web-push";
import { buildChoreList, FAMILY_MEMBERS, dateToKey, getDateNight, MONTHLY_WORK, getWorkMonth, formatMinutes, getMonthKey } from "../src/schedule.js";
import { firebaseConfig } from "../src/firebaseConfig.js";
import { VAPID_PUBLIC_KEY } from "../src/pushConfig.js";

// The schedule is local-time based; run it in the family's timezone.
process.env.TZ = "America/Denver";

export const REMIND_HOUR = 18; // 6 o'clock hour, Mountain time

const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/family`;

// ---------- Firestore REST helpers (the family/* docs are open to the app) ----------
function decode(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  return null;
}
function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decode(v);
  return out;
}
export async function readDoc(name, fetchImpl = fetch) {
  const r = await fetchImpl(`${FIRESTORE}/${name}?key=${firebaseConfig.apiKey}`);
  if (r.status === 404) return {};
  if (!r.ok) throw new Error(`Firestore read ${name}: ${r.status}`);
  const j = await r.json();
  return decodeFields(j.fields || {});
}
// Set string fields and/or delete fields (value null) without touching others.
export async function patchDoc(name, changes, fetchImpl = fetch) {
  const keys = Object.keys(changes);
  if (!keys.length) return;
  const mask = keys.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const fields = {};
  for (const [k, v] of Object.entries(changes)) if (v !== null) fields[k] = { stringValue: String(v) };
  const r = await fetchImpl(`${FIRESTORE}/${name}?key=${firebaseConfig.apiKey}&${mask}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`Firestore write ${name}: ${r.status}`);
}

// ---------- What to say ----------
// Jobs a kid still has open today (routine checklists excluded — bedtime
// routines are for later in the evening and have their own cards).
export function jobsLeft(member, date, customTasks, completedChores) {
  const dk = dateToKey(date);
  return buildChoreList(member, date, customTasks, completedChores)
    .filter(c => !c.routine && !completedChores[`${dk}_${member}_${c.id}`]);
}

export function buildMessages(subscriptions, date, customTasks, completedChores, dateNights = {}, workLogs = {}, workCashouts = {}) {
  const kids = FAMILY_MEMBERS.map(m => m.name);
  const left = Object.fromEntries(kids.map(k => [k, jobsLeft(k, date, customTasks, completedChores)]));
  // Sundays: remind parents whose turn it is for the one-on-one night out (until it's scheduled).
  const dn = date.getDay() === 0 ? getDateNight(date, dateNights) : null;
  const dateLine = dn && !(dn.record && dn.record.status === "scheduled")
    ? `🍔 One-on-one this week: ${dn.kid} — not scheduled yet` : null;
  // Last 7 days of the month: nudge parents about monthly work hours still owed.
  const daysLeft = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate() - date.getDate();
  const workLines = daysLeft < 7 ? Object.keys(MONTHLY_WORK).map(kid => {
    const w = getWorkMonth(kid, getMonthKey(date), workLogs, workCashouts);
    return w && !w.beforeStart && w.remaining > 0 ? `⏱️ ${kid}: ${formatMinutes(w.remaining)} work left this month` : null;
  }).filter(Boolean) : [];
  const extraLines = [dateLine, ...workLines].filter(Boolean);
  const out = []; // { subId, payload }
  for (const [subId, sub] of Object.entries(subscriptions)) {
    if (!sub || !sub.subscription) continue;
    for (const kid of sub.members || []) {
      const jobs = left[kid];
      if (!jobs || jobs.length === 0) continue;
      const titles = jobs.map(j => (j.priority ? "⚠ " : "") + j.text.replace(/^Dinner: /, ""));
      out.push({ subId, payload: {
        title: `${kid}: ${jobs.length} job${jobs.length === 1 ? "" : "s"} left today`,
        body: titles.join(" · "),
        url: `/?kid=${encodeURIComponent(kid)}`,
        tag: `hq-${kid}`,
      } });
    }
    if (sub.parent) {
      const notDone = kids.filter(k => left[k].length > 0);
      if (notDone.length) out.push({ subId, payload: {
        title: notDone.length === 1 ? "1 kid still has jobs" : `${notDone.length} kids still have jobs`,
        body: [notDone.map(k => `${k} ${left[k].length}`).join(" · "), ...extraLines].join("\n"),
        url: "/",
        tag: "hq-parent",
      } });
      else if (dateLine) out.push({ subId, payload: {
        title: `🍔 One-on-one this week: ${dn.kid}`,
        body: ["Not scheduled yet — tap to set it up", ...workLines].join("\n"),
        url: "/",
        tag: "hq-parent",
      } });
      else if (workLines.length) out.push({ subId, payload: {
        title: "⏱️ Work hours this month",
        body: workLines.join("\n"),
        url: "/",
        tag: "hq-parent",
      } });
    }
  }
  return out;
}

// ---------- Sending ----------
function configure() {
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!priv) throw new Error("VAPID_PRIVATE_KEY is not set");
  webpush.setVapidDetails("https://bfcc.vercel.app", VAPID_PUBLIC_KEY, priv);
}

async function sendAll(messages, subscriptions, send = webpush.sendNotification) {
  const gone = new Set();
  let sent = 0, failed = 0;
  for (const { subId, payload } of messages) {
    if (gone.has(subId)) continue;
    try {
      await send(subscriptions[subId].subscription, JSON.stringify(payload), { TTL: 60 * 60 * 3 });
      sent++;
    } catch (err) {
      // 404/410 = the device unsubscribed or the app was removed; forget it.
      if (err && (err.statusCode === 404 || err.statusCode === 410)) gone.add(subId);
      else { failed++; console.warn("push failed", subId, err && (err.statusCode || err.message)); }
    }
  }
  return { sent, failed, removed: [...gone] };
}

// Pure decision so it can be tested: should the scheduled run send now?
export function shouldSendNow(now, lastSentDate, force) {
  if (force) return { send: true };
  if (now.getHours() !== REMIND_HOUR) return { send: false, reason: `not the ${REMIND_HOUR}:00 hour (local ${now.getHours()}:00)` };
  if (lastSentDate === dateToKey(now)) return { send: false, reason: "already sent today" };
  return { send: true };
}

export default async function handler(req, res, deps = {}) {
  process.env.TZ = "America/Denver"; // every request — never trust the server default (UTC)
  const fetchImpl = deps.fetch || fetch;
  const send = deps.send || ((...a) => webpush.sendNotification(...a));
  const now = deps.now || new Date();
  try {
    if (!deps.send) configure();
    const url = new URL(req.url, "https://bfcc.vercel.app");
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

    // --- Test note to one device (from the Reminders screen) ---
    if (req.method === "POST" && body && body.test) {
      const subs = await readDoc("pushSubscriptions", fetchImpl);
      const sub = subs[body.test];
      if (!sub || !sub.subscription) return res.status(404).json({ ok: false, error: "This device isn't registered yet" });
      const who = [...(sub.members || []), ...(sub.parent ? ["parent summary"] : [])].join(", ") || "nobody yet";
      const result = await sendAll([{ subId: body.test, payload: {
        title: "🔔 Family HQ reminders are on",
        body: `This device will get a 6 o'clock reminder for: ${who}.`,
        url: "/", tag: "hq-test",
      } }], subs, send);
      if (result.removed.length) await patchDoc("pushSubscriptions", { [body.test]: null }, fetchImpl);
      return res.status(200).json({ ok: result.sent === 1, ...result });
    }

    // --- Scheduled run ---
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ ok: false, error: "unauthorized" });
    const force = url.searchParams.get("force") === "1";
    const state = await readDoc("pushState", fetchImpl);
    const decision = shouldSendNow(now, state.lastSentDate, force);
    if (!decision.send) return res.status(200).json({ ok: true, skipped: decision.reason });

    // Claim today first so an overlapping run can't double-send.
    if (!force) await patchDoc("pushState", { lastSentDate: dateToKey(now) }, fetchImpl);
    const [subs, completedChores, customTasks, dateNights, workLogs, workCashouts] = await Promise.all([
      readDoc("pushSubscriptions", fetchImpl), readDoc("completedChores", fetchImpl), readDoc("customTasks", fetchImpl),
      readDoc("dateNights", fetchImpl), readDoc("workLogs", fetchImpl), readDoc("workCashouts", fetchImpl),
    ]);
    const messages = buildMessages(subs, now, customTasks, completedChores, dateNights, workLogs, workCashouts);
    const result = await sendAll(messages, subs, send);
    if (result.removed.length) await patchDoc("pushSubscriptions", Object.fromEntries(result.removed.map(id => [id, null])), fetchImpl);
    return res.status(200).json({ ok: true, date: dateToKey(now), devices: Object.keys(subs).length, ...result });
  } catch (err) {
    console.error("remind failed:", err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
}

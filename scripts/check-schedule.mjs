#!/usr/bin/env node
// ============================================================
// Schedule check — run before pushing:   npm run check
//
// Hard rules (fail = exit code 1):
//   1. Weekly jobs: no kid gets two of the five weekly jobs in the same week.
//   2. Dinner jobs: all four filled every night; nobody takes out trash two
//      nights in a row; nobody has a dinner job on his dishes night
//      (Sunday excepted — Sunday dishes rotate through everyone).
//   3. Dishes: someone is on dishes every day.
//   4. Charts: each week every kid has a different housekeeping chart.
//   5. History is frozen: past days must still resolve to the same jobs as
//      recorded in scripts/schedule-history.json. Streaks re-calculate past
//      days, so editing a table in place would rewrite history — add a new
//      *_VERSIONS entry in src/schedule.js instead.
//
// Warnings (printed, don't fail): likely duplicate chart tasks.
//
// Options:
//   --weeks=N          how far ahead to check (default 52)
//   --update-history   append days up to yesterday to the history file
//                      (never rewrites days already recorded)
// ============================================================

// Dates are local-time; pin to the family's timezone so results match the app.
process.env.TZ = "America/Denver";

const { createHash } = await import("node:crypto");
const fs = await import("node:fs");
const path = await import("node:path");
const url = await import("node:url");
const S = await import("../src/schedule.js");

const here = path.dirname(url.fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(here, "schedule-history.json");
const args = process.argv.slice(2);
const weeksAhead = Number((args.find(a => a.startsWith("--weeks=")) || "--weeks=52").split("=")[1]);
const updateHistory = args.includes("--update-history");

const KIDS = S.FAMILY_MEMBERS.map(m => m.name);
const errors = [];
const warnings = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmt = (d) => `${d.toLocaleDateString("en-US", { weekday: "short" })} ${S.dateToKey(d)}`;

const today = new Date(); today.setHours(0, 0, 0, 0);
const firstSunday = S.getWeekStart(today);
const end = addDays(firstSunday, weeksAhead * 7);

// ---------- 0. Version lists are well-formed ----------
for (const [name, list] of [
  ["WEEKLY_ROTATION_VERSIONS", S.WEEKLY_ROTATION_VERSIONS],
  ["HOUSEKEEPING_CHART_VERSIONS", S.HOUSEKEEPING_CHART_VERSIONS],
  ["DINNER_JOB_VERSIONS", S.DINNER_JOB_VERSIONS],
]) {
  list.forEach((v, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.start)) err(`${name}[${i}].start "${v.start}" must be YYYY-MM-DD`);
    if (i > 0 && v.start <= list[i - 1].start) err(`${name} must be sorted oldest→newest ("${list[i - 1].start}" then "${v.start}")`);
  });
}

// ---------- 1. Weekly rotation: one job per kid per week ----------
for (let ws = firstSunday; ws < end; ws = addDays(ws, 7)) {
  const r = S.getWeeklyRotation(ws);
  if (!r) continue;
  const jobs = { "Collect Trash": r.collectTrash, "Take Bins Out": r.trashOut, "Bring Cans In": r.bringCansIn, "Refill Soap": r.refillSoap, "Toilet Paper": r.toiletPaper };
  const byKid = {};
  for (const [job, kid] of Object.entries(jobs)) {
    if (!KIDS.includes(kid)) err(`Week of ${S.dateToKey(ws)}: "${job}" assigned to unknown kid "${kid}"`);
    (byKid[kid] = byKid[kid] || []).push(job);
  }
  for (const [kid, list] of Object.entries(byKid)) {
    if (list.length > 1) err(`Week of ${S.dateToKey(ws)}: ${kid} has ${list.length} weekly jobs (${list.join(" + ")})`);
  }
}

// ---------- 2 & 3. Dinner jobs + dishes, every day ----------
const DINNER_JOBS = ["Clear Table", "Take Out Trash", "Floor Pickup", "Set Table"];
// Daily rules apply from today on (past days are covered by the history check).
// Seed with last night so the hand-off from yesterday to today is checked too.
const trashOn = (d) => KIDS.find(k => (S.getDailyAssignment(k, d)?.dinnerJobs || []).some(dj => dj.job === "Take Out Trash")) || null;
let prevTrash = trashOn(addDays(today, -1));
for (let d = new Date(today); d < end; d = addDays(d, 1)) {
  const perJob = {};
  const dishes = [];
  for (const kid of KIDS) {
    const a = S.getDailyAssignment(kid, d);
    if (!a) continue;
    if (a.dishes) dishes.push(kid);
    for (const dj of a.dinnerJobs) {
      (perJob[dj.job] = perJob[dj.job] || []).push(kid);
      if (a.dishes && d.getDay() !== 0) err(`${fmt(d)}: ${kid} has dinner job "${dj.job}" on his dishes night`);
    }
  }
  if (dishes.length === 0) err(`${fmt(d)}: nobody is on dishes`);
  for (const job of DINNER_JOBS) {
    const who = perJob[job] || [];
    if (who.length !== 1) err(`${fmt(d)}: "${job}" has ${who.length ? who.join(" + ") : "nobody"} (needs exactly one)`);
  }
  const trash = (perJob["Take Out Trash"] || [])[0] || null;
  if (trash && trash === prevTrash) err(`${fmt(d)}: ${trash} has Take Out Trash two nights in a row`);
  prevTrash = trash;
}

// ---------- 4. Charts: distinct per kid each week ----------
for (let ws = firstSunday; ws < end; ws = addDays(ws, 7)) {
  const mon = addDays(ws, 1);
  const names = KIDS.map(k => S.getChartAssignment(k, mon)?.name);
  if (new Set(names).size !== names.length) err(`Week of ${S.dateToKey(ws)}: two kids share a chart (${KIDS.map((k, i) => `${k}=${names[i]}`).join(", ")})`);
}

// ---------- Warnings: likely duplicate chart tasks (current charts) ----------
const current = S.pickVersion(S.HOUSEKEEPING_CHART_VERSIONS, today).charts;
const THINGS = ["fridge", "dishwasher", "microwave", "oven", "toilet paper", "toilet", "tub", "mirror", "soap", "doorknob", "light switch", "baseboard", "windowsill", "shelves", "banister", "garbage", "trash", "curb"];
const ROTATION_THINGS = { "toilet paper": "Toilet Paper (Wednesday rotation)", "soap": "Refill Soap (Wednesday rotation)", "trash": "Collect Trash (Wednesday rotation)", "garbage": "trash rotation jobs", "curb": "Take Bins Out / Bring Cans In" };
const mentions = (text, thing) => new RegExp(`\\b${thing}`, "i").test(text) && !(thing === "toilet" && /toilet paper/i.test(text) && !/toilet(?! paper)/i.test(text));
for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Saturday"]) {
  for (const thing of THINGS) {
    const hits = current.filter(c => c.tasks[day] && mentions(c.tasks[day], thing));
    if (hits.length > 1) warn(`${day}: "${thing}" appears in ${hits.map(h => h.name).join(" and ")} — same job twice?`);
    if (ROTATION_THINGS[thing]) hits.forEach(h => warn(`${h.name} ${day}: "${h.tasks[day]}" overlaps ${ROTATION_THINGS[thing]}`));
  }
}

// ---------- 5. History is frozen ----------
function dayFingerprint(d) {
  const r = S.getWeeklyRotation(d);
  const parts = KIDS.map(k => `${k}:${S.getDailyDueChores(k, d, {}, {}).join(",")}`);
  return createHash("sha1").update(JSON.stringify([r, parts])).digest("hex").slice(0, 10);
}
let history = { note: "", days: {} };
try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch { /* first run */ }
let changedPast = 0;
for (const [key, fp] of Object.entries(history.days)) {
  const [y, m, dd] = key.split("-").map(Number);
  const now = dayFingerprint(new Date(y, m - 1, dd));
  if (now !== fp) {
    if (changedPast < 5) err(`History changed on ${key}: that day's assigned jobs are different now. Past days must not change (it rewrites streaks) — add a new *_VERSIONS entry in src/schedule.js starting today instead of editing an existing table.`);
    changedPast++;
  }
}
if (changedPast > 5) err(`...and ${changedPast - 5} more past days changed.`);
if (updateHistory) {
  if (changedPast) { console.error("Not updating history while past days differ."); }
  else {
    const start = Object.keys(history.days).sort().pop();
    let d = start ? addDays(new Date(start.replace(/-/g, "/")), 1) : new Date(2025, 6, 27);
    let added = 0;
    for (; d < today; d = addDays(d, 1)) { history.days[S.dateToKey(d)] = dayFingerprint(d); added++; }
    history.note = "Fingerprint of each past day's assigned jobs. Generated by `npm run check -- --update-history`. Do not edit by hand.";
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 0).replace(/,"/g, ',\n"') + "\n");
    console.log(`History: recorded ${added} more day(s) through ${S.dateToKey(addDays(today, -1))}.`);
  }
}

// ---------- Report ----------
const days = Object.keys(history.days).length;
console.log(`Checked ${weeksAhead} weeks ahead (from ${S.dateToKey(firstSunday)}) and ${days} recorded past days.`);
if (warnings.length) {
  console.log(`\n⚠ ${warnings.length} warning(s):`);
  [...new Set(warnings)].forEach(w => console.log("  - " + w));
}
if (errors.length) {
  console.log(`\n✖ ${errors.length} problem(s):`);
  errors.slice(0, 40).forEach(e => console.log("  - " + e));
  if (errors.length > 40) console.log(`  ...and ${errors.length - 40} more`);
  process.exit(1);
}
console.log("\n✔ Schedule looks good.");

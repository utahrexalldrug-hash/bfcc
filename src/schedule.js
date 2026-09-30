// ============================================================
// FAMILY HQ SCHEDULE — everything that decides who does what, and when.
//
// Rotation (weekly jobs), housekeeping charts, laundry, dishes, dinner jobs,
// zones, routines, piano, church clothes, the school/video-game calendar, and
// the date + streak helpers that read them. The UI lives in App.jsx; this file
// has no React and no Firebase, so `npm run check` can test it directly.
//
// HOW TO CHANGE A SCHEDULE (without breaking past streaks or points)
//   Streaks and the Week view re-calculate PAST days from these tables, so
//   don't edit a table that's already been used. Instead add a new entry to
//   its *_VERSIONS list with the date it takes effect ("YYYY-MM-DD"); earlier
//   days keep resolving against the older entry. Versioned today:
//     • WEEKLY_ROTATION_VERSIONS  (Collect/Take Out Trash, Cans, Soap, TP)
//     • HOUSEKEEPING_CHART_VERSIONS
//     • DINNER_JOB_VERSIONS
//   Then run `npm run check` before pushing.
// ============================================================

// Pick the entry in effect on `date` from a list sorted by `start` (oldest first).
export function pickVersion(versions, date) {
  if (!date) return versions[versions.length - 1]; // no date → the current version
  const key = typeof date === "string" ? date : dateToKey(date);
  let current = versions[0];
  for (const v of versions) if (v.start <= key) current = v;
  return current;
}

// ============================================================
// WEEKLY ROTATION — Wednesday jobs (Collect Trash, Take Bins Out, Refill Soap,
// Refill TP) + Bring Cans In on Thursday. Recycling alternates every week
// counted from the original epoch, independent of which version is active.
// ============================================================
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// v1 (legacy): the original 31-week spreadsheet, looped. It had built-in
// conflicts (one kid on both trash jobs some weeks) — kept only so past weeks
// still resolve to what was actually assigned.
export const ROTATION_EPOCH_SUNDAY = new Date("2025-07-27"); // Sunday of first rotation week
export const ROT_COLLECT_TRASH = ["Nicholas","Carter","Cole","Carter","Carter","Cole","Cole","Nicholas","Nicholas","Carter","Cole","Nicholas","Carter","Carter","Cole","Nicholas","Cole","Carter","Cole","Nicholas","Nicholas","Carter","Cole","Nicholas","Carter","Carter","Cole","Nicholas","Cole","Carter","Cole"];
export const ROT_TRASH_OUT = ["Carter","Cole","Nicholas","Carter","Cole","Carter","Carter","Cole","Nicholas","Cole","Carter","Cole","Nicholas","Nicholas","Carter","Cole","Nicholas","Carter","Carter","Cole","Nicholas","Cole","Carter","Cole","Nicholas","Nicholas","Carter","Cole","Nicholas","Carter","Carter"];
export const ROT_BRING_CANS = ["Cole","Nicholas","Finn","Liam","Carter","Carter","Finn","Cole","Carter","Nicholas","Nicholas","Carter","Cole","Finn","Nicholas","Carter","Carter","Cole","Liam","Finn","Carter","Nicholas","Cole","Carter","Cole","Finn","Nicholas","Nicholas","Carter","Cole","Liam"];
export const ROT_REFILL_SOAP = ["Finn","Liam","Carter","Finn","Liam","Finn","Liam","Finn","Cole","Liam","Finn","Liam","Finn","Cole","Finn","Liam","Finn","Liam","Nicholas","Cole","Finn","Liam","Finn","Liam","Carter","Cole","Finn","Liam","Liam","Finn","Finn"];
export const ROT_TOILET_PAPER = ["Liam","Finn","Liam","Cole","Finn","Liam","Cole","Liam","Liam","Finn","Liam","Finn","Liam","Liam","Nicholas","Finn","Liam","Finn","Finn","Carter","Liam","Cole","Liam","Finn","Liam","Finn","Liam","Liam","Finn","Liam","Liam"];
export const ROT_LEN = 31;

// v2: computed so a kid can never get two of these jobs in one week.
//   • Trash crew rotates Collect Trash → Take Bins Out → Bring Cans In (one job each)
//   • Supply crew swaps Refill Soap ↔ Toilet Paper every week
function crewRotation({ trashCrew, supplyCrew }) {
  return (v) => ({
    collectTrash: trashCrew[v % trashCrew.length],
    trashOut: trashCrew[(v + 1) % trashCrew.length],
    bringCansIn: trashCrew[(v + 2) % trashCrew.length],
    refillSoap: supplyCrew[v % supplyCrew.length],
    toiletPaper: supplyCrew[(v + 1) % supplyCrew.length],
  });
}

export const WEEKLY_ROTATION_VERSIONS = [
  {
    start: "2025-07-27",
    note: "Original 31-week spreadsheet (had double-assignments)",
    assign: (v, weekNum) => {
      const idx = ((weekNum % ROT_LEN) + ROT_LEN) % ROT_LEN;
      return {
        collectTrash: ROT_COLLECT_TRASH[idx],
        trashOut: ROT_TRASH_OUT[idx],
        bringCansIn: ROT_BRING_CANS[idx],
        refillSoap: ROT_REFILL_SOAP[idx],
        toiletPaper: ROT_TOILET_PAPER[idx],
      };
    },
  },
  {
    start: "2026-09-27",
    note: "Conflict-free crews: no kid ever gets two weekly jobs",
    assign: crewRotation({ trashCrew: ["Nicholas", "Carter", "Cole"], supplyCrew: ["Finn", "Liam"] }),
  },
];

// Whole weeks between two local-midnight Sundays (Math.round absorbs DST shifts).
function weeksBetween(fromDate, toDate) {
  return Math.round((toDate.getTime() - fromDate.getTime()) / WEEK_MS);
}
function localDateFromKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function getWeeklyRotation(date) {
  const weekStart = getWeekStart(date);
  const weekNum = weeksBetween(ROTATION_EPOCH_SUNDAY, weekStart);
  if (weekNum < 0) return null;
  const version = pickVersion(WEEKLY_ROTATION_VERSIONS, weekStart);
  const v = weeksBetween(localDateFromKey(version.start), weekStart); // weeks into this version
  return {
    date: dateToKey(weekStart),
    recycle: weekNum % 2 === 0,
    ...version.assign(v, weekNum),
  };
}

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ============================================================
// HOUSEKEEPING CHARTS (6 rotating weekly, Mon/Tue/Wed/Thu only)
// ============================================================
const HOUSEKEEPING_CHARTS_V1 = [
  { // Chart 1
    name: "Chart 1",
    tasks: {
      Monday: "Bathroom counter/sink",
      Tuesday: "Dust windowsills / shelves / bookcase",
      Wednesday: "Pick up upstairs hallway for Roborock",
      Thursday: "Wipe light switches",
      Saturday: "Vacuum upstairs stairs",
    },
    zone: "Coat closet/stairs/upstairs hallway — pick up and put away any loose items, tell dad so he can set the vacuums loose",
  },
  { // Chart 2
    name: "Chart 2",
    tasks: {
      Monday: "Toilet",
      Tuesday: "Dust banister/wipe down handrail (dry after wet), empty trashes",
      Wednesday: "Pick up front hallway for Roborock",
      Thursday: "Wipe doorknobs",
      Saturday: "Vacuum downstairs stairs",
    },
    zone: "Office/Front hallway — pick up floor, straighten desk/piano/front hallway piece, tell dad so he can set the vacuums loose",
  },
  { // Chart 3
    name: "Chart 3",
    tasks: {
      Monday: "Tub",
      Tuesday: "Dust pieces (TV stand, front hall piece, piano, printer table), put garbage bags in cans",
      Wednesday: "Pick up kitchen for Roborock",
      Thursday: "Wipe microwave/dishwasher",
      Saturday: "Mop kids bathroom floor",
    },
    zone: "Kitchen — pick up floor, countertops, tell dad so he can set the vacuums loose",
  },
  { // Chart 4
    name: "Chart 4",
    tasks: {
      Monday: "Mirror/Refill toilet paper (all bathrooms)/refill soaps (whole house)",
      Tuesday: "Dust baseboards",
      Wednesday: "Pick up family room for Roborock",
      Thursday: "Wipe oven/fridge",
      Saturday: "Mop main level bathroom floor",
    },
    zone: "Family Room + laundry area/garage entry — pick up floor, clean off TV piece, straighten laundry/garage entry, tell dad so he can set the vacuums loose",
  },
  { // Chart 5
    name: "Chart 5",
    tasks: {
      Monday: "Clean floor / wipe bathroom cabinets",
      Tuesday: "Dust shelves/surfaces",
      Wednesday: "Move chairs for Roborock",
      Thursday: "Wipe dishwasher",
      Saturday: "Pick up basement so vacuum can run",
    },
    zone: "Bathroom(s) — pick up and wipe down",
  },
];

// Returns a copy of `charts` with `patch` applied. Patch shape:
//   { "Chart 5": { tasks: { Thursday: null, Monday: "New text" }, zone: "..." } }
// A null task removes that day's task for that chart.
function editCharts(charts, patch) {
  return charts.map(chart => {
    const p = patch[chart.name];
    if (!p) return chart;
    const tasks = { ...chart.tasks };
    Object.entries(p.tasks || {}).forEach(([day, text]) => { if (text === null) delete tasks[day]; else tasks[day] = text; });
    return { ...chart, ...p, tasks };
  });
}

export const HOUSEKEEPING_CHART_VERSIONS = [
  { start: "2025-07-27", charts: HOUSEKEEPING_CHARTS_V1 },
  {
    start: "2026-09-29",
    note: "Chart 5 Thursday: 'Wipe dishwasher' (Chart 3 already does it) replaced by laundry/garage entry, moved out of Chart 4's Tidy Up so Chart 4 is just the Family Room",
    charts: editCharts(HOUSEKEEPING_CHARTS_V1, {
      "Chart 4": { zone: "Family Room — pick up floor, clean off TV piece, tell dad so he can set the vacuums loose" },
      "Chart 5": { tasks: { Thursday: "Straighten laundry area & garage entry" } },
    }),
  },
];

// Laundry days are fixed per kid (do not rotate with charts)
export const LAUNDRY_DAYS = {
  Nicholas: "Monday",
  Carter: "Tuesday",
  Cole: "Wednesday",
  Finn: "Thursday",
  Liam: "Friday",
};


// ============================================================
// SCHOOL CALENDAR & VIDEO GAME DAY RULES
// Video games only on Fri/Sat during school + specific days off.
// Summer TBD. Update these dates each school year.
// ============================================================
export const SCHOOL_CALENDAR = {
  schoolEndDate: "2026-05-22",       // Last day of school
  schoolStartDate: "2026-08-19",     // First day of next school year
  daysOff: [                         // Specific days off during school year
    "2026-03-09",
    "2026-03-23",
    "2026-04-06", "2026-04-07", "2026-04-08", "2026-04-09", "2026-04-10",
  ],
  summerRules: "unrestricted",       // "unrestricted" | "weekends_only" | "custom" — change for summer policy
};

export function isVideoGameDay(date) {
  const dk = dateToKey(date);
  const dayNum = date.getDay(); // 0=Sun, 5=Fri, 6=Sat

  // Check if it's a school day-off
  if (SCHOOL_CALENDAR.daysOff.includes(dk)) return true;

  // Check if we're in summer break
  const endDate = new Date(SCHOOL_CALENDAR.schoolEndDate + "T00:00:00");
  const startDate = new Date(SCHOOL_CALENDAR.schoolStartDate + "T00:00:00");
  const checkDate = new Date(dk + "T00:00:00");

  if (checkDate > endDate && checkDate < startDate) {
    // Summer break — apply summer rules
    if (SCHOOL_CALENDAR.summerRules === "unrestricted") return true;
    if (SCHOOL_CALENDAR.summerRules === "weekends_only") return dayNum === 5 || dayNum === 6;
    return true; // default unrestricted
  }

  // During school year: Friday and Saturday only
  return dayNum === 5 || dayNum === 6;
}

// ============================================================
// LEGACY DAILY CHORES (dates before SCHEDULE_V2_START)
// Kept verbatim so historical completions and streaks still resolve against the
// schedule that was actually in force on those days. Do not edit — edit the v2
// tables below instead.
// ============================================================
export const LEGACY_DAILY_CHORES = {
  Nicholas: { Sunday:{type:"none",zone:null,dinnerJob:null},Monday:{type:"zone",zone:"Office/Front Hall",dinnerJob:"Clear Table"},Tuesday:{type:"none",zone:null,dinnerJob:null},Wednesday:{type:"dishes",zone:null,dinnerJob:null},Thursday:{type:"zone",zone:"Kitchen Floor",dinnerJob:"Sweep"},Friday:{type:"zone",zone:"Office/Front Hall",dinnerJob:"Clear Table"},Saturday:{type:"zone",zone:"Office/Front Hall",dinnerJob:"Clear Table"} },
  Carter: { Sunday:{type:"zone",zone:"Family Room/Vacuum",dinnerJob:"Take Out Trash"},Monday:{type:"dishes",zone:null,dinnerJob:null},Tuesday:{type:"zone",zone:"Kitchen Floor",dinnerJob:"Sweep"},Wednesday:{type:"zone",zone:"Office/Front Hall",dinnerJob:"Clear Table"},Thursday:{type:"zone",zone:"Family Room/Vacuum",dinnerJob:"Take Out Trash"},Friday:{type:"dishes",zone:null,dinnerJob:null},Saturday:{type:"zone",zone:"Kitchen Floor",dinnerJob:"Sweep"} },
  Cole: { Sunday:{type:"zone",zone:"Office/Front Hall",dinnerJob:"Clear Table"},Monday:{type:"zone",zone:"Kitchen Floor",dinnerJob:"Sweep"},Tuesday:{type:"dishes",zone:null,dinnerJob:null},Wednesday:{type:"none",zone:null,dinnerJob:null},Thursday:{type:"zone",zone:"Office/Front Hall",dinnerJob:"Clear Table"},Friday:{type:"zone",zone:"Kitchen Floor",dinnerJob:"Sweep"},Saturday:{type:"dishes",zone:null,dinnerJob:null} },
  Finn: { Sunday:{type:"young",task:"Set Table/Stairs"},Monday:{type:"young",task:"Help with Dishes/Upstairs Hallway"},Tuesday:{type:"young",task:"Set Table/Stairs"},Wednesday:{type:"young",task:"Help with Dishes/Upstairs Hallway"},Thursday:{type:"young",task:"Load Dishes"},Friday:{type:"young",task:"Help with Dishes/Upstairs Hallway"},Saturday:{type:"young",task:"Set Table/Stairs"} },
  Liam: { Sunday:{type:"young",task:"Help with Dishes/Upstairs Hallway"},Monday:{type:"young",task:"Set Table/Stairs"},Tuesday:{type:"young",task:"Help with Dishes/Upstairs Hallway"},Wednesday:{type:"young",task:"Set Table/Stairs"},Thursday:{type:"young",task:"Load Dishes"},Friday:{type:"young",task:"Set Table/Stairs"},Saturday:{type:"young",task:"Help with Dishes/Upstairs Hallway"} },
};

// ============================================================
// SCHEDULE v2 — dinner jobs, dishes and zones are now three INDEPENDENT
// rotations. Previously the dinner job rode along with the cleaning zone, so
// any kid on dishes silently lost his dinner job — which left the nightly trash
// uncovered 5 nights a week. Effective SCHEDULE_V2_START; earlier dates still
// resolve against LEGACY_DAILY_CHORES so history and streaks stay intact.
// ============================================================
export const SCHEDULE_V2_START = "2026-08-14"; // live today — school starts Aug 19

// Who's on dishes each day. Sunday rotates through every kid week by week
// (see SUNDAY_DISH_ROTATION) so nobody permanently owns or dodges it.
export const DISH_DUTY = {
  Monday: ["Carter"], Tuesday: ["Cole"], Wednesday: ["Nicholas"],
  Thursday: ["Finn", "Liam"], Friday: ["Carter"], Saturday: ["Cole"],
};
export const SUNDAY_DISH_ROTATION = ["Nicholas", "Carter", "Cole", "Finn", "Liam"];

export function getDishDutyFor(date) {
  const dn = getDayName(date);
  if (dn === "Sunday") {
    const wk = getWeekNumber(date);
    const i = ((wk % SUNDAY_DISH_ROTATION.length) + SUNDAY_DISH_ROTATION.length) % SUNDAY_DISH_ROTATION.length;
    return [SUNDAY_DISH_ROTATION[i]];
  }
  return DISH_DUTY[dn] || [];
}

// Dishes is two halves: unload in the morning, load in the evening. On school
// days they're labelled by time of day; on weekends it's just both jobs.
// 1 point each, so the day is still worth the same 2 points it always was.
export const DISH_TASKS = [
  { id: "dishes_unload", school: "Unload Dishwasher (morning)", weekend: "Unload Dishwasher" },
  { id: "dishes_load",   school: "Load Dishwasher (evening)",   weekend: "Load Dishwasher" },
];
export function isSchoolDayForDishes(date) {
  const d = date.getDay();
  return d >= 1 && d <= 5; // Mon-Fri
}
export function getDishChores(date) {
  const school = isSchoolDayForDishes(date);
  return DISH_TASKS.map(t => ({ id: t.id, text: school ? t.school : t.weekend }));
}

// The four nightly dinner jobs. Every job is filled every night.
// Thursday: Finn and Liam are both on dishes, so Carter sets the table.
export const DINNER_JOB_IDS = {
  "Clear Table": "dinner_clear",
  "Take Out Trash": "dinner_trash",
  "Floor Pickup": "dinner_floor",
  "Set Table": "dinner_table",
};
// What the kids actually read. Keys above stay stable so the rotation tables
// below don't have to change when we reword a job.
export const DINNER_JOB_LABELS = {
  "Clear Table": "Clear Table, Clear & Wipe Down Countertops",
  "Take Out Trash": "Take Out Trash",
  "Floor Pickup": "Floor Pickup",
  "Set Table": "Set Table",
};
// Dinner jobs by day of the week (they rotate day to day, not week to week).
// Rule: nobody gets a dinner job on his dishes night (Sunday excepted, since
// Sunday dishes rotate) and nobody takes out trash two nights in a row —
// `npm run check` enforces both.
export const DINNER_JOB_VERSIONS = [
  {
    start: "2026-08-14",
    note: "School-year table (gave Carter trash Tue+Wed and Cole Sun+Mon)",
    jobs: {
      Sunday:    { "Clear Table": "Carter",   "Take Out Trash": "Cole",     "Floor Pickup": "Nicholas", "Set Table": "Finn" },
      Monday:    { "Clear Table": "Nicholas", "Take Out Trash": "Cole",     "Floor Pickup": "Finn",     "Set Table": "Liam" },
      Tuesday:   { "Clear Table": "Liam",     "Take Out Trash": "Carter",   "Floor Pickup": "Nicholas", "Set Table": "Finn" },
      Wednesday: { "Clear Table": "Finn",     "Take Out Trash": "Carter",   "Floor Pickup": "Cole",     "Set Table": "Liam" },
      Thursday:  { "Clear Table": "Cole",     "Take Out Trash": "Nicholas", "Floor Pickup": "Carter",   "Set Table": "Carter" },
      Friday:    { "Clear Table": "Nicholas", "Take Out Trash": "Cole",     "Floor Pickup": "Liam",     "Set Table": "Finn" },
      Saturday:  { "Clear Table": "Finn",     "Take Out Trash": "Nicholas", "Floor Pickup": "Carter",   "Set Table": "Liam" },
    },
  },
  {
    start: "2026-09-29",
    note: "No back-to-back trash: Sun Carter↔Cole (Trash/Clear), Tue Nicholas↔Carter (Trash/Floor)",
    jobs: {
      Sunday:    { "Clear Table": "Cole",     "Take Out Trash": "Carter",   "Floor Pickup": "Nicholas", "Set Table": "Finn" },
      Monday:    { "Clear Table": "Nicholas", "Take Out Trash": "Cole",     "Floor Pickup": "Finn",     "Set Table": "Liam" },
      Tuesday:   { "Clear Table": "Liam",     "Take Out Trash": "Nicholas", "Floor Pickup": "Carter",   "Set Table": "Finn" },
      Wednesday: { "Clear Table": "Finn",     "Take Out Trash": "Carter",   "Floor Pickup": "Cole",     "Set Table": "Liam" },
      Thursday:  { "Clear Table": "Cole",     "Take Out Trash": "Nicholas", "Floor Pickup": "Carter",   "Set Table": "Carter" },
      Friday:    { "Clear Table": "Nicholas", "Take Out Trash": "Cole",     "Floor Pickup": "Liam",     "Set Table": "Finn" },
      Saturday:  { "Clear Table": "Finn",     "Take Out Trash": "Nicholas", "Floor Pickup": "Carter",   "Set Table": "Liam" },
    },
  },
];

// Cleaning zones now rotate on their own, so every zone is covered all 7 nights
// regardless of who has dishes.
export const ZONE_KIDS = ["Nicholas", "Carter", "Cole"];
export const ZONE_NAMES = ["Office/Front Hall", "Family Room/Vacuum", "Kitchen Floor"];
export const YOUNG_ZONE_KIDS = ["Finn", "Liam"];
export const YOUNG_ZONE_NAMES = ["Stairs", "Upstairs Hallway"];

export function getZoneForDate(member, date) {
  const oi = ZONE_KIDS.indexOf(member);
  if (oi >= 0) return ZONE_NAMES[(oi + date.getDay()) % ZONE_NAMES.length];
  const yi = YOUNG_ZONE_KIDS.indexOf(member);
  if (yi >= 0) return YOUNG_ZONE_NAMES[(yi + date.getDay()) % YOUNG_ZONE_NAMES.length];
  return null;
}

export function getDinnerJobsFor(member, dayName, date) {
  const table = pickVersion(DINNER_JOB_VERSIONS, date).jobs[dayName] || {};
  return Object.entries(table)
    .filter(([, who]) => who === member)
    .map(([job]) => ({ job, id: DINNER_JOB_IDS[job] }));
}

// Normalized daily assignment for a member on a date. Handles the legacy
// schedule for pre-cutover dates so old streaks don't retroactively break.
export function getDailyAssignment(member, date) {
  const dn = getDayName(date);
  if (dateToKey(date) < SCHEDULE_V2_START) {
    const d = LEGACY_DAILY_CHORES[member]?.[dn];
    if (!d) return null;
    if (d.type === "dishes") return { legacy: true, dishes: true, dinnerJobs: [], zone: null, youngTasks: [] };
    if (d.type === "zone")   return { legacy: true, dishes: false, dinnerJobs: d.dinnerJob ? [{ job: d.dinnerJob, id: "dinner" }] : [], zone: d.zone, youngTasks: [] };
    if (d.type === "young")  return { legacy: true, dishes: false, dinnerJobs: [], zone: null, youngTasks: d.task.split("/").map(s => s.trim()) };
    return { legacy: true, dishes: false, dinnerJobs: [], zone: null, youngTasks: [] };
  }
  return {
    legacy: false,
    dishes: getDishDutyFor(date).includes(member),
    dinnerJobs: getDinnerJobsFor(member, dn, date),
    zone: getZoneForDate(member, date),
    youngTasks: [],
  };
}

// ============================================================
// PRIORITY ("no-miss") CHORES
// These are the weekly rotation jobs that only come around once a week — if
// they're skipped nobody else picks them up and the whole house notices. They
// get a MUST DO badge, sort to the top of the list, and surface on the collapsed
// card header so a kid can't miss one without opening their card.
// ============================================================
export const PRIORITY_CHORE_IDS = new Set([
  "w_trash",     // Collect Trash (all rooms) — Wednesday
  "w_trashout",  // Take Bins Out — Wednesday
  "w_soap",      // Refill Soap — Wednesday
  "w_tp",        // Refill Toilet Paper — Wednesday
  "w_cans",      // Bring Cans In — Thursday (carries to Friday)
]);
export function isPriorityChore(choreId) { return PRIORITY_CHORE_IDS.has(choreId); }


// ============================================================
// DAILY ROUTINES (morning / bedtime checklists)
// All-or-nothing: individual items are worth 0 points; completing every item
// in a routine awards ROUTINE_BONUS. Unchecking any item takes the bonus back.
// Item chore IDs are `rt_<key>_<index>` — the bonus record is `rt_<key>_bonus`.
// ============================================================
export const ROUTINE_MEMBERS = ["Finn", "Liam"];
export const ROUTINE_BONUS = 2;
// Routine items only count as "due" (for streaks) on or after this date, so
// turning routines on doesn't retroactively break existing streaks.
export const ROUTINES_START = "2026-08-14";

export const ROUTINES = [
  {
    key: "morning",
    label: "Morning",
    icon: "☀️",
    days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    items: ["Get Dressed", "Get Lunch", "Get Shoes", "Pack Backpack"],
  },
  {
    key: "night",
    label: "Bedtime",
    icon: "\u{1F319}",
    days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"],
    items: ["Get Jammied", "Brush Teeth", "Set Out Clothes for Tomorrow"],
  },
  {
    key: "night",
    label: "Bedtime",
    icon: "\u{1F319}",
    days: ["Friday", "Saturday"],
    items: ["Get Jammied", "Brush Teeth"],
  },
];

// Returns [{key, label, icon, bonus, items:[{id,text}]}] for a member on a date.
export function getRoutinesForDate(member, date) {
  if (!ROUTINE_MEMBERS.includes(member)) return [];
  if (dateToKey(date) < ROUTINES_START) return [];
  const dn = getDayName(date);
  return ROUTINES.filter(r => r.days.includes(dn)).map(r => ({
    key: r.key,
    label: r.label,
    icon: r.icon,
    bonus: ROUTINE_BONUS,
    items: r.items.map((text, i) => ({ id: `rt_${r.key}_${i}`, text })),
  }));
}

// Given a chore ID, find the routine it belongs to (or null).
export function getRoutineForItemId(member, date, choreId) {
  if (typeof choreId !== "string" || !choreId.startsWith("rt_")) return null;
  return getRoutinesForDate(member, date).find(r => r.items.some(it => it.id === choreId)) || null;
}

// ============================================================
// SATURDAY MORNING — find church clothes for Sunday
// Nicholas handles his own; the other four get the reminder.
// ============================================================
export const CHURCH_CLOTHES_KIDS = ["Carter", "Cole", "Finn", "Liam"];

export function hasChurchClothesOnDate(member, date) {
  return CHURCH_CLOTHES_KIDS.includes(member)
    && date.getDay() === 6 // Saturday
    && dateToKey(date) >= SCHEDULE_V2_START;
}

// ============================================================
// DAILY PRACTICE — piano, every day
// ============================================================
export const PIANO_MEMBERS = ["Cole", "Liam"];
export const PIANO_START = "2026-08-14"; // same grandfathering rule as routines

export function hasPianoOnDate(member, date) {
  return PIANO_MEMBERS.includes(member) && dateToKey(date) >= PIANO_START;
}

export const FAMILY_MEMBERS = [
  { name: "Nicholas", color: "#E85D4A", emoji: "\u{1F985}", group: "older" },
  { name: "Carter", color: "#3B82F6", emoji: "\u26A1", group: "older" },
  { name: "Cole", color: "#10B981", emoji: "\u{1F3AF}", group: "older" },
  { name: "Finn", color: "#F59E0B", emoji: "\u{1F31F}", group: "younger" },
  { name: "Liam", color: "#8B5CF6", emoji: "\u{1F680}", group: "younger" },
];

export function getToday() { return new Date(); }
export function getDayName(date) { return DAYS[date.getDay()]; }
export function formatDate(date) { return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }); }
export function getWeekStart(date) { const d = new Date(date); d.setDate(d.getDate() - d.getDay()); d.setHours(0,0,0,0); return d; }
export function dateToKey(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; }

export function getCurrentWeekRotation(date) {
  return getWeeklyRotation(date);
}

// Week number since a fixed epoch (for determining individual vs team weeks)
export function getWeekNumber(date) {
  const epoch = new Date("2025-07-27"); // A Sunday
  const weekStart = getWeekStart(date);
  return Math.floor((weekStart.getTime() - epoch.getTime()) / (7 * 24 * 60 * 60 * 1000));
}

export function isTeamWeek(date) {
  return false; // teams retired May 2026 — everyone competes individually
}

// Get the housekeeping chart assigned to a member for a given date's week
export function getChartAssignment(memberName, date) {
  const weekNum = getWeekNumber(date);
  const memberIndex = FAMILY_MEMBERS.findIndex(m => m.name === memberName);
  const chartIndex = ((memberIndex + weekNum) % 5 + 5) % 5;
  return pickVersion(HOUSEKEEPING_CHART_VERSIONS, date).charts[chartIndex];
}

// Check if a given Saturday is a mop Saturday (every other Saturday)
// Uses week number: even weeks = mop Saturday
export function isMopSaturday(date) {
  const weekNum = getWeekNumber(date);
  return weekNum % 2 === 0;
}

// Get incomplete housekeeping tasks from the current week (for Saturday catch-up)
export function getIncompleteHousekeepingTasks(member, date, completedChores) {
  const weekStart = getWeekStart(date);
  const chart = getChartAssignment(member, date);
  const incomplete = [];
  const housekeepingDays = ["Monday", "Tuesday", "Wednesday", "Thursday"];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    const dn = getDayName(d);
    if (!housekeepingDays.includes(dn)) continue;
    const dk = dateToKey(d);
    const task = chart.tasks[dn];
    if (task && !completedChores[`${dk}_${member}_hk_${dn.toLowerCase()}`]) {
      incomplete.push({ day: dn, task });
    }
  }
  return incomplete;
}


export function getWeekStartKey(date) { return dateToKey(getWeekStart(date)); }
export function getMonthKey(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`; }
export function getYearKey(date) { return `${date.getFullYear()}`; }

// Get daily chores that are due TODAY for a member (excludes weekly chores without specific due days)
// Single source of truth: what chore IDs are due for a member on a given date.
// Used by both UI rendering (getChoresForDate decorates these with text/tags) and
// by streak math. KEEP THIS IN SYNC with getChoresForDate inside App.
export function getDailyDueChores(member, date, customTasks, completedChores) {
  const dayName = getDayName(date);
  const dk = dateToKey(date);
  const daily = getDailyAssignment(member, date);
  const chores = [];
  if (!daily) return chores;
  if (daily.dishes) {
    if (daily.legacy) chores.push("dishes");
    else getDishChores(date).forEach(t => chores.push(t.id));
  }
  if (daily.zone) chores.push("zone");
  daily.dinnerJobs.forEach(dj => chores.push(dj.id));
  daily.youngTasks.forEach((_, i) => chores.push(`task_${i}`));
  // Daily routines (morning / bedtime) — every item counts toward the streak
  getRoutinesForDate(member, date).forEach(r => r.items.forEach(it => chores.push(it.id)));
  // Saturday morning: find church clothes for Sunday
  if (hasChurchClothesOnDate(member, date)) chores.push("church_clothes");
  // Daily piano practice
  if (hasPianoOnDate(member, date)) chores.push("piano");
  // Weekly rotation
  const weekRotation = getCurrentWeekRotation(date);
  if (weekRotation && dayName === "Wednesday") {
    if (weekRotation.collectTrash === member) chores.push("w_trash");
    if (weekRotation.trashOut === member) chores.push("w_trashout");
    if (weekRotation.refillSoap === member) chores.push("w_soap");
    if (weekRotation.toiletPaper === member) chores.push("w_tp");
  }
  // Bring Cans In: Thursday primary, carries to Friday if not done Thursday
  if (weekRotation && weekRotation.bringCansIn === member) {
    if (dayName === "Thursday") chores.push("w_cans");
    else if (dayName === "Friday" && completedChores) {
      const thuDate = new Date(date); thuDate.setDate(thuDate.getDate() - 1);
      const thuKey = dateToKey(thuDate);
      if (!completedChores[`${thuKey}_${member}_w_cans`]) chores.push("w_cans");
    }
  }
  // Housekeeping
  if (dayName !== "Sunday" && dayName !== "Friday") {
    const chart = getChartAssignment(member, date);
    if (dayName === "Saturday") {
      if (isMopSaturday(date)) chores.push("hk_mop");
      if (chart.tasks["Saturday"]) chores.push("hk_saturday");
    } else {
      if (chart.tasks[dayName]) chores.push(`hk_${dayName.toLowerCase()}`);
      chores.push("hk_zone");
    }
  }
  // Laundry
  if (LAUNDRY_DAYS[member] === dayName) chores.push("laundry");
  // Custom tasks assigned for this date
  if (customTasks && !customTasks._empty) {
    Object.entries(customTasks).forEach(([k, t]) => {
      if (k !== "_empty" && t && t.assignee === member && t.date === dk) {
        chores.push(`custom_${k}`);
      }
    });
  }
  return chores;
}

// A chore counts toward streak only if completed on the same calendar day it was due.
// completedChores values can be `true` (legacy) or `{ts, pts}`. `true` is treated as
// on-time for grandfathering; new completions use the timestamp object.
export function isCompletedOnTime(record, dueDateKey) {
  if (!record) return false;
  if (record === true) return true; // legacy
  if (typeof record === "object" && record.ts) {
    // Convert ts to America/Denver date key
    const d = new Date(record.ts);
    const tsKey = d.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    return tsKey === dueDateKey;
  }
  return false;
}

// Bounded full recalc. No cache — runs in <5ms for 90 days × 5 kids.
// Streak = consecutive days ending today (or yesterday if today not yet done) where
// every due chore was completed on-day.
export function calculateStreak(member, completedChores, today, customTasks) {
  let streak = 0;
  const d = new Date(today);
  for (let i = 0; i < 90; i++) {
    const checkDate = new Date(d);
    checkDate.setDate(d.getDate() - i);
    const dk = dateToKey(checkDate);
    const dueChores = getDailyDueChores(member, checkDate, customTasks, completedChores);
    if (dueChores.length === 0) continue;
    const allOnTime = dueChores.every(choreId => isCompletedOnTime(completedChores[`${dk}_${member}_${choreId}`], dk));
    if (allOnTime) streak++;
    else {
      // Today not done? Don't break the streak — kid still has time
      if (i === 0) continue;
      break;
    }
  }
  return streak;
}

export const STREAK_MILESTONES = [3, 7, 14, 30, 50, 100];

// ============================================================
// TODAY LAYOUT — time-of-day groups + short titles
// Kids work through the day in this order, so the Today card lists chores the
// same way. Long chart text becomes a short title; the full instructions are
// one tap away (the ⓘ button) instead of filling the card.
// ============================================================
export const CHORE_TIME_GROUPS = [
  { key: "morning", label: "Morning", icon: "☀️" },
  { key: "day", label: "After School", icon: "🎒", weekendLabel: "During the Day", weekendIcon: "🏠" },
  { key: "dinner", label: "After Dinner", icon: "🍽️" },
];
export function getChoreTimeOfDay(chore) {
  if (chore.id === "dishes_unload" || chore.id === "church_clothes") return "morning";
  if (chore.id === "dishes_load" || chore.id === "dishes" || chore.id === "zone" || chore.tag === "dinner") return "dinner";
  return "day";
}
export const SHORT_TITLE_MAX = 40;
export function shortenChoreText(text) {
  if (!text || text.length <= SHORT_TITLE_MAX) return { text };
  let cut = -1;
  for (const sep of [" — ", " (", ", "]) {
    const i = text.indexOf(sep);
    if (i > 8 && (cut < 0 || i < cut)) cut = i;
  }
  if (cut < 0) return { text };
  return { text: text.slice(0, cut).trim(), details: text };
}
export function capitalizeFirst(str) { return str ? str.charAt(0).toUpperCase() + str.slice(1) : str; }

// ============================================================
// A KID'S CHORE LIST FOR ONE DAY — what the Today card shows (with text, tags,
// time-of-day group, priority). Pure function: the app calls it for the
// screens, and api/remind.js calls it for the 6pm reminders, so they always
// agree. (getDailyDueChores above is the id-only version used for streaks.)
// ============================================================
export function buildChoreList(member, date, customTasks, completedChores) {
  const dn = getDayName(date);
  const dk = dateToKey(date);
  const daily = getDailyAssignment(member, date);
  const chores = [];
  if (!daily) return chores;
  if (daily.dishes) {
    if (daily.legacy) chores.push({ id: "dishes", text: "Dishes", tag: "dishes", pointValue: 2 });
    else getDishChores(date).forEach(t => chores.push({ id: t.id, text: t.text, tag: "dishes", pointValue: 1 }));
  }
  if (daily.zone) chores.push({ id: "zone", text: `After-Dinner Zone: ${daily.zone}`, tag: "zone", pointValue: 1 });
  daily.dinnerJobs.forEach(dj => {
    chores.push({ id: dj.id, text: `Dinner: ${DINNER_JOB_LABELS[dj.job] || dj.job}`, tag: "dinner", pointValue: 1 });
  });
  daily.youngTasks.forEach((t, i) => { chores.push({ id: `task_${i}`, text: t, tag: "young", pointValue: 1 }); });
  // Daily routines — items are 0 pts each; the routine bonus is awarded when
  // every item is checked (see toggleChoreForDate). `routine` marks the key so
  // TodayView can pull them out into their own cards.
  getRoutinesForDate(member, date).forEach(r => {
    r.items.forEach(it => {
      chores.push({ id: it.id, text: it.text, tag: "routine", pointValue: 0, routine: r.key, routineLabel: r.label, routineIcon: r.icon, routineBonus: r.bonus });
    });
  });
  // Saturday morning: find church clothes for Sunday
  if (hasChurchClothesOnDate(member, date)) {
    chores.push({ id: "church_clothes", text: "Find Church Clothes for Sunday (morning)", tag: "church", pointValue: 1 });
  }
  // Daily piano practice
  if (hasPianoOnDate(member, date)) {
    chores.push({ id: "piano", text: "Practice Piano", tag: "practice", pointValue: 1 });
  }
  const rot = getCurrentWeekRotation(date);
  if (rot) {
    // Collect Trash, Take Bins Out, Refill Soap, Refill TP — Wednesday only
    if (dn === "Wednesday") {
      if (rot.collectTrash === member) chores.push({ id: "w_trash", text: "Collect Trash (all rooms)", tag: "weekly", pointValue: 1 });
      if (rot.trashOut === member) chores.push({ id: "w_trashout", text: `Take Bins Out${rot.recycle ? " + Recycling" : ""}`, tag: "weekly", pointValue: 1 });
      if (rot.refillSoap === member) chores.push({ id: "w_soap", text: "Refill Soap", tag: "weekly", pointValue: 1 });
      if (rot.toiletPaper === member) chores.push({ id: "w_tp", text: "Refill Toilet Paper", tag: "weekly", pointValue: 1 });
    }
    // Bring Cans In — Thursday, carries over to Friday if not done
    if (rot.bringCansIn === member) {
      if (dn === "Thursday") {
        chores.push({ id: "w_cans", text: "Bring Cans In", tag: "weekly", pointValue: 1 });
      } else if (dn === "Friday") {
        // Check if it was completed Thursday — if not, carry over
        const thuDate = new Date(date);
        thuDate.setDate(thuDate.getDate() - 1);
        const thuKey = dateToKey(thuDate);
        const thuDone = !!completedChores[`${thuKey}_${member}_w_cans`];
        if (!thuDone) {
          chores.push({ id: "w_cans", text: "Bring Cans In (carried over!)", tag: "weekly", pointValue: 1 });
        }
      }
    }
  }

  // Housekeeping chart tasks
  const chart = getChartAssignment(member, date);
  if (dn !== "Sunday" && dn !== "Friday") {
    if (dn === "Saturday") {
      if (isMopSaturday(date)) {
        chores.push({ id: "hk_mop", text: "Mop kitchen & bathrooms", tag: "housekeeping", pointValue: 1 });
      }
      // Saturday chart task (stairs, bathroom mopping, etc.)
      const satTask = chart.tasks["Saturday"];
      if (satTask) {
        chores.push({ id: "hk_saturday", text: satTask, tag: "housekeeping", pointValue: 1 });
      }
      const incomplete = getIncompleteHousekeepingTasks(member, date, completedChores);
      incomplete.forEach(item => {
        chores.push({ id: `hk_catchup_${item.day.toLowerCase()}`, text: `Catch-up: ${item.task} (${item.day})`, tag: "housekeeping", pointValue: 1 });
      });
    } else {
      const hkTask = chart.tasks[dn];
      if (hkTask) {
        chores.push({ id: `hk_${dn.toLowerCase()}`, text: hkTask, tag: "housekeeping", pointValue: 1 });
      }
    }
    if (dn !== "Saturday") {
      const [zoneName, ...zoneRest] = chart.zone.split(" — ");
      chores.push({ id: "hk_zone", text: `Tidy Up: ${zoneName}`, details: zoneRest.length ? capitalizeFirst(zoneRest.join(" — ")) : undefined, tag: "housekeeping", pointValue: 1 });
    }
  }

  // Laundry day
  if (LAUNDRY_DAYS[member] === dn) {
    chores.push({ id: "laundry", text: "Laundry Day! (wash, dry, fold, put away)", tag: "laundry", pointValue: 1 });
  }

  // Custom tasks for this date
  if (customTasks && !customTasks._empty) {
    Object.entries(customTasks)
      .filter(([key, task]) => key !== "_empty" && task && task.assignee === member && task.date === dk)
      .forEach(([key, task]) => {
        chores.push({ id: `custom_${key}`, taskKey: key, text: task.description, tag: "custom", pointValue: task.points || 1 });
      });
  }
  // Flag the once-a-week no-miss jobs and float them to the top of the list.
  chores.forEach(c => {
    if (isPriorityChore(c.id)) c.priority = true;
    if (!c.routine && !c.details) Object.assign(c, shortenChoreText(c.text));
    c.when = getChoreTimeOfDay(c);
  });
  chores.sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0));
  return chores;
}

// ============================================================
// DATE NIGHT — each week one kid goes out with Mom & Dad.
// Order is youngest → oldest. A week "counts" once a parent taps "We've
// scheduled it"; if a week passes without that (or they mark "It didn't
// happen"), the same kid keeps the turn the next week — nobody gets skipped.
// Records live in the synced Firestore doc family/dateNights, keyed by the
// week's Sunday: { "2026-09-27": { kid, status: "scheduled" | "missed", day } }
// ============================================================
export const DATE_NIGHT_ORDER = ["Liam", "Finn", "Cole", "Carter", "Nicholas"];
export const DATE_NIGHT_START = { week: "2026-09-27", kid: "Cole" };

export function dateNightHappened(record) {
  return !!record && record.status === "scheduled";
}

// Whose date week is it for the week containing `date`?
// Returns { weekKey, kid, upNext, record, carriedOver } or null before the start.
export function getDateNight(date, records = {}) {
  const weekKey = dateToKey(getWeekStart(date));
  if (weekKey < DATE_NIGHT_START.week) return null;
  const n = DATE_NIGHT_ORDER.length;
  let idx = DATE_NIGHT_ORDER.indexOf(DATE_NIGHT_START.kid);
  let carriedOver = false;
  for (let w = localDateFromKey(DATE_NIGHT_START.week); dateToKey(w) < weekKey; w.setDate(w.getDate() + 7)) {
    if (dateNightHappened(records[dateToKey(w)])) { idx = (idx + 1) % n; carriedOver = false; }
    else carriedOver = true;
  }
  return { weekKey, kid: DATE_NIGHT_ORDER[idx], upNext: DATE_NIGHT_ORDER[(idx + 1) % n], record: records[weekKey] || null, carriedOver };
}

// ============================================================
// MONTHLY WORK HOURS — kids who owe a set amount of work time each month.
// Entries live in the synced Firestore doc family/workLogs:
//   { "<id>": { kid, date: "YYYY-MM-DD", minutes, note, loggedAt, by } }
// The balance carries both ways: a short month adds to next month's target,
// extra time counts as credit. Time logged before `start` is credit toward
// the first month. Add another kid with one line here.
// ============================================================
export const MONTHLY_WORK = {
  // cashRate: $ per extra hour when a kid cashes out credit instead of rolling it over
  Cole: { hours: 12, start: "2026-10", cashRate: 12 },
};

export function addMonths(monthKey, n) {
  let [y, m] = monthKey.split("-").map(Number);
  m += n;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

export function formatMinutes(total) {
  const m = Math.round(total);
  const h = Math.floor(m / 60), r = m % 60;
  if (h && r) return `${h}h ${r}m`;
  if (h) return `${h}h`;
  return `${r}m`;
}

// Everything the work-hours screen and reminders need for one kid + month.
// Minutes throughout. carryIn > 0 = credit from earlier, < 0 = still owed.
// Cash-outs live in Firestore family/workCashouts:
//   { "<id>": { kid, month: "YYYY-MM" (month it was cashed), minutes, rate, amount, at, paid, paidAt } }
// Extra time only becomes cash-able once its month is over: on the 1st, last
// month's leftover shows up as credit, and the kid can cash some/all of it out
// or leave it to roll over. A cash-out reduces the credit for the month it's
// taken in (and everything after).
export function workCashoutsFor(kid, cashouts = {}) {
  return Object.entries(cashouts || {})
    .filter(([id, c]) => id !== "_empty" && c && c.kid === kid && c.month && Number(c.minutes) > 0)
    .map(([id, c]) => ({ id, ...c, minutes: Number(c.minutes), amount: Number(c.amount) || 0 }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

export function getWorkMonth(kid, monthKey, logs = {}, cashouts = {}) {
  const cfg = MONTHLY_WORK[kid];
  if (!cfg) return null;
  const required = cfg.hours * 60;
  const all = Object.entries(logs || {})
    .filter(([id, e]) => id !== "_empty" && e && e.kid === kid && e.date && Number(e.minutes) > 0)
    .map(([id, e]) => ({ id, ...e, minutes: Number(e.minutes) }));
  const perMonth = {};
  let preStart = 0;
  for (const e of all) {
    const mk = e.date.slice(0, 7);
    if (mk < cfg.start) preStart += e.minutes;
    else perMonth[mk] = (perMonth[mk] || 0) + e.minutes;
  }
  const cashList = workCashoutsFor(kid, cashouts);
  const cashedIn = (mk) => cashList.filter(c => (c.month < cfg.start ? cfg.start : c.month) === mk).reduce((t, c) => t + c.minutes, 0);
  const entries = all.filter(e => e.date.slice(0, 7) === monthKey)
    .sort((a, b) => (b.date.localeCompare(a.date)) || ((b.loggedAt || 0) - (a.loggedAt || 0)));
  const logged = entries.reduce((t, e) => t + e.minutes, 0);
  const unpaid = cashList.filter(c => !c.paid);
  const common = { kid, monthKey, start: cfg.start, required, entries, logged, cashRate: cfg.cashRate || 0, cashouts: cashList, unpaid,
    unpaidAmount: unpaid.reduce((t, c) => t + c.amount, 0) };
  if (monthKey < cfg.start) {
    return { ...common, beforeStart: true, creditTowardStart: preStart, cashable: 0, cashedThisMonth: 0 };
  }
  let carry = preStart;               // minutes; > 0 = credit, < 0 = still owed
  for (let mk = cfg.start; mk < monthKey; mk = addMonths(mk, 1)) carry += (perMonth[mk] || 0) - required - cashedIn(mk);
  const cashedThisMonth = cashedIn(monthKey);
  const carryIn = carry - cashedThisMonth;
  const target = Math.max(0, required - carryIn);
  return {
    ...common, beforeStart: false, carryIn, target, cashedThisMonth,
    cashable: Math.max(0, carryIn),   // credit from finished months that can be cashed out now
    remaining: Math.max(0, target - logged),
    extra: Math.max(0, logged - target),
    carryOut: carryIn + logged - required,
  };
}

export function cashoutAmount(kid, minutes) {
  const rate = (MONTHLY_WORK[kid] && MONTHLY_WORK[kid].cashRate) || 0;
  return Math.round((minutes / 60) * rate * 100) / 100;
}

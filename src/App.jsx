import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { db, storage } from "./firebase";
import { doc, setDoc, onSnapshot, deleteField } from "firebase/firestore";
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject, listAll } from "firebase/storage";

// ============================================================
// AUTO-GENERATING WEEKLY ROTATION SYSTEM
// All roles cycle through the original 31-week spreadsheet pattern.
// Recycle alternates every week. When weeks exceed 31, the pattern
// loops back to the start — no manual updates needed.
// ============================================================
const ROTATION_EPOCH_SUNDAY = new Date("2025-07-27"); // Sunday of first rotation week
const ROT_COLLECT_TRASH = ["Emilie","Carter","Cole","Emilie","Carter","Cole","Emilie","Nicholas","Emilie","Carter","Cole","Nicholas","Emilie","Carter","Cole","Nicholas","Emilie","Carter","Cole","Nicholas","Emilie","Carter","Cole","Nicholas","Emilie","Carter","Cole","Nicholas","Emilie","Carter","Cole"];
const ROT_TRASH_OUT = ["Carter","Cole","Emilie","Carter","Cole","Emilie","Carter","Cole","Nicholas","Emilie","Carter","Cole","Nicholas","Emilie","Carter","Cole","Nicholas","Emilie","Carter","Cole","Nicholas","Emilie","Carter","Cole","Nicholas","Emilie","Carter","Cole","Nicholas","Emilie","Carter"];
const ROT_BRING_CANS = ["Cole","Emilie","Finn","Liam","Emilie","Carter","Finn","Emilie","Carter","Nicholas","Emilie","Carter","Cole","Finn","Nicholas","Emilie","Carter","Cole","Liam","Finn","Carter","Nicholas","Emilie","Carter","Cole","Finn","Nicholas","Emilie","Carter","Cole","Liam"];
const ROT_REFILL_SOAP = ["Finn","Liam","Carter","Finn","Liam","Finn","Liam","Finn","Cole","Liam","Finn","Liam","Finn","Cole","Finn","Liam","Finn","Liam","Emilie","Cole","Finn","Liam","Finn","Liam","Carter","Cole","Finn","Liam","Liam","Finn","Finn"];
const ROT_TOILET_PAPER = ["Liam","Finn","Liam","Cole","Finn","Liam","Cole","Liam","Liam","Finn","Liam","Finn","Liam","Liam","Emilie","Finn","Liam","Finn","Finn","Emilie","Liam","Cole","Liam","Finn","Liam","Finn","Liam","Liam","Finn","Liam","Liam"];
const ROT_LEN = 31;

function getWeeklyRotation(date) {
  const weekStart = getWeekStart(date);
  const weekNum = Math.round((weekStart.getTime() - ROTATION_EPOCH_SUNDAY.getTime()) / (7*24*60*60*1000));
  if (weekNum < 0) return null;
  const idx = ((weekNum % ROT_LEN) + ROT_LEN) % ROT_LEN;
  return {
    date: dateToKey(weekStart),
    collectTrash: ROT_COLLECT_TRASH[idx],
    trashOut: ROT_TRASH_OUT[idx],
    recycle: weekNum % 2 === 0,
    bringCansIn: ROT_BRING_CANS[idx],
    refillSoap: ROT_REFILL_SOAP[idx],
    toiletPaper: ROT_TOILET_PAPER[idx],
  };
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ============================================================
// HOUSEKEEPING CHARTS (6 rotating weekly, Mon/Tue/Wed/Thu only)
// ============================================================
const HOUSEKEEPING_CHARTS = [
  { // Chart 1
    name: "Chart 1",
    tasks: {
      Monday: "Bathroom counter/sink",
      Tuesday: "Dust windowsills",
      Wednesday: "Pick up bedroom + office for Roborock",
      Thursday: "Wipe light switches",
    },
    zone: "Coat closet/stairs/upstairs hallway",
  },
  { // Chart 2
    name: "Chart 2",
    tasks: {
      Monday: "Toilet",
      Tuesday: "Dust banister/handrail",
      Wednesday: "Pick up bedroom + family room for Roborock, vacuum top stairs",
      Thursday: "Wipe doorknobs",
    },
    zone: "Office/Front hallway",
  },
  { // Chart 3
    name: "Chart 3",
    tasks: {
      Monday: "Tub",
      Tuesday: "Dust pieces (TV stand, front hall piece, piano, printer table)",
      Wednesday: "Pick up bedroom + upstairs hallway for Roborock",
      Thursday: "Wipe microwave",
    },
    zone: "Kitchen",
  },
  { // Chart 4
    name: "Chart 4",
    tasks: {
      Monday: "Mirror",
      Tuesday: "Dust baseboards",
      Wednesday: "Pick up family room + main floor for Roborock, vacuum bottom stairs",
      Thursday: "Wipe oven",
    },
    zone: "Family Room",
  },
  { // Chart 5
    name: "Chart 5",
    tasks: {
      Monday: "Clean shower door/glass",
      Tuesday: "Dust ceiling fan blades",
      Wednesday: "Pick up upstairs rooms for Roborock",
      Thursday: "Wipe dishwasher",
    },
    zone: "Bathroom(s)",
  },
  { // Chart 6
    name: "Chart 6",
    tasks: {
      Monday: "Wipe bathroom cabinets/shelves",
      Tuesday: "Dust shelves/bookcase",
      Wednesday: "Pick up entry/mudroom for Roborock",
      Thursday: "Wipe fridge",
    },
    zone: "Laundry area/garage entry",
  },
];

// Laundry days are fixed per kid (do not rotate with charts)
const LAUNDRY_DAYS = {
  Nicholas: "Monday",
  Carter: "Tuesday",
  Cole: "Wednesday",
  Finn: "Thursday",
  Liam: "Friday",
  Emilie: "Saturday",
};


// ============================================================
// SCHOOL CALENDAR & VIDEO GAME DAY RULES
// Video games only on Fri/Sat during school + specific days off.
// Summer TBD. Update these dates each school year.
// ============================================================
const SCHOOL_CALENDAR = {
  schoolEndDate: "2026-05-22",       // Last day of school
  schoolStartDate: "2026-08-19",     // First day of next school year
  daysOff: [                         // Specific days off during school year
    "2026-03-09",
    "2026-03-23",
    "2026-04-06", "2026-04-07", "2026-04-08", "2026-04-09", "2026-04-10",
  ],
  summerRules: "unrestricted",       // "unrestricted" | "weekends_only" | "custom" — change for summer policy
};

function isVideoGameDay(date) {
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

const DAILY_CHORES = {
  Nicholas: { Sunday:{type:"dishes",zone:null,dinnerJob:null},Monday:{type:"zone",zone:"Office/Front Hall",dinnerJob:"Clear Table"},Tuesday:{type:"dishes",zone:null,dinnerJob:null},Wednesday:{type:"zone",zone:"Family Room/Vacuum",dinnerJob:"Take Out Trash"},Thursday:{type:"zone",zone:"Kitchen Floor",dinnerJob:"Sweep"},Friday:{type:"zone",zone:"Office/Front Hall",dinnerJob:"Clear Table"},Saturday:{type:"zone",zone:"Office/Front Hall",dinnerJob:"Clear Table"} },
  Emilie: { Sunday:{type:"zone",zone:"Kitchen Floor",dinnerJob:"Sweep"},Monday:{type:"zone",zone:"Family Room/Vacuum",dinnerJob:"Take Out Trash"},Tuesday:{type:"zone",zone:"Office/Front Hall",dinnerJob:"Clear Table"},Wednesday:{type:"zone",zone:"Kitchen Floor",dinnerJob:"Sweep"},Thursday:{type:"dishes",zone:null,dinnerJob:null},Friday:{type:"zone",zone:"Family Room/Vacuum",dinnerJob:"Take Out Trash"},Saturday:{type:"dishes",zone:null,dinnerJob:null} },
  Carter: { Sunday:{type:"zone",zone:"Family Room/Vacuum",dinnerJob:"Take Out Trash"},Monday:{type:"dishes",zone:null,dinnerJob:null},Tuesday:{type:"zone",zone:"Kitchen Floor",dinnerJob:"Sweep"},Wednesday:{type:"zone",zone:"Office/Front Hall",dinnerJob:"Clear Table"},Thursday:{type:"zone",zone:"Family Room/Vacuum",dinnerJob:"Take Out Trash"},Friday:{type:"dishes",zone:null,dinnerJob:null},Saturday:{type:"zone",zone:"Kitchen Floor",dinnerJob:"Sweep"} },
  Cole: { Sunday:{type:"zone",zone:"Office/Front Hall",dinnerJob:"Clear Table"},Monday:{type:"zone",zone:"Kitchen Floor",dinnerJob:"Sweep"},Tuesday:{type:"zone",zone:"Family Room/Vacuum",dinnerJob:"Take Out Trash"},Wednesday:{type:"dishes",zone:null,dinnerJob:null},Thursday:{type:"zone",zone:"Office/Front Hall",dinnerJob:"Clear Table"},Friday:{type:"zone",zone:"Kitchen Floor",dinnerJob:"Sweep"},Saturday:{type:"zone",zone:"Family Room/Vacuum",dinnerJob:"Take Out Trash"} },
  Finn: { Sunday:{type:"young",task:"Set Table/Stairs"},Monday:{type:"young",task:"Help with Dishes/Upstairs Hallway"},Tuesday:{type:"young",task:"Set Table/Stairs"},Wednesday:{type:"young",task:"Help with Dishes/Upstairs Hallway"},Thursday:{type:"young",task:"Set Table/Stairs"},Friday:{type:"young",task:"Help with Dishes/Upstairs Hallway"},Saturday:{type:"young",task:"Set Table/Stairs"} },
  Liam: { Sunday:{type:"young",task:"Help with Dishes/Upstairs Hallway"},Monday:{type:"young",task:"Set Table/Stairs"},Tuesday:{type:"young",task:"Help with Dishes/Upstairs Hallway"},Wednesday:{type:"young",task:"Set Table/Stairs"},Thursday:{type:"young",task:"Help with Dishes/Upstairs Hallway"},Friday:{type:"young",task:"Set Table/Stairs"},Saturday:{type:"young",task:"Help with Dishes/Upstairs Hallway"} },
};

const FAMILY_MEMBERS = [
  { name: "Nicholas", color: "#E85D4A", emoji: "\u{1F985}", group: "older" },
  { name: "Emilie", color: "#D4518A", emoji: "\u{1F338}", group: "older" },
  { name: "Carter", color: "#3B82F6", emoji: "\u26A1", group: "older" },
  { name: "Cole", color: "#10B981", emoji: "\u{1F3AF}", group: "older" },
  { name: "Finn", color: "#F59E0B", emoji: "\u{1F31F}", group: "younger" },
  { name: "Liam", color: "#8B5CF6", emoji: "\u{1F680}", group: "younger" },
];

const PARENT_PIN = "1234";

const EMOJI_OPTIONS = [
  "🦅","🌸","⚡","🎯","🌟","🚀","🐉","🦁","🐺","🦊","🐻","🐼",
  "🦄","🐝","🦋","🐬","🦈","🐙","🦖","🦕","🐢","🦜","🐸","🦩",
  "🔥","💎","⚔️","🛡️","🎮","🎸","🏀","⚽","🏈","🎨","🧩","🌈",
  "💫","✨","🌙","☀️","❄️","🌊","🍕","🍩","🎪","🎭","👑","💪",
];

const TEAM_COLORS = [
  { name: "Red", value: "#EF4444" },
  { name: "Orange", value: "#F97316" },
  { name: "Yellow", value: "#EAB308" },
  { name: "Green", value: "#22C55E" },
  { name: "Teal", value: "#14B8A6" },
  { name: "Blue", value: "#3B82F6" },
  { name: "Indigo", value: "#6366F1" },
  { name: "Purple", value: "#8B5CF6" },
  { name: "Pink", value: "#EC4899" },
  { name: "Rose", value: "#F43F5E" },
];

function getToday() { return new Date(); }
function getDayName(date) { return DAYS[date.getDay()]; }
function formatDate(date) { return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }); }
function getWeekStart(date) { const d = new Date(date); d.setDate(d.getDate() - d.getDay()); d.setHours(0,0,0,0); return d; }
function dateToKey(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; }

function getCurrentWeekRotation(date) {
  return getWeeklyRotation(date);
}

// Week number since a fixed epoch (for determining individual vs team weeks)
function getWeekNumber(date) {
  const epoch = new Date("2025-07-27"); // A Sunday
  const weekStart = getWeekStart(date);
  return Math.floor((weekStart.getTime() - epoch.getTime()) / (7 * 24 * 60 * 60 * 1000));
}

function isTeamWeek(date) {
  return getWeekNumber(date) % 2 === 1; // odd weeks = team weeks
}

// Get the housekeeping chart assigned to a member for a given date's week
function getChartAssignment(memberName, date) {
  const weekNum = getWeekNumber(date);
  const memberIndex = FAMILY_MEMBERS.findIndex(m => m.name === memberName);
  const chartIndex = ((memberIndex + weekNum) % 6 + 6) % 6;
  return HOUSEKEEPING_CHARTS[chartIndex];
}

// Check if a given Saturday is a mop Saturday (every other Saturday)
// Uses week number: even weeks = mop Saturday
function isMopSaturday(date) {
  const weekNum = getWeekNumber(date);
  return weekNum % 2 === 0;
}

// Get incomplete housekeeping tasks from the current week (for Saturday catch-up)
function getIncompleteHousekeepingTasks(member, date, completedChores) {
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


// Seeded random for deterministic team generation per week
function seededRandom(seed) {
  let s = seed;
  return function() {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function shuffleArray(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getTeamsForWeek(date) {
  const weekNum = getWeekNumber(date);
  const seed = weekNum * 31337 + 42;
  const rng = seededRandom(seed);
  const names = FAMILY_MEMBERS.map(m => m.name);
  const shuffled = shuffleArray(names, rng);
  // Captain is index 0 of each team, rotates based on week
  const captainIdx = weekNum % FAMILY_MEMBERS.length;
  // Ensure captain is first in their team
  return {
    team1: { members: shuffled.slice(0, 3), captain: shuffled[0] },
    team2: { members: shuffled.slice(3, 6), captain: shuffled[3] },
  };
}

function getWeekStartKey(date) { return dateToKey(getWeekStart(date)); }
function getMonthKey(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`; }
function getYearKey(date) { return `${date.getFullYear()}`; }

// Get daily chores that are due TODAY for a member (excludes weekly chores without specific due days)
function getDailyDueChores(member, date) {
  const dayName = getDayName(date);
  const daily = DAILY_CHORES[member]?.[dayName];
  const chores = [];
  if (!daily) return chores;
  if (daily.type === "dishes") chores.push("dishes");
  else if (daily.type === "zone") { chores.push("zone"); chores.push("dinner"); }
  else if (daily.type === "young") { daily.task.split("/").forEach((_, i) => chores.push(`task_${i}`)); }
  // Only include weekly chores that have a specific due day matching today
  const weekRotation = getCurrentWeekRotation(date);
  if (weekRotation && dayName === "Thursday") {
    if (weekRotation.bringCansIn === member) chores.push("w_cans");
  }
  // Housekeeping chart tasks
  if (dayName !== "Sunday" && dayName !== "Friday" && dayName !== "Saturday") {
    const chart = getChartAssignment(member, date);
    if (chart.tasks[dayName]) {
      chores.push(`hk_${dayName.toLowerCase()}`);
    }
    chores.push("hk_zone");
  }
  // Laundry
  if (LAUNDRY_DAYS[member] === dayName) {
    chores.push("laundry");
  }
  return chores;
}

// Calculate streak: consecutive days (ending today or yesterday) where all daily-due chores were completed
// Optimized: uses cached streak data to avoid scanning 365 days every time.
// cachedStreak = { count, lastDate } — if provided and recent, we only scan the gap since lastDate.
function calculateStreak(member, completedChores, today, cachedStreak) {
  // If we have a recent cache, try incremental update
  if (cachedStreak && cachedStreak.lastDate && cachedStreak.count > 0) {
    const cachedDate = new Date(cachedStreak.lastDate + "T00:00:00");
    const todayDate = new Date(today);
    const daysDiff = Math.round((todayDate - cachedDate) / 86400000);

    // Cache is from today — return as-is (will be rechecked for today's incomplete)
    if (daysDiff === 0) {
      // Still verify today's status (might have completed more chores)
      return calculateStreakFull(member, completedChores, today);
    }

    // Cache is recent (1-3 days old) — check only the gap days
    if (daysDiff > 0 && daysDiff <= 3) {
      let gapAllDone = true;
      for (let i = 1; i <= daysDiff; i++) {
        const checkDate = new Date(cachedDate);
        checkDate.setDate(cachedDate.getDate() + i);
        if (checkDate > todayDate) break;
        // Skip today (still in progress)
        if (dateToKey(checkDate) === dateToKey(todayDate)) continue;
        const dk = dateToKey(checkDate);
        const dueChores = getDailyDueChores(member, checkDate);
        if (dueChores.length === 0) continue;
        const allDone = dueChores.every(choreId => !!completedChores[`${dk}_${member}_${choreId}`]);
        if (!allDone) { gapAllDone = false; break; }
      }
      if (gapAllDone) {
        // Gap days are all complete — add them to cached count and check today
        let extraDays = 0;
        for (let i = 1; i <= daysDiff; i++) {
          const checkDate = new Date(cachedDate);
          checkDate.setDate(cachedDate.getDate() + i);
          if (checkDate > todayDate) break;
          if (dateToKey(checkDate) === dateToKey(todayDate)) {
            // Check if today's chores are done
            const dk = dateToKey(checkDate);
            const dueChores = getDailyDueChores(member, checkDate);
            if (dueChores.length > 0 && dueChores.every(choreId => !!completedChores[`${dk}_${member}_${choreId}`])) {
              extraDays++;
            }
            // Don't break streak if today is incomplete — they still have time
            continue;
          }
          extraDays++;
        }
        return cachedStreak.count + extraDays;
      }
      // Gap broken — need full recalc
    }
  }

  return calculateStreakFull(member, completedChores, today);
}

function calculateStreakFull(member, completedChores, today) {
  let streak = 0;
  const d = new Date(today);
  for (let i = 0; i < 365; i++) {
    const checkDate = new Date(d);
    checkDate.setDate(d.getDate() - i);
    const dk = dateToKey(checkDate);
    const dueChores = getDailyDueChores(member, checkDate);
    if (dueChores.length === 0) continue;
    const allDone = dueChores.every(choreId => !!completedChores[`${dk}_${member}_${choreId}`]);
    if (allDone) streak++;
    else {
      if (i === 0) continue;
      break;
    }
  }
  return streak;
}

const STREAK_MILESTONES = [3, 7, 14, 30, 50, 100];

// Compress an image file to a target max width and JPEG quality
function compressImage(file, maxWidth = 800, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let w = img.width, h = img.height;
        if (w > maxWidth) { h = Math.round((h * maxWidth) / w); w = maxWidth; }
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Compression failed")), "image/jpeg", quality);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadData(key, fallback) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
function saveData(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }

function useFirebaseSync(docName, localState, setLocalState) {
  const isRemoteUpdate = useRef(false);
  const initialized = useRef(false);
  useEffect(() => {
    const docRef = doc(db, "family", docName);
    const unsub = onSnapshot(docRef, (snapshot) => {
      if (snapshot.exists()) { const data = snapshot.data(); isRemoteUpdate.current = true; setLocalState(data); saveData(`fcc_${docName}`, data); }
      initialized.current = true;
    }, (error) => { console.warn(`Firestore error ${docName}:`, error); initialized.current = true; });
    return () => unsub();
  }, [docName, setLocalState]);
  useEffect(() => {
    if (!initialized.current) return;
    if (isRemoteUpdate.current) { isRemoteUpdate.current = false; return; }
    const docRef = doc(db, "family", docName);
    const dataToSave = localState && Object.keys(localState).length > 0 ? localState : { _empty: true };
    setDoc(docRef, dataToSave).catch((err) => console.warn(`Firestore write error ${docName}:`, err));
  }, [docName, localState]);
}

const Icons = {
  Check: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>),
  Trash: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>),
  Trophy: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9H4.5a2.5 2.5 0 010-5H6M18 9h1.5a2.5 2.5 0 000-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0012 0V2z" /></svg>),
  Calendar: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>),
  Home: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>),
  Settings: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" /></svg>),
  Star: ({ size = 20, color = "currentColor", filled = false }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : "none"} stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>),
  Recycle: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 19H4.815a1.83 1.83 0 01-1.57-.881 1.785 1.785 0 01-.004-1.784L7.196 9.5" /><path d="M11 19h8.203a1.83 1.83 0 001.556-.89 1.784 1.784 0 000-1.775l-1.226-2.12" /><path d="M14 16l3 3-3 3" /><path d="M8.293 13.596L4.875 8.052a1.784 1.784 0 01.004-1.784A1.83 1.83 0 016.476 5.39h7.558" /><path d="M7 16l-3-3 3-3" /><path d="M12 8l3-5-5-1" /></svg>),
  Lock: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>),
  Fire: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none"><path d="M12 23c-3.866 0-7-2.686-7-6 0-1.665.737-3.199 2-4.272C7 9.5 8.5 6 12 2c1 3 3 5 4 6.5.667 1 2 2.5 2 4.5 0 3.314-2.686 6-6 6z" /></svg>),
  Users: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" /></svg>),
  ChevronLeft: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>),
  ChevronRight: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>),
  X: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>),
  Cloud: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z" /></svg>),
  CloudOff: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22.61 16.95A5 5 0 0018 10h-1.26a8 8 0 00-7.05-6M5 5a8 8 0 004 15h9a5 5 0 001.7-.3" /><line x1="1" y1="1" x2="23" y2="23" /></svg>),
  Plus: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>),
  History: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>),
  Gamepad: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="12" x2="10" y2="12" /><line x1="8" y1="10" x2="8" y2="14" /><line x1="15" y1="13" x2="15.01" y2="13" /><line x1="18" y1="11" x2="18.01" y2="11" /><path d="M17.32 5H6.68a4 4 0 00-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 003 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 019.828 16h4.344a2 2 0 011.414.586L17 18c.5.5 1 1 2 1a3 3 0 003-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0017.32 5z" /></svg>),
  Camera: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" /><circle cx="12" cy="13" r="4" /></svg>),
  Image: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>),
};

const styles = `
@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=Fredoka:wght@400;500;600;700&display=swap');
:root{--bg-primary:#0f1724;--bg-secondary:#1a2332;--bg-card:#1e2a3a;--bg-card-hover:#243242;--text-primary:#f0f4f8;--text-secondary:#8899aa;--text-muted:#5a6a7a;--border:#2a3a4a;--accent:#3B82F6;--success:#10B981;--warning:#F59E0B;--danger:#EF4444}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Nunito',sans-serif;background:var(--bg-primary);color:var(--text-primary);min-height:100vh;overflow-x:hidden}
.app{min-height:100vh;display:flex;flex-direction:column}
.header{background:linear-gradient(135deg,#1a2332 0%,#0f1724 100%);border-bottom:1px solid var(--border);padding:12px 20px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.header-left{display:flex;align-items:center;gap:12px}
.header-logo{font-family:'Fredoka',sans-serif;font-size:1.5rem;font-weight:700;background:linear-gradient(135deg,#3B82F6,#8B5CF6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.header-date{font-size:0.9rem;color:var(--text-secondary);font-weight:600}
.header-right{display:flex;align-items:center;gap:8px}
.sync-indicator{display:flex;align-items:center;gap:4px;font-size:0.7rem;font-weight:600;padding:4px 8px;border-radius:8px}
.sync-online{color:#34d399;background:rgba(16,185,129,0.1)}.sync-offline{color:#f87171;background:rgba(239,68,68,0.1)}
.nav{display:flex;background:var(--bg-secondary);border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch}
.nav-btn{flex:1;min-width:80px;padding:12px 8px;background:none;border:none;color:var(--text-muted);font-family:'Nunito',sans-serif;font-size:0.75rem;font-weight:700;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;transition:all 0.2s;border-bottom:3px solid transparent;text-transform:uppercase;letter-spacing:0.5px}
.nav-btn.active{color:var(--accent);border-bottom-color:var(--accent);background:rgba(59,130,246,0.05)}
.nav-btn:hover{color:var(--text-primary);background:rgba(255,255,255,0.03)}
.main{flex:1;padding:16px;max-width:1200px;width:100%;margin:0 auto}
.card{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:16px;transition:all 0.2s}
.card-title{font-family:'Fredoka',sans-serif;font-size:1.1rem;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.member-card{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:16px;margin-bottom:12px;border-left:4px solid;transition:all 0.15s}
.member-card:active{transform:scale(0.99)}
.member-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.member-name-row{display:flex;align-items:center;gap:10px}
.member-emoji{font-size:1.5rem;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:12px;background:rgba(255,255,255,0.05)}
.member-name{font-family:'Fredoka',sans-serif;font-size:1.2rem;font-weight:600}
.member-points{display:flex;align-items:center;gap:4px;font-weight:700;font-size:1.1rem;color:var(--warning)}
.chore-list{display:flex;flex-direction:column;gap:8px}
.chore-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.03);cursor:pointer;transition:all 0.15s;-webkit-tap-highlight-color:transparent}
.chore-item:hover{background:rgba(255,255,255,0.06)}
.chore-item.completed{opacity:0.5}.chore-item.completed .chore-text{text-decoration:line-through}
.chore-checkbox{width:28px;height:28px;border-radius:8px;border:2px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.2s}
.chore-checkbox.checked{background:var(--success);border-color:var(--success)}
.chore-text{flex:1;font-size:0.95rem;font-weight:600}
.chore-tag{font-size:0.7rem;font-weight:700;padding:3px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:0.5px}
.tag-dishes{background:rgba(59,130,246,0.15);color:#60a5fa}.tag-zone{background:rgba(16,185,129,0.15);color:#34d399}
.tag-dinner{background:rgba(245,158,11,0.15);color:#fbbf24}.tag-weekly{background:rgba(139,92,246,0.15);color:#a78bfa}
.tag-young{background:rgba(236,72,153,0.15);color:#f472b6}.tag-custom{background:rgba(251,146,60,0.15);color:#fb923c}.tag-housekeeping{background:rgba(20,184,166,0.15);color:#2dd4bf}.tag-laundry{background:rgba(168,85,247,0.15);color:#c084fc}
.chore-points-badge{font-size:0.7rem;font-weight:800;color:var(--warning);padding:2px 6px;border-radius:6px;background:rgba(245,158,11,0.1);margin-right:4px;white-space:nowrap}
.chore-delete-btn{background:none;border:none;cursor:pointer;padding:4px;color:var(--text-muted);transition:color 0.15s;flex-shrink:0;display:flex;align-items:center}
.chore-delete-btn:hover{color:#f87171}
.weekly-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:480px){.weekly-grid{grid-template-columns:1fr}}
.weekly-item{display:flex;align-items:center;gap:12px;padding:12px;border-radius:10px;background:rgba(255,255,255,0.03)}
.weekly-icon{font-size:1.5rem;width:40px;text-align:center}.weekly-info{flex:1}
.weekly-task{font-size:0.8rem;color:var(--text-secondary);font-weight:600;text-transform:uppercase;letter-spacing:0.5px}
.weekly-person{font-weight:700;font-size:1rem}
.recycle-badge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:0.75rem;font-weight:700}
.recycle-yes{background:rgba(16,185,129,0.15);color:#34d399}.recycle-no{background:rgba(239,68,68,0.1);color:#f87171}
.leaderboard-item{display:flex;align-items:center;gap:12px;padding:14px;border-radius:12px;margin-bottom:8px;background:rgba(255,255,255,0.03);transition:all 0.2s}
.leaderboard-item:first-child{background:linear-gradient(135deg,rgba(245,158,11,0.15),rgba(245,158,11,0.05));border:1px solid rgba(245,158,11,0.2)}
.leaderboard-rank{font-family:'Fredoka',sans-serif;font-size:1.3rem;font-weight:700;width:36px;text-align:center;color:var(--text-muted)}
.leaderboard-item:first-child .leaderboard-rank{color:var(--warning)}
.leaderboard-name{flex:1;font-weight:700;font-size:1.05rem}
.leaderboard-score{display:flex;align-items:center;gap:6px;font-weight:800;font-size:1.1rem;color:var(--warning)}
.leaderboard-bar{height:4px;border-radius:2px;background:var(--border);margin-top:6px}
.leaderboard-bar-fill{height:100%;border-radius:2px;transition:width 0.5s ease}
.streak-badge{display:inline-flex;align-items:center;gap:3px;font-size:0.8rem;font-weight:700;color:#fb923c;padding:2px 8px;border-radius:12px;background:rgba(251,146,60,0.1)}
.week-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.week-nav-btn{background:var(--bg-card);border:1px solid var(--border);border-radius:10px;color:var(--text-primary);padding:8px 12px;cursor:pointer;display:flex;align-items:center;transition:all 0.15s}
.week-nav-btn:hover{background:var(--bg-card-hover)}
.week-label{font-family:'Fredoka',sans-serif;font-size:1.1rem;font-weight:600}
.week-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;overflow-x:auto}
@media(max-width:700px){.week-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:400px){.week-grid{grid-template-columns:repeat(2,1fr)}}
.day-col{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:10px;min-width:120px}
.day-col.today{border-color:var(--accent);background:rgba(59,130,246,0.05)}
.day-col:hover{background:var(--bg-card-hover);border-color:var(--text-muted)}
.day-col-selected{border-color:var(--accent)!important;background:rgba(59,130,246,0.1)!important;box-shadow:0 0 0 2px rgba(59,130,246,0.3)}
.day-detail-panel{margin-top:20px;padding-top:16px;border-top:2px solid var(--accent)}
.day-detail-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.day-detail-title{font-family:'Fredoka',sans-serif;font-size:1.2rem;font-weight:700;display:flex;align-items:center;gap:8px;color:var(--text-primary)}
.day-col-header{text-align:center;padding-bottom:8px;border-bottom:1px solid var(--border);margin-bottom:8px}
.day-name{font-weight:800;font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-secondary)}
.day-col.today .day-name{color:var(--accent)}
.day-date-num{font-family:'Fredoka',sans-serif;font-size:1.3rem;font-weight:700}
.day-member{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:8px;margin-bottom:4px;font-size:0.78rem;font-weight:600;background:rgba(255,255,255,0.03)}
.day-member-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.day-member-chore{color:var(--text-secondary);font-size:0.7rem;font-weight:400}
.pin-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(4px)}
.pin-dialog,.modal{background:var(--bg-card);border:1px solid var(--border);border-radius:20px;padding:28px;max-width:92vw;max-height:90vh;overflow-y:auto}
.pin-dialog{padding:32px;text-align:center;width:320px}
.modal{width:380px}
.pin-title,.modal-title{font-family:'Fredoka',sans-serif;font-size:1.3rem;font-weight:700;margin-bottom:8px}
.modal-title{margin-bottom:20px;display:flex;align-items:center;justify-content:space-between}
.pin-subtitle{color:var(--text-secondary);font-size:0.9rem;margin-bottom:24px}
.pin-input{display:flex;gap:12px;justify-content:center;margin-bottom:24px}
.pin-digit{width:50px;height:56px;border-radius:12px;border:2px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:1.5rem;font-weight:700;text-align:center;font-family:'Fredoka',sans-serif;outline:none;transition:border-color 0.2s}
.pin-digit:focus{border-color:var(--accent)}
.pin-error{color:var(--danger);font-size:0.85rem;font-weight:600;margin-top:-16px;margin-bottom:16px}
.btn{font-family:'Nunito',sans-serif;font-weight:700;border:none;border-radius:10px;padding:10px 20px;cursor:pointer;font-size:0.9rem;transition:all 0.15s;display:inline-flex;align-items:center;gap:6px}
.btn-primary{background:var(--accent);color:white}.btn-primary:hover{background:#2563eb}
.btn-ghost{background:transparent;color:var(--text-secondary);padding:8px 12px}.btn-ghost:hover{color:var(--text-primary);background:rgba(255,255,255,0.05)}
.btn-danger{background:rgba(239,68,68,0.15);color:#f87171}
.admin-section{margin-bottom:24px}
.admin-section-title{font-family:'Fredoka',sans-serif;font-weight:600;color:var(--text-secondary);margin-bottom:12px;text-transform:uppercase;letter-spacing:1px;font-size:0.8rem}
.admin-row{display:flex;align-items:center;justify-content:space-between;padding:12px;background:rgba(255,255,255,0.03);border-radius:10px;margin-bottom:6px}
.admin-row label{font-weight:600;font-size:0.95rem}
.points-adjust{display:flex;align-items:center;gap:8px}
.points-adjust-btn{width:32px;height:32px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:1.2rem;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s}
.points-adjust-btn:hover{background:var(--bg-card-hover)}
.points-value{font-family:'Fredoka',sans-serif;font-size:1.2rem;font-weight:700;min-width:40px;text-align:center}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(4px)}
.form-group{margin-bottom:16px}
.form-label{display:block;font-size:0.8rem;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px}
.form-input,.form-select{width:100%;padding:10px 14px;border-radius:10px;border:2px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-family:'Nunito',sans-serif;font-size:0.95rem;font-weight:600;outline:none;transition:border-color 0.2s}
.form-input:focus,.form-select:focus{border-color:var(--accent)}
.form-input::placeholder{color:var(--text-muted)}
.form-select{cursor:pointer;appearance:auto}
.form-row{display:flex;gap:12px}.form-row .form-group{flex:1}
.form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:20px}
.add-task-fab{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:16px;background:var(--accent);color:white;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(59,130,246,0.4);transition:all 0.2s;z-index:50}
.add-task-fab:hover{background:#2563eb;transform:scale(1.05)}.add-task-fab:active{transform:scale(0.95)}
.time-tabs{display:flex;gap:4px;margin-bottom:16px;background:var(--bg-secondary);padding:4px;border-radius:12px}
.time-tab{flex:1;padding:8px 4px;border:none;background:none;color:var(--text-muted);font-family:'Nunito',sans-serif;font-size:0.75rem;font-weight:700;cursor:pointer;border-radius:8px;transition:all 0.2s;text-transform:uppercase;letter-spacing:0.3px}
.time-tab.active{background:var(--accent);color:white}
.team-card{background:var(--bg-card);border:2px solid var(--border);border-radius:16px;padding:16px;margin-bottom:12px;transition:all 0.2s}
.team-card.winning{border-color:var(--warning);background:linear-gradient(135deg,rgba(245,158,11,0.08),rgba(245,158,11,0.02))}
.team-name{font-family:'Fredoka',sans-serif;font-size:1.2rem;font-weight:700;margin-bottom:4px}
.team-score{font-family:'Fredoka',sans-serif;font-size:2rem;font-weight:700;color:var(--warning)}
.team-members{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.team-member-chip{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:8px;background:rgba(255,255,255,0.05);font-size:0.82rem;font-weight:600}
.team-vs{text-align:center;font-family:'Fredoka',sans-serif;font-size:1.1rem;font-weight:700;color:var(--text-muted);padding:8px 0}
.team-name-row{display:flex;align-items:center;gap:6px}
.team-edit-btn{background:none;border:none;cursor:pointer;padding:4px;color:var(--text-muted);transition:color 0.15s;display:flex;align-items:center}
.team-edit-btn:hover{color:var(--accent)}
.mvp-badge{display:inline-flex;align-items:center;gap:3px;font-size:0.7rem;font-weight:800;color:#fbbf24;padding:2px 8px;border-radius:8px;background:rgba(245,158,11,0.15);margin-left:6px;text-transform:uppercase;letter-spacing:0.5px}
.competition-badge{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;font-size:0.8rem;font-weight:700;margin-bottom:16px}
.badge-individual{background:rgba(59,130,246,0.12);color:#60a5fa}
.badge-team{background:rgba(139,92,246,0.12);color:#a78bfa}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes flamePulse{0%,100%{transform:scale(1);filter:brightness(1)}50%{transform:scale(1.15);filter:brightness(1.3)}}
@keyframes flameGlow{0%,100%{text-shadow:0 0 4px rgba(251,146,60,0.4)}50%{text-shadow:0 0 12px rgba(251,146,60,0.8),0 0 20px rgba(245,158,11,0.4)}}
@keyframes goldenShimmer{0%{background-position:200% center}100%{background-position:-200% center}}
@keyframes milestoneIn{0%{opacity:0;transform:scale(0.5) translateY(20px)}50%{transform:scale(1.1) translateY(-5px)}100%{opacity:1;transform:scale(1) translateY(0)}}
@keyframes milestoneOut{0%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(0.8) translateY(-20px)}}
@keyframes fireParticle{0%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:0;transform:translateY(-40px) scale(0.3)}}
.streak-fire{display:inline-flex;align-items:center;margin-left:6px}
.streak-fire-1{animation:flamePulse 2s ease infinite}
.streak-fire-2{animation:flameGlow 1.5s ease infinite}
.streak-fire-3{animation:flameGlow 1s ease infinite}
.streak-on-fire{display:inline-flex;align-items:center;gap:3px;font-size:0.65rem;font-weight:900;padding:2px 8px;border-radius:8px;background:linear-gradient(90deg,#f59e0b,#ef4444,#f59e0b,#ef4444);background-size:300% 100%;animation:goldenShimmer 3s linear infinite;color:white;text-transform:uppercase;letter-spacing:1px;margin-left:6px}
.milestone-overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:300;pointer-events:none}
.milestone-popup{background:linear-gradient(135deg,rgba(30,42,58,0.97),rgba(15,23,36,0.97));border:2px solid var(--warning);border-radius:24px;padding:32px 40px;text-align:center;animation:milestoneIn 0.5s ease forwards;pointer-events:auto;box-shadow:0 0 40px rgba(245,158,11,0.3)}
.milestone-popup.exit{animation:milestoneOut 0.4s ease forwards}
.milestone-emoji{font-size:3.5rem;margin-bottom:8px;animation:flamePulse 1s ease infinite}
.milestone-title{font-family:'Fredoka',sans-serif;font-size:1.5rem;font-weight:700;color:var(--warning);margin-bottom:4px}
.milestone-sub{font-size:0.9rem;color:var(--text-secondary);font-weight:600}
.milestone-particles{position:absolute;inset:0;pointer-events:none;overflow:hidden}
@keyframes boxShake{0%,100%{transform:rotate(0)}25%{transform:rotate(-3deg)}75%{transform:rotate(3deg)}}
@keyframes boxHover{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
@keyframes confettiBurst{0%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:0;transform:translateY(-80px) scale(0.5)}}
@keyframes prizeReveal{0%{opacity:0;transform:scale(0.5) rotateY(90deg)}50%{transform:scale(1.1) rotateY(0deg)}100%{opacity:1;transform:scale(1) rotateY(0deg)}}
@keyframes sparkle{0%,100%{opacity:0.3;transform:scale(0.8)}50%{opacity:1;transform:scale(1.2)}}
.prize-card{background:var(--bg-card);border:2px solid var(--border);border-radius:16px;padding:16px;margin-bottom:12px;text-align:center;transition:all 0.3s}
.prize-card.has-winner{border-color:var(--warning);background:linear-gradient(135deg,rgba(245,158,11,0.06),rgba(139,92,246,0.06))}
.prize-type{font-size:0.7rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:6px}
.prize-label{font-family:'Fredoka',sans-serif;font-size:1rem;font-weight:600;color:var(--text-primary);margin-bottom:8px}
.prize-value{font-family:'Fredoka',sans-serif;font-size:1.2rem;font-weight:700;color:var(--warning);padding:8px 16px;border-radius:12px;background:rgba(245,158,11,0.1);display:inline-block}
.mystery-box{display:inline-flex;flex-direction:column;align-items:center;cursor:default;padding:12px 20px;border-radius:16px;background:linear-gradient(135deg,rgba(139,92,246,0.12),rgba(245,158,11,0.12));border:2px dashed rgba(139,92,246,0.3)}
.mystery-box.locked{animation:boxHover 2s ease infinite}
.mystery-box.unlocked{cursor:pointer;border-style:solid;border-color:var(--warning);animation:boxShake 0.5s ease infinite}
.mystery-box.unlocked:hover{background:linear-gradient(135deg,rgba(139,92,246,0.2),rgba(245,158,11,0.2))}
.mystery-box-icon{font-size:2.5rem;margin-bottom:4px}
.mystery-box-text{font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px}
.mystery-box.unlocked .mystery-box-text{color:var(--warning)}
.prize-revealed{animation:prizeReveal 0.6s ease forwards}
.confetti-container{position:fixed;inset:0;pointer-events:none;z-index:250;overflow:hidden}
.confetti-piece{position:absolute;width:10px;height:10px;border-radius:2px;animation:confettiFall linear forwards}
@keyframes confettiFall{0%{opacity:1;transform:translateY(0) rotate(0deg)}100%{opacity:0;transform:translateY(100vh) rotate(720deg)}}
.prize-winner-name{font-family:'Fredoka',sans-serif;font-size:0.9rem;font-weight:600;margin-top:6px}
.prize-form-row{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.mystery-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:0.85rem;font-weight:600;color:var(--text-secondary)}
.mystery-toggle input{width:18px;height:18px;accent-color:var(--accent)}
.emoji-picker-btn{cursor:pointer;transition:transform 0.15s;border:none;background:none;padding:0}
.emoji-picker-btn:hover{transform:scale(1.15)}
.emoji-picker-btn:active{transform:scale(0.95)}
.emoji-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:4px;max-height:200px;overflow-y:auto;padding:8px}
.emoji-option{font-size:1.5rem;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:10px;border:2px solid transparent;cursor:pointer;background:rgba(255,255,255,0.03);transition:all 0.15s}
.emoji-option:hover{background:rgba(255,255,255,0.08);border-color:var(--border)}
.emoji-option.selected{border-color:var(--accent);background:rgba(59,130,246,0.1)}
.color-picker-grid{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:12px 0}
.color-option{width:36px;height:36px;border-radius:50%;cursor:pointer;border:3px solid transparent;transition:all 0.15s}
.color-option:hover{transform:scale(1.1)}
.color-option.selected{border-color:white;box-shadow:0 0 12px rgba(255,255,255,0.3)}
.team-badge-mini{display:inline-flex;align-items:center;gap:3px;font-size:0.65rem;font-weight:700;padding:2px 6px;border-radius:6px;margin-left:6px;letter-spacing:0.3px}
.animate-in{animation:fadeIn 0.3s ease both}
.animate-in:nth-child(1){animation-delay:0.02s}.animate-in:nth-child(2){animation-delay:0.06s}.animate-in:nth-child(3){animation-delay:0.1s}.animate-in:nth-child(4){animation-delay:0.14s}.animate-in:nth-child(5){animation-delay:0.18s}.animate-in:nth-child(6){animation-delay:0.22s}
@keyframes checkPop{0%{transform:scale(0.8)}50%{transform:scale(1.15)}100%{transform:scale(1)}}
.check-pop{animation:checkPop 0.25s ease}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.streak-spotlight{background:linear-gradient(135deg,rgba(251,146,60,0.08),rgba(239,68,68,0.05));border-color:rgba(251,146,60,0.3)}
.streak-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
.streak-card{background:rgba(255,255,255,0.04);border-radius:12px;padding:12px;text-align:center;border:1px solid rgba(255,255,255,0.06);transition:all 0.3s}
.streak-card-warm{border-color:rgba(251,146,60,0.2)}
.streak-card-fire{border-color:rgba(251,146,60,0.4);background:rgba(251,146,60,0.06)}
.streak-card-blazing{border-color:rgba(239,68,68,0.4);background:rgba(239,68,68,0.06);animation:flamePulse 2s ease infinite}
.streak-card-legendary{border-color:rgba(245,158,11,0.6);background:linear-gradient(135deg,rgba(245,158,11,0.1),rgba(239,68,68,0.1));animation:goldenShimmer 3s linear infinite;background-size:300% 100%}
.streak-card-top{display:flex;align-items:baseline;justify-content:center;gap:4px;margin-bottom:4px}
.streak-card-emoji{font-size:1.3rem}
.streak-card-days{font-family:'Fredoka',sans-serif;font-size:2rem;font-weight:800;color:var(--warning);line-height:1}
.streak-card-unit{font-size:0.7rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px}
.streak-card-name{font-family:'Fredoka',sans-serif;font-size:0.85rem;font-weight:600;margin-bottom:2px}
.streak-card-tier{font-size:0.7rem;font-weight:700;color:var(--text-secondary);margin-bottom:6px}
.streak-progress-wrap{margin-top:4px}
.streak-progress-bar{height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden}
.streak-progress-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,#fb923c,#ef4444);transition:width 0.5s ease}
.streak-progress-label{font-size:0.6rem;color:var(--text-muted);font-weight:600;margin-top:3px;text-align:right}
.history-hall-of-fame{display:flex;flex-direction:column;gap:8px}
.hall-of-fame-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.03);border-left:3px solid}
.hall-of-fame-rank{font-size:1.2rem;width:32px;text-align:center;font-weight:800}
.hall-of-fame-emoji{font-size:1.3rem}
.hall-of-fame-info{flex:1}
.hall-of-fame-name{font-family:'Fredoka',sans-serif;font-size:1rem;font-weight:600}
.hall-of-fame-stats{display:flex;gap:10px;margin-top:2px}
.hof-stat{font-size:0.75rem;font-weight:700}
.hof-wins{color:#fbbf24}
.hof-mvps{color:#a78bfa}
.history-week-card{padding:16px}
.history-week-card.history-current{border-color:var(--accent);box-shadow:0 0 0 1px rgba(59,130,246,0.3)}
.history-week-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;gap:12px;flex-wrap:wrap}
.history-week-date{font-family:'Fredoka',sans-serif;font-size:1rem;font-weight:600;color:var(--text-primary)}
.history-week-type{display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap}
.history-current-badge{font-size:0.6rem;font-weight:800;padding:2px 6px;border-radius:4px;background:var(--accent);color:white;letter-spacing:0.5px}
.history-awards{display:flex;flex-direction:column;gap:4px;align-items:flex-end}
.history-award{font-size:0.8rem;font-weight:700;display:flex;align-items:center;gap:4px}
.history-scores{display:flex;flex-direction:column;gap:6px}
.history-score-row{display:flex;align-items:center;gap:8px}
.history-score-name{display:flex;align-items:center;gap:4px;min-width:110px}
.history-score-bar-wrapper{flex:1;height:14px;background:rgba(255,255,255,0.05);border-radius:7px;overflow:hidden}
.history-score-bar{height:100%;border-radius:7px;transition:width 0.5s ease;min-width:2px}
.history-score-pts{font-size:0.8rem;font-weight:800;min-width:28px;text-align:right;color:var(--warning)}
.game-unlock-badge{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:10px;font-size:0.75rem;font-weight:800;letter-spacing:0.3px;margin-left:8px;transition:all 0.3s ease}
.game-unlock-badge.unlocked{background:linear-gradient(135deg,rgba(16,185,129,0.2),rgba(52,211,153,0.1));color:#34d399;border:1px solid rgba(16,185,129,0.3);animation:gameUnlockGlow 2s ease-in-out infinite}
.game-unlock-badge.locked{background:rgba(239,68,68,0.12);color:#f87171;border:1px solid rgba(239,68,68,0.2)}
.game-unlock-badge.override{background:linear-gradient(135deg,rgba(245,158,11,0.2),rgba(251,191,36,0.1));color:#fbbf24;border:1px solid rgba(245,158,11,0.3)}
.game-unlock-icon{font-size:1rem;line-height:1}
.game-lock-icon{font-size:0.7rem;margin-left:-2px}
@keyframes gameUnlockGlow{0%,100%{box-shadow:0 0 4px rgba(16,185,129,0.2)}50%{box-shadow:0 0 12px rgba(16,185,129,0.4)}}
.admin-game-unlock{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.03);margin-bottom:8px}
.admin-game-unlock-info{display:flex;flex-direction:column;gap:2px}
.admin-game-unlock-stats{font-size:0.75rem;color:var(--text-muted);font-weight:600}
.admin-unlock-toggle{padding:6px 14px;border-radius:8px;border:none;font-family:'Nunito',sans-serif;font-weight:700;font-size:0.75rem;cursor:pointer;transition:all 0.15s}
.admin-unlock-toggle.unlock{background:rgba(16,185,129,0.15);color:#34d399}
.admin-unlock-toggle.lock{background:rgba(239,68,68,0.15);color:#f87171}
.game-tab-card{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:16px;border-left:4px solid}
.game-timer-display{font-family:'Fredoka',sans-serif;font-size:3rem;font-weight:700;text-align:center;padding:16px 0;letter-spacing:2px}
.game-timer-display.running{color:#34d399}
.game-timer-display.paused{color:#fbbf24}
.game-timer-display.expired{color:#f87171}
.game-timer-display.idle{color:var(--text-muted)}
.game-timer-bar{height:8px;border-radius:4px;background:var(--border);margin:8px 0 16px;overflow:hidden}
.game-timer-bar-fill{height:100%;border-radius:4px;transition:width 1s linear}
.game-timer-controls{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:12px}
.game-timer-btn{padding:10px 20px;border-radius:10px;border:none;font-family:'Nunito',sans-serif;font-weight:700;font-size:0.85rem;cursor:pointer;transition:all 0.15s;display:flex;align-items:center;gap:6px}
.game-timer-btn.start{background:linear-gradient(135deg,#10B981,#059669);color:white}
.game-timer-btn.pause{background:linear-gradient(135deg,#F59E0B,#D97706);color:white}
.game-timer-btn.stop{background:linear-gradient(135deg,#EF4444,#DC2626);color:white}
.game-timer-btn:active{transform:scale(0.95)}
.game-adjust-row{display:flex;gap:6px;justify-content:center;margin-top:8px}
.game-adjust-btn{padding:6px 12px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,0.05);color:var(--text-secondary);font-family:'Nunito',sans-serif;font-weight:700;font-size:0.75rem;cursor:pointer;transition:all 0.15s}
.game-adjust-btn:hover{background:rgba(255,255,255,0.1);color:var(--text-primary)}
.game-status-msg{text-align:center;font-size:0.85rem;font-weight:600;padding:12px;border-radius:10px;margin-bottom:12px}
.game-status-msg.locked{background:rgba(239,68,68,0.1);color:#f87171}
.game-status-msg.not-today{background:rgba(139,92,246,0.1);color:#a78bfa}
.game-family-timers{margin-top:8px}
.game-family-timer-row{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.03);margin-bottom:6px}
.game-family-timer-name{display:flex;align-items:center;gap:8px;font-weight:700}
.game-family-timer-status{font-size:0.8rem;font-weight:700;display:flex;align-items:center;gap:4px}
.times-up-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.92);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;animation:timesUpFadeIn 0.3s ease}
.times-up-emoji{font-size:5rem;animation:timesUpBounce 0.6s ease infinite alternate}
.times-up-text{font-family:'Fredoka',sans-serif;font-size:2.5rem;font-weight:800;color:#f87171;text-align:center;text-shadow:0 0 30px rgba(239,68,68,0.5)}
.times-up-sub{font-size:1rem;color:var(--text-secondary);font-weight:600;text-align:center}
.times-up-pin{margin-top:16px;display:flex;gap:8px}
.times-up-pin input{width:48px;height:56px;text-align:center;font-size:1.5rem;font-weight:800;border-radius:12px;border:2px solid var(--border);background:var(--bg-card);color:var(--text-primary);font-family:'Fredoka',sans-serif}
.times-up-pin input:focus{border-color:var(--accent);outline:none}
@keyframes timesUpFadeIn{from{opacity:0}to{opacity:1}}
@keyframes timesUpBounce{from{transform:translateY(0)}to{transform:translateY(-15px)}}
.chore-photo-btn{width:28px;height:28px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,0.05);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all 0.15s;flex-shrink:0;margin-left:auto}
.chore-photo-btn:hover{background:rgba(59,130,246,0.15);border-color:rgba(59,130,246,0.3)}
.chore-photo-btn.has-photo{background:rgba(16,185,129,0.12);border-color:rgba(16,185,129,0.3)}
.chore-photo-btn input{display:none}
.chore-photo-thumb{width:32px;height:32px;border-radius:8px;object-fit:cover;cursor:pointer;border:2px solid rgba(16,185,129,0.3);flex-shrink:0;margin-left:auto;transition:all 0.15s}
.chore-photo-thumb:hover{border-color:rgba(16,185,129,0.6);transform:scale(1.05)}
.photo-viewer-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.92);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;animation:timesUpFadeIn 0.3s ease}
.photo-viewer-img{max-width:90%;max-height:70vh;border-radius:12px;object-fit:contain}
.photo-viewer-info{color:var(--text-secondary);font-size:0.9rem;font-weight:600;margin-top:12px;text-align:center}
.photo-viewer-close{position:absolute;top:20px;right:20px;width:40px;height:40px;border-radius:50%;border:none;background:rgba(255,255,255,0.1);color:white;font-size:1.2rem;cursor:pointer;display:flex;align-items:center;justify-content:center}
.photo-uploading{opacity:0.5;pointer-events:none}
.admin-photos-section{margin-top:12px}
.admin-photo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin-top:8px}
.admin-photo-card{background:rgba(255,255,255,0.04);border-radius:10px;overflow:hidden;border:1px solid var(--border)}
.admin-photo-card img{width:100%;height:80px;object-fit:cover;cursor:pointer}
.admin-photo-card-info{padding:6px 8px;font-size:0.7rem;font-weight:600;color:var(--text-muted)}
.admin-photo-card-name{color:var(--text-secondary);font-weight:700}
`;

// ============================================================
// MAIN APP COMPONENT
// ============================================================
export default function App() {
  const [currentTab, setCurrentTab] = useState("today");
  const [today] = useState(getToday());
  const [completedChores, setCompletedChores] = useState(() => loadData("fcc_completed", {}));
  const [points, setPoints] = useState(() => loadData("fcc_points", {}));
  const [streaks, setStreaks] = useState(() => loadData("fcc_streaks", {}));
  const [customTasks, setCustomTasks] = useState(() => loadData("fcc_customTasks", {}));
  const [teamNames, setTeamNames] = useState(() => loadData("fcc_teamNames", {}));
  const [awards, setAwards] = useState(() => loadData("fcc_awards", {}));
  const [prizes, setPrizes] = useState(() => loadData("fcc_prizes", {}));
  const [customEmojis, setCustomEmojis] = useState(() => loadData("fcc_customEmojis", {}));
  const [teamColors, setTeamColors] = useState(() => loadData("fcc_teamColors", {}));
  const [gameUnlocks, setGameUnlocks] = useState(() => loadData("fcc_gameUnlocks", {}));
  const [gameTimers, setGameTimers] = useState(() => loadData("fcc_gameTimers", {}));
  const [chorePhotos, setChorePhotos] = useState(() => loadData("fcc_chorePhotos", {}));
  const [photoUploading, setPhotoUploading] = useState(null); // "member_choreId" while uploading
  const [photoViewer, setPhotoViewer] = useState(null); // { url, member, chore } for full-screen view
  const [timesUpMember, setTimesUpMember] = useState(null); // member name for TIMES UP overlay
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [showAddTask, setShowAddTask] = useState(false);
  const [showTeamNaming, setShowTeamNaming] = useState(null);
  const [isParent, setIsParent] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const [milestone, setMilestone] = useState(null); // { member, streak }
  const prevStreaksRef = useRef({});
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useFirebaseSync("completedChores", completedChores, setCompletedChores);
  useFirebaseSync("points", points, setPoints);
  useFirebaseSync("streaks", streaks, setStreaks);
  useFirebaseSync("customTasks", customTasks, setCustomTasks);
  useFirebaseSync("teamNames", teamNames, setTeamNames);
  useFirebaseSync("awards", awards, setAwards);
  useFirebaseSync("prizes", prizes, setPrizes);
  useFirebaseSync("customEmojis", customEmojis, setCustomEmojis);
  useFirebaseSync("teamColors", teamColors, setTeamColors);
  useFirebaseSync("gameUnlocks", gameUnlocks, setGameUnlocks);
  useFirebaseSync("gameTimers", gameTimers, setGameTimers);
  useFirebaseSync("chorePhotos", chorePhotos, setChorePhotos);

  useEffect(() => { saveData("fcc_completed", completedChores); }, [completedChores]);
  useEffect(() => { saveData("fcc_points", points); }, [points]);
  useEffect(() => { saveData("fcc_streaks", streaks); }, [streaks]);
  useEffect(() => { saveData("fcc_customTasks", customTasks); }, [customTasks]);
  useEffect(() => { saveData("fcc_teamNames", teamNames); }, [teamNames]);
  useEffect(() => { saveData("fcc_awards", awards); }, [awards]);
  useEffect(() => { saveData("fcc_prizes", prizes); }, [prizes]);
  useEffect(() => { saveData("fcc_customEmojis", customEmojis); }, [customEmojis]);
  useEffect(() => { saveData("fcc_teamColors", teamColors); }, [teamColors]);
  useEffect(() => { saveData("fcc_gameUnlocks", gameUnlocks); }, [gameUnlocks]);
  useEffect(() => { saveData("fcc_gameTimers", gameTimers); }, [gameTimers]);
  useEffect(() => { saveData("fcc_chorePhotos", chorePhotos); }, [chorePhotos]);

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => { window.removeEventListener("online", goOnline); window.removeEventListener("offline", goOffline); };
  }, []);

  const dayName = getDayName(today);
  const todayKey = dateToKey(today);
  const weekStartKey = getWeekStartKey(today);
  const monthKey = getMonthKey(today);
  const yearKey = getYearKey(today);
  const weekRotation = getCurrentWeekRotation(today);
  const teamWeek = isTeamWeek(today);
  const teams = teamWeek ? getTeamsForWeek(today) : null;

  // ---- Chore Photo Verification ----
  const uploadChorePhoto = useCallback(async (member, choreId, file) => {
    const photoKey = `${todayKey}_${member}_${choreId}`;
    setPhotoUploading(photoKey);
    try {
      const compressed = await compressImage(file, 800, 0.7);
      const path = `chore-photos/${todayKey}/${member}_${choreId}.jpg`;
      const fileRef = storageRef(storage, path);
      await uploadBytes(fileRef, compressed, { contentType: "image/jpeg" });
      const url = await getDownloadURL(fileRef);
      setChorePhotos(prev => {
        const u = { ...prev };
        delete u._empty;
        u[photoKey] = { url, path, ts: Date.now() };
        return u;
      });
    } catch (err) {
      console.error("Photo upload failed:", err);
    } finally {
      setPhotoUploading(null);
    }
  }, [todayKey]);

  const deleteChorePhoto = useCallback(async (photoKey) => {
    const photo = chorePhotos[photoKey];
    if (!photo) return;
    try {
      const fileRef = storageRef(storage, photo.path);
      await deleteObject(fileRef);
    } catch (err) {
      console.warn("Could not delete from storage:", err);
    }
    setChorePhotos(prev => {
      const u = { ...prev };
      delete u[photoKey];
      if (Object.keys(u).length === 0) u._empty = true;
      return u;
    });
  }, [chorePhotos]);

  // Auto-cleanup: delete photos older than 3 days on mount
  useEffect(() => {
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const keysToDelete = [];
    for (const [key, photo] of Object.entries(chorePhotos)) {
      if (key === "_empty") continue;
      if (photo.ts && (now - photo.ts) > THREE_DAYS_MS) {
        keysToDelete.push(key);
      }
    }
    if (keysToDelete.length > 0) {
      keysToDelete.forEach(key => deleteChorePhoto(key));
    }
  }, []); // only on mount

  const getChorePhoto = useCallback((member, choreId) => {
    const key = `${todayKey}_${member}_${choreId}`;
    return chorePhotos[key] || null;
  }, [chorePhotos, todayKey]);

  // Compute streaks from completedChores, using cached values for optimization
  const computedStreaks = useMemo(() => {
    const s = {};
    FAMILY_MEMBERS.forEach(m => {
      const cached = streaks[m.name] ? { count: streaks[m.name], lastDate: streaks._lastDate || null } : null;
      s[m.name] = calculateStreak(m.name, completedChores, today, cached);
    });
    return s;
  }, [completedChores, today]);

  // Persist computed streaks back to Firestore for cross-device caching & instant load
  const streakWriteRef = useRef(null);
  useEffect(() => {
    const todayStr = dateToKey(today);
    let needsUpdate = false;
    for (const m of FAMILY_MEMBERS) {
      if ((streaks[m.name] || 0) !== (computedStreaks[m.name] || 0)) { needsUpdate = true; break; }
    }
    if (streaks._lastDate !== todayStr) needsUpdate = true;
    if (needsUpdate) {
      // Debounce writes to avoid rapid-fire updates
      clearTimeout(streakWriteRef.current);
      streakWriteRef.current = setTimeout(() => {
        const updated = { _lastDate: todayStr };
        FAMILY_MEMBERS.forEach(m => { updated[m.name] = computedStreaks[m.name] || 0; });
        setStreaks(updated);
      }, 500);
    }
    return () => clearTimeout(streakWriteRef.current);
  }, [computedStreaks, today]);

  // Detect milestone hits and show popup
  useEffect(() => {
    for (const m of FAMILY_MEMBERS) {
      const prev = prevStreaksRef.current[m.name] || 0;
      const curr = computedStreaks[m.name] || 0;
      if (curr > prev && STREAK_MILESTONES.includes(curr)) {
        setMilestone({ member: m.name, streak: curr, emoji: m.emoji, color: m.color });
        setTimeout(() => setMilestone(null), 3500);
        break;
      }
    }
    prevStreaksRef.current = { ...computedStreaks };
  }, [computedStreaks]);

  // Points are stored with period prefixes: w_WEEKKEY_member, m_MONTHKEY_member, y_YEAR_member, a_member
  const addPoints = useCallback((member, delta) => {
    setPoints(p => {
      const u = { ...p }; delete u._empty;
      // Weekly
      const wk = `w_${weekStartKey}_${member}`;
      u[wk] = Math.max(0, (u[wk] || 0) + delta);
      // Monthly
      const mk = `m_${monthKey}_${member}`;
      u[mk] = Math.max(0, (u[mk] || 0) + delta);
      // Yearly
      const yk = `y_${yearKey}_${member}`;
      u[yk] = Math.max(0, (u[yk] || 0) + delta);
      // All-time
      const ak = `a_${member}`;
      u[ak] = Math.max(0, (u[ak] || 0) + delta);
      return u;
    });
  }, [weekStartKey, monthKey, yearKey]);

  // Date-aware version: adds points to the correct week/month/year for any date
  const addPointsForDate = useCallback((member, delta, date) => {
    const wsk = getWeekStartKey(date);
    const mk = getMonthKey(date);
    const yk = getYearKey(date);
    setPoints(p => {
      const u = { ...p }; delete u._empty;
      const wk = `w_${wsk}_${member}`;
      u[wk] = Math.max(0, (u[wk] || 0) + delta);
      const mKey = `m_${mk}_${member}`;
      u[mKey] = Math.max(0, (u[mKey] || 0) + delta);
      const yKey = `y_${yk}_${member}`;
      u[yKey] = Math.max(0, (u[yKey] || 0) + delta);
      const ak = `a_${member}`;
      u[ak] = Math.max(0, (u[ak] || 0) + delta);
      return u;
    });
  }, []);

  const getPoints = useCallback((member, period) => {
    if (!points || points._empty) return 0;
    if (period === "weekly") return points[`w_${weekStartKey}_${member}`] || 0;
    if (period === "monthly") return points[`m_${monthKey}_${member}`] || 0;
    if (period === "yearly") return points[`y_${yearKey}_${member}`] || 0;
    if (period === "alltime") return points[`a_${member}`] || 0;
    return 0;
  }, [points, weekStartKey, monthKey, yearKey]);

  const getCustomTasksForMember = useCallback((member) => {
    if (!customTasks || customTasks._empty) return [];
    return Object.entries(customTasks)
      .filter(([key, task]) => key !== "_empty" && task && task.assignee === member && task.date === todayKey)
      .map(([key, task]) => ({ id: `custom_${key}`, taskKey: key, text: task.description, tag: "custom", pointValue: task.points || 1 }));
  }, [customTasks, todayKey]);

  const toggleChore = useCallback((member, choreId, pointValue = 1) => {
    const key = `${todayKey}_${member}_${choreId}`;
    setCompletedChores(prev => {
      const next = { ...prev }; delete next._empty;
      if (next[key]) {
        delete next[key];
        addPoints(member, -pointValue);
      } else {
        next[key] = true;
        addPoints(member, pointValue);
        // Check if this is a team captain's first chore of the week
        if (teamWeek && teams) {
          const isT1Captain = teams.team1.captain === member;
          const isT2Captain = teams.team2.captain === member;
          if (isT1Captain || isT2Captain) {
            const tk = isT1Captain ? "team1" : "team2";
            const nameKey = `${weekStartKey}_${tk}`;
            if (!teamNames[nameKey] && !teamNames._empty) {
              // Check if they have any other completions this week
              // Check all 7 days of the current week for any completions by this captain
              const ws = getWeekStart(today);
              const weekDayKeys = Array.from({ length: 7 }, (_, i) => {
                const d = new Date(ws); d.setDate(d.getDate() + i); return dateToKey(d);
              });
              const hasOtherCompletions = Object.keys(prev).some(k => {
                return weekDayKeys.some(dk => k.startsWith(dk)) && k.includes(`_${member}_`);
              });
              if (!hasOtherCompletions) {
                setTimeout(() => setShowTeamNaming({ teamKey: tk, captain: member, nameKey }), 300);
              }
            }
          } else if (isT1Captain === false && isT2Captain === false) {
            // not a captain, skip
          }
        }
      }
      return next;
    });
  }, [todayKey, today, addPoints, teamWeek, teams, weekStartKey, teamNames]);

  const isChoreComplete = useCallback((member, choreId) => {
    return !!completedChores[`${todayKey}_${member}_${choreId}`];
  }, [completedChores, todayKey]);

  // Date-parameterized versions for Week View day detail
  const isChoreCompleteForDate = useCallback((member, choreId, date) => {
    return !!completedChores[`${dateToKey(date)}_${member}_${choreId}`];
  }, [completedChores]);

  const toggleChoreForDate = useCallback((member, choreId, date, pointValue = 1) => {
    const dk = dateToKey(date);
    const key = `${dk}_${member}_${choreId}`;
    setCompletedChores(prev => {
      const next = { ...prev }; delete next._empty;
      if (next[key]) {
        delete next[key];
        addPointsForDate(member, -pointValue, date);
      } else {
        next[key] = true;
        addPointsForDate(member, pointValue, date);
      }
      return next;
    });
  }, [addPointsForDate]);

  // Generic: get chores for any member on any date
  const getChoresForDate = useCallback((member, date) => {
    const dn = getDayName(date);
    const dk = dateToKey(date);
    const daily = DAILY_CHORES[member]?.[dn];
    const chores = [];
    if (!daily) return chores;
    if (daily.type === "dishes") { chores.push({ id: "dishes", text: "Dishes", tag: "dishes", pointValue: 1 }); }
    else if (daily.type === "zone") {
      chores.push({ id: "zone", text: `Zone: ${daily.zone}`, tag: "zone", pointValue: 1 });
      chores.push({ id: "dinner", text: `Dinner: ${daily.dinnerJob}`, tag: "dinner", pointValue: 1 });
    } else if (daily.type === "young") {
      daily.task.split("/").forEach((t, i) => { chores.push({ id: `task_${i}`, text: t.trim(), tag: "young", pointValue: 1 }); });
    }
    const rot = getCurrentWeekRotation(date);
    if (rot) {
      if (rot.collectTrash === member) chores.push({ id: "w_trash", text: "Collect Trash (all rooms)", tag: "weekly", pointValue: 1 });
      if (rot.trashOut === member) chores.push({ id: "w_trashout", text: `Take Trash Out${rot.recycle ? " + Recycling" : ""}`, tag: "weekly", pointValue: 1 });
      if (rot.bringCansIn === member) chores.push({ id: "w_cans", text: "Bring Cans In (Thursday)", tag: "weekly", pointValue: 1 });
      if (rot.refillSoap === member) chores.push({ id: "w_soap", text: "Refill Soap", tag: "weekly", pointValue: 1 });
      if (rot.toiletPaper === member) chores.push({ id: "w_tp", text: "Refill Toilet Paper", tag: "weekly", pointValue: 1 });
    }

    // Housekeeping chart tasks
    const chart = getChartAssignment(member, date);
    if (dn !== "Sunday" && dn !== "Friday") {
      if (dn === "Saturday") {
        if (isMopSaturday(date)) {
          chores.push({ id: "hk_mop", text: "Mop kitchen & bathrooms", tag: "housekeeping", pointValue: 1 });
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
        chores.push({ id: "hk_zone", text: `HK Zone: ${chart.zone}`, tag: "housekeeping", pointValue: 1 });
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
    return chores;
  }, [completedChores, customTasks]);

  // Today-specific wrapper (used by TodayView)
  const getMemberChores = useCallback((member) => {
    return getChoresForDate(member, today);
  }, [getChoresForDate, today]);

  const getCompletionCount = useCallback((member) => {
    const chores = getMemberChores(member);
    return { done: chores.filter(c => isChoreComplete(member, c.id)).length, total: chores.length };
  }, [getMemberChores, isChoreComplete]);

  const addCustomTask = useCallback((task) => {
    const taskId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setCustomTasks(prev => { const u = { ...prev }; delete u._empty; u[taskId] = task; return u; });
  }, []);

  const deleteCustomTask = useCallback((taskKey) => {
    setCustomTasks(prev => { const u = { ...prev }; delete u[taskKey]; if (Object.keys(u).length === 0) u._empty = true; return u; });
  }, []);

  const setTeamName = useCallback((nameKey, name) => {
    setTeamNames(prev => { const u = { ...prev }; delete u._empty; u[nameKey] = name; return u; });
  }, []);

  const getTeamName = useCallback((teamKey) => {
    const nameKey = `${weekStartKey}_${teamKey}`;
    const name = teamNames[nameKey];
    if (name) return name;
    return teamKey === "team1" ? "Team 1" : "Team 2";
  }, [teamNames, weekStartKey]);

  const getMemberEmoji = useCallback((name) => {
    if (customEmojis && !customEmojis._empty && customEmojis[name]) return customEmojis[name];
    return FAMILY_MEMBERS.find(m => m.name === name)?.emoji || "⭐";
  }, [customEmojis]);

  const setMemberEmoji = useCallback((name, emoji) => {
    setCustomEmojis(prev => { const u = { ...prev }; delete u._empty; u[name] = emoji; return u; });
  }, []);

  const getTeamColor = useCallback((teamKey) => {
    const ck = `${weekStartKey}_${teamKey}`;
    return teamColors?.[ck] || null;
  }, [teamColors, weekStartKey]);

  const setTeamColor = useCallback((teamKey, color) => {
    const ck = `${weekStartKey}_${teamKey}`;
    setTeamColors(prev => { const u = { ...prev }; delete u._empty; u[ck] = color; return u; });
  }, [weekStartKey]);

  const getTeamForMember = useCallback((memberName) => {
    if (!teamWeek || !teams) return null;
    if (teams.team1.members.includes(memberName)) return { key: "team1", ...teams.team1 };
    if (teams.team2.members.includes(memberName)) return { key: "team2", ...teams.team2 };
    return null;
  }, [teamWeek, teams]);

  const recordWeekAwards = useCallback(() => {
    const wk = weekStartKey;
    const alreadyRecorded = Object.keys(awards).some(k => k.startsWith(`win_${wk}_`));
    if (alreadyRecorded) return "already";
    setAwards(prev => {
      const u = { ...prev }; delete u._empty;
      const sorted = [...FAMILY_MEMBERS].sort((a, b) => getPoints(b.name, "weekly") - getPoints(a.name, "weekly"));
      if (getPoints(sorted[0].name, "weekly") > 0) u[`win_${wk}_${sorted[0].name}`] = true;
      if (teamWeek && teams) {
        const t1 = teams.team1.members.reduce((s, m) => s + getPoints(m, "weekly"), 0);
        const t2 = teams.team2.members.reduce((s, m) => s + getPoints(m, "weekly"), 0);
        const winTeam = t1 >= t2 ? teams.team1 : teams.team2;
        let topM = winTeam.members[0], topP = getPoints(winTeam.members[0], "weekly");
        for (const m of winTeam.members) { const p = getPoints(m, "weekly"); if (p > topP) { topM = m; topP = p; } }
        if (topP > 0) u[`mvp_${wk}_${topM}`] = true;
      }
      if (Object.keys(u).length === 0) u._empty = true;
      return u;
    });
    return "recorded";
  }, [weekStartKey, awards, getPoints, teamWeek, teams]);

  const getAwardCounts = useCallback((member, type, period) => {
    if (!awards || awards._empty) return 0;
    const prefix = type === "win" ? "win_" : "mvp_";
    return Object.keys(awards).filter(k => {
      if (!k.startsWith(prefix) || !k.endsWith(`_${member}`)) return false;
      if (period === "alltime") return true;
      const weekKey = k.slice(prefix.length, k.length - member.length - 1);
      if (period === "monthly") return weekKey.startsWith(monthKey);
      if (period === "yearly") return weekKey.startsWith(yearKey);
      return true;
    }).length;
  }, [awards, monthKey, yearKey]);

  // ============================================================
  // VIDEO GAME UNLOCK STATUS
  // Checks previous week's chores: housekeeping 100%, dinner 90%+
  // Parent can override via gameUnlocks Firebase doc
  // ============================================================
  const getVideoGameStatus = useCallback((member) => {
    // Get previous week's date range
    const prevWeekStart = new Date(getWeekStart(today));
    prevWeekStart.setDate(prevWeekStart.getDate() - 7);
    const prevWeekKey = dateToKey(prevWeekStart);

    // Check for parent override
    const overrideKey = `${prevWeekKey}_${member}`;
    if (gameUnlocks && !gameUnlocks._empty && gameUnlocks[overrideKey]) {
      return { unlocked: true, parentOverride: true, housekeepingPct: 100, dinnerPct: 100, gameDay: isVideoGameDay(today), choresComplete: true };
    }

    let housekeepingTotal = 0;
    let housekeepingDone = 0;
    let dinnerTotal = 0;
    let dinnerDone = 0;

    // Loop through each day of previous week
    for (let i = 0; i < 7; i++) {
      const d = new Date(prevWeekStart);
      d.setDate(d.getDate() + i);
      const dk = dateToKey(d);
      const dn = getDayName(d);
      const daily = DAILY_CHORES[member]?.[dn];
      if (!daily) continue;

      // Housekeeping tasks (Mon-Thu for older kids)
      if (dn !== "Sunday" && dn !== "Friday" && dn !== "Saturday") {
        const chart = getChartAssignment(member, d);
        const hkTask = chart.tasks[dn];
        if (hkTask) {
          housekeepingTotal++;
          if (completedChores[`${dk}_${member}_hk_${dn.toLowerCase()}`]) housekeepingDone++;
        }
        // HK Zone
        housekeepingTotal++;
        if (completedChores[`${dk}_${member}_hk_zone`]) housekeepingDone++;
      }

      // Dinner jobs (only for older kids who have zone-type days)
      if (daily.type === "zone" && daily.dinnerJob) {
        dinnerTotal++;
        if (completedChores[`${dk}_${member}_dinner`]) dinnerDone++;
      }

      // For younger kids, check their daily tasks
      if (daily.type === "young") {
        const tasks = daily.task.split("/");
        tasks.forEach((_, idx) => {
          housekeepingTotal++;
          if (completedChores[`${dk}_${member}_task_${idx}`]) housekeepingDone++;
        });
      }
    }

    const housekeepingPct = housekeepingTotal > 0 ? Math.round((housekeepingDone / housekeepingTotal) * 100) : 100;
    const dinnerPct = dinnerTotal > 0 ? Math.round((dinnerDone / dinnerTotal) * 100) : 100;

    // Check if today is even a video game day
    const gameDay = isVideoGameDay(today);

    // Chore-based unlock: housekeeping = 100% AND dinner >= 90%
    const choresComplete = housekeepingPct >= 100 && dinnerPct >= 90;

    // Final: must be a game day AND chores complete
    const unlocked = gameDay && choresComplete;

    return { unlocked, parentOverride: false, housekeepingPct, dinnerPct, gameDay, choresComplete };
  }, [today, completedChores, gameUnlocks]);

  const toggleGameUnlock = useCallback((member) => {
    const prevWeekStart = new Date(getWeekStart(today));
    prevWeekStart.setDate(prevWeekStart.getDate() - 7);
    const overrideKey = `${dateToKey(prevWeekStart)}_${member}`;
    setGameUnlocks(prev => {
      const u = { ...prev }; delete u._empty;
      if (u[overrideKey]) { delete u[overrideKey]; }
      else { u[overrideKey] = true; }
      if (Object.keys(u).length === 0) u._empty = true;
      return u;
    });
  }, [today]);

  // ============================================================
  // VIDEO GAME TIMER CONTROLS
  // ============================================================
  const DEFAULT_TIMER_DURATION = 7200; // 2 hours in seconds

  const startTimer = useCallback((member) => {
    const now = Date.now();
    setGameTimers(prev => {
      const u = { ...prev }; delete u._empty;
      const existing = u[member];
      // If there's a paused timer, resume it
      if (existing && existing.pausedAt && existing.remaining > 0) {
        u[member] = { ...existing, startedAt: now, pausedAt: null, active: true };
      } else {
        // Start fresh timer
        u[member] = { startedAt: now, duration: DEFAULT_TIMER_DURATION, pausedAt: null, remaining: DEFAULT_TIMER_DURATION, active: true };
      }
      return u;
    });
  }, []);

  const pauseTimer = useCallback((member) => {
    setGameTimers(prev => {
      const u = { ...prev }; delete u._empty;
      const timer = u[member];
      if (!timer || !timer.active || timer.pausedAt) return prev;
      const elapsed = Math.floor((Date.now() - timer.startedAt) / 1000);
      const remaining = Math.max(0, timer.remaining - elapsed);
      u[member] = { ...timer, pausedAt: Date.now(), remaining, active: remaining > 0 };
      return u;
    });
  }, []);

  const stopTimer = useCallback((member) => {
    setGameTimers(prev => {
      const u = { ...prev }; delete u._empty;
      u[member] = { startedAt: null, duration: DEFAULT_TIMER_DURATION, pausedAt: null, remaining: 0, active: false };
      return u;
    });
  }, []);

  const adjustTimer = useCallback((member, deltaMinutes) => {
    setGameTimers(prev => {
      const u = { ...prev }; delete u._empty;
      const timer = u[member] || { startedAt: null, duration: DEFAULT_TIMER_DURATION, pausedAt: null, remaining: DEFAULT_TIMER_DURATION, active: false };
      const deltaSec = deltaMinutes * 60;
      const newRemaining = Math.max(0, timer.remaining + deltaSec);
      const newDuration = Math.max(0, timer.duration + deltaSec);
      u[member] = { ...timer, remaining: newRemaining, duration: newDuration };
      return u;
    });
  }, []);

  return (
    <><style>{styles}</style>
      <div className="app">
        <header className="header">
          <div className="header-left">
            <span className="header-logo">Family HQ</span>
            <span className="header-date">{formatDate(today)}</span>
          </div>
          <div className="header-right">
            <div className={`sync-indicator ${isOnline ? "sync-online" : "sync-offline"}`}>
              {isOnline ? <Icons.Cloud size={14} /> : <Icons.CloudOff size={14} />}
              {isOnline ? "Synced" : "Offline"}
            </div>
            {isParent ? (
              <button className="btn btn-ghost" onClick={() => setIsParent(false)} style={{ fontSize: "0.8rem" }}><Icons.Lock size={16} /> Lock</button>
            ) : (
              <button className="btn btn-ghost" onClick={() => setShowPinDialog(true)} style={{ fontSize: "0.8rem" }}><Icons.Settings size={16} /> Parent</button>
            )}
          </div>
        </header>
        <nav className="nav">
          <button className={`nav-btn ${currentTab === "today" ? "active" : ""}`} onClick={() => setCurrentTab("today")}><Icons.Home size={20} /> Today</button>
          <button className={`nav-btn ${currentTab === "week" ? "active" : ""}`} onClick={() => setCurrentTab("week")}><Icons.Calendar size={20} /> Week</button>
          <button className={`nav-btn ${currentTab === "rotation" ? "active" : ""}`} onClick={() => setCurrentTab("rotation")}><Icons.Recycle size={20} /> Rotation</button>
          <button className={`nav-btn ${currentTab === "leaderboard" ? "active" : ""}`} onClick={() => setCurrentTab("leaderboard")}><Icons.Trophy size={20} /> Points</button>
          <button className={`nav-btn ${currentTab === "games" ? "active" : ""}`} onClick={() => setCurrentTab("games")}><Icons.Gamepad size={20} /> Games</button>
          <button className={`nav-btn ${currentTab === "history" ? "active" : ""}`} onClick={() => setCurrentTab("history")}><Icons.History size={20} /> History</button>
          {isParent && <button className={`nav-btn ${currentTab === "admin" ? "active" : ""}`} onClick={() => setCurrentTab("admin")}><Icons.Settings size={20} /> Admin</button>}
        </nav>
        <main className="main">
          {currentTab === "today" && <TodayView members={FAMILY_MEMBERS} getMemberChores={getMemberChores} isChoreComplete={isChoreComplete} toggleChore={toggleChore} getCompletionCount={getCompletionCount} getPoints={getPoints} isParent={isParent} deleteCustomTask={deleteCustomTask} computedStreaks={computedStreaks} getMemberEmoji={getMemberEmoji} setMemberEmoji={setMemberEmoji} teamWeek={teamWeek} getTeamForMember={getTeamForMember} getTeamName={getTeamName} getTeamColor={getTeamColor} getVideoGameStatus={getVideoGameStatus} uploadChorePhoto={uploadChorePhoto} getChorePhoto={getChorePhoto} photoUploading={photoUploading} setPhotoViewer={setPhotoViewer} />}
          {currentTab === "week" && <WeekView today={today} weekOffset={weekOffset} setWeekOffset={setWeekOffset} getChoresForDate={getChoresForDate} isChoreCompleteForDate={isChoreCompleteForDate} toggleChoreForDate={toggleChoreForDate} getMemberEmoji={getMemberEmoji} getPoints={getPoints} computedStreaks={computedStreaks} isParent={isParent} deleteCustomTask={deleteCustomTask} teamWeek={teamWeek} getTeamForMember={getTeamForMember} getTeamName={getTeamName} getTeamColor={getTeamColor} />}
          {currentTab === "rotation" && <RotationView today={today} weekRotation={weekRotation} />}
          {currentTab === "leaderboard" && <LeaderboardView getPoints={getPoints} computedStreaks={computedStreaks} teamWeek={teamWeek} teams={teams} getTeamName={getTeamName} setTeamName={setTeamName} weekStartKey={weekStartKey} getAwardCounts={getAwardCounts} prizes={prizes} setPrizes={setPrizes} awards={awards} getMemberEmoji={getMemberEmoji} getTeamColor={getTeamColor} setTeamColor={setTeamColor} />}
          {currentTab === "games" && <GameView members={FAMILY_MEMBERS} getVideoGameStatus={getVideoGameStatus} getMemberEmoji={getMemberEmoji} gameTimers={gameTimers} startTimer={startTimer} pauseTimer={pauseTimer} stopTimer={stopTimer} adjustTimer={adjustTimer} isParent={isParent} toggleGameUnlock={toggleGameUnlock} setTimesUpMember={setTimesUpMember} />}
          {currentTab === "history" && <HistoryView awards={awards} points={points} teamNames={teamNames} getMemberEmoji={getMemberEmoji} today={today} />}
          {currentTab === "admin" && isParent && <AdminView points={points} setPoints={setPoints} completedChores={completedChores} setCompletedChores={setCompletedChores} streaks={streaks} setStreaks={setStreaks} customTasks={customTasks} deleteCustomTask={deleteCustomTask} getPoints={getPoints} addPoints={addPoints} recordWeekAwards={recordWeekAwards} prizes={prizes} setPrizes={setPrizes} weekStartKey={weekStartKey} monthKey={monthKey} awards={awards} setAwards={setAwards} getVideoGameStatus={getVideoGameStatus} toggleGameUnlock={toggleGameUnlock} chorePhotos={chorePhotos} deleteChorePhoto={deleteChorePhoto} setPhotoViewer={setPhotoViewer} getMemberEmoji={getMemberEmoji} />}
        </main>
        {isParent && currentTab === "today" && <button className="add-task-fab" onClick={() => setShowAddTask(true)} title="Add Custom Task"><Icons.Plus size={28} /></button>}
        {timesUpMember && <TimesUpOverlay member={timesUpMember} memberEmoji={getMemberEmoji(timesUpMember)} onDismiss={() => setTimesUpMember(null)} />}
        {photoViewer && (
          <div className="photo-viewer-overlay" onClick={() => setPhotoViewer(null)}>
            <button className="photo-viewer-close" onClick={() => setPhotoViewer(null)}><Icons.X size={20} /></button>
            <img className="photo-viewer-img" src={photoViewer.url} alt="Chore proof" />
            <div className="photo-viewer-info">{getMemberEmoji(photoViewer.member)} {photoViewer.member} — {photoViewer.chore}</div>
          </div>
        )}
        {showPinDialog && <PinDialog onSuccess={() => { setIsParent(true); setShowPinDialog(false); }} onClose={() => setShowPinDialog(false)} />}
        {showAddTask && <AddTaskModal onAdd={(task) => { addCustomTask(task); setShowAddTask(false); }} onClose={() => setShowAddTask(false)} todayKey={todayKey} />}
        {showTeamNaming && <TeamNamingModal teamKey={showTeamNaming.teamKey} captain={showTeamNaming.captain} nameKey={showTeamNaming.nameKey} getMemberEmoji={getMemberEmoji} onName={(nk, name) => { setTeamName(nk, name); setShowTeamNaming(null); }} onColor={(color) => setTeamColor(showTeamNaming.teamKey, color)} onClose={() => setShowTeamNaming(null)} />}
        {milestone && (
          <div className="milestone-overlay">
            <div className="milestone-popup">
              <div className="milestone-emoji">{milestone.emoji} 🔥</div>
              <div className="milestone-title" style={{ color: milestone.color }}>{milestone.member}</div>
              <div className="milestone-title">{milestone.streak}-DAY STREAK!</div>
              <div className="milestone-sub">{milestone.streak >= 30 ? "ABSOLUTELY ON FIRE! 🔥🔥🔥" : milestone.streak >= 14 ? "Unstoppable! Keep it going! 🔥🔥" : milestone.streak >= 7 ? "A whole week! Amazing! 🔥" : "Getting started! Keep it up! 🔥"}</div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ============================================================
// TODAY VIEW
// ============================================================
function StreakSpotlight({ members, computedStreaks, getMemberEmoji }) {
  const TIERS = [
    { min: 0, label: "No streak", icon: "", next: 3 },
    { min: 3, label: "Warming up", icon: "🔥", next: 7 },
    { min: 7, label: "On fire!", icon: "🔥🔥", next: 14 },
    { min: 14, label: "Blazing!", icon: "🔥🔥🔥", next: 30 },
    { min: 30, label: "UNSTOPPABLE", icon: "🔥", next: 50 },
    { min: 50, label: "LEGENDARY", icon: "🔥", next: 100 },
    { min: 100, label: "MYTHICAL", icon: "🔥", next: null },
  ];
  const getTier = (s) => { for (let i = TIERS.length - 1; i >= 0; i--) { if (s >= TIERS[i].min) return TIERS[i]; } return TIERS[0]; };

  const streakData = members.map(m => {
    const streak = computedStreaks?.[m.name] || 0;
    const tier = getTier(streak);
    return { ...m, streak, tier };
  }).sort((a, b) => b.streak - a.streak);

  const anyStreaks = streakData.some(s => s.streak >= 1);
  if (!anyStreaks) return null;

  return (
    <div className="card animate-in streak-spotlight">
      <div className="card-title"><Icons.Fire size={22} color="#fb923c" /> Streak Tracker</div>
      <div className="streak-grid">
        {streakData.map(s => {
          if (s.streak < 1) return null;
          const nextMilestone = s.tier.next;
          const prevMilestone = s.tier.min;
          const progress = nextMilestone ? ((s.streak - prevMilestone) / (nextMilestone - prevMilestone)) * 100 : 100;
          return (
            <div key={s.name} className={`streak-card ${s.streak >= 30 ? "streak-card-legendary" : s.streak >= 14 ? "streak-card-blazing" : s.streak >= 7 ? "streak-card-fire" : "streak-card-warm"}`}>
              <div className="streak-card-top">
                <span className="streak-card-emoji">{getMemberEmoji(s.name)}</span>
                <span className="streak-card-days">{s.streak}</span>
                <span className="streak-card-unit">days</span>
              </div>
              <div className="streak-card-name" style={{ color: s.color }}>{s.name}</div>
              <div className="streak-card-tier">{s.tier.icon} {s.tier.label}</div>
              {nextMilestone && (
                <div className="streak-progress-wrap">
                  <div className="streak-progress-bar">
                    <div className="streak-progress-fill" style={{ width: `${Math.min(progress, 100)}%` }} />
                  </div>
                  <div className="streak-progress-label">Next: {nextMilestone}d</div>
                </div>
              )}
              {!nextMilestone && <div className="streak-progress-label" style={{ textAlign: "center", marginTop: 4 }}>Max tier reached! 👑</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TodayView({ members, getMemberChores, isChoreComplete, toggleChore, getCompletionCount, getPoints, isParent, deleteCustomTask, computedStreaks, getMemberEmoji, setMemberEmoji, teamWeek, getTeamForMember, getTeamName, getTeamColor, getVideoGameStatus, uploadChorePhoto, getChorePhoto, photoUploading, setPhotoViewer }) {
  const [emojiPicker, setEmojiPicker] = useState(null); // member name or null
  return (
    <div>
      <StreakSpotlight members={members} computedStreaks={computedStreaks} getMemberEmoji={getMemberEmoji} />
      {members.map((member) => {
        const chores = getMemberChores(member.name);
        const { done, total } = getCompletionCount(member.name);
        const allDone = total > 0 && done === total;
        const weeklyPts = getPoints(member.name, "weekly");
        const streak = computedStreaks?.[member.name] || 0;
        const emoji = getMemberEmoji(member.name);
        const team = getTeamForMember(member.name);
        const teamColor = team ? getTeamColor(team.key) : null;
        const cardBorderColor = teamColor || member.color;
        const gameStatus = getVideoGameStatus(member.name);
        return (
          <div key={member.name} className="member-card animate-in" style={{ borderLeftColor: cardBorderColor }}>
            <div className="member-header">
              <div className="member-name-row">
                <button className="emoji-picker-btn" onClick={(e) => { e.stopPropagation(); setEmojiPicker(emojiPicker === member.name ? null : member.name); }}>
                  <div className="member-emoji">{emoji}</div>
                </button>
                <div>
                  <div className="member-name" style={{ color: member.color }}>
                    {member.name}
                    {teamWeek && team && <span className="team-badge-mini" style={{ background: `${teamColor || "var(--border)"}22`, color: teamColor || "var(--text-muted)", border: `1px solid ${teamColor || "var(--border)"}` }}>{getTeamName(team.key)}</span>}
                    {streak >= 30 ? <span className="streak-on-fire">🔥 {streak}d ON FIRE</span>
                     : streak >= 14 ? <span className="streak-fire streak-fire-3" title={`${streak}-day streak!`}>🔥🔥🔥 {streak}d</span>
                     : streak >= 7 ? <span className="streak-fire streak-fire-2" title={`${streak}-day streak!`}>🔥🔥 {streak}d</span>
                     : streak >= 3 ? <span className="streak-fire streak-fire-1" title={`${streak}-day streak!`}>🔥 {streak}d</span>
                     : null}
                    <span className={`game-unlock-badge ${gameStatus.unlocked ? (gameStatus.parentOverride ? "override" : "unlocked") : "locked"}`} title={gameStatus.unlocked ? (gameStatus.parentOverride ? "Unlocked by parent" : `Video games unlocked! HK: ${gameStatus.housekeepingPct}% · Dinner: ${gameStatus.dinnerPct}%`) : `Locked — HK: ${gameStatus.housekeepingPct}% · Dinner: ${gameStatus.dinnerPct}%`}>
                      <span className="game-unlock-icon">🎮</span>
                      <span className="game-lock-icon">{gameStatus.unlocked ? "🔓" : "🔒"}</span>
                    </span>
                  </div>
                  <div style={{ fontSize: "0.8rem", color: allDone ? "#10B981" : "var(--text-muted)", fontWeight: 600 }}>
                    {allDone ? "All done!" : `${done}/${total} complete`}
                  </div>
                </div>
              </div>
              <div className="member-points"><Icons.Star size={18} color="#F59E0B" filled />{weeklyPts}</div>
            </div>
            {emojiPicker === member.name && (
              <div className="emoji-grid" style={{ marginBottom: 12 }}>
                {EMOJI_OPTIONS.map(e => (
                  <div key={e} className={`emoji-option ${emoji === e ? "selected" : ""}`} onClick={() => { setMemberEmoji(member.name, e); setEmojiPicker(null); }}>{e}</div>
                ))}
              </div>
            )}
            <div className="chore-list">
              {chores.map((chore) => {
                const completed = isChoreComplete(member.name, chore.id);
                const isCustom = chore.tag === "custom";
                const photo = getChorePhoto ? getChorePhoto(member.name, chore.id) : null;
                const isUploading = photoUploading === `${dateToKey(new Date())}_${member.name}_${chore.id}`;
                return (
                  <div key={chore.id} className={`chore-item ${completed ? "completed" : ""} ${isUploading ? "photo-uploading" : ""}`}>
                    <div className={`chore-checkbox ${completed ? "checked check-pop" : ""}`} onClick={() => toggleChore(member.name, chore.id, chore.pointValue || 1)}>{completed && <Icons.Check size={16} color="white" />}</div>
                    <span className="chore-text" onClick={() => toggleChore(member.name, chore.id, chore.pointValue || 1)}>{chore.text}</span>
                    {isCustom && chore.pointValue > 1 && <span className="chore-points-badge">+{chore.pointValue}</span>}
                    <span className={`chore-tag tag-${chore.tag}`}>{chore.tag}</span>
                    {completed && photo && (
                      <img className="chore-photo-thumb" src={photo.url} alt="proof" onClick={(e) => { e.stopPropagation(); setPhotoViewer({ url: photo.url, member: member.name, chore: chore.text }); }} />
                    )}
                    {completed && !photo && uploadChorePhoto && (
                      <label className={`chore-photo-btn ${photo ? "has-photo" : ""}`} title="Add photo proof" onClick={(e) => e.stopPropagation()}>
                        <Icons.Camera size={14} color="var(--text-muted)" />
                        <input type="file" accept="image/*" capture="environment" onChange={(e) => { if (e.target.files[0]) uploadChorePhoto(member.name, chore.id, e.target.files[0]); }} />
                      </label>
                    )}
                    {isParent && isCustom && <button className="chore-delete-btn" onClick={(e) => { e.stopPropagation(); deleteCustomTask(chore.taskKey); }} title="Delete task"><Icons.X size={16} /></button>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// LEADERBOARD VIEW (with time tabs + team competition)
// ============================================================
function LeaderboardView({ getPoints, computedStreaks, teamWeek, teams, getTeamName, setTeamName, weekStartKey, getAwardCounts, prizes, setPrizes, awards, getMemberEmoji, getTeamColor, setTeamColor }) {
  const [period, setPeriod] = useState("weekly");
  const [renamingTeam, setRenamingTeam] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [colorEditing, setColorEditing] = useState(null); // null or "team1"/"team2"
  const medals = ["\u{1F947}", "\u{1F948}", "\u{1F949}"];

  const sorted = useMemo(() => {
    return [...FAMILY_MEMBERS].sort((a, b) => getPoints(b.name, period) - getPoints(a.name, period));
  }, [getPoints, period]);

  const maxPts = useMemo(() => Math.max(1, ...FAMILY_MEMBERS.map(m => getPoints(m.name, period))), [getPoints, period]);

  const teamScores = useMemo(() => {
    if (!teamWeek || !teams) return null;
    const t1Score = teams.team1.members.reduce((sum, m) => sum + getPoints(m, "weekly"), 0);
    const t2Score = teams.team2.members.reduce((sum, m) => sum + getPoints(m, "weekly"), 0);
    return { team1: t1Score, team2: t2Score };
  }, [teamWeek, teams, getPoints]);

  // MVP: top scorer on the winning team
  const mvp = useMemo(() => {
    if (!teamWeek || !teams || !teamScores) return null;
    const winningTeamKey = teamScores.team1 >= teamScores.team2 ? "team1" : "team2";
    // If tied, both teams can have MVP
    const winningMembers = teams[winningTeamKey].members;
    if (winningMembers.every(m => getPoints(m, "weekly") === 0)) return null;
    let topMember = winningMembers[0];
    let topPts = getPoints(winningMembers[0], "weekly");
    for (let i = 1; i < winningMembers.length; i++) {
      const p = getPoints(winningMembers[i], "weekly");
      if (p > topPts) { topMember = winningMembers[i]; topPts = p; }
    }
    return topPts > 0 ? topMember : null;
  }, [teamWeek, teams, teamScores, getPoints]);

  const startRename = (teamKey) => {
    setRenamingTeam(teamKey);
    setRenameValue(getTeamName(teamKey));
  };

  const saveRename = () => {
    if (renamingTeam && renameValue.trim()) {
      const nameKey = `${weekStartKey}_${renamingTeam}`;
      setTeamName(nameKey, renameValue.trim());
    }
    setRenamingTeam(null);
    setRenameValue("");
  };

  return (
    <div>
      {/* Competition type badge */}
      <div style={{ textAlign: "center" }}>
        <span className={`competition-badge ${teamWeek ? "badge-team" : "badge-individual"}`}>
          {teamWeek ? "\u{1F46B} Team Week" : "\u{1F3C3} Individual Week"}
        </span>
      </div>

      {/* Prize Cards */}
      <PrizeDisplay prizes={prizes} setPrizes={setPrizes} weekStartKey={weekStartKey} period={period} awards={awards} teamWeek={teamWeek} />

      {/* Team standings (team weeks only, weekly period) */}
      {teamWeek && teams && period === "weekly" && teamScores && (
        <div className="animate-in" style={{ marginBottom: 16 }}>
          <div className={`team-card ${teamScores.team1 >= teamScores.team2 ? "winning" : ""}`} style={getTeamColor("team1") ? { borderColor: getTeamColor("team1") } : {}}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div className="team-name-row">
                  {renamingTeam === "team1" ? (
                    <input className="form-input" style={{ padding: "4px 8px", fontSize: "1rem", width: 180 }} value={renameValue} onChange={e => setRenameValue(e.target.value)} onKeyDown={e => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setRenamingTeam(null); }} onBlur={saveRename} autoFocus maxLength={30} />
                  ) : (
                    <>
                      <span className="team-name" style={getTeamColor("team1") ? { color: getTeamColor("team1") } : {}}>{getTeamName("team1")}</span>
                      <button className="team-edit-btn" onClick={() => startRename("team1")} title="Rename team"><Icons.Settings size={14} /></button>
                      <div className="color-option" style={{ width: 20, height: 20, background: getTeamColor("team1") || "var(--border)", cursor: "pointer", border: colorEditing === "team1" ? "2px solid white" : "2px solid transparent" }} onClick={() => setColorEditing(colorEditing === "team1" ? null : "team1")} title="Change team color" />
                    </>
                  )}
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Captain: {teams.team1.captain}</div>
                {colorEditing === "team1" && (
                  <div className="color-picker-grid" style={{ justifyContent: "flex-start", margin: "6px 0" }}>
                    {TEAM_COLORS.map(c => <div key={c.value} className={`color-option ${getTeamColor("team1") === c.value ? "selected" : ""}`} style={{ width: 24, height: 24, background: c.value }} onClick={() => { setTeamColor("team1", c.value); setColorEditing(null); }} />)}
                  </div>
                )}
              </div>
              <div className="team-score">{teamScores.team1}</div>
            </div>
            <div className="team-members">
              {teams.team1.members.map(m => {
                const mo = FAMILY_MEMBERS.find(f => f.name === m);
                return <span key={m} className="team-member-chip" style={{ borderLeft: `3px solid ${getTeamColor("team1") || mo?.color}` }}>{getMemberEmoji(m)} {m} {mvp === m && <span className="mvp-badge">⭐ MVP</span>}<span style={{ color: "var(--warning)", fontWeight: 800, marginLeft: 4 }}>{getPoints(m, "weekly")}</span></span>;
              })}
            </div>
          </div>

          <div className="team-vs">VS</div>

          <div className={`team-card ${teamScores.team2 > teamScores.team1 ? "winning" : ""}`} style={getTeamColor("team2") ? { borderColor: getTeamColor("team2") } : {}}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div className="team-name-row">
                  {renamingTeam === "team2" ? (
                    <input className="form-input" style={{ padding: "4px 8px", fontSize: "1rem", width: 180 }} value={renameValue} onChange={e => setRenameValue(e.target.value)} onKeyDown={e => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setRenamingTeam(null); }} onBlur={saveRename} autoFocus maxLength={30} />
                  ) : (
                    <>
                      <span className="team-name" style={getTeamColor("team2") ? { color: getTeamColor("team2") } : {}}>{getTeamName("team2")}</span>
                      <button className="team-edit-btn" onClick={() => startRename("team2")} title="Rename team"><Icons.Settings size={14} /></button>
                      <div className="color-option" style={{ width: 20, height: 20, background: getTeamColor("team2") || "var(--border)", cursor: "pointer", border: colorEditing === "team2" ? "2px solid white" : "2px solid transparent" }} onClick={() => setColorEditing(colorEditing === "team2" ? null : "team2")} title="Change team color" />
                    </>
                  )}
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Captain: {teams.team2.captain}</div>
                {colorEditing === "team2" && (
                  <div className="color-picker-grid" style={{ justifyContent: "flex-start", margin: "6px 0" }}>
                    {TEAM_COLORS.map(c => <div key={c.value} className={`color-option ${getTeamColor("team2") === c.value ? "selected" : ""}`} style={{ width: 24, height: 24, background: c.value }} onClick={() => { setTeamColor("team2", c.value); setColorEditing(null); }} />)}
                  </div>
                )}
              </div>
              <div className="team-score">{teamScores.team2}</div>
            </div>
            <div className="team-members">
              {teams.team2.members.map(m => {
                const mo = FAMILY_MEMBERS.find(f => f.name === m);
                return <span key={m} className="team-member-chip" style={{ borderLeft: `3px solid ${getTeamColor("team2") || mo?.color}` }}>{getMemberEmoji(m)} {m} {mvp === m && <span className="mvp-badge">⭐ MVP</span>}<span style={{ color: "var(--warning)", fontWeight: 800, marginLeft: 4 }}>{getPoints(m, "weekly")}</span></span>;
              })}
            </div>
          </div>
        </div>
      )}

      {/* Time period tabs */}
      <div className="time-tabs">
        {[["weekly","Week"],["monthly","Month"],["yearly","Year"],["alltime","All"]].map(([key, label]) => (
          <button key={key} className={`time-tab ${period === key ? "active" : ""}`} onClick={() => setPeriod(key)}>{label}</button>
        ))}
      </div>

      {/* Individual leaderboard */}
      <div className="card animate-in">
        <div className="card-title"><Icons.Trophy size={22} color="var(--warning)" />
          {period === "weekly" ? "This Week" : period === "monthly" ? "This Month" : period === "yearly" ? "This Year" : "All Time"}
        </div>
        {sorted.map((member, i) => {
          const pts = getPoints(member.name, period);
          const streak = computedStreaks?.[member.name] || 0;
          return (
            <div key={member.name} className="leaderboard-item animate-in">
              <div className="leaderboard-rank">{i < 3 ? medals[i] : `#${i + 1}`}</div>
              <div className="member-emoji" style={{ fontSize: "1.3rem", width: 36, height: 36 }}>{getMemberEmoji(member.name)}</div>
              <div style={{ flex: 1 }}>
                <div className="leaderboard-name" style={{ color: member.color }}>
                  {member.name}
                  {streak >= 30 ? <span className="streak-on-fire" style={{ marginLeft: 8 }}>🔥 {streak}d ON FIRE</span>
                   : streak >= 14 ? <span className="streak-fire streak-fire-3" style={{ marginLeft: 8 }}>🔥🔥🔥 {streak}d</span>
                   : streak >= 7 ? <span className="streak-fire streak-fire-2" style={{ marginLeft: 8 }}>🔥🔥 {streak}d</span>
                   : streak >= 3 ? <span className="streak-fire streak-fire-1" style={{ marginLeft: 8 }}>🔥 {streak}d</span>
                   : streak >= 1 ? <span className="streak-badge" style={{ marginLeft: 8 }}><Icons.Fire size={14} color="#fb923c" /> {streak}d</span>
                   : null}
                </div>
                <div className="leaderboard-bar"><div className="leaderboard-bar-fill" style={{ width: `${maxPts > 0 ? (pts / maxPts) * 100 : 0}%`, background: member.color }} /></div>
                {period !== "weekly" && (() => {
                  const wins = getAwardCounts(member.name, "win", period);
                  const mvps = getAwardCounts(member.name, "mvp", period);
                  return (wins > 0 || mvps > 0) ? (
                    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                      {wins > 0 && <span style={{ fontSize: "0.7rem", fontWeight: 700, color: "#fbbf24" }}>🏆 {wins} win{wins !== 1 ? "s" : ""}</span>}
                      {mvps > 0 && <span style={{ fontSize: "0.7rem", fontWeight: 700, color: "#a78bfa" }}>⭐ {mvps} MVP{mvps !== 1 ? "s" : ""}</span>}
                    </div>
                  ) : null;
                })()}
              </div>
              <div className="leaderboard-score"><Icons.Star size={18} color="#F59E0B" filled />{pts}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// ============================================================
// PRIZE DISPLAY (Points tab)
// ============================================================
function PrizeDisplay({ prizes, setPrizes, weekStartKey, period, awards, teamWeek }) {
  const [showConfetti, setShowConfetti] = useState(false);
  const [revealedPrizes, setRevealedPrizes] = useState({});

  const PRIZE_TYPES = [
    { key: "weekly", label: "Weekly Winner", icon: "🏆" },
    { key: "monthly", label: "Monthly Winner", icon: "📅" },
    ...(teamWeek ? [{ key: "team", label: "Winning Team", icon: "👫" }] : []),
    { key: "mvp", label: "MVP", icon: "⭐" },
  ];

  const isFinalized = Object.keys(awards || {}).some(k => k.startsWith(`win_${weekStartKey}_`));

  const triggerConfetti = () => {
    setShowConfetti(true);
    setTimeout(() => setShowConfetti(false), 3000);
  };

  const revealPrize = (prizeKey) => {
    if (!isFinalized) return;
    triggerConfetti();
    setRevealedPrizes(prev => ({ ...prev, [prizeKey]: true }));
  };

  // Get active prizes for current period
  const activePrizes = PRIZE_TYPES.map(t => {
    const pk = `${t.key}_${weekStartKey}`;
    const prize = prizes?.[pk];
    if (!prize) return null;
    return { ...t, prize, pk };
  }).filter(Boolean);

  if (activePrizes.length === 0) return null;

  return (
    <>
      {showConfetti && (
        <div className="confetti-container">
          {Array.from({ length: 40 }, (_, i) => (
            <div key={i} className="confetti-piece" style={{
              left: `${Math.random() * 100}%`,
              top: `-5%`,
              background: ["#f59e0b", "#ef4444", "#3b82f6", "#10b981", "#8b5cf6", "#ec4899"][i % 6],
              width: `${6 + Math.random() * 8}px`,
              height: `${6 + Math.random() * 8}px`,
              borderRadius: Math.random() > 0.5 ? "50%" : "2px",
              animationDuration: `${2 + Math.random() * 2}s`,
              animationDelay: `${Math.random() * 0.5}s`,
            }} />
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        {activePrizes.map(({ key, label, icon, prize, pk }) => {
          const isMystery = prize.mystery;
          const isRevealed = revealedPrizes[pk];
          const canReveal = isFinalized && isMystery && !isRevealed;

          return (
            <div key={pk} className={`prize-card ${isFinalized ? "has-winner" : ""}`} style={{ flex: "1 1 calc(50% - 4px)", minWidth: 150 }}>
              <div className="prize-type">{icon} {label}</div>
              {isMystery && !isRevealed ? (
                <div className={`mystery-box ${canReveal ? "unlocked" : "locked"}`} onClick={() => canReveal && revealPrize(pk)}>
                  <div className="mystery-box-icon">🎁</div>
                  <div className="mystery-box-text">{canReveal ? "Tap to reveal!" : "Mystery Prize"}</div>
                </div>
              ) : (
                <div className={isRevealed ? "prize-revealed" : ""}>
                  <div className="prize-value">{prize.text || "TBD"}</div>
                </div>
              )}
              {!isFinalized && <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 6 }}>🔒 Winner not decided yet</div>}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ============================================================
// TEAM NAMING MODAL
// ============================================================
function TeamNamingModal({ teamKey, captain, nameKey, getMemberEmoji, onName, onColor, onClose }) {
  const [name, setName] = useState("");
  const [selectedColor, setSelectedColor] = useState(TEAM_COLORS[5].value);
  const member = FAMILY_MEMBERS.find(m => m.name === captain);
  const handleSave = () => {
    onColor(selectedColor);
    onName(nameKey, name.trim() || (teamKey === "team1" ? "Team 1" : "Team 2"));
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ textAlign: "center" }}>
        <div style={{ fontSize: "2.5rem", marginBottom: 8 }}>{getMemberEmoji(captain)}</div>
        <div className="pin-title" style={{ color: member?.color }}>{captain}, you're Team Captain!</div>
        <div className="pin-subtitle">Name your team and pick a color!</div>
        <div className="form-group">
          <input className="form-input" type="text" placeholder="Enter a team name..." maxLength={30} value={name} onChange={e => setName(e.target.value)} autoFocus onKeyDown={e => { if (e.key === "Enter") handleSave(); }} />
        </div>
        <div className="form-group">
          <label className="form-label" style={{ textAlign: "center" }}>Team Color</label>
          <div className="color-picker-grid">
            {TEAM_COLORS.map(c => (
              <div key={c.value} className={`color-option ${selectedColor === c.value ? "selected" : ""}`} style={{ background: c.value }} onClick={() => setSelectedColor(c.value)} title={c.name} />
            ))}
          </div>
        </div>
        <div className="form-actions" style={{ justifyContent: "center" }}>
          <button className="btn btn-ghost" onClick={() => { onColor(selectedColor); onName(nameKey, teamKey === "team1" ? "Team 1" : "Team 2"); }}>Skip</button>
          <button className="btn btn-primary" style={{ background: selectedColor }} onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// ADD TASK MODAL
// ============================================================
function AddTaskModal({ onAdd, onClose, todayKey }) {
  const [desc, setDesc] = useState("");
  const [assignee, setAssignee] = useState(FAMILY_MEMBERS[0].name);
  const [pts, setPts] = useState(1);
  const [date, setDate] = useState(todayKey);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title"><span>Add Custom Task</span><button className="btn btn-ghost" onClick={onClose} style={{ padding: 4 }}><Icons.X size={20} /></button></div>
        <div className="form-group"><label className="form-label">Task Description</label><input className="form-input" placeholder="What needs doing?" value={desc} onChange={e => setDesc(e.target.value)} autoFocus /></div>
        <div className="form-group"><label className="form-label">Assign To</label><select className="form-select" value={assignee} onChange={e => setAssignee(e.target.value)}>{FAMILY_MEMBERS.map(m => <option key={m.name} value={m.name}>{m.emoji} {m.name}</option>)}</select></div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Points</label><input className="form-input" type="number" min={1} max={50} value={pts} onChange={e => setPts(Math.min(50, Math.max(1, parseInt(e.target.value) || 1)))} /></div>
          <div className="form-group"><label className="form-label">Due Date</label><input className="form-input" type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
        </div>
        <div className="form-actions"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => { if (desc.trim()) onAdd({ description: desc.trim(), assignee, points: pts, date }); }} disabled={!desc.trim()}>Add Task</button></div>
      </div>
    </div>
  );
}

// ============================================================
// WEEK VIEW
// ============================================================
function WeekView({ today, weekOffset, setWeekOffset, getChoresForDate, isChoreCompleteForDate, toggleChoreForDate, getMemberEmoji, getPoints, computedStreaks, isParent, deleteCustomTask, teamWeek, getTeamForMember, getTeamName, getTeamColor }) {
  const [selectedDay, setSelectedDay] = useState(null); // Date object or null
  const weekStart = useMemo(() => { const d = getWeekStart(today); d.setDate(d.getDate() + weekOffset * 7); return d; }, [today, weekOffset]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(d.getDate() + i); return d; }), [weekStart]);
  const weekLabel = `${days[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })} - ${days[6].toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  const rotation = getCurrentWeekRotation(weekStart);

  // Clear selection when changing weeks
  const prevWeekOffset = useRef(weekOffset);
  useEffect(() => { if (prevWeekOffset.current !== weekOffset) { setSelectedDay(null); prevWeekOffset.current = weekOffset; } }, [weekOffset]);

  const selectedDayKey = selectedDay ? dateToKey(selectedDay) : null;

  return (
    <div>
      <div className="week-nav">
        <button className="week-nav-btn" onClick={() => setWeekOffset(o => o - 1)}><Icons.ChevronLeft size={20} /></button>
        <span className="week-label">{weekLabel}</span>
        <button className="week-nav-btn" onClick={() => setWeekOffset(o => o + 1)}><Icons.ChevronRight size={20} /></button>
      </div>
      <div className="week-grid">
        {days.map((date) => {
          const dn = getDayName(date);
          const dk = dateToKey(date);
          const isToday = dk === dateToKey(today);
          const isSelected = dk === selectedDayKey;
          return (
            <div key={dk} className={`day-col ${isToday ? "today" : ""} ${isSelected ? "day-col-selected" : ""}`} onClick={() => setSelectedDay(isSelected ? null : date)} style={{ cursor: "pointer" }}>
              <div className="day-col-header">
                <div className="day-name">{dn.slice(0, 3)}</div>
                <div className="day-date-num">{date.getDate()}</div>
                {isSelected && <div style={{ fontSize: "0.6rem", color: "var(--accent)", fontWeight: 700, marginTop: 2 }}>VIEWING</div>}
              </div>
              {FAMILY_MEMBERS.map(member => {
                const daily = DAILY_CHORES[member.name]?.[dn];
                if (!daily) return null;
                let label = "";
                if (daily.type === "dishes") label = "Dishes";
                else if (daily.type === "zone") label = daily.zone.split("/")[0];
                else if (daily.type === "young") label = daily.task.split("/")[0];
                const chart = getChartAssignment(member.name, date);
                const hkTask = (dn !== "Sunday" && dn !== "Friday" && dn !== "Saturday") ? chart.tasks[dn] : null;
                const isLaundryDay = LAUNDRY_DAYS[member.name] === dn;
                return (
                  <div key={member.name} className="day-member">
                    <div className="day-member-dot" style={{ background: member.color }} />
                    <div>
                      <div style={{ fontSize: "0.78rem", fontWeight: 700 }}>{member.name}</div>
                      <div className="day-member-chore">{label}</div>
                      {hkTask && <div className="day-member-chore" style={{ color: "#2dd4bf" }}>{hkTask.length > 25 ? hkTask.slice(0, 25) + "..." : hkTask}</div>}
                      {isLaundryDay && <div className="day-member-chore" style={{ color: "#c084fc" }}>🧺 Laundry</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Day Detail Panel — like Today view but for the selected day */}
      {selectedDay && (
        <div className="day-detail-panel animate-in">
          <div className="day-detail-header">
            <div className="day-detail-title">
              <Icons.Calendar size={20} color="var(--accent)" />
              {selectedDay.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            </div>
            <button className="btn btn-ghost" onClick={() => setSelectedDay(null)} style={{ padding: 4 }}><Icons.X size={20} /></button>
          </div>
          {FAMILY_MEMBERS.map((member) => {
            const chores = getChoresForDate(member.name, selectedDay);
            if (chores.length === 0) return null;
            const doneCount = chores.filter(c => isChoreCompleteForDate(member.name, c.id, selectedDay)).length;
            const allDone = chores.length > 0 && doneCount === chores.length;
            const emoji = getMemberEmoji(member.name);
            const streak = computedStreaks?.[member.name] || 0;
            const team = getTeamForMember ? getTeamForMember(member.name) : null;
            const teamColor = team && getTeamColor ? getTeamColor(team.key) : null;
            const cardBorderColor = teamColor || member.color;
            return (
              <div key={member.name} className="member-card animate-in" style={{ borderLeftColor: cardBorderColor }}>
                <div className="member-header">
                  <div className="member-name-row">
                    <div className="member-emoji">{emoji}</div>
                    <div>
                      <div className="member-name" style={{ color: member.color }}>
                        {member.name}
                        {teamWeek && team && getTeamName && <span className="team-badge-mini" style={{ background: `${teamColor || "var(--border)"}22`, color: teamColor || "var(--text-muted)", border: `1px solid ${teamColor || "var(--border)"}` }}>{getTeamName(team.key)}</span>}
                        {streak >= 30 ? <span className="streak-on-fire">🔥 {streak}d ON FIRE</span>
                         : streak >= 14 ? <span className="streak-fire streak-fire-3" title={`${streak}-day streak!`}>🔥🔥🔥 {streak}d</span>
                         : streak >= 7 ? <span className="streak-fire streak-fire-2" title={`${streak}-day streak!`}>🔥🔥 {streak}d</span>
                         : streak >= 3 ? <span className="streak-fire streak-fire-1" title={`${streak}-day streak!`}>🔥 {streak}d</span>
                         : null}
                      </div>
                      <div style={{ fontSize: "0.8rem", color: allDone ? "#10B981" : "var(--text-muted)", fontWeight: 600 }}>
                        {allDone ? "All done!" : `${doneCount}/${chores.length} complete`}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="chore-list">
                  {chores.map((chore) => {
                    const completed = isChoreCompleteForDate(member.name, chore.id, selectedDay);
                    const isCustom = chore.tag === "custom";
                    return (
                      <div key={chore.id} className={`chore-item ${completed ? "completed" : ""}`} onClick={(e) => { e.stopPropagation(); toggleChoreForDate(member.name, chore.id, selectedDay, chore.pointValue || 1); }}>
                        <div className={`chore-checkbox ${completed ? "checked check-pop" : ""}`}>{completed && <Icons.Check size={16} color="white" />}</div>
                        <span className="chore-text">{chore.text}</span>
                        {isCustom && chore.pointValue > 1 && <span className="chore-points-badge">+{chore.pointValue}</span>}
                        <span className={`chore-tag tag-${chore.tag}`}>{chore.tag}</span>
                        {isParent && isCustom && <button className="chore-delete-btn" onClick={(e) => { e.stopPropagation(); deleteCustomTask(chore.taskKey); }} title="Delete task"><Icons.X size={16} /></button>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// ROTATION VIEW
// ============================================================
function RotationView({ today, weekRotation }) {
  const [rotationOffset, setRotationOffset] = useState(0);
  const member = (name) => FAMILY_MEMBERS.find(m => m.name === name);

  // Show 4 weeks at a time starting from offset
  const weeks = useMemo(() => {
    const result = [];
    for (let i = 0; i < 4; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + (rotationOffset + i) * 7);
      const ws = getWeekStart(d);
      const rot = getCurrentWeekRotation(ws);
      const isCurrent = dateToKey(getWeekStart(today)) === dateToKey(ws);
      result.push({ date: ws, rotation: rot, isCurrent });
    }
    return result;
  }, [today, rotationOffset]);

  return (
    <div>
      <div className="week-nav">
        <button className="week-nav-btn" onClick={() => setRotationOffset(o => o - 4)}><Icons.ChevronLeft size={20} /></button>
        <span className="week-label">Rotation Schedule</span>
        <button className="week-nav-btn" onClick={() => setRotationOffset(o => o + 4)}><Icons.ChevronRight size={20} /></button>
      </div>
      {weeks.map(({ date, rotation, isCurrent }) => {
        if (!rotation) return null;
        const weekLabel = `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} - ${new Date(date.getTime() + 6*24*60*60*1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
        const tasks = [
          { icon: "🗑️", task: "Collect Trash", person: rotation.collectTrash },
          { icon: "🚛", task: "Take Trash Out", person: rotation.trashOut },
          { icon: "🫧", task: "Refill Soap", person: rotation.refillSoap },
          { icon: "🧻", task: "Toilet Paper", person: rotation.toiletPaper },
          { icon: "🗑️", task: "Bring Cans In", person: rotation.bringCansIn },
        ];
        return (
          <div key={dateToKey(date)} className="card animate-in" style={isCurrent ? { borderColor: "var(--accent)", borderWidth: 2 } : {}}>
            <div className="card-title">
              <Icons.Recycle size={18} color={isCurrent ? "var(--accent)" : "var(--success)"} />
              <span>{weekLabel}</span>
              {isCurrent && <span style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--accent)", background: "rgba(59,130,246,0.1)", padding: "2px 8px", borderRadius: 6 }}>THIS WEEK</span>}
            </div>
            <div style={{ marginBottom: 12, display: "flex", justifyContent: "center" }}>
              <span className={`recycle-badge ${rotation.recycle ? "recycle-yes" : "recycle-no"}`}>
                <Icons.Recycle size={14} /> Recycling: {rotation.recycle ? "YES" : "No"}
              </span>
            </div>
            <div className="weekly-grid">
              {tasks.map((t) => {
                const m = member(t.person);
                return (
                  <div key={t.task} className="weekly-item">
                    <div className="weekly-icon">{t.icon}</div>
                    <div className="weekly-info">
                      <div className="weekly-task">{t.task}</div>
                      <div className="weekly-person" style={{ color: m?.color }}>{m?.emoji} {t.person}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// HISTORY VIEW
// ============================================================
function HistoryView({ awards, points, teamNames, getMemberEmoji, today }) {
  // Parse awards to get all finalized weeks
  const pastWeeks = useMemo(() => {
    if (!awards || awards._empty) return [];
    const weekMap = {};
    for (const key of Object.keys(awards)) {
      if (key === "_empty") continue;
      const isWin = key.startsWith("win_");
      const isMvp = key.startsWith("mvp_");
      if (!isWin && !isMvp) continue;
      const prefix = isWin ? "win_" : "mvp_";
      const rest = key.slice(prefix.length);
      // rest is like "2026-02-16_Nicholas" — find the last underscore that separates weekKey from name
      const lastUnderscore = rest.lastIndexOf("_");
      if (lastUnderscore === -1) continue;
      const weekKey = rest.slice(0, lastUnderscore);
      const member = rest.slice(lastUnderscore + 1);
      if (!weekMap[weekKey]) weekMap[weekKey] = { weekKey, winner: null, mvp: null };
      if (isWin) weekMap[weekKey].winner = member;
      if (isMvp) weekMap[weekKey].mvp = member;
    }
    // Sort by week descending (most recent first)
    return Object.values(weekMap).sort((a, b) => b.weekKey.localeCompare(a.weekKey));
  }, [awards]);

  // For each past week, get the scores from the points object
  const getWeekScores = useCallback((weekKey) => {
    if (!points || points._empty) return [];
    const scores = FAMILY_MEMBERS.map(m => {
      const key = `w_${weekKey}_${m.name}`;
      return { name: m.name, color: m.color, points: points[key] || 0 };
    }).sort((a, b) => b.points - a.points);
    return scores;
  }, [points]);

  // Check if a week was a team week and get team info
  const getWeekTeamInfo = useCallback((weekKey) => {
    const weekDate = new Date(weekKey + "T00:00:00");
    const wasTeamWeek = isTeamWeek(weekDate);
    if (!wasTeamWeek) return null;
    const teams = getTeamsForWeek(weekDate);
    const t1Name = teamNames?.[`${weekKey}_team1`] || "Team 1";
    const t2Name = teamNames?.[`${weekKey}_team2`] || "Team 2";
    return { teams, t1Name, t2Name };
  }, [teamNames]);

  const formatWeekLabel = (weekKey) => {
    const d = new Date(weekKey + "T00:00:00");
    const end = new Date(d);
    end.setDate(end.getDate() + 6);
    const opts = { month: "short", day: "numeric" };
    return `${d.toLocaleDateString("en-US", opts)} – ${end.toLocaleDateString("en-US", opts)}`;
  };

  const currentWeekKey = dateToKey(getWeekStart(today));

  // Build all-time stats
  const allTimeStats = useMemo(() => {
    const stats = {};
    for (const m of FAMILY_MEMBERS) {
      stats[m.name] = { wins: 0, mvps: 0 };
    }
    for (const week of pastWeeks) {
      if (week.winner && stats[week.winner]) stats[week.winner].wins++;
      if (week.mvp && stats[week.mvp]) stats[week.mvp].mvps++;
    }
    return Object.entries(stats)
      .map(([name, s]) => ({ name, ...s, total: s.wins * 2 + s.mvps }))
      .sort((a, b) => b.total - a.total || b.wins - a.wins);
  }, [pastWeeks]);

  return (
    <div>
      {/* All-Time Hall of Fame */}
      <div className="card animate-in">
        <div className="card-title"><Icons.Trophy size={22} color="#fbbf24" /> Hall of Fame</div>
        {allTimeStats.length > 0 ? (
          <div className="history-hall-of-fame">
            {allTimeStats.map((s, i) => {
              const member = FAMILY_MEMBERS.find(m => m.name === s.name);
              return (
                <div key={s.name} className="hall-of-fame-item" style={{ borderLeftColor: member?.color }}>
                  <div className="hall-of-fame-rank">{i === 0 ? "\u{1F947}" : i === 1 ? "\u{1F948}" : i === 2 ? "\u{1F949}" : `#${i+1}`}</div>
                  <div className="hall-of-fame-emoji">{getMemberEmoji(s.name)}</div>
                  <div className="hall-of-fame-info">
                    <div className="hall-of-fame-name" style={{ color: member?.color }}>{s.name}</div>
                    <div className="hall-of-fame-stats">
                      {s.wins > 0 && <span className="hof-stat hof-wins">{"\u{1F3C6}"} {s.wins} win{s.wins !== 1 ? "s" : ""}</span>}
                      {s.mvps > 0 && <span className="hof-stat hof-mvps">{"\u2B50"} {s.mvps} MVP{s.mvps !== 1 ? "s" : ""}</span>}
                      {s.wins === 0 && s.mvps === 0 && <span className="hof-stat" style={{ color: "var(--text-muted)" }}>No awards yet</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ textAlign: "center", color: "var(--text-muted)", padding: 20 }}>No finalized weeks yet</div>
        )}
      </div>

      {/* Week-by-week results */}
      <div className="card-title" style={{ padding: "0 4px", marginBottom: 12 }}><Icons.History size={22} color="var(--accent)" /> Past Weeks</div>
      {pastWeeks.length === 0 ? (
        <div className="card"><div style={{ textAlign: "center", color: "var(--text-muted)", padding: 20 }}>No finalized weeks yet. Results appear here after the admin finalizes each week.</div></div>
      ) : pastWeeks.map(week => {
        const scores = getWeekScores(week.weekKey);
        const teamInfo = getWeekTeamInfo(week.weekKey);
        const isCurrent = week.weekKey === currentWeekKey;
        const maxPts = Math.max(1, ...scores.map(s => s.points));
        return (
          <div key={week.weekKey} className={`card animate-in history-week-card ${isCurrent ? "history-current" : ""}`}>
            <div className="history-week-header">
              <div>
                <div className="history-week-date">{formatWeekLabel(week.weekKey)}</div>
                <div className="history-week-type">
                  {teamInfo ? (
                    <span className="competition-badge badge-team" style={{ fontSize: "0.65rem", padding: "2px 8px" }}>{"\u{1F46B}"} {teamInfo.t1Name} vs {teamInfo.t2Name}</span>
                  ) : (
                    <span className="competition-badge badge-individual" style={{ fontSize: "0.65rem", padding: "2px 8px" }}>{"\u{1F3C3}"} Individual</span>
                  )}
                  {isCurrent && <span className="history-current-badge">CURRENT</span>}
                </div>
              </div>
              <div className="history-awards">
                {week.winner && <div className="history-award">{"\u{1F3C6}"} {getMemberEmoji(week.winner)} {week.winner}</div>}
                {week.mvp && <div className="history-award">{"\u2B50"} {getMemberEmoji(week.mvp)} {week.mvp}</div>}
              </div>
            </div>
            {/* Score bars */}
            <div className="history-scores">
              {scores.map(s => {
                const member = FAMILY_MEMBERS.find(m => m.name === s.name);
                return (
                  <div key={s.name} className="history-score-row">
                    <div className="history-score-name">
                      <span style={{ fontSize: "0.9rem" }}>{getMemberEmoji(s.name)}</span>
                      <span style={{ color: member?.color, fontWeight: 700, fontSize: "0.8rem" }}>{s.name}</span>
                      {s.name === week.winner && <span style={{ fontSize: "0.7rem" }}>{"\u{1F3C6}"}</span>}
                      {s.name === week.mvp && <span style={{ fontSize: "0.7rem" }}>{"\u2B50"}</span>}
                    </div>
                    <div className="history-score-bar-wrapper">
                      <div className="history-score-bar" style={{ width: `${maxPts > 0 ? (s.points / maxPts) * 100 : 0}%`, background: member?.color || "var(--accent)" }} />
                    </div>
                    <div className="history-score-pts">{s.points}</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// WEB AUDIO ALARM (generates alarm tone without external files)
// ============================================================
function playAlarm() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const playTone = (freq, startTime, dur) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = "square";
      gain.gain.setValueAtTime(0.3, startTime);
      gain.gain.exponentialRampToValueAtTime(0.01, startTime + dur);
      osc.start(startTime);
      osc.stop(startTime + dur);
    };
    // Play an alarm pattern: 3 beeps, pause, repeat
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 3; i++) {
        playTone(880, ctx.currentTime + r * 1.5 + i * 0.3, 0.2);
      }
    }
    setTimeout(() => ctx.close(), 5000);
  } catch (e) { console.warn("Audio alarm failed:", e); }
}

function sendLocalNotification(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body, icon: "/icons/icon-192.png", tag: "game-timer" });
  }
}

// ============================================================
// TIMES UP OVERLAY
// ============================================================
function TimesUpOverlay({ member, memberEmoji, onDismiss }) {
  const [pin, setPin] = useState(["", "", "", ""]);
  const [error, setError] = useState(false);
  const refs = [useRef(), useRef(), useRef(), useRef()];
  useEffect(() => { refs[0].current?.focus(); playAlarm(); }, []);

  const handleChange = (i, val) => {
    if (!/^\d*$/.test(val)) return;
    const newPin = [...pin]; newPin[i] = val.slice(-1);
    setPin(newPin); setError(false);
    if (val && i < 3) refs[i + 1].current?.focus();
    const full = newPin.join("");
    if (full.length === 4) {
      if (full === PARENT_PIN) { onDismiss(); }
      else { setError(true); setPin(["", "", "", ""]); setTimeout(() => refs[0].current?.focus(), 100); }
    }
  };

  return (
    <div className="times-up-overlay">
      <div className="times-up-emoji">{memberEmoji} ⏰</div>
      <div className="times-up-text">TIME'S UP!</div>
      <div className="times-up-sub">{member}'s video game time is over</div>
      <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: 12 }}>Enter parent PIN to dismiss</div>
      <div className="times-up-pin">
        {pin.map((d, i) => (
          <input key={i} ref={refs[i]} type="tel" inputMode="numeric" maxLength={1} value={d}
            onChange={e => handleChange(i, e.target.value)}
            onKeyDown={e => { if (e.key === "Backspace" && !d && i > 0) refs[i - 1].current?.focus(); }}
            style={error ? { borderColor: "#EF4444" } : {}} />
        ))}
      </div>
      {error && <div style={{ color: "#f87171", fontSize: "0.85rem", fontWeight: 600, marginTop: 4 }}>Wrong PIN</div>}
    </div>
  );
}

// ============================================================
// GAME VIEW (🎮 Tab)
// ============================================================
function GameView({ members, getVideoGameStatus, getMemberEmoji, gameTimers, startTimer, pauseTimer, stopTimer, adjustTimer, isParent, toggleGameUnlock, setTimesUpMember }) {
  const [, forceUpdate] = useState(0);

  // Tick every second to update live countdowns
  useEffect(() => {
    const interval = setInterval(() => forceUpdate(n => n + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Request notification permission on first render
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  const getTimerRemaining = (member) => {
    const timer = gameTimers?.[member];
    if (!timer || !timer.active) return timer?.remaining || 0;
    if (timer.pausedAt) return timer.remaining;
    const elapsed = Math.floor((Date.now() - timer.startedAt) / 1000);
    return Math.max(0, timer.remaining - elapsed);
  };

  const getTimerState = (member) => {
    const timer = gameTimers?.[member];
    if (!timer || !timer.active) return "idle";
    if (timer.pausedAt) return "paused";
    const remaining = getTimerRemaining(member);
    if (remaining <= 0) return "expired";
    return "running";
  };

  const formatTime = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  // Check for expired timers and trigger TIMES UP
  useEffect(() => {
    members.forEach(member => {
      const state = getTimerState(member.name);
      const timer = gameTimers?.[member.name];
      if (state === "expired" && timer?.active) {
        setTimesUpMember(member.name);
        playAlarm();
        sendLocalNotification("Time's Up!", `${member.name}'s video game time is over!`);
        stopTimer(member.name);
      }
    });
  });

  return (
    <div>
      <div className="card">
        <div className="card-title" style={{ fontSize: "1.3rem" }}>🎮 Video Games</div>
        <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: 16 }}>
          {isVideoGameDay(new Date()) ? "Today is a game day! Check your status below." : "Games are available on Fridays & Saturdays (and school days off)."}
        </div>
      </div>

      {members.map(member => {
        const gs = getVideoGameStatus(member.name);
        const emoji = getMemberEmoji(member.name);
        const timerState = getTimerState(member.name);
        const remaining = getTimerRemaining(member.name);
        const timer = gameTimers?.[member.name];
        const duration = timer?.duration || 7200;
        const pct = duration > 0 ? (remaining / duration) * 100 : 0;

        return (
          <div key={member.name} className="game-tab-card" style={{ borderLeftColor: member.color }}>
            <div className="member-header" style={{ marginBottom: 8 }}>
              <div className="member-name-row">
                <div className="member-emoji">{emoji}</div>
                <div>
                  <div className="member-name" style={{ color: member.color }}>
                    {member.name}
                    <span className={`game-unlock-badge ${gs.unlocked ? (gs.parentOverride ? "override" : "unlocked") : "locked"}`}>
                      <span className="game-unlock-icon">🎮</span>
                      <span className="game-lock-icon">{gs.unlocked ? "🔓" : "🔒"}</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Status messages */}
            {!gs.gameDay && !gs.parentOverride && (
              <div className="game-status-msg not-today">📅 Not a game day — games available on Fridays, Saturdays & days off</div>
            )}
            {gs.gameDay && !gs.choresComplete && !gs.parentOverride && (
              <div className="game-status-msg locked">
                🔒 Last week's chores incomplete — HK: {gs.housekeepingPct}% (need 100%) · Dinner: {gs.dinnerPct}% (need 90%)
              </div>
            )}

            {/* Timer section - only show if unlocked */}
            {gs.unlocked && (
              <>
                <div className={`game-timer-display ${timerState}`}>
                  {timerState === "idle" ? formatTime(duration) : formatTime(remaining)}
                </div>
                {timerState !== "idle" && (
                  <div className="game-timer-bar">
                    <div className="game-timer-bar-fill" style={{
                      width: `${pct}%`,
                      background: pct > 25 ? "linear-gradient(90deg, #10B981, #34d399)" : pct > 10 ? "#F59E0B" : "#EF4444"
                    }} />
                  </div>
                )}
                <div className="game-timer-controls">
                  {timerState === "idle" && (
                    <button className="game-timer-btn start" onClick={() => startTimer(member.name)}>▶️ Start Timer</button>
                  )}
                  {timerState === "running" && (
                    <button className="game-timer-btn pause" onClick={() => { pauseTimer(member.name); sendLocalNotification("Timer Paused", `${member.name} paused their game timer`); }}>⏸️ Pause</button>
                  )}
                  {timerState === "paused" && (
                    <>
                      <button className="game-timer-btn start" onClick={() => startTimer(member.name)}>▶️ Resume</button>
                      <button className="game-timer-btn stop" onClick={() => stopTimer(member.name)}>⏹️ End</button>
                    </>
                  )}
                  {timerState === "running" && (
                    <button className="game-timer-btn stop" onClick={() => stopTimer(member.name)}>⏹️ End Session</button>
                  )}
                </div>
                {/* Parent time adjustments */}
                {isParent && (
                  <div className="game-adjust-row">
                    <button className="game-adjust-btn" onClick={() => adjustTimer(member.name, -30)}>-30m</button>
                    <button className="game-adjust-btn" onClick={() => adjustTimer(member.name, -15)}>-15m</button>
                    <button className="game-adjust-btn" onClick={() => adjustTimer(member.name, 15)}>+15m</button>
                    <button className="game-adjust-btn" onClick={() => adjustTimer(member.name, 30)}>+30m</button>
                  </div>
                )}
                {isParent && (
                  <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
                    <button className={`admin-unlock-toggle ${gs.unlocked ? "lock" : "unlock"}`} onClick={() => toggleGameUnlock(member.name)}>
                      {gs.parentOverride ? "↩️ Remove Override" : gs.unlocked ? "🔒 Lock Games" : "🔓 Override Unlock"}
                    </button>
                  </div>
                )}
              </>
            )}

            {/* If locked, parent can override */}
            {!gs.unlocked && isParent && (
              <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
                <button className="admin-unlock-toggle unlock" onClick={() => toggleGameUnlock(member.name)}>🔓 Override Unlock</button>
              </div>
            )}
          </div>
        );
      })}

      {/* Family timer overview */}
      <div className="card">
        <div className="card-title">👀 Active Timers</div>
        <div className="game-family-timers">
          {members.map(member => {
            const timerState = getTimerState(member.name);
            const remaining = getTimerRemaining(member.name);
            const emoji = getMemberEmoji(member.name);
            return (
              <div key={member.name} className="game-family-timer-row">
                <div className="game-family-timer-name">
                  <span>{emoji}</span>
                  <span style={{ color: member.color }}>{member.name}</span>
                </div>
                <div className="game-family-timer-status" style={{
                  color: timerState === "running" ? "#34d399" : timerState === "paused" ? "#fbbf24" : "var(--text-muted)"
                }}>
                  {timerState === "running" && <>🟢 {formatTime(remaining)}</>}
                  {timerState === "paused" && <>⏸️ {formatTime(remaining)} paused</>}
                  {timerState === "idle" && <>⚫ Not playing</>}
                  {timerState === "expired" && <>🔴 Time's up</>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// ADMIN VIEW
// ============================================================
function AdminView({ points, setPoints, completedChores, setCompletedChores, streaks, setStreaks, customTasks, deleteCustomTask, getPoints, addPoints, recordWeekAwards, prizes, setPrizes, weekStartKey, monthKey, awards, setAwards, getVideoGameStatus, toggleGameUnlock, chorePhotos, deleteChorePhoto, setPhotoViewer, getMemberEmoji }) {
  const [awardMsg, setAwardMsg] = useState("");

  // Get today's photos for review
  const todayPhotos = useMemo(() => {
    if (!chorePhotos) return [];
    return Object.entries(chorePhotos)
      .filter(([k]) => k !== "_empty")
      .map(([key, photo]) => {
        const parts = key.split("_");
        // key format: YYYY-MM-DD_MemberName_choreId
        const dateStr = parts[0];
        const member = parts.slice(1, -1).join("_"); // handle names with underscores
        const choreId = parts[parts.length - 1];
        return { key, ...photo, dateStr, member, choreId };
      })
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }, [chorePhotos]);

  return (
    <div>
      <div className="card">
        <div className="card-title"><Icons.Camera size={22} color="#10B981" /> Chore Photo Proof {todayPhotos.length > 0 ? `(${todayPhotos.length})` : ""}</div>
        {todayPhotos.length === 0 ? (
          <div style={{ textAlign: "center", padding: "16px 0", color: "var(--text-muted)", fontSize: "0.85rem", fontWeight: 600 }}>
            <div style={{ fontSize: "2rem", marginBottom: 8 }}>📷</div>
            No photos yet. Kids can tap the camera icon on completed chores to add proof.
          </div>
        ) : (
          <div className="admin-photo-grid">
            {todayPhotos.map(p => (
              <div key={p.key} className="admin-photo-card">
                <img src={p.url} alt="proof" onClick={() => setPhotoViewer({ url: p.url, member: p.member, chore: p.choreId })} />
                <div className="admin-photo-card-info">
                  <div className="admin-photo-card-name">{getMemberEmoji(p.member)} {p.member}</div>
                  <div>{p.choreId} · {p.dateStr}</div>
                  <button style={{ marginTop: 4, fontSize: "0.65rem", padding: "2px 8px", borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.1)", color: "#f87171", cursor: "pointer", fontWeight: 700 }} onClick={() => deleteChorePhoto(p.key)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <div className="card-title"><Icons.Settings size={22} color="var(--accent)" /> Point Management</div>
        <div className="admin-section">
          <div className="admin-section-title">Adjust Weekly Points</div>
          {FAMILY_MEMBERS.map(member => {
            const pts = getPoints(member.name, "weekly");
            return (
              <div key={member.name} className="admin-row">
                <label style={{ color: member.color }}>{member.emoji} {member.name}</label>
                <div className="points-adjust">
                  <button className="points-adjust-btn" onClick={() => addPoints(member.name, -1)}>-</button>
                  <span className="points-value">{pts}</span>
                  <button className="points-adjust-btn" onClick={() => addPoints(member.name, 1)}>+</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Custom Tasks */}
      {customTasks && !customTasks._empty && Object.keys(customTasks).filter(k => k !== "_empty").length > 0 && (
        <div className="card">
          <div className="card-title"><Icons.Star size={22} color="var(--warning)" /> Custom Tasks</div>
          {Object.entries(customTasks).filter(([k]) => k !== "_empty").map(([key, task]) => {
            const m = FAMILY_MEMBERS.find(f => f.name === task.assignee);
            return (
              <div key={key} className="admin-row">
                <div>
                  <div style={{ fontWeight: 700 }}>{task.description}</div>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                    <span style={{ color: m?.color }}>{task.assignee}</span> · {task.points} pts · {task.date}
                  </div>
                </div>
                <button className="btn btn-danger" onClick={() => deleteCustomTask(key)} style={{ padding: "6px 10px", fontSize: "0.75rem" }}><Icons.Trash size={14} /> Delete</button>
              </div>
            );
          })}
        </div>
      )}

      {/* Set Prizes */}
      <div className="card">
        <div className="card-title">🎁 Set Prizes</div>
        <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: 12 }}>
          Set prizes for this week's competitions. Toggle mystery box to hide the prize until revealed!
        </div>
        {[
          { key: "weekly", label: "Weekly Winner Prize", icon: "🏆" },
          { key: "monthly", label: "Monthly Winner Prize", icon: "📅" },
          { key: "team", label: "Winning Team Prize", icon: "👫" },
          { key: "mvp", label: "MVP Prize", icon: "⭐" },
        ].map(({ key, label, icon }) => {
          const pk = `${key}_${weekStartKey}`;
          const current = prizes?.[pk] || {};
          return (
            <div key={pk} style={{ marginBottom: 12, padding: 12, background: "rgba(255,255,255,0.03)", borderRadius: 10 }}>
              <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-secondary)", marginBottom: 6 }}>{icon} {label}</div>
              <div className="prize-form-row">
                <input className="form-input" style={{ flex: 1 }} placeholder="e.g. Ice cream trip!" value={current.text || ""} onChange={e => {
                  setPrizes(prev => { const u = { ...prev }; delete u._empty; u[pk] = { ...current, text: e.target.value }; return u; });
                }} />
              </div>
              <label className="mystery-toggle">
                <input type="checkbox" checked={!!current.mystery} onChange={e => {
                  setPrizes(prev => { const u = { ...prev }; delete u._empty; u[pk] = { ...current, mystery: e.target.checked }; return u; });
                }} />
                🎁 Mystery Box (hidden until winner revealed)
              </label>
            </div>
          );
        })}
      </div>

      {/* Video Game Unlock Override */}
      <div className="card">
        <div className="card-title">🎮 Video Game Access</div>
        <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: 12 }}>
          Based on last week's chores. Housekeeping must be 100%, dinner jobs 90%+. Override to manually unlock/lock.
        </div>
        {FAMILY_MEMBERS.map(member => {
          const gs = getVideoGameStatus(member.name);
          return (
            <div key={member.name} className="admin-game-unlock">
              <div className="admin-game-unlock-info">
                <div style={{ fontWeight: 700, color: member.color, display: "flex", alignItems: "center", gap: 6 }}>
                  {member.emoji} {member.name}
                  <span className={`game-unlock-badge ${gs.unlocked ? (gs.parentOverride ? "override" : "unlocked") : "locked"}`} style={{ marginLeft: 4 }}>
                    <span className="game-unlock-icon">🎮</span>
                    <span className="game-lock-icon">{gs.unlocked ? "🔓" : "🔒"}</span>
                  </span>
                </div>
                <div className="admin-game-unlock-stats">
                  HK: {gs.housekeepingPct}% · Dinner: {gs.dinnerPct}%
                  {gs.parentOverride && " · Parent override"}
                </div>
              </div>
              <button className={`admin-unlock-toggle ${gs.unlocked ? "lock" : "unlock"}`} onClick={() => toggleGameUnlock(member.name)}>
                {gs.unlocked && !gs.parentOverride ? "🔒 Lock" : gs.unlocked && gs.parentOverride ? "↩️ Remove Override" : "🔓 Unlock"}
              </button>
            </div>
          );
        })}
      </div>

      {/* Finalize Week Awards */}
      <div className="card">
        <div className="card-title"><Icons.Trophy size={22} color="var(--warning)" /> Finalize Week</div>
        <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: 12 }}>
          Record this week's 1st place winner and MVP (team weeks). Do this at the end of each week before points reset.
        </div>
        <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => {
          const result = recordWeekAwards();
          if (result === "already") setAwardMsg("Awards already recorded for this week!");
          else setAwardMsg("✅ Awards recorded! Winner and MVP saved.");
          setTimeout(() => setAwardMsg(""), 3000);
        }}>🏆 Record This Week's Awards</button>
        {awardMsg && <div style={{ marginTop: 8, fontSize: "0.85rem", fontWeight: 600, color: awardMsg.startsWith("✅") ? "var(--success)" : "var(--warning)", textAlign: "center" }}>{awardMsg}</div>}
      </div>

      {/* Reset Actions */}
      <div className="card">
        <div className="card-title"><Icons.Trash size={22} color="var(--danger)" /> Reset Data</div>
        <div className="admin-section">
          <button className="btn btn-danger" style={{ width: "100%", justifyContent: "center", marginBottom: 8 }} onClick={() => {
            if (confirm("Reset ALL weekly points to 0?")) {
              setPoints(p => {
                const u = { ...p };
                Object.keys(u).forEach(k => { if (k.startsWith("w_")) delete u[k]; });
                if (Object.keys(u).length === 0) u._empty = true;
                return u;
              });
            }
          }}>Reset Weekly Points</button>
          <button className="btn btn-danger" style={{ width: "100%", justifyContent: "center", marginBottom: 8 }} onClick={() => {
            if (confirm("Clear today's completed chores?")) {
              const todayKey = dateToKey(getToday());
              setCompletedChores(p => {
                const u = {};
                Object.entries(p).forEach(([k, v]) => { if (!k.startsWith(todayKey)) u[k] = v; });
                if (Object.keys(u).length === 0) u._empty = true;
                return u;
              });
            }
          }}>Clear Today's Completions</button>
          <button className="btn btn-danger" style={{ width: "100%", justifyContent: "center", marginBottom: 8 }} onClick={() => {
            if (confirm("Reset ALL awards (wins & MVPs)? This cannot be undone!")) {
              setAwards({ _empty: true });
            }
          }}>Reset All Awards (Wins & MVPs)</button>
          <button className="btn btn-danger" style={{ width: "100%", justifyContent: "center" }} onClick={() => {
            if (confirm("Reset ALL data? This cannot be undone!")) {
              setPoints({ _empty: true }); setCompletedChores({ _empty: true }); setStreaks({ _empty: true }); setAwards({ _empty: true });
            }
          }}>Reset Everything</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// PIN DIALOG
// ============================================================
function PinDialog({ onSuccess, onClose }) {
  const [pin, setPin] = useState(["", "", "", ""]);
  const [error, setError] = useState(false);
  const refs = [useRef(), useRef(), useRef(), useRef()];
  useEffect(() => { refs[0].current?.focus(); }, []);
  const handleChange = (i, val) => {
    if (!/^\d*$/.test(val)) return;
    const newPin = [...pin]; newPin[i] = val.slice(-1);
    setPin(newPin); setError(false);
    if (val && i < 3) refs[i + 1].current?.focus();
    const full = newPin.join("");
    if (full.length === 4) {
      if (full === PARENT_PIN) onSuccess();
      else { setError(true); setTimeout(() => { setPin(["","","",""]); refs[0].current?.focus(); }, 600); }
    }
  };
  return (
    <div className="pin-overlay" onClick={onClose}>
      <div className="pin-dialog" onClick={e => e.stopPropagation()}>
        <div className="pin-title">Parent Access</div>
        <div className="pin-subtitle">Enter 4-digit PIN</div>
        <div className="pin-input">
          {pin.map((d, i) => <input key={i} ref={refs[i]} type="tel" inputMode="numeric" className="pin-digit" value={d} onChange={e => handleChange(i, e.target.value)} onKeyDown={e => { if (e.key === "Backspace" && !pin[i] && i > 0) refs[i-1].current?.focus(); }} maxLength={1} />)}
        </div>
        {error && <div className="pin-error">Incorrect PIN</div>}
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

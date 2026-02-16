import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { db } from "./firebase";
import { doc, setDoc, onSnapshot, deleteField } from "firebase/firestore";

// ============================================================
// DATA: Weekly Rotation Schedule (from spreadsheet)
// ============================================================
const WEEKLY_ROTATIONS = [
  { date: "2025-07-30", collectTrash: "Emilie", trashOut: "Carter", recycle: false, bringCansIn: "Cole", refillSoap: "Finn", toiletPaper: "Liam" },
  { date: "2025-08-06", collectTrash: "Carter", trashOut: "Cole", recycle: true, bringCansIn: "Emilie", refillSoap: "Liam", toiletPaper: "Finn" },
  { date: "2025-08-13", collectTrash: "Cole", trashOut: "Emilie", recycle: false, bringCansIn: "Finn", refillSoap: "Carter", toiletPaper: "Liam" },
  { date: "2025-08-20", collectTrash: "Emilie", trashOut: "Carter", recycle: true, bringCansIn: "Liam", refillSoap: "Finn", toiletPaper: "Cole" },
  { date: "2025-08-27", collectTrash: "Carter", trashOut: "Cole", recycle: false, bringCansIn: "Emilie", refillSoap: "Liam", toiletPaper: "Finn" },
  { date: "2025-09-03", collectTrash: "Cole", trashOut: "Emilie", recycle: true, bringCansIn: "Carter", refillSoap: "Finn", toiletPaper: "Liam" },
  { date: "2025-09-10", collectTrash: "Emilie", trashOut: "Carter", recycle: false, bringCansIn: "Finn", refillSoap: "Liam", toiletPaper: "Cole" },
  { date: "2025-09-17", collectTrash: "Nicholas", trashOut: "Cole", recycle: true, bringCansIn: "Emilie", refillSoap: "Finn", toiletPaper: "Liam" },
  { date: "2025-09-24", collectTrash: "Emilie", trashOut: "Nicholas", recycle: false, bringCansIn: "Carter", refillSoap: "Cole", toiletPaper: "Liam" },
  { date: "2025-10-01", collectTrash: "Carter", trashOut: "Emilie", recycle: true, bringCansIn: "Nicholas", refillSoap: "Liam", toiletPaper: "Finn" },
  { date: "2025-10-08", collectTrash: "Cole", trashOut: "Carter", recycle: false, bringCansIn: "Emilie", refillSoap: "Finn", toiletPaper: "Liam" },
  { date: "2025-10-15", collectTrash: "Nicholas", trashOut: "Cole", recycle: true, bringCansIn: "Carter", refillSoap: "Liam", toiletPaper: "Finn" },
  { date: "2025-10-22", collectTrash: "Emilie", trashOut: "Nicholas", recycle: false, bringCansIn: "Cole", refillSoap: "Finn", toiletPaper: "Liam" },
  { date: "2025-10-29", collectTrash: "Carter", trashOut: "Emilie", recycle: true, bringCansIn: "Finn", refillSoap: "Cole", toiletPaper: "Liam" },
  { date: "2025-11-05", collectTrash: "Cole", trashOut: "Carter", recycle: false, bringCansIn: "Nicholas", refillSoap: "Finn", toiletPaper: "Emilie" },
  { date: "2025-11-12", collectTrash: "Nicholas", trashOut: "Cole", recycle: true, bringCansIn: "Emilie", refillSoap: "Liam", toiletPaper: "Finn" },
  { date: "2025-11-19", collectTrash: "Emilie", trashOut: "Nicholas", recycle: false, bringCansIn: "Carter", refillSoap: "Finn", toiletPaper: "Liam" },
  { date: "2025-11-26", collectTrash: "Carter", trashOut: "Emilie", recycle: true, bringCansIn: "Cole", refillSoap: "Liam", toiletPaper: "Finn" },
  { date: "2025-12-03", collectTrash: "Cole", trashOut: "Carter", recycle: false, bringCansIn: "Liam", refillSoap: "Emilie", toiletPaper: "Finn" },
  { date: "2025-12-10", collectTrash: "Nicholas", trashOut: "Cole", recycle: true, bringCansIn: "Finn", refillSoap: "Cole", toiletPaper: "Emilie" },
  { date: "2025-12-17", collectTrash: "Emilie", trashOut: "Nicholas", recycle: false, bringCansIn: "Carter", refillSoap: "Finn", toiletPaper: "Liam" },
  { date: "2025-12-24", collectTrash: "Carter", trashOut: "Emilie", recycle: true, bringCansIn: "Nicholas", refillSoap: "Liam", toiletPaper: "Cole" },
  { date: "2025-12-31", collectTrash: "Cole", trashOut: "Carter", recycle: false, bringCansIn: "Emilie", refillSoap: "Finn", toiletPaper: "Liam" },
  { date: "2026-01-07", collectTrash: "Nicholas", trashOut: "Cole", recycle: true, bringCansIn: "Carter", refillSoap: "Liam", toiletPaper: "Finn" },
  { date: "2026-01-14", collectTrash: "Emilie", trashOut: "Nicholas", recycle: false, bringCansIn: "Cole", refillSoap: "Carter", toiletPaper: "Liam" },
  { date: "2026-01-21", collectTrash: "Carter", trashOut: "Emilie", recycle: true, bringCansIn: "Finn", refillSoap: "Cole", toiletPaper: "Finn" },
  { date: "2026-01-28", collectTrash: "Cole", trashOut: "Carter", recycle: false, bringCansIn: "Nicholas", refillSoap: "Finn", toiletPaper: "Liam" },
  { date: "2026-02-04", collectTrash: "Nicholas", trashOut: "Cole", recycle: true, bringCansIn: "Emilie", refillSoap: "Liam", toiletPaper: "Liam" },
  { date: "2026-02-11", collectTrash: "Emilie", trashOut: "Nicholas", recycle: false, bringCansIn: "Carter", refillSoap: "Liam", toiletPaper: "Finn" },
  { date: "2026-02-18", collectTrash: "Carter", trashOut: "Emilie", recycle: true, bringCansIn: "Cole", refillSoap: "Finn", toiletPaper: "Liam" },
  { date: "2026-02-25", collectTrash: "Cole", trashOut: "Carter", recycle: false, bringCansIn: "Liam", refillSoap: "Finn", toiletPaper: "Liam" },
];

// ============================================================
// DATA: Daily Chore Assignments (from spreadsheet)
// ============================================================
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const DAILY_CHORES = {
  Nicholas: {
    Sunday: { type: "dishes", zone: null, dinnerJob: null },
    Monday: { type: "zone", zone: "Office/Front Hall", dinnerJob: "Clear Table" },
    Tuesday: { type: "dishes", zone: null, dinnerJob: null },
    Wednesday: { type: "zone", zone: "Family Room/Vacuum", dinnerJob: "Take Out Trash" },
    Thursday: { type: "zone", zone: "Kitchen Floor", dinnerJob: "Sweep" },
    Friday: { type: "zone", zone: "Office/Front Hall", dinnerJob: "Clear Table" },
    Saturday: { type: "zone", zone: "Office/Front Hall", dinnerJob: "Clear Table" },
  },
  Emilie: {
    Sunday: { type: "zone", zone: "Kitchen Floor", dinnerJob: "Sweep" },
    Monday: { type: "zone", zone: "Family Room/Vacuum", dinnerJob: "Take Out Trash" },
    Tuesday: { type: "zone", zone: "Office/Front Hall", dinnerJob: "Clear Table" },
    Wednesday: { type: "zone", zone: "Kitchen Floor", dinnerJob: "Sweep" },
    Thursday: { type: "dishes", zone: null, dinnerJob: null },
    Friday: { type: "zone", zone: "Family Room/Vacuum", dinnerJob: "Take Out Trash" },
    Saturday: { type: "dishes", zone: null, dinnerJob: null },
  },
  Carter: {
    Sunday: { type: "zone", zone: "Family Room/Vacuum", dinnerJob: "Take Out Trash" },
    Monday: { type: "dishes", zone: null, dinnerJob: null },
    Tuesday: { type: "zone", zone: "Kitchen Floor", dinnerJob: "Sweep" },
    Wednesday: { type: "zone", zone: "Office/Front Hall", dinnerJob: "Clear Table" },
    Thursday: { type: "zone", zone: "Family Room/Vacuum", dinnerJob: "Take Out Trash" },
    Friday: { type: "dishes", zone: null, dinnerJob: null },
    Saturday: { type: "zone", zone: "Kitchen Floor", dinnerJob: "Sweep" },
  },
  Cole: {
    Sunday: { type: "zone", zone: "Office/Front Hall", dinnerJob: "Clear Table" },
    Monday: { type: "zone", zone: "Kitchen Floor", dinnerJob: "Sweep" },
    Tuesday: { type: "zone", zone: "Family Room/Vacuum", dinnerJob: "Take Out Trash" },
    Wednesday: { type: "dishes", zone: null, dinnerJob: null },
    Thursday: { type: "zone", zone: "Office/Front Hall", dinnerJob: "Clear Table" },
    Friday: { type: "zone", zone: "Kitchen Floor", dinnerJob: "Sweep" },
    Saturday: { type: "zone", zone: "Family Room/Vacuum", dinnerJob: "Take Out Trash" },
  },
  Finn: {
    Sunday: { type: "young", task: "Set Table/Stairs" },
    Monday: { type: "young", task: "Help with Dishes/Upstairs Hallway" },
    Tuesday: { type: "young", task: "Set Table/Stairs" },
    Wednesday: { type: "young", task: "Help with Dishes/Upstairs Hallway" },
    Thursday: { type: "young", task: "Set Table/Stairs" },
    Friday: { type: "young", task: "Help with Dishes/Upstairs Hallway" },
    Saturday: { type: "young", task: "Set Table/Stairs" },
  },
  Liam: {
    Sunday: { type: "young", task: "Help with Dishes/Upstairs Hallway" },
    Monday: { type: "young", task: "Set Table/Stairs" },
    Tuesday: { type: "young", task: "Help with Dishes/Upstairs Hallway" },
    Wednesday: { type: "young", task: "Set Table/Stairs" },
    Thursday: { type: "young", task: "Help with Dishes/Upstairs Hallway" },
    Friday: { type: "young", task: "Set Table/Stairs" },
    Saturday: { type: "young", task: "Help with Dishes/Upstairs Hallway" },
  },
};

// ============================================================
// Family Members Config
// ============================================================
const FAMILY_MEMBERS = [
  { name: "Nicholas", color: "#E85D4A", emoji: "🦅", group: "older" },
  { name: "Emilie", color: "#D4518A", emoji: "🌸", group: "older" },
  { name: "Carter", color: "#3B82F6", emoji: "⚡", group: "older" },
  { name: "Cole", color: "#10B981", emoji: "🎯", group: "older" },
  { name: "Finn", color: "#F59E0B", emoji: "🌟", group: "younger" },
  { name: "Liam", color: "#8B5CF6", emoji: "🚀", group: "younger" },
];

const PARENT_PIN = "1234";

// ============================================================
// Utility Functions
// ============================================================
function getToday() {
  return new Date();
}

function getDayName(date) {
  return DAYS[date.getDay()];
}

function formatDate(date) {
  return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function getWeekStart(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0, 0, 0, 0);
  return d;
}

function dateToKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getCurrentWeekRotation(date) {
  const weekStart = getWeekStart(date);
  const weekStartKey = dateToKey(weekStart);

  for (let i = WEEKLY_ROTATIONS.length - 1; i >= 0; i--) {
    if (WEEKLY_ROTATIONS[i].date <= weekStartKey) {
      return WEEKLY_ROTATIONS[i];
    }
  }

  const baseRotation = [
    ["Nicholas", "Cole", "Emilie", "Finn", "Liam"],
    ["Emilie", "Nicholas", "Carter", "Cole", "Liam"],
    ["Carter", "Emilie", "Nicholas", "Liam", "Finn"],
    ["Cole", "Carter", "Finn", "Finn", "Liam"],
  ];
  const weekNum = Math.floor((weekStart.getTime() - new Date("2025-07-30").getTime()) / (7 * 24 * 60 * 60 * 1000));
  const idx = ((weekNum % baseRotation.length) + baseRotation.length) % baseRotation.length;
  const r = baseRotation[idx];
  return {
    date: weekStartKey,
    collectTrash: r[0], trashOut: r[1], recycle: weekNum % 2 === 1,
    bringCansIn: r[2], refillSoap: r[3], toiletPaper: r[4],
  };
}

// ============================================================
// Storage helpers (localStorage as offline cache)
// ============================================================
function loadData(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveData(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* silent */ }
}

// ============================================================
// Firebase Sync Hook
// ============================================================
function useFirebaseSync(docName, localState, setLocalState) {
  const isRemoteUpdate = useRef(false);
  const initialized = useRef(false);

  // Listen for real-time updates from Firestore
  useEffect(() => {
    const docRef = doc(db, "family", docName);
    const unsub = onSnapshot(docRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        isRemoteUpdate.current = true;
        setLocalState(data);
        saveData(`fcc_${docName}`, data);
      }
      initialized.current = true;
    }, (error) => {
      console.warn(`Firestore listener error for ${docName}:`, error);
      initialized.current = true;
    });

    return () => unsub();
  }, [docName, setLocalState]);

  // Write local changes to Firestore
  useEffect(() => {
    if (!initialized.current) return;
    if (isRemoteUpdate.current) {
      isRemoteUpdate.current = false;
      return;
    }

    const docRef = doc(db, "family", docName);
    // Firestore doesn't allow empty docs, so ensure we have something
    const dataToSave = localState && Object.keys(localState).length > 0 ? localState : { _empty: true };
    setDoc(docRef, dataToSave).catch((err) => {
      console.warn(`Firestore write error for ${docName}:`, err);
    });
  }, [docName, localState]);
}

// ============================================================
// ICONS (inline SVGs to avoid dependencies)
// ============================================================
const Icons = {
  Check: ({ size = 20, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  Trash: ({ size = 20, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  Trophy: ({ size = 20, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9H4.5a2.5 2.5 0 010-5H6M18 9h1.5a2.5 2.5 0 000-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0012 0V2z" />
    </svg>
  ),
  Calendar: ({ size = 20, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  Home: ({ size = 20, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  ),
  Settings: ({ size = 20, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  ),
  Star: ({ size = 20, color = "currentColor", filled = false }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : "none"} stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
  Recycle: ({ size = 20, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 19H4.815a1.83 1.83 0 01-1.57-.881 1.785 1.785 0 01-.004-1.784L7.196 9.5" />
      <path d="M11 19h8.203a1.83 1.83 0 001.556-.89 1.784 1.784 0 000-1.775l-1.226-2.12" />
      <path d="M14 16l3 3-3 3" /><path d="M8.293 13.596L4.875 8.052a1.784 1.784 0 01.004-1.784A1.83 1.83 0 016.476 5.39h7.558" />
      <path d="M7 16l-3-3 3-3" /><path d="M12 8l3-5-5-1" />
    </svg>
  ),
  Lock: ({ size = 20, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  ),
  Fire: ({ size = 20, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <path d="M12 23c-3.866 0-7-2.686-7-6 0-1.665.737-3.199 2-4.272C7 9.5 8.5 6 12 2c1 3 3 5 4 6.5.667 1 2 2.5 2 4.5 0 3.314-2.686 6-6 6z" />
    </svg>
  ),
  Users: ({ size = 20, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  ),
  ChevronLeft: ({ size = 20, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  ),
  ChevronRight: ({ size = 20, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  X: ({ size = 20, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  Cloud: ({ size = 20, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z" />
    </svg>
  ),
  CloudOff: ({ size = 20, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22.61 16.95A5 5 0 0018 10h-1.26a8 8 0 00-7.05-6M5 5a8 8 0 004 15h9a5 5 0 001.7-.3" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ),
};

// ============================================================
// STYLES
// ============================================================
const styles = `
  @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=Fredoka:wght@400;500;600;700&display=swap');

  :root {
    --bg-primary: #0f1724;
    --bg-secondary: #1a2332;
    --bg-card: #1e2a3a;
    --bg-card-hover: #243242;
    --text-primary: #f0f4f8;
    --text-secondary: #8899aa;
    --text-muted: #5a6a7a;
    --border: #2a3a4a;
    --accent: #3B82F6;
    --success: #10B981;
    --warning: #F59E0B;
    --danger: #EF4444;
    --nicholas: #E85D4A;
    --emilie: #D4518A;
    --carter: #3B82F6;
    --cole: #10B981;
    --finn: #F59E0B;
    --liam: #8B5CF6;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Nunito', sans-serif;
    background: var(--bg-primary);
    color: var(--text-primary);
    min-height: 100vh;
    overflow-x: hidden;
  }

  .app {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .header {
    background: linear-gradient(135deg, #1a2332 0%, #0f1724 100%);
    border-bottom: 1px solid var(--border);
    padding: 12px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .header-logo {
    font-family: 'Fredoka', sans-serif;
    font-size: 1.5rem;
    font-weight: 700;
    background: linear-gradient(135deg, #3B82F6, #8B5CF6);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .header-date {
    font-size: 0.9rem;
    color: var(--text-secondary);
    font-weight: 600;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .sync-indicator {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.7rem;
    font-weight: 600;
    padding: 4px 8px;
    border-radius: 8px;
  }

  .sync-online {
    color: #34d399;
    background: rgba(16, 185, 129, 0.1);
  }

  .sync-offline {
    color: #f87171;
    background: rgba(239, 68, 68, 0.1);
  }

  .nav {
    display: flex;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .nav-btn {
    flex: 1;
    min-width: 80px;
    padding: 12px 8px;
    background: none;
    border: none;
    color: var(--text-muted);
    font-family: 'Nunito', sans-serif;
    font-size: 0.75rem;
    font-weight: 700;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    transition: all 0.2s;
    border-bottom: 3px solid transparent;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .nav-btn.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    background: rgba(59, 130, 246, 0.05);
  }

  .nav-btn:hover {
    color: var(--text-primary);
    background: rgba(255,255,255,0.03);
  }

  .main {
    flex: 1;
    padding: 16px;
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
  }

  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px;
    margin-bottom: 16px;
    transition: all 0.2s;
  }

  .card-title {
    font-family: 'Fredoka', sans-serif;
    font-size: 1.1rem;
    font-weight: 600;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .member-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 16px;
    margin-bottom: 12px;
    border-left: 4px solid;
    transition: all 0.15s;
  }

  .member-card:active {
    transform: scale(0.99);
  }

  .member-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .member-name-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .member-emoji {
    font-size: 1.5rem;
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    background: rgba(255,255,255,0.05);
  }

  .member-name {
    font-family: 'Fredoka', sans-serif;
    font-size: 1.2rem;
    font-weight: 600;
  }

  .member-points {
    display: flex;
    align-items: center;
    gap: 4px;
    font-weight: 700;
    font-size: 1.1rem;
    color: var(--warning);
  }

  .chore-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .chore-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 10px;
    background: rgba(255,255,255,0.03);
    cursor: pointer;
    transition: all 0.15s;
    -webkit-tap-highlight-color: transparent;
  }

  .chore-item:hover {
    background: rgba(255,255,255,0.06);
  }

  .chore-item.completed {
    opacity: 0.5;
  }

  .chore-item.completed .chore-text {
    text-decoration: line-through;
  }

  .chore-checkbox {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    border: 2px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 0.2s;
  }

  .chore-checkbox.checked {
    background: var(--success);
    border-color: var(--success);
  }

  .chore-text {
    flex: 1;
    font-size: 0.95rem;
    font-weight: 600;
  }

  .chore-tag {
    font-size: 0.7rem;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 6px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .tag-dishes { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
  .tag-zone { background: rgba(16, 185, 129, 0.15); color: #34d399; }
  .tag-dinner { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
  .tag-weekly { background: rgba(139, 92, 246, 0.15); color: #a78bfa; }
  .tag-young { background: rgba(236, 72, 153, 0.15); color: #f472b6; }

  .weekly-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  @media (max-width: 480px) {
    .weekly-grid {
      grid-template-columns: 1fr;
    }
  }

  .weekly-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    border-radius: 10px;
    background: rgba(255,255,255,0.03);
  }

  .weekly-icon {
    font-size: 1.5rem;
    width: 40px;
    text-align: center;
  }

  .weekly-info {
    flex: 1;
  }

  .weekly-task {
    font-size: 0.8rem;
    color: var(--text-secondary);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .weekly-person {
    font-weight: 700;
    font-size: 1rem;
  }

  .recycle-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    border-radius: 20px;
    font-size: 0.75rem;
    font-weight: 700;
  }

  .recycle-yes {
    background: rgba(16, 185, 129, 0.15);
    color: #34d399;
  }

  .recycle-no {
    background: rgba(239, 68, 68, 0.1);
    color: #f87171;
  }

  .leaderboard-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px;
    border-radius: 12px;
    margin-bottom: 8px;
    background: rgba(255,255,255,0.03);
    transition: all 0.2s;
  }

  .leaderboard-item:first-child {
    background: linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(245, 158, 11, 0.05));
    border: 1px solid rgba(245, 158, 11, 0.2);
  }

  .leaderboard-rank {
    font-family: 'Fredoka', sans-serif;
    font-size: 1.3rem;
    font-weight: 700;
    width: 36px;
    text-align: center;
    color: var(--text-muted);
  }

  .leaderboard-item:first-child .leaderboard-rank {
    color: var(--warning);
  }

  .leaderboard-name {
    flex: 1;
    font-weight: 700;
    font-size: 1.05rem;
  }

  .leaderboard-score {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 800;
    font-size: 1.1rem;
    color: var(--warning);
  }

  .leaderboard-bar {
    height: 4px;
    border-radius: 2px;
    background: var(--border);
    margin-top: 6px;
  }

  .leaderboard-bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.5s ease;
  }

  .streak-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 0.8rem;
    font-weight: 700;
    color: #fb923c;
    padding: 2px 8px;
    border-radius: 12px;
    background: rgba(251, 146, 60, 0.1);
  }

  .week-nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  .week-nav-btn {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text-primary);
    padding: 8px 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    transition: all 0.15s;
  }

  .week-nav-btn:hover {
    background: var(--bg-card-hover);
  }

  .week-label {
    font-family: 'Fredoka', sans-serif;
    font-size: 1.1rem;
    font-weight: 600;
  }

  .week-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 6px;
    overflow-x: auto;
  }

  @media (max-width: 700px) {
    .week-grid {
      grid-template-columns: repeat(3, 1fr);
    }
  }

  @media (max-width: 400px) {
    .week-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  .day-col {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 10px;
    min-width: 120px;
  }

  .day-col.today {
    border-color: var(--accent);
    background: rgba(59, 130, 246, 0.05);
  }

  .day-col-header {
    text-align: center;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 8px;
  }

  .day-name {
    font-weight: 800;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-secondary);
  }

  .day-col.today .day-name {
    color: var(--accent);
  }

  .day-date-num {
    font-family: 'Fredoka', sans-serif;
    font-size: 1.3rem;
    font-weight: 700;
  }

  .day-member {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-radius: 8px;
    margin-bottom: 4px;
    font-size: 0.78rem;
    font-weight: 600;
    background: rgba(255,255,255,0.03);
  }

  .day-member-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .day-member-chore {
    color: var(--text-secondary);
    font-size: 0.7rem;
    font-weight: 400;
  }

  .pin-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
    backdrop-filter: blur(4px);
  }

  .pin-dialog {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 32px;
    text-align: center;
    width: 320px;
    max-width: 90vw;
  }

  .pin-title {
    font-family: 'Fredoka', sans-serif;
    font-size: 1.4rem;
    font-weight: 700;
    margin-bottom: 8px;
  }

  .pin-subtitle {
    color: var(--text-secondary);
    font-size: 0.9rem;
    margin-bottom: 24px;
  }

  .pin-input {
    display: flex;
    gap: 12px;
    justify-content: center;
    margin-bottom: 24px;
  }

  .pin-digit {
    width: 50px;
    height: 56px;
    border-radius: 12px;
    border: 2px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 1.5rem;
    font-weight: 700;
    text-align: center;
    font-family: 'Fredoka', sans-serif;
    outline: none;
    transition: border-color 0.2s;
  }

  .pin-digit:focus {
    border-color: var(--accent);
  }

  .pin-error {
    color: var(--danger);
    font-size: 0.85rem;
    font-weight: 600;
    margin-top: -16px;
    margin-bottom: 16px;
  }

  .btn {
    font-family: 'Nunito', sans-serif;
    font-weight: 700;
    border: none;
    border-radius: 10px;
    padding: 10px 20px;
    cursor: pointer;
    font-size: 0.9rem;
    transition: all 0.15s;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .btn-primary {
    background: var(--accent);
    color: white;
  }

  .btn-primary:hover {
    background: #2563eb;
  }

  .btn-ghost {
    background: transparent;
    color: var(--text-secondary);
    padding: 8px 12px;
  }

  .btn-ghost:hover {
    color: var(--text-primary);
    background: rgba(255,255,255,0.05);
  }

  .btn-danger {
    background: rgba(239, 68, 68, 0.15);
    color: #f87171;
  }

  .admin-section {
    margin-bottom: 24px;
  }

  .admin-section-title {
    font-family: 'Fredoka', sans-serif;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    font-size: 0.8rem;
  }

  .admin-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px;
    background: rgba(255,255,255,0.03);
    border-radius: 10px;
    margin-bottom: 6px;
  }

  .admin-row label {
    font-weight: 600;
    font-size: 0.95rem;
  }

  .points-adjust {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .points-adjust-btn {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 1.2rem;
    font-weight: 700;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }

  .points-adjust-btn:hover {
    background: var(--bg-card-hover);
  }

  .points-value {
    font-family: 'Fredoka', sans-serif;
    font-size: 1.2rem;
    font-weight: 700;
    min-width: 40px;
    text-align: center;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .animate-in {
    animation: fadeIn 0.3s ease both;
  }

  .animate-in:nth-child(1) { animation-delay: 0.02s; }
  .animate-in:nth-child(2) { animation-delay: 0.06s; }
  .animate-in:nth-child(3) { animation-delay: 0.1s; }
  .animate-in:nth-child(4) { animation-delay: 0.14s; }
  .animate-in:nth-child(5) { animation-delay: 0.18s; }
  .animate-in:nth-child(6) { animation-delay: 0.22s; }

  @keyframes checkPop {
    0% { transform: scale(0.8); }
    50% { transform: scale(1.15); }
    100% { transform: scale(1); }
  }

  .check-pop {
    animation: checkPop 0.25s ease;
  }

  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
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
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [isParent, setIsParent] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // Firebase real-time sync
  useFirebaseSync("completedChores", completedChores, setCompletedChores);
  useFirebaseSync("points", points, setPoints);
  useFirebaseSync("streaks", streaks, setStreaks);

  // Also keep localStorage as cache (for offline/fast load)
  useEffect(() => { saveData("fcc_completed", completedChores); }, [completedChores]);
  useEffect(() => { saveData("fcc_points", points); }, [points]);
  useEffect(() => { saveData("fcc_streaks", streaks); }, [streaks]);

  // Online/offline detection
  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  const dayName = getDayName(today);
  const todayKey = dateToKey(today);
  const weekRotation = getCurrentWeekRotation(today);

  const toggleChore = useCallback((member, choreId) => {
    const key = `${todayKey}_${member}_${choreId}`;
    setCompletedChores(prev => {
      const next = { ...prev };
      // Remove the _empty placeholder if present
      delete next._empty;
      if (next[key]) {
        delete next[key];
        setPoints(p => {
          const updated = { ...p };
          delete updated._empty;
          updated[member] = Math.max(0, (updated[member] || 0) - 1);
          return updated;
        });
      } else {
        next[key] = true;
        setPoints(p => {
          const updated = { ...p };
          delete updated._empty;
          updated[member] = (updated[member] || 0) + 1;
          return updated;
        });
      }
      return next;
    });
  }, [todayKey]);

  const isChoreComplete = useCallback((member, choreId) => {
    return !!completedChores[`${todayKey}_${member}_${choreId}`];
  }, [completedChores, todayKey]);

  const getMemberChores = useCallback((member) => {
    const daily = DAILY_CHORES[member]?.[dayName];
    const chores = [];

    if (!daily) return chores;

    if (daily.type === "dishes") {
      chores.push({ id: "dishes", text: "Dishes", tag: "dishes" });
    } else if (daily.type === "zone") {
      chores.push({ id: "zone", text: `Zone: ${daily.zone}`, tag: "zone" });
      chores.push({ id: "dinner", text: `Dinner: ${daily.dinnerJob}`, tag: "dinner" });
    } else if (daily.type === "young") {
      const tasks = daily.task.split("/");
      tasks.forEach((t, i) => {
        chores.push({ id: `task_${i}`, text: t.trim(), tag: "young" });
      });
    }

    if (weekRotation) {
      if (weekRotation.collectTrash === member) chores.push({ id: "w_trash", text: "Collect Trash (all rooms)", tag: "weekly" });
      if (weekRotation.trashOut === member) chores.push({ id: "w_trashout", text: `Take Trash Out${weekRotation.recycle ? " + Recycling" : ""}`, tag: "weekly" });
      if (weekRotation.bringCansIn === member) chores.push({ id: "w_cans", text: "Bring Cans In (Thursday)", tag: "weekly" });
      if (weekRotation.refillSoap === member) chores.push({ id: "w_soap", text: "Refill Soap", tag: "weekly" });
      if (weekRotation.toiletPaper === member) chores.push({ id: "w_tp", text: "Refill Toilet Paper", tag: "weekly" });
    }

    return chores;
  }, [dayName, weekRotation]);

  const getCompletionCount = useCallback((member) => {
    const chores = getMemberChores(member);
    const done = chores.filter(c => isChoreComplete(member, c.id)).length;
    return { done, total: chores.length };
  }, [getMemberChores, isChoreComplete]);

  const sortedLeaderboard = useMemo(() => {
    return [...FAMILY_MEMBERS].sort((a, b) => (points[b.name] || 0) - (points[a.name] || 0));
  }, [points]);

  const maxPoints = useMemo(() => {
    return Math.max(1, ...FAMILY_MEMBERS.map(m => points[m.name] || 0));
  }, [points]);

  return (
    <>
      <style>{styles}</style>
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
              <button className="btn btn-ghost" onClick={() => setIsParent(false)} style={{ fontSize: "0.8rem" }}>
                <Icons.Lock size={16} /> Lock
              </button>
            ) : (
              <button className="btn btn-ghost" onClick={() => setShowPinDialog(true)} style={{ fontSize: "0.8rem" }}>
                <Icons.Settings size={16} /> Parent
              </button>
            )}
          </div>
        </header>

        <nav className="nav">
          <button className={`nav-btn ${currentTab === "today" ? "active" : ""}`} onClick={() => setCurrentTab("today")}>
            <Icons.Home size={20} /> Today
          </button>
          <button className={`nav-btn ${currentTab === "week" ? "active" : ""}`} onClick={() => setCurrentTab("week")}>
            <Icons.Calendar size={20} /> Week
          </button>
          <button className={`nav-btn ${currentTab === "rotation" ? "active" : ""}`} onClick={() => setCurrentTab("rotation")}>
            <Icons.Recycle size={20} /> Rotation
          </button>
          <button className={`nav-btn ${currentTab === "leaderboard" ? "active" : ""}`} onClick={() => setCurrentTab("leaderboard")}>
            <Icons.Trophy size={20} /> Points
          </button>
          {isParent && (
            <button className={`nav-btn ${currentTab === "admin" ? "active" : ""}`} onClick={() => setCurrentTab("admin")}>
              <Icons.Settings size={20} /> Admin
            </button>
          )}
        </nav>

        <main className="main">
          {currentTab === "today" && (
            <TodayView
              members={FAMILY_MEMBERS}
              getMemberChores={getMemberChores}
              isChoreComplete={isChoreComplete}
              toggleChore={toggleChore}
              getCompletionCount={getCompletionCount}
              points={points}
            />
          )}
          {currentTab === "week" && (
            <WeekView
              today={today}
              weekOffset={weekOffset}
              setWeekOffset={setWeekOffset}
            />
          )}
          {currentTab === "rotation" && (
            <RotationView today={today} weekRotation={weekRotation} />
          )}
          {currentTab === "leaderboard" && (
            <LeaderboardView
              sorted={sortedLeaderboard}
              points={points}
              maxPoints={maxPoints}
              streaks={streaks}
            />
          )}
          {currentTab === "admin" && isParent && (
            <AdminView
              points={points}
              setPoints={setPoints}
              completedChores={completedChores}
              setCompletedChores={setCompletedChores}
              streaks={streaks}
              setStreaks={setStreaks}
            />
          )}
        </main>

        {showPinDialog && (
          <PinDialog
            onSuccess={() => { setIsParent(true); setShowPinDialog(false); }}
            onClose={() => setShowPinDialog(false)}
          />
        )}
      </div>
    </>
  );
}

// ============================================================
// TODAY VIEW
// ============================================================
function TodayView({ members, getMemberChores, isChoreComplete, toggleChore, getCompletionCount, points }) {
  return (
    <div>
      {members.map((member) => {
        const chores = getMemberChores(member.name);
        const { done, total } = getCompletionCount(member.name);
        const allDone = total > 0 && done === total;

        return (
          <div
            key={member.name}
            className="member-card animate-in"
            style={{ borderLeftColor: member.color }}
          >
            <div className="member-header">
              <div className="member-name-row">
                <div className="member-emoji">{member.emoji}</div>
                <div>
                  <div className="member-name" style={{ color: member.color }}>{member.name}</div>
                  <div style={{ fontSize: "0.8rem", color: allDone ? "#10B981" : "var(--text-muted)", fontWeight: 600 }}>
                    {allDone ? "All done!" : `${done}/${total} complete`}
                  </div>
                </div>
              </div>
              <div className="member-points">
                <Icons.Star size={18} color="#F59E0B" filled />
                {points[member.name] || 0}
              </div>
            </div>

            <div className="chore-list">
              {chores.map((chore) => {
                const completed = isChoreComplete(member.name, chore.id);
                return (
                  <div
                    key={chore.id}
                    className={`chore-item ${completed ? "completed" : ""}`}
                    onClick={() => toggleChore(member.name, chore.id)}
                  >
                    <div className={`chore-checkbox ${completed ? "checked check-pop" : ""}`}>
                      {completed && <Icons.Check size={16} color="white" />}
                    </div>
                    <span className="chore-text">{chore.text}</span>
                    <span className={`chore-tag tag-${chore.tag}`}>{chore.tag}</span>
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
// WEEK VIEW
// ============================================================
function WeekView({ today, weekOffset, setWeekOffset }) {
  const weekStart = useMemo(() => {
    const d = getWeekStart(today);
    d.setDate(d.getDate() + weekOffset * 7);
    return d;
  }, [today, weekOffset]);

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [weekStart]);

  const weekLabel = useMemo(() => {
    const start = weekDays[0];
    const end = weekDays[6];
    const sMonth = start.toLocaleDateString("en-US", { month: "short" });
    const eMonth = end.toLocaleDateString("en-US", { month: "short" });
    if (sMonth === eMonth) {
      return `${sMonth} ${start.getDate()} – ${end.getDate()}`;
    }
    return `${sMonth} ${start.getDate()} – ${eMonth} ${end.getDate()}`;
  }, [weekDays]);

  return (
    <div>
      <div className="week-nav">
        <button className="week-nav-btn" onClick={() => setWeekOffset(o => o - 1)}>
          <Icons.ChevronLeft size={20} />
        </button>
        <div style={{ textAlign: "center" }}>
          <div className="week-label">{weekLabel}</div>
          {weekOffset !== 0 && (
            <button className="btn btn-ghost" onClick={() => setWeekOffset(0)} style={{ fontSize: "0.75rem", padding: "2px 8px" }}>
              Today
            </button>
          )}
        </div>
        <button className="week-nav-btn" onClick={() => setWeekOffset(o => o + 1)}>
          <Icons.ChevronRight size={20} />
        </button>
      </div>

      <div className="week-grid">
        {weekDays.map((d, i) => {
          const dayN = getDayName(d);
          const isToday = dateToKey(d) === dateToKey(today);
          return (
            <div key={i} className={`day-col ${isToday ? "today" : ""}`}>
              <div className="day-col-header">
                <div className="day-name">{dayN.slice(0, 3)}</div>
                <div className="day-date-num">{d.getDate()}</div>
              </div>
              {FAMILY_MEMBERS.map(member => {
                const daily = DAILY_CHORES[member.name]?.[dayN];
                if (!daily) return null;
                let shortChore = "";
                if (daily.type === "dishes") shortChore = "Dishes";
                else if (daily.type === "zone") shortChore = daily.zone;
                else if (daily.type === "young") shortChore = daily.task.split("/")[0];

                return (
                  <div key={member.name} className="day-member">
                    <div className="day-member-dot" style={{ background: member.color }} />
                    <div>
                      <div style={{ fontSize: "0.78rem", fontWeight: 700 }}>{member.name}</div>
                      <div className="day-member-chore">{shortChore}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// ROTATION VIEW
// ============================================================
function RotationView({ today, weekRotation }) {
  if (!weekRotation) return <div className="card">No rotation data for this week.</div>;

  return (
    <div>
      <div className="card animate-in">
        <div className="card-title">
          <Icons.Recycle size={22} color="var(--accent)" />
          This Week's Rotation
        </div>

        <div style={{ marginBottom: 16, textAlign: "center" }}>
          <span className={`recycle-badge ${weekRotation.recycle ? "recycle-yes" : "recycle-no"}`}>
            <Icons.Recycle size={14} />
            {weekRotation.recycle ? "Recycling Week" : "No Recycling"}
          </span>
        </div>

        <div className="weekly-grid">
          <div className="weekly-item">
            <div className="weekly-icon">🗑️</div>
            <div className="weekly-info">
              <div className="weekly-task">Collect Trash</div>
              <div className="weekly-person" style={{ color: FAMILY_MEMBERS.find(m => m.name === weekRotation.collectTrash)?.color }}>
                {weekRotation.collectTrash}
              </div>
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>Wed after school, before electronics</div>
            </div>
          </div>

          <div className="weekly-item">
            <div className="weekly-icon">🚛</div>
            <div className="weekly-info">
              <div className="weekly-task">Take Trash Out</div>
              <div className="weekly-person" style={{ color: FAMILY_MEMBERS.find(m => m.name === weekRotation.trashOut)?.color }}>
                {weekRotation.trashOut}
              </div>
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>Wednesday evening</div>
            </div>
          </div>

          <div className="weekly-item">
            <div className="weekly-icon">📦</div>
            <div className="weekly-info">
              <div className="weekly-task">Bring Cans In</div>
              <div className="weekly-person" style={{ color: FAMILY_MEMBERS.find(m => m.name === weekRotation.bringCansIn)?.color }}>
                {weekRotation.bringCansIn}
              </div>
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>Thursday</div>
            </div>
          </div>

          <div className="weekly-item">
            <div className="weekly-icon">🧴</div>
            <div className="weekly-info">
              <div className="weekly-task">Refill Soap</div>
              <div className="weekly-person" style={{ color: FAMILY_MEMBERS.find(m => m.name === weekRotation.refillSoap)?.color }}>
                {weekRotation.refillSoap}
              </div>
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>Wed after school, before electronics</div>
            </div>
          </div>

          <div className="weekly-item">
            <div className="weekly-icon">🧻</div>
            <div className="weekly-info">
              <div className="weekly-task">Toilet Paper</div>
              <div className="weekly-person" style={{ color: FAMILY_MEMBERS.find(m => m.name === weekRotation.toiletPaper)?.color }}>
                {weekRotation.toiletPaper}
              </div>
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>Wed after school, before electronics</div>
            </div>
          </div>
        </div>
      </div>

      <div className="card animate-in" style={{ animationDelay: "0.1s" }}>
        <div className="card-title">
          <Icons.Calendar size={22} color="var(--text-secondary)" />
          Upcoming Weeks
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: "8px", textAlign: "left", color: "var(--text-muted)", fontWeight: 700 }}>Week Of</th>
                <th style={{ padding: "8px", textAlign: "left", color: "var(--text-muted)", fontWeight: 700 }}>Collect</th>
                <th style={{ padding: "8px", textAlign: "left", color: "var(--text-muted)", fontWeight: 700 }}>Out</th>
                <th style={{ padding: "8px", textAlign: "center", color: "var(--text-muted)", fontWeight: 700 }}>♻️</th>
                <th style={{ padding: "8px", textAlign: "left", color: "var(--text-muted)", fontWeight: 700 }}>Cans</th>
                <th style={{ padding: "8px", textAlign: "left", color: "var(--text-muted)", fontWeight: 700 }}>Soap</th>
                <th style={{ padding: "8px", textAlign: "left", color: "var(--text-muted)", fontWeight: 700 }}>TP</th>
              </tr>
            </thead>
            <tbody>
              {WEEKLY_ROTATIONS.filter(r => r.date >= dateToKey(today)).slice(0, 8).map(r => {
                const d = new Date(r.date + "T00:00:00");
                const isThisWeek = r.date === weekRotation?.date;
                return (
                  <tr key={r.date} style={{ borderBottom: "1px solid var(--border)", background: isThisWeek ? "rgba(59,130,246,0.08)" : "transparent" }}>
                    <td style={{ padding: "8px", fontWeight: isThisWeek ? 800 : 600 }}>
                      {d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      {isThisWeek && <span style={{ color: "var(--accent)", fontSize: "0.7rem", marginLeft: 6 }}>NOW</span>}
                    </td>
                    <td style={{ padding: "8px", color: FAMILY_MEMBERS.find(m => m.name === r.collectTrash)?.color, fontWeight: 600 }}>{r.collectTrash}</td>
                    <td style={{ padding: "8px", color: FAMILY_MEMBERS.find(m => m.name === r.trashOut)?.color, fontWeight: 600 }}>{r.trashOut}</td>
                    <td style={{ padding: "8px", textAlign: "center" }}>{r.recycle ? "✅" : "—"}</td>
                    <td style={{ padding: "8px", color: FAMILY_MEMBERS.find(m => m.name === r.bringCansIn)?.color, fontWeight: 600 }}>{r.bringCansIn}</td>
                    <td style={{ padding: "8px", color: FAMILY_MEMBERS.find(m => m.name === r.refillSoap)?.color, fontWeight: 600 }}>{r.refillSoap}</td>
                    <td style={{ padding: "8px", color: FAMILY_MEMBERS.find(m => m.name === r.toiletPaper)?.color, fontWeight: 600 }}>{r.toiletPaper}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// LEADERBOARD VIEW
// ============================================================
function LeaderboardView({ sorted, points, maxPoints, streaks }) {
  const medals = ["🥇", "🥈", "🥉"];

  return (
    <div>
      <div className="card animate-in">
        <div className="card-title">
          <Icons.Trophy size={22} color="var(--warning)" />
          Leaderboard
        </div>

        {sorted.map((member, i) => {
          const pts = points[member.name] || 0;
          const streak = streaks[member.name] || 0;

          return (
            <div key={member.name} className="leaderboard-item animate-in">
              <div className="leaderboard-rank">
                {i < 3 ? medals[i] : `#${i + 1}`}
              </div>
              <div className="member-emoji" style={{ fontSize: "1.3rem", width: 36, height: 36 }}>
                {member.emoji}
              </div>
              <div style={{ flex: 1 }}>
                <div className="leaderboard-name" style={{ color: member.color }}>
                  {member.name}
                  {streak > 1 && (
                    <span className="streak-badge" style={{ marginLeft: 8 }}>
                      <Icons.Fire size={14} color="#fb923c" /> {streak}
                    </span>
                  )}
                </div>
                <div className="leaderboard-bar">
                  <div
                    className="leaderboard-bar-fill"
                    style={{ width: `${(pts / maxPoints) * 100}%`, background: member.color }}
                  />
                </div>
              </div>
              <div className="leaderboard-score">
                <Icons.Star size={18} color="#F59E0B" filled />
                {pts}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card animate-in" style={{ animationDelay: "0.1s" }}>
        <div className="card-title">
          <Icons.Users size={22} color="var(--text-secondary)" />
          Family Stats
        </div>
        <div className="weekly-grid">
          <div className="weekly-item">
            <div className="weekly-icon" style={{ fontSize: "1.8rem" }}>⭐</div>
            <div className="weekly-info">
              <div className="weekly-task">Total Points</div>
              <div className="weekly-person">
                {Object.entries(points).reduce((a, [k, b]) => k === "_empty" ? a : a + (b || 0), 0)}
              </div>
            </div>
          </div>
          <div className="weekly-item">
            <div className="weekly-icon" style={{ fontSize: "1.8rem" }}>👑</div>
            <div className="weekly-info">
              <div className="weekly-task">Leader</div>
              <div className="weekly-person" style={{ color: sorted[0]?.color }}>{sorted[0]?.name || "—"}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// ADMIN VIEW (Parent Only)
// ============================================================
function AdminView({ points, setPoints, completedChores, setCompletedChores, streaks, setStreaks }) {
  const adjustPoints = (member, delta) => {
    setPoints(prev => {
      const updated = { ...prev };
      delete updated._empty;
      updated[member] = Math.max(0, (updated[member] || 0) + delta);
      return updated;
    });
  };

  const resetAllPoints = () => {
    if (window.confirm("Reset ALL points to zero? This cannot be undone.")) {
      setPoints({ _empty: true });
      setStreaks({ _empty: true });
    }
  };

  const resetTodayChores = () => {
    if (window.confirm("Reset today's chore completions?")) {
      const todayKey = dateToKey(getToday());
      setCompletedChores(prev => {
        const next = {};
        Object.keys(prev).forEach(k => {
          if (!k.startsWith(todayKey) && k !== "_empty") next[k] = prev[k];
        });
        if (Object.keys(next).length === 0) next._empty = true;
        return next;
      });
    }
  };

  return (
    <div>
      <div className="card animate-in">
        <div className="card-title">
          <Icons.Settings size={22} color="var(--accent)" />
          Parent Controls
        </div>

        <div className="admin-section">
          <div className="admin-section-title">Adjust Points</div>
          {FAMILY_MEMBERS.map(member => (
            <div key={member.name} className="admin-row">
              <label style={{ color: member.color }}>
                {member.emoji} {member.name}
              </label>
              <div className="points-adjust">
                <button className="points-adjust-btn" onClick={() => adjustPoints(member.name, -5)}>-5</button>
                <button className="points-adjust-btn" onClick={() => adjustPoints(member.name, -1)}>-</button>
                <span className="points-value">{points[member.name] || 0}</span>
                <button className="points-adjust-btn" onClick={() => adjustPoints(member.name, 1)}>+</button>
                <button className="points-adjust-btn" onClick={() => adjustPoints(member.name, 5)}>+5</button>
              </div>
            </div>
          ))}
        </div>

        <div className="admin-section">
          <div className="admin-section-title">Reset Options</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-danger" onClick={resetTodayChores}>
              Reset Today's Chores
            </button>
            <button className="btn btn-danger" onClick={resetAllPoints}>
              Reset All Points
            </button>
          </div>
        </div>

        <div className="admin-section">
          <div className="admin-section-title">Sync Status</div>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            Data syncs automatically across all devices via Firebase. Check for the green <strong>Synced</strong> indicator in the header.
          </p>
        </div>

        <div className="admin-section">
          <div className="admin-section-title">PIN</div>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            Default parent PIN is <strong>1234</strong>. To change it, update PARENT_PIN in the code.
          </p>
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

  const handleChange = (index, value) => {
    if (value.length > 1) return;
    const newPin = [...pin];
    newPin[index] = value;
    setPin(newPin);
    setError(false);

    if (value && index < 3) {
      const next = document.getElementById(`pin-${index + 1}`);
      next?.focus();
    }

    if (index === 3 && value) {
      const fullPin = newPin.join("");
      if (fullPin === PARENT_PIN) {
        onSuccess();
      } else {
        setError(true);
        setPin(["", "", "", ""]);
        setTimeout(() => document.getElementById("pin-0")?.focus(), 100);
      }
    }
  };

  const handleKeyDown = (index, e) => {
    if (e.key === "Backspace" && !pin[index] && index > 0) {
      const prev = document.getElementById(`pin-${index - 1}`);
      prev?.focus();
    }
    if (e.key === "Escape") onClose();
  };

  useEffect(() => {
    document.getElementById("pin-0")?.focus();
  }, []);

  return (
    <div className="pin-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pin-dialog">
        <button className="btn btn-ghost" onClick={onClose} style={{ position: "absolute", top: 12, right: 12 }}>
          <Icons.X size={20} />
        </button>
        <div style={{ fontSize: "2.5rem", marginBottom: 8 }}>🔒</div>
        <div className="pin-title">Parent Access</div>
        <div className="pin-subtitle">Enter 4-digit PIN</div>

        {error && <div className="pin-error">Incorrect PIN. Try again.</div>}

        <div className="pin-input">
          {pin.map((digit, i) => (
            <input
              key={i}
              id={`pin-${i}`}
              type="tel"
              className="pin-digit"
              value={digit}
              onChange={(e) => handleChange(i, e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => handleKeyDown(i, e)}
              maxLength={1}
              inputMode="numeric"
              autoComplete="off"
            />
          ))}
        </div>

        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

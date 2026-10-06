import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";
import { db, storage } from "./firebase";
import { doc, setDoc, onSnapshot, deleteField, increment, FieldPath } from "firebase/firestore";
import {
  isVideoGameDay, getDailyAssignment, getRoutineForItemId, FAMILY_MEMBERS, getToday, getDayName,
  getWeekStart, dateToKey, getCurrentWeekRotation, getWeekNumber, isTeamWeek,
  getChartAssignment, getWeekStartKey, getMonthKey, getYearKey, calculateStreak, STREAK_MILESTONES,
  CHORE_TIME_GROUPS, buildChoreList, getDateNight, MONTHLY_WORK, addMonths, formatMinutes,
  getWorkMonth, cashoutAmount,
} from "./schedule";
import { LogoMark, LaunchSplash, shouldShowSplash } from "./Logo";
import { pushSupport, subscribeThisDevice, subscriptionId, currentSubscriptionId, unsubscribeThisDevice, sendTestReminder, deviceLabel } from "./push";
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject, listAll } from "firebase/storage";



// Parent PIN: only a salted SHA-256 fingerprint lives in code/Firestore, never the
// digits. Parents change it in Admin -> "Parent PIN" (stored in the synced
// `parentSettings` doc). Until one is set, the default fingerprint below applies.
const PARENT_PIN_SALT = "family-hq-parent-v1:";
const DEFAULT_PARENT_PIN_HASH = "612cb0953ec4062ea2c4875569fb525379267e65163adee8c8c73431d778941c";
const PIN_MAX_FAILS = 5;
const PIN_LOCKOUT_MS = 60 * 1000;

async function hashParentPin(pin) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PARENT_PIN_SALT + pin));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Per-device lockout after repeated wrong guesses.
function getPinLockoutRemaining() {
  try {
    const { until } = JSON.parse(localStorage.getItem("fcc_parentPinFails") || "{}");
    return until && until > Date.now() ? until - Date.now() : 0;
  } catch { return 0; }
}
function recordPinFailure() {
  try {
    const rec = JSON.parse(localStorage.getItem("fcc_parentPinFails") || "{}");
    const count = (rec.until && rec.until <= Date.now() ? 0 : (rec.count || 0)) + 1;
    const until = count >= PIN_MAX_FAILS ? Date.now() + PIN_LOCKOUT_MS : 0;
    localStorage.setItem("fcc_parentPinFails", JSON.stringify({ count: until ? 0 : count, until }));
  } catch {}
}
function clearPinFailures() { try { localStorage.removeItem("fcc_parentPinFails"); } catch {} }

// Returns "ok", "wrong", or "locked".
async function verifyParentPin(pin, parentSettings) {
  if (getPinLockoutRemaining() > 0) return "locked";
  const expected = parentSettings?.pinHash || DEFAULT_PARENT_PIN_HASH;
  if ((await hashParentPin(pin)) === expected) { clearPinFailures(); return "ok"; }
  recordPinFailure();
  return getPinLockoutRemaining() > 0 ? "locked" : "wrong";
}

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

// Two-way sync between a React state object and one Firestore document.
//
// Writes are recorded AT THE MOMENT OF THE LOCAL CHANGE, not by diffing state
// afterwards. The returned setter works like React's: every update is
// "given the current data, return the new data" — so we diff exactly those two
// objects and upload only what that one update changed (changed keys merged in,
// removed keys deleted with deleteField()). Consequences:
//   • Phones can't overwrite each other: a write only touches the keys the tap
//     changed. (Previously every change re-uploaded the device's ENTIRE copy,
//     so two phones — or one waking up with a stale copy — wiped each other.)
//   • Server snapshots go straight into state through the raw setter and never
//     trigger a write, so there's no echo/revert loop.
//   • Each update writes once, even if React re-runs the updater (StrictMode,
//     or re-basing an update on top of a newer snapshot).
//   • Changes made offline are queued by Firestore and sent on reconnect.
// Numeric counters in the points doc are sent as increment(delta), so two kids
// earning points at the same moment both count.
const SYNC_INCREMENT_DOCS = new Set(["points"]);
const SYNC_MAX_INCREMENTS = 400; // Firestore allows ~500 transforms per write; bigger diffs send absolute values

// Deep equality that ignores key order (Firestore may return map keys in a
// different order than we wrote them).
function syncEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && syncEqual(a[k], b[k]));
}

function computeSyncDiff(base, next, useIncrement) {
  const diff = {};
  let count = 0;
  const b = base || {}, n = next || {};
  for (const k of Object.keys(n)) {
    if (!(k in b)) { diff[k] = n[k]; count++; continue; }
    if (syncEqual(b[k], n[k])) continue;
    diff[k] = (useIncrement && typeof b[k] === "number" && typeof n[k] === "number") ? increment(n[k] - b[k]) : n[k];
    count++;
  }
  for (const k of Object.keys(b)) {
    if (!(k in n)) { diff[k] = deleteField(); count++; }
  }
  return { diff, count };
}

const syncNormalize = (x) => (x && Object.keys(x).length > 0 ? x : { _empty: true });

function writeSyncDiff(docName, base, next) {
  const useInc = SYNC_INCREMENT_DOCS.has(docName);
  let { diff, count } = computeSyncDiff(syncNormalize(base), syncNormalize(next), useInc);
  if (count === 0) return;
  if (useInc && count > SYNC_MAX_INCREMENTS) ({ diff } = computeSyncDiff(syncNormalize(base), syncNormalize(next), false));
  try {
    setDoc(doc(db, "family", docName), diff, { mergeFields: Object.keys(diff).map(k => new FieldPath(k)) })
      .catch((err) => console.warn(`Firestore write error ${docName}:`, err));
  } catch (err) {
    console.warn(`Firestore write error ${docName}:`, err); // e.g. an undefined value — never crash the app
  }
}

// Usage: const [x, setXRaw] = useState(...); const setX = useFirebaseSync("docName", setXRaw);
function useFirebaseSync(docName, setRawState) {
  useEffect(() => {
    const docRef = doc(db, "family", docName);
    // Until the server has answered once, Firestore's local cache only knows
    // the fields this device wrote (offline start / slow connection), so a
    // cache-only snapshot can be a PARTIAL document. Ignore those — the screen
    // keeps its localStorage copy until real server data arrives. After the
    // first server snapshot the cache holds the full doc and is safe to use.
    let serverSeen = false;
    const unsub = onSnapshot(docRef, { includeMetadataChanges: true }, (snapshot) => {
      if (!snapshot.metadata.fromCache) serverSeen = true;
      if (!serverSeen) return;
      if (!snapshot.exists()) return;
      const data = snapshot.data();
      setRawState(data);
      saveData(`fcc_${docName}`, data);
    }, (error) => { console.warn(`Firestore error ${docName}:`, error); });
    return () => unsub();
  }, [docName, setRawState]);

  return useCallback((valueOrUpdater) => {
    let written = false;
    setRawState(prev => {
      const next = typeof valueOrUpdater === "function" ? valueOrUpdater(prev) : valueOrUpdater;
      if (!written) {
        written = true;
        // Defer the network call out of React's update cycle.
        queueMicrotask(() => writeSyncDiff(docName, prev, next));
      }
      return next;
    });
  }, [docName, setRawState]);
}

const Icons = {
  Check: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>),
  Trash: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>),
  Trophy: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9H4.5a2.5 2.5 0 010-5H6M18 9h1.5a2.5 2.5 0 000-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0012 0V2z" /></svg>),
  Calendar: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>),
  Home: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>),
  Settings: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" /></svg>),
  Star: ({ size = 20, color = "currentColor", filled = false }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : "none"} stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>),
  Recycle: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 19H4.815a1.83 1.83 0 0 1-1.57-.881 1.785 1.785 0 0 1-.004-1.784L7.196 9.5" /><path d="M11 19h8.203a1.83 1.83 0 0 0 1.556-.89 1.784 1.784 0 0 0 0-1.775l-1.226-2.12" /><path d="m14 16-3 3 3 3" /><path d="M8.293 13.596 7.196 9.5 3.1 10.598" /><path d="m9.344 5.811 1.093-1.892A1.83 1.83 0 0 1 11.985 3a1.784 1.784 0 0 1 1.546.888l3.943 6.843" /><path d="m13.378 9.633 4.096 1.098 1.097-4.096" /></svg>),
  Lock: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>),
  Bell: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>),
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
  More: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>),
  Info: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>),
  Crown: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 10H5z" /></svg>),
  List: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>),
};

const styles = `
@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=Fredoka:wght@400;500;600;700&display=swap');
:root{--bg-primary:#0d111a;--bg-secondary:#131a26;--bg-card:#161e2c;--bg-card-hover:#1b243a;--text-primary:#f0f4f8;--text-secondary:#8899aa;--text-muted:#5a6a7a;--text-soft:#a9b6c4;--border:#222d44;--ring-track:#222d44;--surface-hi:#1b2a4a;--accent:#3B82F6;--accent-soft:#8ab4ff;--success:#10B981;--warning:#F59E0B;--danger:#EF4444}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Nunito',sans-serif;background:var(--bg-primary);color:var(--text-primary);min-height:100vh;overflow-x:hidden}
.app{min-height:100vh;display:flex;flex-direction:column;padding-bottom:calc(73px + env(safe-area-inset-bottom))}
/* --- Top bar: logo (or back arrow), page name, bell, Parent --- */
.topbar{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:calc(10px + env(safe-area-inset-top)) 12px 10px 16px;background:var(--bg-primary)}
.topbar.sub{padding-left:6px}
.topbar-left{display:flex;align-items:center;gap:12px;min-width:0}
.topbar.sub .topbar-left{gap:4px}
.topbar-left .hq-logo{flex-shrink:0;border-radius:9px}
.topbar-text{min-width:0}
.topbar-kicker{font-size:0.75rem;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-title{font-family:'Fredoka',sans-serif;font-weight:600;font-size:1.6rem;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-right{display:flex;align-items:center;gap:4px;flex-shrink:0}
.icon-btn{width:44px;height:44px;padding:0;border:none;border-radius:12px;background:none;color:var(--text-primary);display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0}
.icon-btn:hover{background:rgba(255,255,255,0.06)}
.pill-btn{height:44px;padding:0 14px;border:1px solid var(--border);border-radius:22px;background:var(--bg-card);color:var(--text-primary);font-family:inherit;font-size:0.88rem;font-weight:700;display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap}
.pill-btn:hover{background:var(--bg-card-hover)}
.offline-pill{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border-radius:14px;background:rgba(239,68,68,0.14);color:#fca5a5;font-size:0.75rem;font-weight:800;white-space:nowrap}
.topbar.sub .offline-pill span{display:none}
.topbar.sub .offline-pill{padding:0 8px}
@media (max-width:440px){.offline-pill span{display:none}.offline-pill{padding:0 8px}}
/* --- Bottom tab bar: five tabs, always reachable by thumb --- */
.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:100;background:var(--bg-secondary);border-top:1px solid var(--border);padding:8px 8px calc(8px + env(safe-area-inset-bottom))}
.tabbar-inner{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));max-width:640px;margin:0 auto}
.tab-btn{height:56px;padding:0;border:none;border-radius:16px;background:none;color:var(--text-soft);font-family:inherit;font-size:0.75rem;font-weight:700;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;cursor:pointer;-webkit-tap-highlight-color:transparent}
.tab-btn.active{background:var(--surface-hi);color:var(--accent-soft);font-weight:800}
.main{flex:1;padding:6px 16px 16px;max-width:1400px;width:100%;margin:0 auto}
.main.has-fab{padding-bottom:84px}
.page{max-width:720px;width:100%;margin:0 auto;display:flex;flex-direction:column;gap:12px}
.card{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:14px;transition:all 0.2s}
.card-title{font-family:'Fredoka',sans-serif;font-size:1.05rem;font-weight:600;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.member-progress{height:3px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;margin-top:8px}
.member-progress-fill{height:100%;border-radius:2px;transition:width 0.4s ease}
.chore-list{display:flex;flex-direction:column;gap:8px}
.chore-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.03);cursor:pointer;transition:all 0.15s;-webkit-tap-highlight-color:transparent}
.chore-item:hover{background:rgba(255,255,255,0.06)}
.chore-item.completed{opacity:0.5}.chore-item.completed .chore-text{text-decoration:line-through}
.chore-checkbox{width:28px;height:28px;padding:0;border-radius:8px;border:2px solid var(--border);background:none;color:inherit;-webkit-appearance:none;appearance:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.2s}
.chore-checkbox.checked{background:var(--success);border-color:var(--success)}
.chore-text{flex:1;font-size:0.95rem;font-weight:600}
.chore-tag{font-size:0.7rem;font-weight:700;padding:3px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:0.5px}
.tag-dishes{background:rgba(59,130,246,0.15);color:#60a5fa}.tag-zone{background:rgba(16,185,129,0.15);color:#34d399}
.tag-dinner{background:rgba(245,158,11,0.15);color:#fbbf24}.tag-weekly{background:rgba(139,92,246,0.15);color:#a78bfa}
.tag-young{background:rgba(236,72,153,0.15);color:#f472b6}.tag-custom{background:rgba(251,146,60,0.15);color:#fb923c}.tag-housekeeping{background:rgba(20,184,166,0.15);color:#2dd4bf}.tag-laundry{background:rgba(168,85,247,0.15);color:#c084fc}
.tag-practice{background:rgba(217,70,239,0.15);color:#e879f9}.tag-routine{background:rgba(56,189,248,0.15);color:#38bdf8}
.tag-church{background:rgba(99,102,241,0.16);color:#a5b4fc}
/* --- Priority "no-miss" chores (weekly rotation jobs) --- */
.chore-item.priority{background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.45);border-left:4px solid #f59e0b;box-shadow:0 0 0 0 rgba(245,158,11,0.5);animation:mustDoPulse 2.4s ease-in-out infinite}
.chore-item.priority:hover{background:rgba(245,158,11,0.16)}
.chore-item.priority .chore-text{color:#fcd34d}
.chore-item.priority .chore-checkbox{border-color:#f59e0b}
.chore-item.priority.completed{animation:none;box-shadow:none;background:rgba(255,255,255,0.03);border-color:var(--border);border-left-color:rgba(16,185,129,0.6)}
.chore-item.priority.completed .chore-text{color:var(--text-primary)}
@keyframes mustDoPulse{0%,100%{box-shadow:0 0 0 0 rgba(245,158,11,0.35)}50%{box-shadow:0 0 0 5px rgba(245,158,11,0)}}
.must-do-badge{font-size:0.62rem;font-weight:900;letter-spacing:0.6px;padding:3px 7px;border-radius:6px;background:#f59e0b;color:#1a1205;white-space:nowrap;flex-shrink:0}
.chore-item.completed .must-do-badge{background:rgba(245,158,11,0.25);color:#fbbf24}
.must-do-alert{display:inline-flex;align-items:center;gap:5px;margin-top:5px;padding:3px 8px;border-radius:7px;background:rgba(245,158,11,0.14);border:1px solid rgba(245,158,11,0.4);max-width:100%;animation:mustDoPulse 2.4s ease-in-out infinite}
.must-do-alert-icon{font-size:0.75rem;flex-shrink:0}
.must-do-alert-text{font-size:0.72rem;font-weight:800;color:#fbbf24;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.my-jobs-chore.priority:not(.done){background:rgba(245,158,11,0.12);border-left:3px solid #f59e0b;font-weight:700;color:#fcd34d}
@media(prefers-reduced-motion:reduce){.chore-item.priority,.must-do-alert{animation:none}}
.chore-group-label{display:flex;align-items:center;gap:6px;font-size:0.72rem;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-muted);margin:8px 2px 0}
.chore-list>.chore-group-label:first-child{margin-top:0}
.chore-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.chore-details{font-size:0.8rem;font-weight:500;color:var(--text-secondary);line-height:1.4}
.chore-info-btn{width:40px;height:40px;margin:-6px -4px -6px 0;border-radius:12px;border:none;background:none;color:var(--text-secondary);display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;padding:0}
.chore-info-btn.open{color:var(--accent-soft)}
@media (max-width:560px){.chore-list .chore-tag{display:none}}
.reminders-modal{width:440px;max-width:94vw}
.reminders-close{background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:1.6rem;line-height:1}
.reminders-sub{font-size:0.88rem;color:var(--text-secondary);margin-bottom:16px;line-height:1.45}
.reminders-label{font-size:0.72rem;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-muted);margin:4px 0 8px}
.reminders-kids{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.reminders-kid{display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border-radius:10px;border:2px solid var(--border);background:var(--bg-secondary);font-weight:700;cursor:pointer;user-select:none}
.reminders-kid input{display:none}
.reminders-kid.on{background:rgba(59,130,246,0.1)}
.reminders-actions{display:flex;flex-wrap:wrap;gap:8px}
.reminders-msg{font-size:0.85rem;font-weight:600;margin-top:12px;line-height:1.4}
.reminders-help{font-size:0.9rem;line-height:1.5;color:var(--text-primary);background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:14px}
.reminders-help ol{margin:8px 0 0 18px;padding:0}
.reminders-devices{margin-top:18px;border-top:1px solid var(--border);padding-top:12px}
.reminders-device{display:flex;align-items:center;gap:10px;font-size:0.85rem;padding:6px 0}
.reminders-device span:first-child{font-weight:700;min-width:110px}
.reminders-device-who{flex:1;color:var(--text-secondary)}
.date-night{display:flex;gap:14px;align-items:flex-start;padding:14px 16px;border-radius:16px;border:1px solid #1f5c58;background:#10201f}
.date-night.scheduled{border-color:rgba(16,185,129,0.45);background:#10231d}
.date-night.fresh{box-shadow:0 0 0 3px rgba(20,184,166,0.18)}
.date-night-icon{font-size:1.9rem;line-height:1}
.date-night-body{flex:1;min-width:0}
.date-night-label{font-size:0.72rem;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:#5eead4;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.date-night-new{font-size:0.65rem;letter-spacing:0.06em;background:#0d9488;color:#fff;padding:2px 8px;border-radius:999px}
.date-night-who{display:flex;align-items:center;gap:10px;margin:8px 0 6px;flex-wrap:wrap}
.date-night-kid{font-family:'Fredoka',sans-serif;font-weight:600;font-size:1.1rem;color:#0d111a;padding:4px 14px;border-radius:999px}
.date-night-with{font-weight:700;color:var(--text-secondary)}
.date-night-status{font-size:0.85rem;color:var(--text-secondary);font-weight:600}
.date-night-next{color:var(--text-secondary)}
.date-night-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;align-items:center}
.date-night-date{padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-family:inherit;color-scheme:dark}
.date-night-btn{background:#0d9488;border-color:#0d9488}
.work-bar{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;width:100%;margin-top:10px;padding:9px 12px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,0.03);color:var(--text-primary);font-family:inherit;text-align:left;cursor:pointer}
.work-bar.done{border-color:rgba(16,185,129,0.4)}
.work-bar-label{font-size:0.68rem;font-weight:900;letter-spacing:1.2px;text-transform:uppercase;color:var(--text-muted)}
.work-bar-text{font-size:0.85rem;font-weight:700;flex:1;min-width:0}
.work-bar-track{display:block;width:100%;height:6px;border-radius:99px;background:rgba(255,255,255,0.08);overflow:hidden}
.work-bar-track.big{height:10px;margin:10px 0 6px}
.work-bar-fill{display:block;height:100%;border-radius:99px;transition:width .3s}
.work-modal{width:480px;max-width:94vw}
.work-month-nav{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:6px 0 12px;font-weight:800}
.work-month-nav .week-nav-btn{width:34px;height:34px}
.work-month-nav .week-nav-btn:disabled{opacity:.3;cursor:default}
.work-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center}
.work-stats .stat-value{font-family:'Fredoka',sans-serif;font-size:1.5rem;font-weight:700}
.work-stats .stat-label{font-size:0.72rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted)}
.work-summary-note{font-size:0.85rem;color:var(--text-secondary);line-height:1.45}
.work-form{margin-top:16px;padding-top:14px;border-top:1px solid var(--border)}
.work-form-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.work-form-row .form-select{width:auto;flex:0 0 auto}
.work-entries{margin-top:16px;border-top:1px solid var(--border);padding-top:12px;max-height:40vh;overflow-y:auto}
.work-entry{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:0.88rem}
.work-entry-when{color:var(--text-muted);font-weight:700;min-width:84px;font-size:0.8rem}
.work-entry-what{flex:1;min-width:0}
.work-entry-mins{font-weight:800;white-space:nowrap}
.duty-grid{flex:1;min-width:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.duty-col{min-width:0;display:flex;flex-direction:column;gap:7px}
.duty-label{font-size:0.82rem;font-weight:700;color:#c3ccd6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.duty-chips{display:flex;flex-direction:column;align-items:stretch;gap:6px;min-width:0}
.duty-chip{display:flex;align-items:center;justify-content:center;gap:5px;width:100%;min-width:0;min-height:34px;padding:4px 10px;border-radius:999px;font-family:'Fredoka',sans-serif;font-size:1rem;font-weight:600;color:#0d111a;white-space:nowrap}
.duty-chip-name{overflow:hidden;text-overflow:ellipsis}
.duty-chip.done{background:rgba(16,185,129,0.22);color:#6ee7b7}
.duty-chip-count{font-size:0.75rem;font-weight:800;opacity:0.85}
.duty-chip-check{font-weight:900}
.duty-none{font-family:'Fredoka',sans-serif;font-size:1rem;color:var(--text-secondary);padding:5px 0}
@media (max-width:560px){.duty-grid{gap:8px}.duty-chip{font-size:0.95rem;padding:4px 6px;gap:3px}.duty-chip-emoji{display:none}}
@media (max-width:400px){.duty-chip{font-size:0.88rem;padding:4px 4px}.duty-chip-count{font-size:0.68rem}}
.work-bar-tag{font-size:0.72rem;font-weight:800;padding:2px 8px;border-radius:999px;white-space:nowrap}
.work-bar-tag.cash{background:rgba(245,158,11,0.18);color:#fcd34d}
.work-bar-tag.owed{background:rgba(16,185,129,0.18);color:#6ee7b7}
.work-cash{margin-top:14px;padding:12px 14px;border-radius:12px;border:1px solid rgba(245,158,11,0.4);background:linear-gradient(135deg,rgba(245,158,11,0.14),rgba(16,185,129,0.06))}
.work-cash-title{font-family:'Fredoka',sans-serif;font-weight:700;font-size:1.1rem}
.work-cash-sub{font-size:0.82rem;color:var(--text-secondary);margin-top:2px;line-height:1.4}
.btn.work-cash-btn{background:#16a34a;border-color:#16a34a}
.work-cashouts{margin-top:16px;border-top:1px solid var(--border);padding-top:12px}
.work-paid{font-size:0.78rem;font-weight:800;color:var(--success);white-space:nowrap}
.work-unpaid{font-size:0.78rem;font-weight:800;color:#fcd34d;white-space:nowrap}
.work-mark-paid{padding:4px 10px;font-size:0.78rem}
.chore-empty{font-size:0.85rem;color:var(--text-muted);padding:8px 12px;font-style:italic}
/* --- Tonight's dinner jobs (Dishes / Clear table / Trash) --- */
.tonight{padding:12px 14px 14px;border:1px solid #2b4a86;border-radius:16px;background:#131c30;display:flex;flex-direction:column;gap:10px}
.tonight.done{border-color:rgba(16,185,129,0.45);background:#10231d}
.tonight .mini-label{color:#9db4d6}
.tonight.done .mini-label{color:#6ee7b7}
/* --- Routine summary chips on the collapsed card --- */
/* --- Daily routine sections (morning / bedtime), nested in the card --- */
.routine-card{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:12px 14px;border-left:3px solid rgba(56,189,248,0.5)}
.routine-card.complete{border-left-color:#10B981;background:rgba(16,185,129,0.05)}
.routine-header{display:flex;align-items:center;gap:10px;cursor:pointer;-webkit-tap-highlight-color:transparent}
.routine-icon{font-size:1.2rem;width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,0.05);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.routine-title{font-family:'Fredoka',sans-serif;font-weight:600;font-size:0.95rem}
.routine-meta{font-size:0.75rem;color:var(--text-muted);margin-top:1px}
.routine-bonus-chip{font-size:0.7rem;font-weight:800;padding:3px 7px;border-radius:6px;background:rgba(255,255,255,0.06);color:var(--text-muted);flex-shrink:0}
.routine-bonus-chip.earned{background:rgba(16,185,129,0.15);color:#34d399}
.routine-card .member-progress{margin-top:8px}
.chore-points-badge{font-size:0.7rem;font-weight:800;color:var(--warning);padding:2px 6px;border-radius:6px;background:rgba(245,158,11,0.1);margin-right:4px;white-space:nowrap}
.chore-delete-btn{background:none;border:none;cursor:pointer;padding:4px;color:var(--text-muted);transition:color 0.15s;flex-shrink:0;display:flex;align-items:center}
.chore-delete-btn:hover{color:#f87171}
.recycle-badge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:0.75rem;font-weight:700}
.recycle-yes{background:rgba(16,185,129,0.15);color:#34d399}.recycle-no{background:rgba(239,68,68,0.1);color:#f87171}
.week-nav-btn{background:var(--bg-card);border:1px solid var(--border);border-radius:10px;color:var(--text-primary);width:40px;height:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s;padding:0}
.week-nav-btn:hover{background:var(--bg-card-hover)}
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
.my-jobs-modal{background:var(--bg-card);border-radius:20px;padding:20px;width:90%;max-width:480px;max-height:85vh;overflow-y:auto;animation:slideUp 0.25s ease}
.my-jobs-day{margin-bottom:16px}
.my-jobs-day-header{font-family:'Fredoka',sans-serif;font-size:0.95rem;font-weight:700;color:var(--text-primary);margin-bottom:8px;display:flex;align-items:center;gap:8px}
.my-jobs-day-header .day-badge{font-size:0.7rem;padding:2px 8px;border-radius:6px;background:var(--bg-secondary);color:var(--text-muted);font-weight:600;text-transform:uppercase}
.my-jobs-day-header .day-badge.today{background:var(--accent);color:white}
.my-jobs-chore{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;font-size:0.85rem;color:var(--text-secondary);background:rgba(255,255,255,0.03)}
.my-jobs-chore.done{opacity:0.5;text-decoration:line-through}
.my-jobs-chore .chore-status{font-size:0.9rem;flex-shrink:0}
.my-jobs-summary{display:flex;gap:12px;margin-bottom:16px;padding:12px;border-radius:12px;background:var(--bg-secondary)}
.my-jobs-summary-stat{flex:1;text-align:center}
.my-jobs-summary-stat .stat-value{font-family:'Fredoka',sans-serif;font-size:1.4rem;font-weight:700}
.my-jobs-summary-stat .stat-label{font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;font-weight:600}
.add-task-fab{position:fixed;bottom:calc(90px + env(safe-area-inset-bottom));right:20px;width:56px;height:56px;border-radius:16px;background:var(--accent);color:white;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(59,130,246,0.4);transition:all 0.2s;z-index:50}
.add-task-fab:hover{background:#2563eb;transform:scale(1.05)}.add-task-fab:active{transform:scale(0.95)}
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

/* ============================================================
   Layout refresh (Oct 2026): faces, rings, rows, grids, podium
   ============================================================ */
.page>.card,.page>.date-night{margin-bottom:0}
.stack-8{display:flex;flex-direction:column;gap:8px}
.mini-label{font-size:0.75rem;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;color:var(--text-soft)}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:2px 2px 0}
.section-head h2{font-family:'Fredoka',sans-serif;font-weight:500;font-size:1.06rem}
.section-head h2.ok{color:#6ee7b7}
.section-head span{font-size:0.82rem;font-weight:700;color:var(--text-secondary)}
.avatar{border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;line-height:1}
.ring{border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.ring-inner{border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center}
/* Row of faces */
.faces{display:grid;width:100%;max-width:520px;margin:0 auto}
.face{display:flex;flex-direction:column;align-items:center;gap:5px;min-width:0;padding:6px 0;border:none;border-radius:14px;background:none;color:#c3ccd6;font-family:inherit;font-size:0.75rem;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent}
.face.active{background:var(--bg-card-hover);color:var(--text-primary);font-weight:800}
.face-all{width:48px;height:48px;border-radius:50%;border:2px solid var(--border);display:flex;align-items:center;justify-content:center}
.face.active .face-all{border-color:#6ea8ff}
.face-emoji{font-size:20px;line-height:1}
.face-name{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.face .avatar{margin:2px 0}
/* List rows (kids, More menu) */
.rows{border:1px solid var(--border);border-radius:16px;background:var(--bg-card);overflow:hidden;display:flex;flex-direction:column}
.row{display:flex;align-items:center;gap:12px;width:100%;min-height:62px;padding:10px 8px 10px 12px;border:none;border-top:1px solid var(--border);background:none;color:var(--text-primary);font-family:inherit;font-size:1rem;text-align:left;cursor:pointer;-webkit-tap-highlight-color:transparent}
.rows>.row:first-child{border-top:none}
button.row:hover{background:rgba(255,255,255,0.03)}
div.row{cursor:default}
.row-body{flex:1;min-width:0;display:flex;flex-direction:column;align-items:stretch;gap:7px}
.row-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.row-tags{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;min-width:0}
.row-tags .streak-fire,.row-tags .streak-on-fire,.hero-chips .streak-fire,.hero-chips .streak-on-fire{margin-left:0;font-size:0.8rem}
.row-name{font-family:'Fredoka',sans-serif;font-weight:500;font-size:1.06rem}
.row-count{font-size:0.82rem;font-weight:700;color:var(--text-soft);white-space:nowrap;flex-shrink:0}
.row-count.ok{color:#6ee7b7}
.row-points{min-width:42px;display:flex;align-items:center;justify-content:flex-end;gap:3px;font-size:0.95rem;font-weight:800;color:#fbbf24;flex-shrink:0}
.row-chev{color:var(--text-secondary);display:flex;flex-shrink:0}
.row .must-do-alert{align-self:flex-start;margin-top:0}
.tag-pill{padding:2px 8px;border-radius:9px;font-size:0.75rem;font-weight:800;white-space:nowrap}
.tag-pill.dishes{background:#1c2d4f;color:#9cc0ff}.tag-pill.ok{background:#14332b;color:#6ee7b7}
.tag-pill.locked{background:rgba(239,68,68,0.14);color:#fca5a5}
.tag-pill.work{background:#14332b;color:#6ee7b7}.tag-pill.routine{background:rgba(56,189,248,0.14);color:#7dd3fc}
.bar{display:block;height:6px;border-radius:3px;background:var(--ring-track);overflow:hidden}
.bar>span{display:block;height:100%;border-radius:3px;transition:width 0.4s ease}
.row-icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:var(--ring-track);color:#c3ccd6;font-size:1.15rem}
.row-icon.blue{background:#1b2a4a;color:#8ab4ff}.row-icon.gold{background:#3a2c10;color:#fcd34d}.row-icon.green{background:#14332b;color:#6ee7b7}.row-icon.teal{background:#10201f}
.row-label{flex:1;min-width:0;font-size:1rem;font-weight:700}
.row-label small{display:block;font-size:0.8rem;font-weight:700;color:var(--text-soft);margin-top:1px}
.row-value{font-size:0.88rem;font-weight:700;color:var(--text-soft);white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.row-value.ok{color:#6ee7b7}.row-value.bad{color:#fca5a5}
/* One kid: big ring, chips, bigger checkboxes */
.kid-view{display:flex;flex-direction:column;gap:12px}
.hero{display:flex;align-items:center;gap:16px;padding:14px 16px;border:1px solid var(--border);border-radius:18px;background:var(--bg-card)}
.hero-count{font-family:'Fredoka',sans-serif;font-weight:600;font-size:1.5rem;line-height:1}
.hero-count small{font-size:0.95rem;font-weight:500;color:var(--text-soft)}
.hero-done{font-size:0.68rem;font-weight:800;letter-spacing:0.6px;text-transform:uppercase;color:var(--text-soft);margin-top:2px}
.hero-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}
.hero-name .emoji-picker-btn{width:44px;height:44px;margin:-5px -2px -5px -5px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.hero-name{display:flex;align-items:center;gap:8px;font-family:'Fredoka',sans-serif;font-weight:600;font-size:1.5rem;line-height:1.1}
.hero-left{font-size:0.95rem;font-weight:700;color:#c3ccd6}
.hero-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.chip{min-height:26px;padding:0 10px;border-radius:13px;font-size:0.8rem;font-weight:800;display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.chip.points{background:#3a2c10;color:#fcd34d}.chip.dishes{background:#1c2d4f;color:#9cc0ff}.chip.ok{background:#14332b;color:#6ee7b7}
.emoji-panel{border:1px solid var(--border);border-radius:14px;background:var(--bg-card)}
.info-line{display:flex;align-items:center;gap:10px;width:100%;min-height:46px;padding:8px 10px 8px 14px;border:1px solid var(--border);border-radius:14px;background:none;color:#c3ccd6;font-family:inherit;font-size:0.9rem;font-weight:700;text-align:left;cursor:pointer}
.info-line.good{border-color:rgba(16,185,129,0.45);color:#6ee7b7}
.info-line-text{flex:1;min-width:0}
.info-line small{display:block;font-size:0.8rem;font-weight:700;color:var(--text-secondary);margin-top:1px}
.link-btn{align-self:center;min-height:44px;padding:0 12px;border:none;background:none;color:var(--accent-soft);font-family:inherit;font-size:0.9rem;font-weight:800;cursor:pointer}
.kid-view .chore-item,.day-chores .chore-item{min-height:56px;padding:10px 12px;border:1px solid var(--border);border-radius:14px;background:var(--bg-card)}
.kid-view .chore-item.priority,.day-chores .chore-item.priority{border-color:rgba(245,158,11,0.45);background:rgba(245,158,11,0.10)}
.kid-view .chore-checkbox,.day-chores .chore-checkbox{width:30px;height:30px;border-radius:9px;border-color:#5d7096;cursor:pointer}
.kid-view .chore-checkbox.checked,.day-chores .chore-checkbox.checked{border-color:var(--success)}
.kid-view .chore-text,.day-chores .chore-text{font-size:1rem;font-weight:700;cursor:pointer}
.kid-view .chore-item.completed,.day-chores .chore-item.completed{opacity:1;min-height:46px;padding:7px 12px;border-color:transparent;background:#121924}
.kid-view .chore-item.completed .chore-text,.day-chores .chore-item.completed .chore-text{font-size:0.95rem;color:var(--text-soft)}
.kid-view .chore-group-label,.day-chores .chore-group-label{color:var(--text-soft)}
.kid-view .routine-card{border-radius:14px;border-left:1px solid var(--border)}
.kid-view .routine-card.complete{border-color:rgba(16,185,129,0.45)}
.kid-view .work-bar{margin-top:0}
.done-list{gap:6px}
.all-done{display:flex;align-items:center;gap:14px;padding:16px;border:1px solid rgba(16,185,129,0.45);border-radius:16px;background:#10231d}
.all-done-check{width:44px;height:44px;border-radius:50%;background:var(--success);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.all-done b{display:block;font-family:'Fredoka',sans-serif;font-weight:600;font-size:1.2rem}
.all-done small{display:block;font-size:0.88rem;font-weight:700;color:#a7e8cf;margin-top:2px}
/* Week: day strip + the picked day */
.daystrip{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}
.daycell{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;padding:8px 0;border:none;border-radius:14px;background:none;color:#c3ccd6;font-family:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
.daycell.selected{background:var(--surface-hi);color:var(--text-primary)}
.daycell-name{font-size:0.75rem;font-weight:800;letter-spacing:0.5px;text-transform:uppercase}
.daycell.today .daycell-name{color:var(--accent-soft)}
.daycell-num{font-family:'Fredoka',sans-serif;font-weight:600;font-size:1rem;line-height:1}
.daycell-num.ok{color:#6ee7b7}
.day-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px;flex-wrap:wrap}
.day-head h2{display:flex;align-items:center;gap:10px;font-family:'Fredoka',sans-serif;font-weight:600;font-size:1.35rem}
.day-head>span{font-size:0.88rem;font-weight:700;color:var(--text-soft)}
.today-pill{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:12px;background:var(--surface-hi);color:var(--accent-soft);font-family:'Nunito',sans-serif;font-size:0.72rem;font-weight:800;letter-spacing:0.5px;text-transform:uppercase}
.today-pill.plain{background:var(--bg-card);color:var(--text-soft)}
.dinner-card{padding:12px 8px;border:1px solid var(--border);border-radius:16px;background:var(--bg-card);display:flex;flex-direction:column;gap:10px}
.dinner-card .mini-label{padding:0 6px}
.dinner-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr))}
.dinner-col{display:flex;flex-direction:column;align-items:center;gap:5px;min-width:0}
.dinner-job{font-size:0.75rem;font-weight:700;color:#c3ccd6}
.dinner-who{max-width:100%;padding:0 2px;font-size:0.75rem;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dinner-none{height:34px;display:flex;align-items:center;color:var(--text-secondary);font-weight:700}
.av-stack{display:flex;justify-content:center}
.av-stack .avatar+.avatar{margin-left:-8px;box-shadow:0 0 0 2px var(--bg-card)}
.week-row{min-height:52px}
.week-row-name{width:78px;flex-shrink:0;font-family:'Fredoka',sans-serif;font-weight:500;font-size:1rem}
.week-row .bar{flex:1;height:8px;border-radius:4px}
.week-row .bar>span{border-radius:4px}
.week-row-count{width:44px;flex-shrink:0;text-align:right;font-size:0.88rem;font-weight:800;color:#c3ccd6}
.week-row-count.ok{color:#6ee7b7}
.week-row .row-chev{transition:transform 0.2s}
.week-row.open .row-chev{transform:rotate(90deg)}
.day-chores{padding:2px 10px 12px;border-top:none}
.upnext-day{width:40px;flex-shrink:0;font-size:0.75rem;font-weight:800;letter-spacing:0.5px;text-transform:uppercase;color:var(--text-soft)}
/* Jobs: the week as a grid */
.grid-card{padding:12px 8px 8px;border:1px solid var(--border);border-radius:16px;background:var(--bg-card);display:flex;flex-direction:column;gap:6px}
.grid-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 6px}
.grid-card h2{font-family:'Fredoka',sans-serif;font-weight:500;font-size:1.06rem}
.jg-row{display:flex;align-items:center;min-height:38px;border-radius:10px}
.jg-row.head{min-height:22px;font-size:0.75rem;font-weight:800;color:var(--text-soft)}
.jg-row.today{background:var(--surface-hi)}
.jg-day{width:58px;flex-shrink:0;padding-left:8px;font-size:0.82rem;font-weight:800;color:#c3ccd6;line-height:1.15}
.jg-row.today .jg-day{color:var(--text-primary)}
.jg-day small{display:block;font-size:0.68rem;font-weight:800;color:var(--accent-soft)}
.jg-day small.recycle{color:#6ee7b7}
.jg-cell{flex:1;min-width:0;display:flex;justify-content:center;text-align:center}
.jg-cell .avatar+.avatar{margin-left:-8px;box-shadow:0 0 0 2px var(--bg-card)}
.jg-row.today .jg-cell .avatar+.avatar{box-shadow:0 0 0 2px var(--surface-hi)}
.avatar.dim{opacity:0.2}
.avatar.hit{box-shadow:0 0 0 2px var(--bg-card),0 0 0 4px #f0f4f8}
.jg-row.today .avatar.hit{box-shadow:0 0 0 2px var(--surface-hi),0 0 0 4px #f0f4f8}
.jg-empty{color:var(--text-secondary);font-weight:700}
.wk-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 10px;padding:4px 6px 6px}
.wk-item{display:flex;align-items:center;gap:8px;min-width:0;min-height:40px}
.wk-item.dim{opacity:0.3}
.wk-item-text{min-width:0;line-height:1.2}
.wk-item-text b{display:block;font-size:0.88rem;font-weight:800}
.wk-item-text small{display:block;font-size:0.82rem;font-weight:700;color:var(--text-soft)}
.week-switch{display:flex;align-items:center;justify-content:space-between;gap:10px}
.week-switch .week-nav-btn{width:44px;height:44px;border-radius:22px}
.week-switch-label{flex:1;text-align:center;font-family:'Fredoka',sans-serif;font-weight:500;font-size:1.1rem;display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap}
/* Points: podium */
.seg{display:grid;min-height:48px;padding:4px;border-radius:24px;background:var(--bg-card)}
.seg button{min-height:40px;padding:0 4px;border:none;border-radius:20px;background:none;color:#c3ccd6;font-family:inherit;font-size:0.88rem;font-weight:700;cursor:pointer}
.seg button.active{background:var(--accent);color:#0d111a;font-weight:800}
.podium{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:end;width:100%;max-width:460px;margin:0 auto;padding-top:6px}
.podium-col{display:flex;flex-direction:column;align-items:center;gap:5px;min-width:0}
.podium-name{max-width:100%;margin-top:6px;font-family:'Fredoka',sans-serif;font-weight:500;font-size:1.06rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.podium-col.first .podium-name{font-weight:600;font-size:1.25rem}
.podium-pts{display:flex;align-items:center;gap:4px;font-size:1.06rem;font-weight:800;color:#fbbf24}
.podium-col.first .podium-pts{font-size:1.25rem}
.podium-extra{display:flex;flex-wrap:wrap;justify-content:center;gap:2px 6px;min-height:16px;font-size:0.72rem;font-weight:800;color:var(--text-soft)}
.podium-extra .streak-fire,.podium-extra .streak-on-fire{margin-left:0;font-size:0.72rem}
.podium-block{width:100%;border-top:3px solid;border-radius:12px 12px 0 0;background:var(--bg-card);display:flex;align-items:center;justify-content:center;font-family:'Fredoka',sans-serif;font-weight:600;line-height:1}
.podium-col.first .podium-block{background:var(--bg-card-hover)}
.podium-rest{margin-top:-12px}
.rank-num{width:22px;flex-shrink:0;text-align:center;font-family:'Fredoka',sans-serif;font-weight:600;font-size:1.25rem;color:var(--text-soft)}
.total-line{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:52px;padding:0 14px;border:1px solid var(--border);border-radius:16px;font-size:0.95rem;font-weight:700;color:#c3ccd6}
.total-line b{display:inline-flex;align-items:center;gap:4px;font-family:'Fredoka',sans-serif;font-weight:600;font-size:1.25rem;color:var(--text-primary)}
/* Games + Hall of Fame */
.status-card{padding:16px;border:1px solid var(--border);border-radius:18px;background:var(--bg-card);display:flex;flex-direction:column;gap:14px}
.status-top{display:flex;align-items:center;gap:14px}
.status-icon{width:56px;height:56px;border-radius:50%;background:var(--ring-track);color:#c3ccd6;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.status-card.on{border-color:rgba(16,185,129,0.45)}
.status-card.on .status-icon{background:#14332b;color:#6ee7b7}
.status-title{font-family:'Fredoka',sans-serif;font-weight:600;font-size:1.35rem;line-height:1.1}
.status-text{font-size:0.9rem;font-weight:700;color:#c3ccd6;line-height:1.35;margin-top:3px}
.status-next{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:48px;padding:0 14px;border-radius:12px;background:var(--surface-hi);font-size:0.9rem;font-weight:700;color:#c3ccd6}
.status-next b{font-family:'Fredoka',sans-serif;font-weight:600;font-size:1.06rem;color:var(--accent-soft)}
.section-note{padding:0 2px;font-size:0.82rem;font-weight:700;color:var(--text-soft);line-height:1.4}
.game-row{align-items:flex-start;padding:12px 14px 12px 12px}
.game-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:7px}
.game-top{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:38px}
.game-meter{display:flex;align-items:center;gap:8px;font-size:0.78rem;font-weight:700;color:var(--text-soft)}
.game-meter-label{width:96px;flex-shrink:0}
.game-meter .bar{flex:1}
.game-meter-val{width:40px;flex-shrink:0;text-align:right;color:#c3ccd6}
.game-meter-val.ok{color:#6ee7b7}
.state-pill{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border-radius:13px;background:var(--ring-track);color:#c3ccd6;font-size:0.78rem;font-weight:800;white-space:nowrap}
.state-pill.open{background:#14332b;color:#6ee7b7}.state-pill.parent{background:#3a2c10;color:#fcd34d}
.small-btn{min-height:40px;padding:0 14px;border:1px solid var(--border);border-radius:20px;background:var(--bg-card-hover);color:var(--text-primary);font-family:inherit;font-size:0.8rem;font-weight:800;cursor:pointer;white-space:nowrap}
.empty-card{padding:24px 20px 22px;border:1px solid var(--border);border-radius:18px;background:var(--bg-card);display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center}
.empty-medals{display:flex;align-items:flex-end;gap:14px}
.empty-medal{width:52px;height:52px;border:2px dashed;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Fredoka',sans-serif;font-weight:600;font-size:1.25rem}
.empty-medal.big{width:72px;height:72px}
.empty-title{font-family:'Fredoka',sans-serif;font-weight:600;font-size:1.35rem}
.empty-text{font-size:0.95rem;font-weight:700;color:#c3ccd6;line-height:1.4;margin-top:6px}
.wide-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 20px;border:1px solid #3a4a6b;border-radius:24px;background:var(--bg-card-hover);color:var(--text-primary);font-family:inherit;font-size:0.95rem;font-weight:800;cursor:pointer}
.medal-dot{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:'Fredoka',sans-serif;font-weight:600;font-size:0.95rem;color:#0d111a}
.more-group h2{padding:0 2px;font-family:'Nunito',sans-serif;font-size:0.75rem;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;color:var(--text-soft)}
@media(min-width:768px){.main{padding-top:10px}.page{gap:14px}}
@media(max-width:350px){.main{padding-left:10px;padding-right:10px}.face{font-size:0.62rem}.topbar-title{font-size:1.4rem}}
`;

// ============================================================
// NAVIGATION — five bottom tabs; three more pages live under "More"
// ============================================================
const MAIN_TABS = [
  { key: "today", label: "Today", title: "Today", Icon: Icons.Home },
  { key: "week", label: "Week", title: "Week", Icon: Icons.Calendar },
  { key: "rotation", label: "Jobs", title: "Jobs", Icon: Icons.Recycle },
  { key: "leaderboard", label: "Points", title: "Points", Icon: Icons.Star },
  { key: "more", label: "More", title: "More", Icon: Icons.More },
];
const SUB_PAGES = {
  games: { title: "Video games" },
  history: { title: "Hall of Fame" },
  admin: { title: "Parent tools" },
};
const knownKid = (name) => (FAMILY_MEMBERS.some(m => m.name === name) ? name : null);

// ============================================================
// MAIN APP COMPONENT
// ============================================================
export default function App() {
  const [currentTab, setCurrentTab] = useState("today");
  const [today] = useState(getToday());
  const [completedChores, setCompletedChoresRaw] = useState(() => loadData("fcc_completed", {}));
  const [points, setPointsRaw] = useState(() => loadData("fcc_points", {}));
  const [streaks, setStreaksRaw] = useState(() => loadData("fcc_streaks", {}));
  const [customTasks, setCustomTasksRaw] = useState(() => loadData("fcc_customTasks", {}));
  const [teamNames, setTeamNamesRaw] = useState(() => loadData("fcc_teamNames", {}));
  const [awards, setAwardsRaw] = useState(() => loadData("fcc_awards", {}));
  const [prizes, setPrizesRaw] = useState(() => loadData("fcc_prizes", {}));
  const [customEmojis, setCustomEmojisRaw] = useState(() => loadData("fcc_customEmojis", {}));
  const [teamColors, setTeamColorsRaw] = useState(() => loadData("fcc_teamColors", {}));
  const [gameUnlocks, setGameUnlocksRaw] = useState(() => loadData("fcc_gameUnlocks", {}));
  const [gameTimers, setGameTimersRaw] = useState(() => loadData("fcc_gameTimers", {}));
  const [chorePhotos, setChorePhotosRaw] = useState(() => loadData("fcc_chorePhotos", {}));
  const [photoUploading, setPhotoUploading] = useState(null); // "member_choreId" while uploading
  const [photoViewer, setPhotoViewer] = useState(null); // { url, member, chore } for full-screen view
  const [timesUpMember, setTimesUpMember] = useState(null); // member name for TIMES UP overlay
  const [memberPins, setMemberPinsRaw] = useState(() => loadData("fcc_memberPins", {})); // {Nicholas:"1234",...}
  const [parentSettings, setParentSettingsRaw] = useState(() => loadData("fcc_parentSettings", {})); // { pinHash }
  const [pushSubscriptions, setPushSubscriptionsRaw] = useState(() => loadData("fcc_pushSubscriptions", {})); // { subId: { members, parent, subscription, device } }
  const [showReminders, setShowReminders] = useState(false);
  const [dateNights, setDateNightsRaw] = useState(() => loadData("fcc_dateNights", {})); // { "2026-09-27": { kid, status, day } }
  const [workLogs, setWorkLogsRaw] = useState(() => loadData("fcc_workLogs", {})); // { id: { kid, date, minutes, note, loggedAt, by } }
  const [workCashouts, setWorkCashoutsRaw] = useState(() => loadData("fcc_workCashouts", {})); // { id: { kid, month, minutes, rate, amount, at, paid } }
  // Tapping a reminder opens /?kid=Carter — expand that kid's card on Today.
  const [focusKid] = useState(() => { try { return new URLSearchParams(window.location.search).get("kid"); } catch { return null; } });
  // Whose jobs this device is looking at: a kid's name, or null for everyone.
  // Remembered per device (Carter's phone opens on Carter). A reminder tap wins
  // for that visit without changing what's remembered: /?kid=Carter opens
  // Carter, and the parent summary's /?kid=all opens Everyone.
  const [viewKid, setViewKidRaw] = useState(() => (focusKid != null ? knownKid(focusKid) : knownKid(loadData("fcc_viewKid", null))));
  const setViewKid = useCallback((name) => { setViewKidRaw(knownKid(name)); saveData("fcc_viewKid", knownKid(name)); }, []);
  const [afterPin, setAfterPin] = useState(null); // page to open once the parent PIN is accepted
  const [pinPrompt, setPinPrompt] = useState(null); // { member, action } when waiting on kid PIN
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [showAddTask, setShowAddTask] = useState(false);
  const [showTeamNaming, setShowTeamNaming] = useState(null);
  const [isParent, setIsParent] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const [milestone, setMilestone] = useState(null); // { member, streak }
  const [showSplash, setShowSplash] = useState(() => shouldShowSplash());
  const prevStreaksRef = useRef({});
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  const setCompletedChores = useFirebaseSync("completedChores", setCompletedChoresRaw);
  const setPoints = useFirebaseSync("points", setPointsRaw);
  const setStreaks = useFirebaseSync("streaks", setStreaksRaw);
  const setCustomTasks = useFirebaseSync("customTasks", setCustomTasksRaw);
  const setTeamNames = useFirebaseSync("teamNames", setTeamNamesRaw);
  const setAwards = useFirebaseSync("awards", setAwardsRaw);
  const setPrizes = useFirebaseSync("prizes", setPrizesRaw);
  const setCustomEmojis = useFirebaseSync("customEmojis", setCustomEmojisRaw);
  const setTeamColors = useFirebaseSync("teamColors", setTeamColorsRaw);
  const setGameUnlocks = useFirebaseSync("gameUnlocks", setGameUnlocksRaw);
  const setGameTimers = useFirebaseSync("gameTimers", setGameTimersRaw);
  const setChorePhotos = useFirebaseSync("chorePhotos", setChorePhotosRaw);
  const setMemberPins = useFirebaseSync("memberPins", setMemberPinsRaw);
  const setParentSettings = useFirebaseSync("parentSettings", setParentSettingsRaw);
  const setPushSubscriptions = useFirebaseSync("pushSubscriptions", setPushSubscriptionsRaw);
  const setDateNights = useFirebaseSync("dateNights", setDateNightsRaw);
  const setWorkLogs = useFirebaseSync("workLogs", setWorkLogsRaw);
  const setWorkCashouts = useFirebaseSync("workCashouts", setWorkCashoutsRaw);

  useEffect(() => { saveData("fcc_memberPins", memberPins); }, [memberPins]);
  useEffect(() => { saveData("fcc_parentSettings", parentSettings); }, [parentSettings]);
  useEffect(() => { saveData("fcc_pushSubscriptions", pushSubscriptions); }, [pushSubscriptions]);
  useEffect(() => { saveData("fcc_dateNights", dateNights); }, [dateNights]);
  useEffect(() => { saveData("fcc_workLogs", workLogs); }, [workLogs]);
  useEffect(() => { saveData("fcc_workCashouts", workCashouts); }, [workCashouts]);
  useEffect(() => { if (focusKid) { try { window.history.replaceState(null, "", window.location.pathname); } catch { /* ignore */ } } }, [focusKid]);
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

  // Compute streaks fresh each render (bounded 90-day scan, <5ms for 5 kids).
  // No cache — was causing drift. Source of truth = completedChores timestamps.
  const computedStreaks = useMemo(() => {
    const s = {};
    FAMILY_MEMBERS.forEach(m => {
      s[m.name] = calculateStreak(m.name, completedChores, today, customTasks);
    });
    return s;
  }, [completedChores, today, customTasks]);

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
    if (period === "weekly") return Math.max(0, points[`w_${weekStartKey}_${member}`] || 0);
    if (period === "monthly") return Math.max(0, points[`m_${monthKey}_${member}`] || 0);
    if (period === "yearly") return Math.max(0, points[`y_${yearKey}_${member}`] || 0);
    if (period === "alltime") return Math.max(0, points[`a_${member}`] || 0);
    return 0;
  }, [points, weekStartKey, monthKey, yearKey]);

  const getCustomTasksForMember = useCallback((member) => {
    if (!customTasks || customTasks._empty) return [];
    return Object.entries(customTasks)
      .filter(([key, task]) => key !== "_empty" && task && task.assignee === member && task.date === todayKey)
      .map(([key, task]) => ({ id: `custom_${key}`, taskKey: key, text: task.description, tag: "custom", pointValue: task.points || 1 }));
  }, [customTasks, todayKey]);

  // PIN gate: returns true if the action should proceed immediately, false if it
  // queued a PIN prompt that will run it after success. Parents bypass. Kids with
  // no PIN set also bypass (parent hasn't configured yet — soft rollout).
  const PIN_CACHE_MS = 5 * 60 * 1000;
  const pinGate = useCallback((member, action) => {
    if (isParent) { action(); return true; }
    const expected = memberPins?.[member];
    if (!expected || expected === true || (typeof expected === "object")) { action(); return true; }
    // Check cache
    try {
      const raw = sessionStorage.getItem(`fcc_pinCache_${member}`);
      if (raw) {
        const { ts } = JSON.parse(raw);
        if (Date.now() - ts < PIN_CACHE_MS) { action(); return true; }
      }
    } catch {}
    setPinPrompt({ member, action });
    return false;
  }, [isParent, memberPins]);

  const isChoreComplete = useCallback((member, choreId) => {
    return !!completedChores[`${todayKey}_${member}_${choreId}`];
  }, [completedChores, todayKey]);

  // Date-parameterized versions for Week View day detail
  const isChoreCompleteForDate = useCallback((member, choreId, date) => {
    return !!completedChores[`${dateToKey(date)}_${member}_${choreId}`];
  }, [completedChores]);

  // Toggle a chore for any date. Late penalty applies only at toggle-ON time;
  // toggle-OFF refunds exactly what was awarded (read from stored record).
  const toggleChoreForDate = useCallback((member, choreId, date, pointValue = 1) => {
    const doToggle = () => {
      const dk = dateToKey(date);
      const key = `${dk}_${member}_${choreId}`;
      const now = new Date(); now.setHours(0,0,0,0);
      const choreDate = new Date(dk + "T00:00:00");
      const daysDiff = Math.floor((now.getTime() - choreDate.getTime()) / (24*60*60*1000));
      const lateFactor = daysDiff > 1 ? 0.75 : 1;
      const effectivePoints = Math.round(pointValue * lateFactor * 100) / 100;
      // If this is a routine item, the points are all-or-nothing at the routine level.
      const routine = getRoutineForItemId(member, date, choreId);
      setCompletedChores(prev => {
        const next = { ...prev }; delete next._empty;
        const wasRoutineDone = routine ? routine.items.every(it => !!next[`${dk}_${member}_${it.id}`]) : false;
        const existing = next[key];
        let delta = 0;
        if (existing) {
          const refund = (existing === true) ? effectivePoints : (existing.pts ?? effectivePoints);
          delete next[key];
          delta -= refund;
        } else {
          next[key] = { ts: Date.now(), pts: effectivePoints };
          delta += effectivePoints;
        }
        if (routine) {
          const isRoutineDone = routine.items.every(it => !!next[`${dk}_${member}_${it.id}`]);
          const bonusKey = `${dk}_${member}_rt_${routine.key}_bonus`;
          if (isRoutineDone && !wasRoutineDone) {
            const bonus = Math.round(routine.bonus * lateFactor * 100) / 100;
            next[bonusKey] = { ts: Date.now(), pts: bonus };
            delta += bonus;
          } else if (!isRoutineDone && wasRoutineDone) {
            const rec = next[bonusKey];
            const refund = !rec ? routine.bonus : (rec === true ? routine.bonus : (rec.pts ?? routine.bonus));
            delete next[bonusKey];
            delta -= refund;
          }
        }
        if (delta !== 0) addPointsForDate(member, delta, date);
        return next;
      });
    };
    pinGate(member, doToggle);
  }, [addPointsForDate, pinGate]);

  // Toggle chore for TODAY. Same path as any other date (daysDiff is 0, so no
  // late penalty) — one implementation means UI and streak math can't drift.
  const toggleChore = useCallback((member, choreId, pointValue = 1) => {
    toggleChoreForDate(member, choreId, today, pointValue);
  }, [toggleChoreForDate, today]);

  // Generic: get chores for any member on any date
  // Built by buildChoreList() in schedule.js — shared with the reminder sender
  // (api/remind.js) so notifications list exactly what the Today screen shows.
  const getChoresForDate = useCallback((member, date) => buildChoreList(member, date, customTasks, completedChores), [completedChores, customTasks]);

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
    // Unlock for Fri/Sat games is based on THIS week's Mon-Thu chores.
    const weekStart = new Date(getWeekStart(today));  // Sunday of this week
    const weekKey = dateToKey(weekStart);

    // Check for parent override
    const overrideKey = `${weekKey}_${member}`;
    if (gameUnlocks && !gameUnlocks._empty && gameUnlocks[overrideKey]) {
      return { unlocked: true, parentOverride: true, housekeepingPct: 100, dinnerPct: 100, gameDay: isVideoGameDay(today), choresComplete: true };
    }

    let housekeepingTotal = 0;
    let housekeepingDone = 0;
    let dinnerTotal = 0;
    let dinnerDone = 0;

    // Loop Mon-Thu of this week (offset 1..4 from Sunday weekStart)
    for (let i = 1; i <= 4; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      const dk = dateToKey(d);
      const dn = getDayName(d);
      const daily = getDailyAssignment(member, d);
      if (!daily) continue;

      // Housekeeping task for that weekday
      const chart = getChartAssignment(member, d);
      const hkTask = chart.tasks[dn];
      if (hkTask) {
        housekeepingTotal++;
        if (completedChores[`${dk}_${member}_hk_${dn.toLowerCase()}`]) housekeepingDone++;
      }
      // HK Zone (Mon-Thu always include zone tidy)
      housekeepingTotal++;
      if (completedChores[`${dk}_${member}_hk_zone`]) housekeepingDone++;

      // Dinner jobs — every kid now has at least one every night (v2), so this
      // is a real gate rather than something that silently vanished on dishes days.
      daily.dinnerJobs.forEach(dj => {
        dinnerTotal++;
        if (completedChores[`${dk}_${member}_${dj.id}`]) dinnerDone++;
      });

      // Legacy younger-kid tasks count as housekeeping equivalent
      daily.youngTasks.forEach((_, idx) => {
        housekeepingTotal++;
        if (completedChores[`${dk}_${member}_task_${idx}`]) housekeepingDone++;
      });
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
    const weekStart = new Date(getWeekStart(today));
    const overrideKey = `${dateToKey(weekStart)}_${member}`;
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

  // ---- Shell: which page is showing, and what the top bar says ----
  const goTab = (tab) => { setCurrentTab(tab); try { window.scrollTo(0, 0); } catch { /* ignore */ } };
  const lockParent = () => { setIsParent(false); if (currentTab === "admin") goTab("more"); };
  // Parent tools sit behind the parent PIN: ask for it first if needed.
  const openParentTools = () => { if (isParent) goTab("admin"); else { setAfterPin("admin"); setShowPinDialog(true); } };
  const subPage = SUB_PAGES[currentTab] || null; // Games, Hall of Fame and Parent tools live under More
  const mainTab = subPage ? "more" : currentTab;
  const pageTitle = subPage ? subPage.title : (MAIN_TABS.find(t => t.key === currentTab)?.title || "Today");
  const pageKicker = subPage ? "More"
    : currentTab === "today" ? today.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })
    : currentTab === "leaderboard" ? (teamWeek ? "Team week" : "Individual week")
    : currentTab === "rotation" ? "Who does what"
    : "Family HQ";

  return (
    <><style>{styles}</style>
      {showSplash && <LaunchSplash onDone={() => setShowSplash(false)} />}
      <div className="app">
        <header className={`topbar ${subPage ? "sub" : ""}`}>
          <div className="topbar-left">
            {subPage
              ? <button className="icon-btn" onClick={() => goTab("more")} aria-label="Back to More"><Icons.ChevronLeft size={24} /></button>
              : <LogoMark size={38} />}
            <div className="topbar-text">
              <div className="topbar-kicker">{pageKicker}</div>
              <h1 className="topbar-title">{pageTitle}</h1>
            </div>
          </div>
          <div className="topbar-right">
            {!isOnline && <span className="offline-pill" title="Changes are saved on this device and sync when you're back online"><Icons.CloudOff size={14} /><span>Offline</span></span>}
            <button className="icon-btn" onClick={() => setShowReminders(true)} title="Reminders" aria-label="Reminders"><Icons.Bell size={22} /></button>
            {isParent ? (
              <button className="pill-btn" onClick={lockParent}><Icons.Lock size={16} /> Lock</button>
            ) : (
              <button className="pill-btn" onClick={() => setShowPinDialog(true)}><Icons.Lock size={16} /> Parent</button>
            )}
          </div>
        </header>
        <main className={`main ${isParent && currentTab === "today" ? "has-fab" : ""}`}>
          {currentTab === "today" && <TodayView viewKid={viewKid} setViewKid={setViewKid} onOpenGames={() => goTab("games")} dateNights={dateNights} setDateNights={setDateNights} workLogs={workLogs} setWorkLogs={setWorkLogs} workCashouts={workCashouts} setWorkCashouts={setWorkCashouts} pinGate={pinGate} members={FAMILY_MEMBERS} getMemberChores={getMemberChores} isChoreComplete={isChoreComplete} toggleChore={toggleChore} getCompletionCount={getCompletionCount} getPoints={getPoints} isParent={isParent} deleteCustomTask={deleteCustomTask} computedStreaks={computedStreaks} getMemberEmoji={getMemberEmoji} setMemberEmoji={setMemberEmoji} teamWeek={teamWeek} getTeamForMember={getTeamForMember} getTeamName={getTeamName} getTeamColor={getTeamColor} getVideoGameStatus={getVideoGameStatus} uploadChorePhoto={uploadChorePhoto} getChorePhoto={getChorePhoto} photoUploading={photoUploading} setPhotoViewer={setPhotoViewer} getChoresForDate={getChoresForDate} isChoreCompleteForDate={isChoreCompleteForDate} today={today} />}
          {currentTab === "week" && <WeekView today={today} weekOffset={weekOffset} setWeekOffset={setWeekOffset} getChoresForDate={getChoresForDate} isChoreCompleteForDate={isChoreCompleteForDate} toggleChoreForDate={toggleChoreForDate} getMemberEmoji={getMemberEmoji} getPoints={getPoints} computedStreaks={computedStreaks} isParent={isParent} deleteCustomTask={deleteCustomTask} teamWeek={teamWeek} getTeamForMember={getTeamForMember} getTeamName={getTeamName} getTeamColor={getTeamColor} />}
          {currentTab === "rotation" && <JobsView today={today} viewKid={viewKid} setViewKid={setViewKid} getMemberEmoji={getMemberEmoji} />}
          {currentTab === "leaderboard" && <LeaderboardView getPoints={getPoints} computedStreaks={computedStreaks} teamWeek={teamWeek} teams={teams} getTeamName={getTeamName} setTeamName={setTeamName} weekStartKey={weekStartKey} getAwardCounts={getAwardCounts} prizes={prizes} setPrizes={setPrizes} awards={awards} getMemberEmoji={getMemberEmoji} getTeamColor={getTeamColor} setTeamColor={setTeamColor} />}
          {currentTab === "games" && <GameView today={today} members={FAMILY_MEMBERS} getVideoGameStatus={getVideoGameStatus} getMemberEmoji={getMemberEmoji} gameTimers={gameTimers} startTimer={startTimer} pauseTimer={pauseTimer} stopTimer={stopTimer} adjustTimer={adjustTimer} isParent={isParent} toggleGameUnlock={toggleGameUnlock} setTimesUpMember={setTimesUpMember} />}
          {currentTab === "history" && <HistoryView awards={awards} points={points} teamNames={teamNames} getMemberEmoji={getMemberEmoji} today={today} getPoints={getPoints} isParent={isParent} onParentTools={openParentTools} onSeePoints={() => goTab("leaderboard")} />}
          {currentTab === "more" && <MoreView today={today} isOnline={isOnline} isParent={isParent} awards={awards} dateNights={dateNights} workLogs={workLogs} setWorkLogs={setWorkLogs} workCashouts={workCashouts} setWorkCashouts={setWorkCashouts} pinGate={pinGate} getMemberEmoji={getMemberEmoji} onOpen={goTab} onOneOnOne={() => { setViewKidRaw(null); goTab("today"); }} onReminders={() => setShowReminders(true)} onParentTools={openParentTools} onLock={lockParent} />}
          {currentTab === "admin" && isParent && <AdminView points={points} setPoints={setPoints} completedChores={completedChores} setCompletedChores={setCompletedChores} streaks={streaks} setStreaks={setStreaks} customTasks={customTasks} deleteCustomTask={deleteCustomTask} getPoints={getPoints} addPoints={addPoints} recordWeekAwards={recordWeekAwards} prizes={prizes} setPrizes={setPrizes} weekStartKey={weekStartKey} monthKey={monthKey} awards={awards} setAwards={setAwards} getVideoGameStatus={getVideoGameStatus} toggleGameUnlock={toggleGameUnlock} chorePhotos={chorePhotos} deleteChorePhoto={deleteChorePhoto} setPhotoViewer={setPhotoViewer} getMemberEmoji={getMemberEmoji} memberPins={memberPins} setMemberPins={setMemberPins} parentSettings={parentSettings} setParentSettings={setParentSettings} />}
        </main>
        <nav className="tabbar" aria-label="Main">
          <div className="tabbar-inner">
            {MAIN_TABS.map(({ key, label, Icon }) => (
              <button key={key} className={`tab-btn ${mainTab === key ? "active" : ""}`} aria-current={mainTab === key ? "page" : undefined} onClick={() => goTab(key)}><Icon size={22} />{label}</button>
            ))}
          </div>
        </nav>
        {isParent && currentTab === "today" && <button className="add-task-fab" onClick={() => setShowAddTask(true)} title="Add Custom Task"><Icons.Plus size={28} /></button>}
        {showReminders && <RemindersModal pushSubscriptions={pushSubscriptions} setPushSubscriptions={setPushSubscriptions} isParent={isParent} getMemberEmoji={getMemberEmoji} onClose={() => setShowReminders(false)} />}
        {showPinDialog && <PinDialog parentSettings={parentSettings} onSuccess={() => { setIsParent(true); setShowPinDialog(false); if (afterPin) { goTab(afterPin); setAfterPin(null); } }} onClose={() => { setShowPinDialog(false); setAfterPin(null); }} />}
        {pinPrompt && (() => {
          const m = FAMILY_MEMBERS.find(f => f.name === pinPrompt.member);
          const expected = memberPins?.[pinPrompt.member];
          return (
            <KidPinDialog
              member={pinPrompt.member}
              memberEmoji={getMemberEmoji(pinPrompt.member)}
              memberColor={m?.color}
              expectedPin={expected}
              onSuccess={() => {
                try { sessionStorage.setItem(`fcc_pinCache_${pinPrompt.member}`, JSON.stringify({ ts: Date.now() })); } catch {}
                const a = pinPrompt.action;
                setPinPrompt(null);
                if (a) a();
              }}
              onClose={() => setPinPrompt(null)}
            />
          );
        })()}
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
// SHARED BITS — faces, progress rings, streak tags, dinner jobs
// ============================================================
// A kid's emoji on their colour.
function Avatar({ member, emoji, size = 38, className = "", title }) {
  return <span className={`avatar ${className}`} title={title} role={title ? "img" : undefined} aria-label={title} style={{ width: size, height: size, fontSize: Math.round(size * 0.5), background: member.color }}>{emoji}</span>;
}

// A progress ring drawn around whatever is inside it (0-100).
function Ring({ pct, color, size = 48, thickness = 4, inner = "var(--bg-primary)", children }) {
  const deg = Math.round(Math.max(0, Math.min(100, pct || 0)) * 3.6);
  return (
    <span className="ring" style={{ width: size, height: size, background: `conic-gradient(${color} ${deg}deg, var(--ring-track) 0deg)` }}>
      <span className="ring-inner" style={{ width: size - thickness * 2, height: size - thickness * 2, background: inner }}>{children}</span>
    </span>
  );
}

// The row of faces: Everyone, then each kid. `value` is a kid's name or null.
// Pass `progress` ({ name: 0-100 }) to draw today's ring around each face.
function KidSwitcher({ value, onChange, getMemberEmoji, progress }) {
  return (
    <div className="faces" role="group" aria-label="Whose jobs to show" style={{ gridTemplateColumns: `repeat(${FAMILY_MEMBERS.length + 1}, minmax(0, 1fr))` }}>
      <button className={`face ${!value ? "active" : ""}`} aria-pressed={!value} onClick={() => onChange(null)}>
        <span className="face-all"><Icons.Users size={24} /></span>
        <span className="face-name">Everyone</span>
      </button>
      {FAMILY_MEMBERS.map(m => {
        const emoji = getMemberEmoji(m.name);
        const p = progress ? progress[m.name] : null;
        return (
          <button key={m.name} className={`face ${value === m.name ? "active" : ""}`} aria-pressed={value === m.name} onClick={() => onChange(m.name)}>
            {p != null
              ? <Ring pct={p} color={p >= 100 ? "var(--success)" : m.color} size={48}><span className="face-emoji">{emoji}</span></Ring>
              : <Avatar member={m} emoji={emoji} size={44} />}
            <span className="face-name">{m.name}</span>
          </button>
        );
      })}
    </div>
  );
}

// Streak flames — same tiers everywhere a streak is shown.
function StreakTag({ streak }) {
  if (streak >= 30) return <span className="streak-on-fire">🔥 {streak}d ON FIRE</span>;
  if (streak >= 14) return <span className="streak-fire streak-fire-3" title={`${streak}-day streak!`}>🔥🔥🔥 {streak}d</span>;
  if (streak >= 7) return <span className="streak-fire streak-fire-2" title={`${streak}-day streak!`}>🔥🔥 {streak}d</span>;
  if (streak >= 3) return <span className="streak-fire streak-fire-1" title={`${streak}-day streak!`}>🔥 {streak}d</span>;
  return null;
}

// Who has each dinner job on a given night. Built from the same
// getDailyAssignment() the Today screen uses, so the screens can't disagree.
const NIGHTLY_JOBS = [
  { key: "Dishes", label: "Dishes" },
  { key: "Clear Table", label: "Clear" },
  { key: "Take Out Trash", label: "Trash" },
  { key: "Floor Pickup", label: "Floor" },
  { key: "Set Table", label: "Set" },
];
function getNightlyJobs(date) {
  const jobs = {};
  FAMILY_MEMBERS.forEach(m => {
    const a = getDailyAssignment(m.name, date);
    if (!a) return;
    if (a.dishes) (jobs["Dishes"] = jobs["Dishes"] || []).push(m.name);
    a.dinnerJobs.forEach(dj => { (jobs[dj.job] = jobs[dj.job] || []).push(m.name); });
  });
  return jobs;
}

// The next day games are allowed (today counts). Null if none in two weeks.
function nextGameDay(from) {
  for (let i = 0; i < 14; i++) {
    const d = new Date(from); d.setDate(d.getDate() + i);
    if (isVideoGameDay(d)) return { date: d, daysAway: i };
  }
  return null;
}

const isDishChore = (c) => c.id === "dishes" || c.id.startsWith("dishes_");

// ============================================================
// TODAY VIEW
// ============================================================
function StreakSpotlight({ members, computedStreaks, getMemberEmoji }) {
  const [expanded, setExpanded] = useState(false);
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
  const activeCount = streakData.filter(s => s.streak >= 1).length;
  const topStreak = streakData[0]?.streak || 0;

  return (
    <div className="card animate-in streak-spotlight">
      <div className="card-title" onClick={() => setExpanded(!expanded)} style={{ cursor: "pointer", justifyContent: "space-between", marginBottom: expanded ? 14 : 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icons.Fire size={20} color="#fb923c" /> Streak Tracker
          <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", fontWeight: 400 }}>· {activeCount} active · top {topStreak}d</span>
        </span>
        <div style={{ transform: expanded ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.2s", color: "var(--text-muted)", display: "flex", alignItems: "center" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
        </div>
      </div>
      {expanded && (
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
      )}
    </div>
  );
}

function TodayView({ viewKid, setViewKid, onOpenGames, dateNights, setDateNights, workLogs, setWorkLogs, workCashouts, setWorkCashouts, pinGate, members, getMemberChores, isChoreComplete, toggleChore, getPoints, isParent, deleteCustomTask, computedStreaks, getMemberEmoji, setMemberEmoji, getVideoGameStatus, getChoresForDate, isChoreCompleteForDate, today }) {
  const [emojiPicker, setEmojiPicker] = useState(false);
  const [jobsModal, setJobsModal] = useState(null); // member name or null
  const [workModal, setWorkModal] = useState(null); // kid name for the work-hours log
  const [expanded, setExpanded] = useState(() => new Set()); // open routine cards and job details
  const toggleExpanded = (name) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  useEffect(() => { setEmojiPicker(false); }, [viewKid]);

  const weeklyJobsData = useMemo(() => {
    if (!jobsModal || !getChoresForDate || !isChoreCompleteForDate) return null;
    const weekStart = getWeekStart(today);
    const todayKey = dateToKey(today);
    const days = [];
    let totalChores = 0;
    let doneChores = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      const dk = dateToKey(d);
      const dayName = getDayName(d);
      const chores = getChoresForDate(jobsModal, d).filter(c => !c.routine);
      const choreStatuses = chores.map(c => ({
        ...c,
        done: isChoreCompleteForDate(jobsModal, c.id, d),
      }));
      totalChores += chores.length;
      doneChores += choreStatuses.filter(c => c.done).length;
      days.push({ date: d, dateKey: dk, dayName, chores: choreStatuses, isToday: dk === todayKey });
    }
    return { days, totalChores, doneChores, pct: totalChores > 0 ? Math.round((doneChores / totalChores) * 100) : 0 };
  }, [jobsModal, getChoresForDate, isChoreCompleteForDate, today]);

  // One pass over every kid's list for today: counts, tags and what's left.
  // Routine checklists (morning / bedtime) are kept apart from the job count,
  // the same way they always have been.
  const kids = members.map(member => {
    const name = member.name;
    const allChores = getMemberChores(name);
    const chores = allChores.filter(c => !c.routine);
    const routineGroups = [];
    allChores.filter(c => c.routine).forEach(c => {
      let g = routineGroups.find(r => r.key === c.routine);
      if (!g) { g = { key: c.routine, label: c.routineLabel, icon: c.routineIcon, bonus: c.routineBonus, items: [] }; routineGroups.push(g); }
      g.items.push(c);
    });
    const done = chores.filter(c => isChoreComplete(name, c.id)).length;
    const total = chores.length;
    const dishJobs = chores.filter(isDishChore);
    const routineItems = allChores.filter(c => c.routine);
    return {
      member, name, emoji: getMemberEmoji(name), chores, routineGroups, done, total,
      pct: total > 0 ? Math.round((done / total) * 100) : 0,
      allDone: total > 0 && done === total,
      // No-miss jobs still outstanding.
      priorityOpen: chores.filter(c => c.priority && !isChoreComplete(name, c.id)),
      hasDishes: dishJobs.length > 0,
      dishesDone: dishJobs.length > 0 && dishJobs.every(c => isChoreComplete(name, c.id)),
      routineTotal: routineItems.length,
      routineDone: routineItems.filter(c => isChoreComplete(name, c.id)).length,
      streak: computedStreaks?.[name] || 0,
      points: getPoints(name, "weekly"),
    };
  });
  const progress = Object.fromEntries(kids.map(k => [k.name, k.pct]));
  const familyDone = kids.reduce((s, k) => s + k.done, 0);
  const familyTotal = kids.reduce((s, k) => s + k.total, 0);
  const kid = viewKid ? kids.find(k => k.name === viewKid) : null;

  // Tonight's three "whose turn is it" jobs — dishes, clear table, trash —
  // side by side in equal columns so everyone can see them at a glance.
  const tonight = [
    { key: "dishes", label: "Dishes", match: isDishChore },
    { key: "clear", label: "Clear table", match: c => c.id === "dinner_clear" },
    { key: "trash", label: "Trash", match: c => c.id === "dinner_trash" },
  ].map(col => ({
    ...col,
    kids: kids.map(k => {
      const jobs = k.chores.filter(col.match);
      if (!jobs.length) return null;
      const doneCount = jobs.filter(c => isChoreComplete(k.name, c.id)).length;
      return { m: k.member, emoji: k.emoji, total: jobs.length, doneCount, done: doneCount === jobs.length };
    }).filter(Boolean),
  }));
  const tonightAssigned = tonight.flatMap(c => c.kids);
  const tonightDone = tonightAssigned.length > 0 && tonightAssigned.every(k => k.done);

  const renderChore = (k, chore) => {
    const completed = isChoreComplete(k.name, chore.id);
    const isCustom = chore.tag === "custom";
    const infoKey = `${k.name}::info::${chore.id}`;
    const infoOpen = expanded.has(infoKey);
    const toggle = () => toggleChore(k.name, chore.id, chore.pointValue || 1);
    return (
      <div key={chore.id} className={`chore-item ${completed ? "completed" : ""} ${chore.priority ? "priority" : ""}`} onClick={toggle}>
        <button type="button" className={`chore-checkbox ${completed ? "checked check-pop" : ""}`} aria-pressed={completed} aria-label={chore.text} onClick={(e) => { e.stopPropagation(); toggle(); }}>{completed && <Icons.Check size={16} color="#0d111a" />}</button>
        <div className="chore-body">
          <span className="chore-text">{chore.text}</span>
          {infoOpen && chore.details && <div className="chore-details" onClick={(e) => { e.stopPropagation(); toggleExpanded(infoKey); }}>{chore.details}</div>}
        </div>
        {chore.details && <button className={`chore-info-btn ${infoOpen ? "open" : ""}`} onClick={(e) => { e.stopPropagation(); toggleExpanded(infoKey); }} title={infoOpen ? "Hide details" : "What this job includes"} aria-label="What this job includes"><Icons.Info size={20} /></button>}
        {isCustom && chore.pointValue > 1 && <span className="chore-points-badge">+{chore.pointValue}</span>}
        {chore.priority && <span className="must-do-badge">⚠ MUST DO</span>}
        <span className={`chore-tag tag-${chore.tag}`}>{chore.tag}</span>
        {isParent && isCustom && <button className="chore-delete-btn" onClick={(e) => { e.stopPropagation(); deleteCustomTask(chore.taskKey); }} title="Delete task"><Icons.X size={16} /></button>}
      </div>
    );
  };

  return (
    <div className="page">
      <KidSwitcher value={viewKid} onChange={setViewKid} getMemberEmoji={getMemberEmoji} progress={progress} />

      {/* ---------- Everyone ---------- */}
      {!kid && (
        <>
          <section className={`tonight ${tonightDone ? "done" : ""}`} aria-label="Tonight's dinner jobs">
            <div className="mini-label">{tonightDone ? "Tonight · all done" : "Tonight"}</div>
            <div className="duty-grid">
              {tonight.map(col => (
                <div key={col.key} className="duty-col">
                  <div className="duty-label">{col.label}</div>
                  <div className="duty-chips">
                    {col.kids.length === 0 && <span className="duty-none">{col.key === "dishes" ? "Day off" : "—"}</span>}
                    {col.kids.map(({ m, emoji, total, doneCount, done }) => (
                      <span key={m.name} className={`duty-chip ${done ? "done" : ""}`} style={done ? undefined : { background: m.color }}>
                        <span className="duty-chip-emoji">{emoji}</span>
                        <span className="duty-chip-name">{m.name}</span>
                        {done ? <span className="duty-chip-check">✓</span> : total > 1 && <span className="duty-chip-count">{doneCount}/{total}</span>}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
          <DateNightCard today={today} dateNights={dateNights} setDateNights={setDateNights} isParent={isParent} getMemberEmoji={getMemberEmoji} />
          <StreakSpotlight members={members} computedStreaks={computedStreaks} getMemberEmoji={getMemberEmoji} />
          <section className="stack-8" aria-label="Jobs today">
            <div className="section-head"><h2>Jobs today</h2><span>{familyDone} of {familyTotal} done</span></div>
            <div className="rows">
              {kids.map(k => {
                const work = MONTHLY_WORK[k.name] ? getWorkMonth(k.name, getMonthKey(today), workLogs, workCashouts) : null;
                const gs = getVideoGameStatus(k.name);
                return (
                  <button key={k.name} id={`member-${k.name}`} className="row" onClick={() => setViewKid(k.name)}>
                    <Avatar member={k.member} emoji={k.emoji} size={38} />
                    <span className="row-body">
                      <span className="row-top">
                        <span className="row-tags">
                          <span className="row-name">{k.name}</span>
                          {k.hasDishes && <span className={`tag-pill ${k.dishesDone ? "ok" : "dishes"}`}>Dishes{k.dishesDone ? " ✓" : ""}</span>}
                          <StreakTag streak={k.streak} />
                          {work && !work.beforeStart && <span className={`tag-pill ${work.remaining === 0 ? "ok" : "work"}`}>Work {formatMinutes(work.logged)} of {formatMinutes(work.target)}</span>}
                          {k.routineTotal > 0 && <span className={`tag-pill ${k.routineDone === k.routineTotal ? "ok" : "routine"}`}>Routines {k.routineDone} of {k.routineTotal}</span>}
                          {gs.unlocked ? <span className="tag-pill ok" title={gs.parentOverride ? "Unlocked by a parent" : "Video games unlocked"}>🎮 Unlocked</span>
                            : gs.gameDay ? <span className="tag-pill locked" title={`Housekeeping ${gs.housekeepingPct}% · Dinner ${gs.dinnerPct}%`}>🎮 Locked</span> : null}
                        </span>
                        <span className={`row-count ${k.allDone ? "ok" : ""}`}>{k.total === 0 ? "No jobs" : k.allDone ? "All done" : `${k.done} of ${k.total}`}</span>
                      </span>
                      <span className="bar"><span style={{ width: `${k.pct}%`, background: k.allDone ? "var(--success)" : k.member.color }} /></span>
                      {k.priorityOpen.length > 0 && (
                        <span className="must-do-alert">
                          <span className="must-do-alert-icon">⚠</span>
                          <span className="must-do-alert-text">{k.priorityOpen.length === 1 ? k.priorityOpen[0].text : `${k.priorityOpen.length} must-do jobs today`}</span>
                        </span>
                      )}
                    </span>
                    <span className="row-points" title="Points this week"><Icons.Star size={14} color="#fbbf24" filled />{k.points}</span>
                    <span className="row-chev"><Icons.ChevronRight size={18} /></span>
                  </button>
                );
              })}
            </div>
          </section>
        </>
      )}

      {/* ---------- One kid ---------- */}
      {kid && (() => {
        const name = kid.name;
        const left = kid.total - kid.done;
        const isWeekend = today.getDay() === 0 || today.getDay() === 6;
        const openChores = kid.chores.filter(c => !isChoreComplete(name, c.id));
        const doneChores = kid.chores.filter(c => isChoreComplete(name, c.id));
        const gs = getVideoGameStatus(name);
        const nextGame = nextGameDay(today);
        const gameText = gs.unlocked ? (gs.parentOverride ? "Games unlocked by a parent" : "Games unlocked")
          : gs.gameDay ? "Games locked today"
          : nextGame ? `Games open ${nextGame.daysAway === 1 ? "tomorrow" : nextGame.date.toLocaleDateString("en-US", { weekday: "long" })}`
          : "Video games";
        const gameNote = gs.unlocked ? "" : gs.gameDay ? `Jobs ${gs.housekeepingPct}% · Dinner ${gs.dinnerPct}%` : "Mon–Thu jobs unlock them";
        return (
          <div className="kid-view" id={`member-${name}`}>
            <section className="hero">
              <Ring pct={kid.pct} color={kid.allDone ? "var(--success)" : kid.member.color} size={88} thickness={8} inner="var(--bg-card)">
                <span className="hero-count">{kid.done}<small> / {kid.total}</small></span>
                <span className="hero-done">done</span>
              </Ring>
              <div className="hero-body">
                <div className="hero-name">
                  <button className="emoji-picker-btn" onClick={() => setEmojiPicker(v => !v)} title="Change picture" aria-label={`Change ${name}'s picture`}><Avatar member={kid.member} emoji={kid.emoji} size={34} /></button>
                  {name}
                </div>
                <div className="hero-left">{kid.total === 0 ? "Nothing assigned today" : kid.allDone ? "All done for today" : `${left} job${left === 1 ? "" : "s"} left today`}</div>
                <div className="hero-chips">
                  <span className="chip points"><Icons.Star size={13} color="#fcd34d" filled /> {kid.points} this week</span>
                  {kid.hasDishes && <span className={`chip ${kid.dishesDone ? "ok" : "dishes"}`}>{kid.dishesDone ? "Dishes done ✓" : "Dishes tonight"}</span>}
                  <StreakTag streak={kid.streak} />
                </div>
              </div>
            </section>

            {emojiPicker && (
              <div className="emoji-grid emoji-panel">
                {EMOJI_OPTIONS.map(e => (
                  <div key={e} className={`emoji-option ${kid.emoji === e ? "selected" : ""}`} onClick={() => { setMemberEmoji(name, e); setEmojiPicker(false); }}>{e}</div>
                ))}
              </div>
            )}

            <button className={`info-line ${gs.unlocked ? "good" : ""}`} onClick={onOpenGames}>
              <Icons.Gamepad size={20} />
              <span className="info-line-text">{gameText}{gameNote && <small>{gameNote}</small>}</span>
              <Icons.ChevronRight size={16} />
            </button>

            {MONTHLY_WORK[name] && <WorkHoursBar kid={name} color={kid.member.color} today={today} workLogs={workLogs} workCashouts={workCashouts} onOpen={() => setWorkModal(name)} />}

            {/* What's left, grouped by time of day (must-do jobs stay first within their group). */}
            <div className="chore-list">
              {CHORE_TIME_GROUPS.map(group => {
                const items = openChores.filter(c => (c.when || "day") === group.key);
                if (items.length === 0) return null;
                return (
                  <Fragment key={group.key}>
                    <div className="chore-group-label">
                      <span>{isWeekend && group.weekendIcon ? group.weekendIcon : group.icon}</span>
                      {isWeekend && group.weekendLabel ? group.weekendLabel : group.label}
                    </div>
                    {items.map(c => renderChore(kid, c))}
                  </Fragment>
                );
              })}
              {kid.chores.length === 0 && <div className="chore-empty">Nothing assigned today</div>}
              {kid.chores.length > 0 && openChores.length === 0 && (
                <div className="all-done">
                  <span className="all-done-check"><Icons.Check size={22} color="#0d111a" /></span>
                  <span><b>All done for today</b><small>Every job is checked off. Nice work!</small></span>
                </div>
              )}
            </div>

            {kid.routineGroups.map((rg) => {
              const rKey = `${name}::${rg.key}`;
              const rOpen = expanded.has(rKey);
              const rDone = rg.items.filter(it => isChoreComplete(name, it.id)).length;
              const rTotal = rg.items.length;
              const rComplete = rDone === rTotal;
              const rPct = rTotal > 0 ? Math.round((rDone / rTotal) * 100) : 0;
              return (
                <div key={rg.key} className={`routine-card ${rComplete ? "complete" : ""}`}>
                  <div className="routine-header" onClick={() => toggleExpanded(rKey)}>
                    <div className="routine-icon">{rg.icon}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="routine-title">{rg.label}</div>
                      <div className="routine-meta">
                        {rComplete
                          ? <span style={{ color: "#34d399" }}>Complete · +{rg.bonus} pts earned</span>
                          : <span>{rDone} of {rTotal} · +{rg.bonus} pts when all done</span>}
                      </div>
                    </div>
                    <div className={`routine-bonus-chip ${rComplete ? "earned" : ""}`}>+{rg.bonus}</div>
                    <div className="expand-chevron" style={{ transform: rOpen ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.2s", color: "var(--text-secondary)", display: "flex", alignItems: "center" }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                    </div>
                  </div>
                  <div className="member-progress">
                    <div className="member-progress-fill" style={{ width: `${rPct}%`, background: rComplete ? "#10B981" : kid.member.color }} />
                  </div>
                  {rOpen && (
                    <div className="chore-list" style={{ marginTop: 10 }}>
                      {rg.items.map((item) => {
                        const completed = isChoreComplete(name, item.id);
                        return (
                          <div key={item.id} className={`chore-item ${completed ? "completed" : ""}`} onClick={() => toggleChore(name, item.id, item.pointValue ?? 0)}>
                            <button type="button" className={`chore-checkbox ${completed ? "checked check-pop" : ""}`} aria-pressed={completed} aria-label={item.text} onClick={(e) => { e.stopPropagation(); toggleChore(name, item.id, item.pointValue ?? 0); }}>{completed && <Icons.Check size={16} color="#0d111a" />}</button>
                            <span className="chore-text">{item.text}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            {doneChores.length > 0 && (
              <div className="chore-list done-list">
                <div className="section-head"><h2 className="ok">Done</h2><span>tap to undo</span></div>
                {doneChores.map(c => renderChore(kid, c))}
              </div>
            )}

            <button className="link-btn" onClick={() => setJobsModal(name)}>See {name}'s whole week</button>
          </div>
        );
      })()}

      {workModal && <WorkHoursModal kid={workModal} today={today} workLogs={workLogs} setWorkLogs={setWorkLogs} workCashouts={workCashouts} setWorkCashouts={setWorkCashouts} isParent={isParent} pinGate={pinGate} getMemberEmoji={getMemberEmoji} onClose={() => setWorkModal(null)} />}
      {jobsModal && weeklyJobsData && (
        <div className="modal-overlay" onClick={() => setJobsModal(null)}>
          <div className="my-jobs-modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontFamily: "'Fredoka', sans-serif", fontSize: "1.2rem", fontWeight: 700 }}>
                {getMemberEmoji(jobsModal)} {jobsModal}'s Week
              </div>
              <button onClick={() => setJobsModal(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)", fontSize: "1.5rem" }} aria-label="Close">&times;</button>
            </div>
            <div className="my-jobs-summary">
              <div className="my-jobs-summary-stat">
                <div className="stat-value" style={{ color: weeklyJobsData.pct === 100 ? "#10B981" : "var(--text-primary)" }}>{weeklyJobsData.pct}%</div>
                <div className="stat-label">Complete</div>
              </div>
              <div className="my-jobs-summary-stat">
                <div className="stat-value" style={{ color: "#10B981" }}>{weeklyJobsData.doneChores}</div>
                <div className="stat-label">Done</div>
              </div>
              <div className="my-jobs-summary-stat">
                <div className="stat-value" style={{ color: weeklyJobsData.totalChores - weeklyJobsData.doneChores > 0 ? "#EF4444" : "var(--text-muted)" }}>{weeklyJobsData.totalChores - weeklyJobsData.doneChores}</div>
                <div className="stat-label">Remaining</div>
              </div>
            </div>
            {weeklyJobsData.days.map(day => (
              <div key={day.dateKey} className="my-jobs-day">
                <div className="my-jobs-day-header">
                  {day.dayName}
                  <span className={`day-badge ${day.isToday ? "today" : ""}`}>{day.isToday ? "Today" : day.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                  <span style={{ marginLeft: "auto", fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                    {day.chores.filter(c => c.done).length}/{day.chores.length}
                  </span>
                </div>
                {day.chores.length === 0 && <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", paddingLeft: 10 }}>No chores</div>}
                {day.chores.map(chore => (
                  <div key={chore.id} className={`my-jobs-chore ${chore.done ? "done" : ""} ${chore.priority ? "priority" : ""}`}>
                    <span className="chore-status">{chore.done ? "✅" : chore.priority ? "⚠️" : "⬜"}</span>
                    <span style={{ flex: 1 }}>{chore.text}</span>
                    <span className={`chore-tag tag-${chore.tag}`} style={{ fontSize: "0.65rem" }}>{chore.tag}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
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
  const sorted = useMemo(() => {
    return [...FAMILY_MEMBERS].sort((a, b) => getPoints(b.name, period) - getPoints(a.name, period));
  }, [getPoints, period]);

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
    <div className="page">
      {/* Time period */}
      <div className="seg" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }} role="group" aria-label="Time period">
        {[["weekly","Week"],["monthly","Month"],["yearly","Year"],["alltime","All time"]].map(([key, label]) => (
          <button key={key} className={period === key ? "active" : ""} aria-pressed={period === key} onClick={() => setPeriod(key)}>{label}</button>
        ))}
      </div>

      {/* Prize Cards */}
      <PrizeDisplay prizes={prizes} setPrizes={setPrizes} weekStartKey={weekStartKey} period={period} awards={awards} teamWeek={teamWeek} />

      {/* Team standings (team weeks only, weekly period) */}
      {teamWeek && teams && period === "weekly" && teamScores && (
        <div className="animate-in">
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

      {/* Podium for the top three, everyone else listed underneath */}
      {(() => {
        const periodWord = period === "weekly" ? "this week" : period === "monthly" ? "this month" : period === "yearly" ? "this year" : "all time";
        const allPts = sorted.map(m => getPoints(m.name, period));
        const ranked = sorted.map((member, i) => ({
          member, i,
          place: 1 + allPts.filter(p => p > allPts[i]).length, // tied kids share a place
          pts: getPoints(member.name, period),
          streak: computedStreaks?.[member.name] || 0,
          wins: period !== "weekly" ? getAwardCounts(member.name, "win", period) : 0,
          mvps: period !== "weekly" ? getAwardCounts(member.name, "mvp", period) : 0,
        }));
        const total = ranked.reduce((s, r) => s + r.pts, 0);
        const extras = (r) => (
          <>
            {r.streak >= 3 ? <StreakTag streak={r.streak} /> : r.streak >= 1 ? <span>🔥 {r.streak}d</span> : null}
            {r.wins > 0 && <span style={{ color: "#fbbf24" }}>🏆 {r.wins} win{r.wins !== 1 ? "s" : ""}</span>}
            {r.mvps > 0 && <span style={{ color: "#c4b5fd" }}>⭐ {r.mvps} MVP{r.mvps !== 1 ? "s" : ""}</span>}
          </>
        );
        // Only kids who have points stand on the podium.
        const onPodium = ranked.slice(0, 3).filter(r => r.pts > 0);
        const rest = ranked.filter(r => !onPodium.includes(r));
        const MEDALS = [
          { color: "#fbbf24", height: 100, size: 80, num: 36 },
          { color: "#cbd5e1", height: 70, size: 62, num: 28 },
          { color: "#d99a5b", height: 50, size: 62, num: 24 },
        ];
        return (
          <>
            {total === 0 && <div className="section-note" style={{ textAlign: "center", padding: "8px 0" }}>No points yet {periodWord}. Check off a job to get on the board.</div>}
            {onPodium.length > 0 && (
              <section className="podium" aria-label={`Top of the board ${periodWord}`} style={{ gridTemplateColumns: `repeat(${onPodium.length}, minmax(0, 1fr))`, maxWidth: 153 * onPodium.length }}>
                {(onPodium.length === 3 ? [onPodium[1], onPodium[0], onPodium[2]] : onPodium.length === 2 ? [onPodium[1], onPodium[0]] : onPodium).map(r => {
                  const medal = MEDALS[r.place - 1];
                  return (
                    <div key={r.member.name} className={`podium-col ${r.place === 1 ? "first" : ""}`}>
                      {r.place === 1 && <Icons.Crown size={26} color="#fbbf24" />}
                      <span className="avatar" style={{ width: medal.size, height: medal.size, fontSize: Math.round(medal.size * 0.48), background: r.member.color, boxShadow: `0 0 0 3px var(--bg-primary), 0 0 0 ${r.place === 1 ? 6 : 5}px ${medal.color}` }}>{getMemberEmoji(r.member.name)}</span>
                      <span className="podium-name">{r.member.name}</span>
                      <span className="podium-pts"><Icons.Star size={r.place === 1 ? 17 : 15} color="#fbbf24" filled />{r.pts}</span>
                      <span className="podium-extra">{extras(r)}</span>
                      <div className="podium-block" style={{ height: medal.height, borderTopColor: medal.color, color: medal.color, fontSize: medal.num }}>{r.place}</div>
                    </div>
                  );
                })}
              </section>
            )}
            {rest.length > 0 && (
              <section className={`rows ${onPodium.length > 0 ? "podium-rest" : ""}`} aria-label="Standings">
                {rest.map(r => {
                  const above = r.i > 0 ? ranked[r.i - 1] : null;
                  const gap = above ? above.pts - r.pts : 0;
                  return (
                    <div key={r.member.name} className="row">
                      <span className="rank-num">{r.place}</span>
                      <Avatar member={r.member} emoji={getMemberEmoji(r.member.name)} size={38} />
                      <span className="row-label">
                        <span className="row-name">{r.member.name}</span>
                        {total > 0 && (r.pts === 0 ? <small>No points yet</small> : above && <small>{gap === 0 ? `Tied with ${above.member.name}` : `${gap} behind ${above.member.name}`}</small>)}
                        <span className="podium-extra" style={{ justifyContent: "flex-start", minHeight: 0 }}>{extras(r)}</span>
                      </span>
                      <span className="row-points" style={{ fontSize: "1.06rem" }}><Icons.Star size={15} color="#fbbf24" filled />{r.pts}</span>
                    </div>
                  );
                })}
              </section>
            )}
            <div className="total-line">
              <span>Family total {periodWord}</span>
              <b><Icons.Star size={16} color="#fbbf24" filled />{total}</b>
            </div>
          </>
        );
      })()}
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
function WeekView({ today, weekOffset, setWeekOffset, getChoresForDate, isChoreCompleteForDate, toggleChoreForDate, getMemberEmoji, isParent, deleteCustomTask, teamWeek, getTeamForMember, getTeamName, getTeamColor }) {
  const todayKey = dateToKey(today);
  const weekStart = useMemo(() => { const d = getWeekStart(today); d.setDate(d.getDate() + weekOffset * 7); return d; }, [today, weekOffset]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(d.getDate() + i); return d; }), [weekStart]);
  const weekLabel = `${days[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${days[6].toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  const [pickedKey, setPickedKey] = useState(null); // a day the user tapped; otherwise today (Sunday in other weeks)
  const [openKid, setOpenKid] = useState(null); // whose checklist is open for the picked day

  // Start fresh when changing weeks
  const prevWeekOffset = useRef(weekOffset);
  useEffect(() => { if (prevWeekOffset.current !== weekOffset) { setPickedKey(null); setOpenKid(null); prevWeekOffset.current = weekOffset; } }, [weekOffset]);

  // Jobs done / total for the whole family on each day. Routine checklists
  // aren't counted, so the numbers match the Today screen.
  const stats = days.map(date => {
    const key = dateToKey(date);
    let done = 0, total = 0;
    FAMILY_MEMBERS.forEach(m => {
      const jobs = getChoresForDate(m.name, date).filter(c => !c.routine);
      total += jobs.length;
      done += jobs.filter(c => isChoreCompleteForDate(m.name, c.id, date)).length;
    });
    return { date, key, done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0, complete: total > 0 && done === total, isToday: key === todayKey, isPast: key < todayKey };
  });
  const sel = stats.find(s => s.key === pickedKey) || stats.find(s => s.isToday) || stats[0];
  const nightly = getNightlyJobs(sel.date);

  // Later this week: days with a once-a-week must-do job, and game days.
  // A job that only shows up because an earlier day's wasn't checked yet
  // ("carried over") isn't news, and in summer every day is a game day.
  const everyDayIsGameDay = days.every(d => isVideoGameDay(d));
  const comingUp = stats.filter(s => s.key > todayKey && s.key !== sel.key).map(s => {
    const who = FAMILY_MEMBERS.filter(m => getChoresForDate(m.name, s.date).some(c => c.priority && !/carried over/i.test(c.text))).map(m => m.name);
    return { ...s, who, gameDay: !everyDayIsGameDay && isVideoGameDay(s.date) };
  }).filter(s => s.who.length > 0 || s.gameDay);
  // Weeks before the current schedule began used different dinner jobs.
  const oldSchedule = !!getDailyAssignment(FAMILY_MEMBERS[0].name, sel.date)?.legacy;

  return (
    <div className="page">
      <div className="week-switch">
        <button className="week-nav-btn" onClick={() => setWeekOffset(o => o - 1)} aria-label="Previous week"><Icons.ChevronLeft size={20} /></button>
        <span className="week-switch-label">
          {weekLabel}
          {weekOffset === 0 ? <span className="today-pill">This week</span> : <button className="small-btn" onClick={() => setWeekOffset(0)}>Back to this week</button>}
        </span>
        <button className="week-nav-btn" onClick={() => setWeekOffset(o => o + 1)} aria-label="Next week"><Icons.ChevronRight size={20} /></button>
      </div>

      <div className="daystrip" role="group" aria-label="Pick a day">
        {stats.map(s => {
          const isSel = s.key === sel.key;
          const color = s.complete ? "var(--success)" : s.isPast ? "var(--warning)" : "var(--accent-soft)";
          return (
            <button key={s.key} className={`daycell ${isSel ? "selected" : ""} ${s.isToday ? "today" : ""}`} aria-pressed={isSel}
              aria-label={`${s.date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}${s.isToday ? ", today" : ""}: ${s.done} of ${s.total} jobs done`}
              onClick={() => { setPickedKey(s.key); setOpenKid(null); }}>
              <span className="daycell-name">{s.date.toLocaleDateString("en-US", { weekday: "short" })}</span>
              <Ring pct={s.pct} color={color} size={40} thickness={3.5} inner={isSel ? "var(--surface-hi)" : "var(--bg-primary)"}>
                <span className={`daycell-num ${s.complete ? "ok" : ""}`}>{s.date.getDate()}</span>
              </Ring>
            </button>
          );
        })}
      </div>

      <div className="day-head">
        <h2>
          {sel.date.toLocaleDateString("en-US", { weekday: "long" })}
          {sel.isToday ? <span className="today-pill">Today</span> : <span className="today-pill plain">{sel.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
        </h2>
        <span>{sel.total === 0 ? "No jobs" : `${sel.done} of ${sel.total} jobs done`}</span>
      </div>

      {!oldSchedule && <section className="dinner-card" aria-label="Dinner jobs">
        <div className="mini-label">Dinner jobs</div>
        <div className="dinner-grid">
          {NIGHTLY_JOBS.map(j => {
            const names = nightly[j.key] || [];
            return (
              <div key={j.key} className="dinner-col">
                <span className="dinner-job">{j.key === "Set Table" ? "Set table" : j.label}</span>
                {names.length > 0
                  ? <span className="av-stack">{names.map(n => { const m = FAMILY_MEMBERS.find(f => f.name === n); return m ? <Avatar key={n} member={m} emoji={getMemberEmoji(n)} size={34} /> : null; })}</span>
                  : <span className="dinner-none">–</span>}
                <span className="dinner-who">{names.length > 0 ? names.join(" & ") : (j.key === "Dishes" ? "Day off" : "")}</span>
              </div>
            );
          })}
        </div>
      </section>}

      {/* Each kid's day — tap a row to open the checklist and check things off. */}
      <section className="rows" aria-label="Each kid's jobs">
        {FAMILY_MEMBERS.map((member) => {
          const chores = getChoresForDate(member.name, sel.date);
          if (chores.length === 0) return null;
          const jobs = chores.filter(c => !c.routine);
          const routineItems = chores.filter(c => c.routine);
          const done = jobs.filter(c => isChoreCompleteForDate(member.name, c.id, sel.date)).length;
          const renderDayChore = (chore) => {
            const completed = isChoreCompleteForDate(member.name, chore.id, sel.date);
            const isCustom = chore.tag === "custom";
            const toggle = () => toggleChoreForDate(member.name, chore.id, sel.date, chore.pointValue ?? 1);
            return (
              <div key={chore.id} className={`chore-item ${completed ? "completed" : ""} ${chore.priority ? "priority" : ""}`} onClick={toggle}>
                <button type="button" className={`chore-checkbox ${completed ? "checked check-pop" : ""}`} aria-pressed={completed} aria-label={chore.text} onClick={(e) => { e.stopPropagation(); toggle(); }}>{completed && <Icons.Check size={16} color="#0d111a" />}</button>
                <span className="chore-text">{chore.text}</span>
                {isCustom && chore.pointValue > 1 && <span className="chore-points-badge">+{chore.pointValue}</span>}
                {chore.priority && <span className="must-do-badge">⚠ MUST DO</span>}
                <span className={`chore-tag tag-${chore.tag}`}>{chore.tag}</span>
                {isParent && isCustom && <button className="chore-delete-btn" onClick={(e) => { e.stopPropagation(); deleteCustomTask(chore.taskKey); }} title="Delete task"><Icons.X size={16} /></button>}
              </div>
            );
          };
          const allDone = jobs.length > 0 && done === jobs.length;
          const isOpen = openKid === member.name;
          // Team names belong to the current week only.
          const team = teamWeek && weekOffset === 0 && getTeamForMember ? getTeamForMember(member.name) : null;
          const teamColor = team && getTeamColor ? getTeamColor(team.key) : null;
          return (
            <Fragment key={member.name}>
              <button className={`row week-row ${isOpen ? "open" : ""}`} aria-expanded={isOpen} onClick={() => setOpenKid(isOpen ? null : member.name)}>
                <Avatar member={member} emoji={getMemberEmoji(member.name)} size={30} />
                <span className="week-row-name">{member.name}</span>
                <span className="bar"><span style={{ width: `${jobs.length > 0 ? (done / jobs.length) * 100 : 0}%`, background: allDone ? "var(--success)" : member.color }} /></span>
                <span className={`week-row-count ${allDone ? "ok" : ""}`}>{jobs.length > 0 ? `${done} / ${jobs.length}` : "–"}</span>
                <span className="row-chev"><Icons.ChevronRight size={18} /></span>
              </button>
              {isOpen && (
                <div className="chore-list day-chores">
                  {team && getTeamName && <div><span className="team-badge-mini" style={{ marginLeft: 0, background: `${teamColor || "var(--border)"}22`, color: teamColor || "var(--text-soft)", border: `1px solid ${teamColor || "var(--border)"}` }}>{getTeamName(team.key)}</span></div>}
                  {jobs.map(renderDayChore)}
                  {routineItems.length > 0 && <div className="chore-group-label">Routines · not part of the count</div>}
                  {routineItems.map(renderDayChore)}
                </div>
              )}
            </Fragment>
          );
        })}
      </section>

      {comingUp.length > 0 && (
        <section className="stack-8" aria-label="Coming up this week">
          <div className="section-head"><h2>Coming up</h2></div>
          <div className="rows">
            {comingUp.map(s => (
              <button key={s.key} className="row" onClick={() => { setPickedKey(s.key); setOpenKid(null); try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { /* ignore */ } }}>
                <span className="upnext-day">{s.date.toLocaleDateString("en-US", { weekday: "short" })}</span>
                <span className="row-label">
                  {s.who.length > 0 ? "Weekly must-do jobs" : "Game day"}
                  <small>{s.who.length > 0 ? `${s.who.join(", ")}${s.gameDay ? " · also a game day" : ""}` : "Unlocked by Monday–Thursday jobs"}</small>
                </span>
                <span className="row-chev"><Icons.ChevronRight size={18} /></span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ============================================================
// JOBS VIEW (was "Rotation") — who does what, one week per screen
// ============================================================
const WEEKLY_JOBS = [
  { key: "collectTrash", label: "Collect trash", short: "Collect" },
  { key: "trashOut", label: "Take bins out", short: "Bins out" },
  { key: "bringCansIn", label: "Bring cans in", short: "Cans in" },
  { key: "refillSoap", label: "Refill soap", short: "Soap" },
  { key: "toiletPaper", label: "Refill toilet paper", short: "TP" },
];

function JobsView({ today, viewKid, setViewKid, getMemberEmoji }) {
  const [offset, setOffset] = useState(0); // weeks away from this week
  const todayKey = dateToKey(today);
  const weekStart = useMemo(() => { const d = getWeekStart(today); d.setDate(d.getDate() + offset * 7); return d; }, [today, offset]);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  // Dishes + dinner jobs for each night of the week shown.
  const rows = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart); d.setDate(d.getDate() + i);
    return { date: d, key: dateToKey(d), isToday: dateToKey(d) === todayKey, jobs: getNightlyJobs(d) };
  }), [weekStart, todayKey]);
  const rotation = getCurrentWeekRotation(weekStart);
  // Weeks before the current schedule began used different dinner jobs.
  const oldSchedule = !!getDailyAssignment(FAMILY_MEMBERS[0].name, weekStart)?.legacy;
  const comingWeeks = useMemo(() => [1, 2, 3].map(i => {
    const d = new Date(weekStart); d.setDate(d.getDate() + i * 7);
    return { date: d, rotation: getCurrentWeekRotation(d) };
  }).filter(w => w.rotation), [weekStart]);

  // A kid's face; with a kid picked up top, theirs are ringed and the rest fade.
  const face = (name, size = 28, fade = true) => {
    const m = FAMILY_MEMBERS.find(f => f.name === name);
    if (!m) return <span key={name} className="jg-empty">{name || "–"}</span>;
    return <Avatar key={name} member={m} emoji={getMemberEmoji(name)} size={size} title={name} className={viewKid ? (viewKid === name ? "hit" : fade ? "dim" : "") : ""} />;
  };

  return (
    <div className="page">
      <KidSwitcher value={viewKid} onChange={setViewKid} getMemberEmoji={getMemberEmoji} />

      <div className="week-switch">
        <button className="week-nav-btn" onClick={() => setOffset(o => o - 1)} aria-label="Previous week"><Icons.ChevronLeft size={20} /></button>
        <span className="week-switch-label">
          {fmt(weekStart)} – {fmt(weekEnd)}
          {offset === 0 ? <span className="today-pill">This week</span> : <button className="small-btn" onClick={() => setOffset(0)}>Back to this week</button>}
        </span>
        <button className="week-nav-btn" onClick={() => setOffset(o => o + 1)} aria-label="Next week"><Icons.ChevronRight size={20} /></button>
      </div>

      {oldSchedule && <div className="section-note">This week was on the old schedule, so its nightly jobs aren't shown here. Open the day in Week to see what each kid had.</div>}
      {!oldSchedule && <section className="grid-card" aria-label="Nightly jobs">
        <div className="grid-card-head"><h2>Nightly jobs</h2></div>
        <div className="jg-row head">
          <span className="jg-day" />
          {NIGHTLY_JOBS.map(j => <span key={j.key} className="jg-cell">{j.label}</span>)}
        </div>
        {rows.map(row => (
          <div key={row.key} className={`jg-row ${row.isToday ? "today" : ""}`}>
            <span className="jg-day">
              {row.date.toLocaleDateString("en-US", { weekday: "short" })} {row.date.getDate()}
              {row.isToday && <small>Today</small>}
            </span>
            {NIGHTLY_JOBS.map(j => (
              <span key={j.key} className="jg-cell">
                {(row.jobs[j.key] || []).length > 0 ? row.jobs[j.key].map(n => face(n)) : <span className="jg-empty">–</span>}
              </span>
            ))}
          </div>
        ))}
      </section>}

      {rotation && (
        <section className="grid-card" aria-label="Weekly jobs">
          <div className="grid-card-head">
            <h2>Weekly jobs</h2>
            <span className={`recycle-badge ${rotation.recycle ? "recycle-yes" : "recycle-no"}`}><Icons.Recycle size={14} /> {rotation.recycle ? "Recycling week" : "No recycling"}</span>
          </div>
          <div className="wk-grid">
            {WEEKLY_JOBS.map(j => {
              const name = rotation[j.key];
              return (
                <div key={j.key} className={`wk-item ${viewKid && viewKid !== name ? "dim" : ""}`}>
                  {face(name, 30, false)}
                  <span className="wk-item-text"><b>{j.label}</b><small>{name}</small></span>
                </div>
              );
            })}
          </div>
          <div className="section-note" style={{ padding: "0 6px 4px" }}>Wednesday jobs. The cans come back in on Thursday.</div>
        </section>
      )}

      {comingWeeks.length > 0 && (
        <section className="grid-card" aria-label="Weekly jobs in the coming weeks">
          <div className="grid-card-head"><h2>Coming weeks</h2></div>
          <div className="jg-row head">
            <span className="jg-day" />
            {WEEKLY_JOBS.map(j => <span key={j.key} className="jg-cell">{j.short}</span>)}
          </div>
          {comingWeeks.map(w => (
            <div key={dateToKey(w.date)} className="jg-row">
              <span className="jg-day">
                {fmt(w.date)}
                {w.rotation.recycle && <small className="recycle">Recycling</small>}
              </span>
              {WEEKLY_JOBS.map(j => <span key={j.key} className="jg-cell">{face(w.rotation[j.key])}</span>)}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

// ============================================================
// HISTORY VIEW
// ============================================================
function HistoryView({ awards, points, teamNames, getMemberEmoji, today, getPoints, isParent, onParentTools, onSeePoints }) {
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
      return { name: m.name, color: m.color, points: Math.max(0, points[key] || 0) };
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

  // Where this week stands right now — shown until the first awards exist.
  const standings = [...FAMILY_MEMBERS].map(m => ({ member: m, pts: getPoints(m.name, "weekly") })).sort((a, b) => b.pts - a.pts).filter(r => r.pts > 0).slice(0, 3);
  const MEDAL_COLORS = ["#fbbf24", "#cbd5e1", "#d99a5b"];
  const withAwards = allTimeStats.filter(s => s.total > 0);
  const withoutAwards = allTimeStats.filter(s => s.total === 0);

  return (
    <div className="page">
      {pastWeeks.length === 0 ? (
        <>
          <section className="empty-card" aria-label="No awards yet">
            <div className="empty-medals" aria-hidden="true">
              <span className="empty-medal" style={{ color: MEDAL_COLORS[1] }}>2</span>
              <span className="empty-medal big" style={{ color: MEDAL_COLORS[0] }}><Icons.Trophy size={34} /></span>
              <span className="empty-medal" style={{ color: MEDAL_COLORS[2] }}>3</span>
            </div>
            <div>
              <div className="empty-title">No awards yet</div>
              <div className="empty-text">The first medals land here when a parent finalizes the week.</div>
            </div>
            <button className="wide-btn" onClick={onParentTools}>{!isParent && <Icons.Lock size={16} />} Finalize in parent tools</button>
          </section>
          {standings.length > 0 && (
            <section className="stack-8" aria-label="Standings if the week ended today">
              <div className="section-head"><h2>If the week ended today</h2><button className="link-btn" style={{ margin: "-12px 0" }} onClick={onSeePoints}>See points</button></div>
              <div className="rows">
                {standings.map((r, i) => (
                  <div key={r.member.name} className="row" style={{ minHeight: 56, paddingRight: 14 }}>
                    <span className="medal-dot" style={{ background: MEDAL_COLORS[i] }}>{i + 1}</span>
                    <Avatar member={r.member} emoji={getMemberEmoji(r.member.name)} size={34} />
                    <span className="row-label"><span className="row-name">{r.member.name}</span></span>
                    <span className="row-points"><Icons.Star size={14} color="#fbbf24" filled />{r.pts}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          <section className="stack-8" aria-label="Past weeks">
            <div className="section-head"><h2>Past weeks</h2></div>
            <div className="section-note">Each finalized week is saved here with its winners.</div>
          </section>
        </>
      ) : (
        <>
          {/* All-Time Hall of Fame */}
          <div className="card animate-in">
            <div className="card-title"><Icons.Trophy size={22} color="#fbbf24" /> Hall of Fame</div>
            <div className="history-hall-of-fame">
              {withAwards.map((s, i) => {
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
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {withoutAwards.length > 0 && <div className="section-note" style={{ marginTop: 10 }}>No awards yet: {withoutAwards.map(s => s.name).join(", ")}</div>}
          </div>
          <div className="section-head"><h2>Past weeks</h2></div>
        </>
      )}
      {pastWeeks.map(week => {
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
function TimesUpOverlay({ member, memberEmoji, parentSettings, onDismiss }) {
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
      verifyParentPin(full, parentSettings).then(result => {
        if (result === "ok") { onDismiss(); return; }
        setError(result === "locked" ? "Too many tries — wait a minute" : "Wrong PIN");
        setPin(["", "", "", ""]); setTimeout(() => refs[0].current?.focus(), 100);
      });
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
      {error && <div style={{ color: "#f87171", fontSize: "0.85rem", fontWeight: 600, marginTop: 4 }}>{error}</div>}
    </div>
  );
}

// ============================================================
// GAME VIEW (under More) — one status card, then each kid's unlock progress
// Rule (see getVideoGameStatus): Monday–Thursday housekeeping 100% and dinner
// jobs 90%+, on a game day. A parent can unlock a kid early.
// ============================================================
function GameView({ today, members, getVideoGameStatus, getMemberEmoji, isParent, toggleGameUnlock }) {
  const gameDay = isVideoGameDay(today);
  const next = nextGameDay(today);
  const nextLabel = !next ? null : next.daysAway === 1 ? "Tomorrow" : next.date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

  return (
    <div className="page">
      <section className={`status-card ${gameDay ? "on" : ""}`} aria-label="Game day status">
        <div className="status-top">
          <span className="status-icon"><Icons.Gamepad size={30} /></span>
          <div>
            <div className="status-title">{gameDay ? "It's a game day" : "Not a game day"}</div>
            <div className="status-text">{gameDay ? "Kids who finished their Monday–Thursday jobs can play." : "Games open Fridays, Saturdays and days off school."}</div>
          </div>
        </div>
        {!gameDay && nextLabel && (
          <div className="status-next"><span>Next game day</span><b>{nextLabel}</b></div>
        )}
      </section>

      <section className="stack-8" aria-label="Unlock progress">
        <div className="section-head"><h2>{gameDay ? "Who can play" : "Unlock progress"}</h2></div>
        <div className="section-note">Games unlock with every Monday–Thursday housekeeping job done and at least 90% of dinner jobs.</div>
        <div className="rows">
          {members.map(member => {
            const gs = getVideoGameStatus(member.name);
            const hkOk = gs.housekeepingPct >= 100;
            const dinnerOk = gs.dinnerPct >= 90;
            const state = gs.parentOverride ? { cls: "parent", text: "Unlocked by parent" }
              : gs.unlocked ? { cls: "open", text: "Unlocked" }
              : gs.choresComplete ? { cls: "open", text: "Ready for game day" }
              : { cls: "", text: "Locked" };
            return (
              <div key={member.name} className="row game-row">
                <Avatar member={member} emoji={getMemberEmoji(member.name)} size={38} />
                <div className="game-body">
                  <div className="game-top">
                    <span className="row-name">{member.name}</span>
                    <span className={`state-pill ${state.cls}`}>{state.cls ? <Icons.Check size={13} /> : <Icons.Lock size={13} />}{state.text}</span>
                  </div>
                  {!gs.parentOverride && (
                    <>
                      <div className="game-meter">
                        <span className="game-meter-label">Housekeeping</span>
                        <span className="bar"><span style={{ width: `${Math.min(100, gs.housekeepingPct)}%`, background: hkOk ? "var(--success)" : member.color }} /></span>
                        <span className={`game-meter-val ${hkOk ? "ok" : ""}`}>{gs.housekeepingPct}%</span>
                      </div>
                      <div className="game-meter">
                        <span className="game-meter-label">Dinner jobs</span>
                        <span className="bar"><span style={{ width: `${Math.min(100, gs.dinnerPct)}%`, background: dinnerOk ? "var(--success)" : member.color }} /></span>
                        <span className={`game-meter-val ${dinnerOk ? "ok" : ""}`}>{gs.dinnerPct}%</span>
                      </div>
                    </>
                  )}
                  {isParent && (gs.parentOverride || !gs.unlocked) && (
                    <div><button className="small-btn" onClick={() => toggleGameUnlock(member.name)}>{gs.parentOverride ? "Remove parent unlock" : "Unlock early"}</button></div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {!isParent && <div className="section-note">Parents can unlock a kid early after tapping Parent.</div>}
      </section>
    </div>
  );
}

// ============================================================
// MORE VIEW — everything that isn't one of the four main tabs
// ============================================================
function MoreView({ today, isOnline, isParent, awards, dateNights, workLogs, setWorkLogs, workCashouts, setWorkCashouts, pinGate, getMemberEmoji, onOpen, onOneOnOne, onReminders, onParentTools, onLock }) {
  const [workModal, setWorkModal] = useState(null); // kid name for the work-hours log
  const next = nextGameDay(today);
  const gamesValue = !next ? "" : next.daysAway === 0 ? "Game day" : next.daysAway === 1 ? "Opens tomorrow" : `Opens ${next.date.toLocaleDateString("en-US", { weekday: "long" })}`;
  const finalizedWeeks = new Set(Object.keys(awards || {}).filter(k => k.startsWith("win_") || k.startsWith("mvp_")).map(k => k.slice(4, 14))).size;
  const oneOnOne = getDateNight(today, dateNights || {});
  const chevron = <span className="row-chev"><Icons.ChevronRight size={18} /></span>;

  return (
    <div className="page">
      <section className="stack-8 more-group" aria-label="Family">
        <h2>Family</h2>
        <div className="rows">
          <button className="row" onClick={() => onOpen("games")}>
            <span className="row-icon blue"><Icons.Gamepad size={20} /></span>
            <span className="row-label">Video games</span>
            <span className="row-value">{gamesValue}</span>
            {chevron}
          </button>
          <button className="row" onClick={() => onOpen("history")}>
            <span className="row-icon gold"><Icons.Trophy size={20} /></span>
            <span className="row-label">Hall of Fame</span>
            <span className="row-value">{finalizedWeeks === 0 ? "No awards yet" : `${finalizedWeeks} week${finalizedWeeks === 1 ? "" : "s"}`}</span>
            {chevron}
          </button>
          {Object.keys(MONTHLY_WORK).map(kid => {
            const w = getWorkMonth(kid, getMonthKey(today), workLogs, workCashouts);
            if (!w) return null;
            const value = w.beforeStart ? "Not started yet" : w.remaining > 0 ? `${formatMinutes(w.logged)} of ${formatMinutes(w.target)}` : "Done this month";
            return (
              <button key={kid} className="row" onClick={() => setWorkModal(kid)}>
                <span className="row-icon green"><Icons.History size={20} /></span>
                <span className="row-label">{kid}'s work hours</span>
                <span className={`row-value ${!w.beforeStart && w.remaining === 0 ? "ok" : ""}`}>{value}</span>
                {chevron}
              </button>
            );
          })}
          {oneOnOne && (
            <button className="row" onClick={onOneOnOne}>
              <span className="row-icon teal">🍔</span>
              <span className="row-label">One-on-one</span>
              <span className="row-value">{oneOnOne.kid} this week</span>
              {chevron}
            </button>
          )}
        </div>
      </section>

      <section className="stack-8 more-group" aria-label="This device">
        <h2>This device</h2>
        <div className="rows">
          <button className="row" onClick={onReminders}>
            <span className="row-icon"><Icons.Bell size={20} /></span>
            <span className="row-label">Reminders<small>A 6 o'clock nudge for the kids you pick</small></span>
            {chevron}
          </button>
          <div className="row" style={{ paddingRight: 14 }}>
            <span className="row-icon">{isOnline ? <Icons.Cloud size={20} /> : <Icons.CloudOff size={20} />}</span>
            <span className="row-label">Sync{!isOnline && <small>Changes are kept on this device until it's back online</small>}</span>
            <span className={`row-value ${isOnline ? "ok" : "bad"}`}>{isOnline ? <><Icons.Check size={14} /> Online</> : "Offline"}</span>
          </div>
        </div>
      </section>

      <section className="stack-8 more-group" aria-label="Parents">
        <h2>Parents</h2>
        <div className="rows">
          <button className="row" onClick={onParentTools}>
            <span className="row-icon"><Icons.Settings size={20} /></span>
            <span className="row-label">Parent tools<small>Points, prizes, custom jobs, game unlocks, PINs</small></span>
            {!isParent && <span className="row-value"><Icons.Lock size={14} /> PIN</span>}
            {chevron}
          </button>
          {isParent && (
            <button className="row" onClick={onLock}>
              <span className="row-icon"><Icons.Lock size={20} /></span>
              <span className="row-label">Lock parent mode</span>
            </button>
          )}
        </div>
      </section>

      {workModal && <WorkHoursModal kid={workModal} today={today} workLogs={workLogs} setWorkLogs={setWorkLogs} workCashouts={workCashouts} setWorkCashouts={setWorkCashouts} isParent={isParent} pinGate={pinGate} getMemberEmoji={getMemberEmoji} onClose={() => setWorkModal(null)} />}
    </div>
  );
}

// ============================================================
// ADMIN VIEW
// ============================================================
function AdminView({ points, setPoints, completedChores, setCompletedChores, streaks, setStreaks, customTasks, deleteCustomTask, getPoints, addPoints, recordWeekAwards, prizes, setPrizes, weekStartKey, monthKey, awards, setAwards, getVideoGameStatus, toggleGameUnlock, chorePhotos, deleteChorePhoto, setPhotoViewer, getMemberEmoji, memberPins, setMemberPins, parentSettings, setParentSettings }) {
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

  // Download a JSON snapshot of all key Firestore docs. Called before destructive resets.
  const downloadBackup = useCallback(() => {
    const backup = {
      exportedAt: new Date().toISOString(),
      appVersion: "FamilyHQ",
      points: points || {},
      completedChores: completedChores || {},
      streaks: streaks || {},
      awards: awards || {},
      customTasks: customTasks || {},
      prizes: prizes || {},
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.download = `familyhq-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [points, completedChores, streaks, awards, customTasks, prizes]);

  return (
    <div>
      <ParentPinCard parentSettings={parentSettings} setParentSettings={setParentSettings} />
      {/* Kid PINs */}
      <div className="card">
        <div className="card-title"><Icons.Lock size={22} color="var(--accent)" /> Kid PINs</div>
        <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: 12 }}>
          Set a 3- or 4-digit PIN for each kid. They'll enter it to check or uncheck a chore (cached 5 min per device). Leave blank to disable for that kid.
        </div>
        {FAMILY_MEMBERS.map(member => {
          const currentPin = memberPins?.[member.name] || "";
          return (
            <div key={member.name} className="admin-row">
              <label style={{ color: member.color, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: "1.2rem" }}>{member.emoji}</span>
                {member.name}
              </label>
              <input
                type="tel"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={4}
                placeholder="set PIN"
                value={currentPin}
                onChange={(e) => {
                  const val = e.target.value.replace(/[^0-9]/g, "").slice(0, 4);
                  setMemberPins(prev => {
                    const u = { ...prev }; delete u._empty;
                    if (val.length === 0) delete u[member.name];
                    else u[member.name] = val;
                    if (Object.keys(u).length === 0) u._empty = true;
                    return u;
                  });
                }}
                style={{ width: 100, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-secondary)", color: "var(--text-primary)", fontFamily: "monospace", fontSize: "1rem", textAlign: "center", letterSpacing: "0.2em" }}
              />
            </div>
          );
        })}
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
          Record this week's 1st place winner. Do this at the end of each week before points reset.
        </div>
        <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => {
          const result = recordWeekAwards();
          if (result === "already") setAwardMsg("Awards already recorded for this week!");
          else setAwardMsg("✅ Awards recorded! Winner saved.");
          setTimeout(() => setAwardMsg(""), 3000);
        }}>🏆 Record This Week's Awards</button>
        {awardMsg && <div style={{ marginTop: 8, fontSize: "0.85rem", fontWeight: 600, color: awardMsg.startsWith("✅") ? "var(--success)" : "var(--warning)", textAlign: "center" }}>{awardMsg}</div>}
      </div>

      {/* Reset Actions */}
      <div className="card">
        <div className="card-title"><Icons.Trash size={22} color="var(--danger)" /> Reset Data</div>
        <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: 12 }}>
          Every reset below downloads a JSON backup first so you can restore later if needed.
        </div>
        <div className="admin-section">
          <button className="btn" style={{ width: "100%", justifyContent: "center", marginBottom: 12, background: "rgba(59,130,246,0.15)", color: "#60a5fa", border: "1px solid rgba(59,130,246,0.3)" }} onClick={() => {
            downloadBackup();
          }}>📥 Download Backup Now</button>
          <button className="btn btn-danger" style={{ width: "100%", justifyContent: "center", marginBottom: 8 }} onClick={() => {
            if (confirm("Reset ALL weekly points to 0? A backup will download first.")) {
              downloadBackup();
              setPoints(p => {
                const u = { ...p };
                Object.keys(u).forEach(k => { if (k.startsWith("w_")) delete u[k]; });
                if (Object.keys(u).length === 0) u._empty = true;
                return u;
              });
            }
          }}>Reset Weekly Points</button>
          <button className="btn btn-danger" style={{ width: "100%", justifyContent: "center", marginBottom: 8 }} onClick={() => {
            if (confirm("Clear today's completed chores? A backup will download first.")) {
              downloadBackup();
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
            if (confirm("Reset ALL awards? A backup will download first. This cannot be undone!")) {
              downloadBackup();
              setAwards({ _empty: true });
            }
          }}>Reset All Awards</button>
          <button className="btn btn-danger" style={{ width: "100%", justifyContent: "center" }} onClick={() => {
            if (confirm("Reset ALL data? A backup will download first. This cannot be undone!")) {
              downloadBackup();
              setPoints({ _empty: true }); setCompletedChores({ _empty: true }); setStreaks({ _empty: true }); setAwards({ _empty: true });
            }
          }}>Reset Everything</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// PIN DIALOG (parent)
// ============================================================
function PinDialog({ parentSettings, onSuccess, onClose }) {
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
      verifyParentPin(full, parentSettings).then(result => {
        if (result === "ok") { onSuccess(); return; }
        setError(result === "locked" ? "Too many tries — wait a minute" : "Incorrect PIN");
        setTimeout(() => { setPin(["","","",""]); refs[0].current?.focus(); }, 600);
      });
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
        {error && <div className="pin-error">{error}</div>}
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

// ============================================================
// MONTHLY WORK HOURS (Cole) — bar on the kid's card + log screen.
// Math lives in schedule.js getWorkMonth(); entries in Firestore family/workLogs.
// ============================================================
const monthLabel = (mk) => { const [y, m] = mk.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }); };
const monthName = (mk) => { const [y, m] = mk.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long" }); };

function WorkHoursBar({ kid, color, today, workLogs, workCashouts, onOpen }) {
  const mk = getMonthKey(today);
  const w = getWorkMonth(kid, mk, workLogs, workCashouts);
  if (!w) return null;
  let text, pct;
  if (w.beforeStart) {
    text = `Starts ${monthName(w.start)} 1${w.logged ? ` · ${formatMinutes(w.logged)} credit so far` : " · early time counts as credit"}`;
    pct = 0;
  } else {
    pct = w.target > 0 ? Math.min(100, Math.round((w.logged / w.target) * 100)) : 100;
    text = w.remaining > 0 ? `${formatMinutes(w.logged)} of ${formatMinutes(w.target)} · ${formatMinutes(w.remaining)} left`
      : `✓ ${formatMinutes(w.logged)} done${w.extra ? ` · +${formatMinutes(w.extra)} extra` : ""}`;
  }
  return (
    <button className={`work-bar ${!w.beforeStart && w.remaining === 0 ? "done" : ""}`} onClick={(e) => { e.stopPropagation(); onOpen(); }}>
      <span className="work-bar-label">⏱️ Work hours</span>
      <span className="work-bar-text">{text}</span>
      {w.cashable > 0 && <span className="work-bar-tag cash">🎉 {formatMinutes(w.cashable)} extra</span>}
      {w.unpaidAmount > 0 && <span className="work-bar-tag owed">💵 ${w.unpaidAmount % 1 ? w.unpaidAmount.toFixed(2) : w.unpaidAmount} to pay</span>}
      <span className="work-bar-track"><span className="work-bar-fill" style={{ width: `${pct}%`, background: !w.beforeStart && w.remaining === 0 ? "var(--success)" : color }} /></span>
    </button>
  );
}

function WorkHoursModal({ kid, today, workLogs, setWorkLogs, workCashouts, setWorkCashouts, isParent, pinGate, getMemberEmoji, onClose }) {
  const currentMonth = getMonthKey(today);
  const [monthKey, setMonthKey] = useState(currentMonth);
  const [hours, setHours] = useState(1);
  const [mins, setMins] = useState(0);
  const [date, setDate] = useState(dateToKey(today));
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(null); // entry id being edited (parents)
  const [msg, setMsg] = useState(null);
  const [cashMins, setCashMins] = useState(null); // minutes chosen to cash out (null = all available)
  const w = getWorkMonth(kid, monthKey, workLogs, workCashouts);
  if (!w) return null;
  const monthStart = `${currentMonth}-01`;
  const todayKey = dateToKey(today);
  const UNDO_MS = 10 * 60 * 1000;

  const resetForm = () => { setHours(1); setMins(0); setDate(todayKey); setNote(""); setEditing(null); };
  const submit = () => {
    const minutes = Number(hours) * 60 + Number(mins);
    if (minutes <= 0) return setMsg({ ok: false, text: "Add how long you worked." });
    if (!note.trim()) return setMsg({ ok: false, text: "Add a quick note about what you did." });
    const run = () => {
      const id = editing || `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      setWorkLogs(prev => {
        const u = { ...prev }; delete u._empty;
        const old = u[id] || {};
        u[id] = { ...old, kid, date, minutes, note: note.trim(), loggedAt: old.loggedAt || Date.now(), by: old.by || (isParent ? "Parent" : kid), ...(editing ? { editedAt: Date.now() } : {}) };
        return u;
      });
      setMsg({ ok: true, text: editing ? "Entry updated." : `Logged ${formatMinutes(minutes)} — nice work!` });
      setMonthKey(date.slice(0, 7));
      resetForm();
    };
    if (isParent) run(); else pinGate(kid, run);
  };
  const remove = (id) => setWorkLogs(prev => { const u = { ...prev }; delete u[id]; if (Object.keys(u).length === 0) u._empty = true; return u; });
  const startEdit = (e) => { setEditing(e.id); setHours(Math.floor(e.minutes / 60)); setMins(e.minutes % 60); setDate(e.date); setNote(e.note || ""); setMsg(null); };
  const money = (n) => `$${n % 1 ? n.toFixed(2) : n}`;
  const cashChoice = w.cashable > 0 ? Math.min(cashMins ?? w.cashable, w.cashable) : 0;
  const cashSteps = []; for (let m = 15; m <= w.cashable; m += 15) cashSteps.push(m);
  if (w.cashable > 0 && !cashSteps.includes(w.cashable)) cashSteps.push(w.cashable);
  const cashOut = () => {
    if (!cashChoice) return;
    const run = () => {
      const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const amount = cashoutAmount(kid, cashChoice);
      setWorkCashouts(prev => { const u = { ...prev }; delete u._empty; u[id] = { kid, month: currentMonth, minutes: cashChoice, rate: w.cashRate, amount, at: Date.now(), by: isParent ? "Parent" : kid, paid: false }; return u; });
      setCashMins(null);
      setMsg({ ok: true, text: `Cashed out ${formatMinutes(cashChoice)} = ${money(amount)}. Mom or Dad will mark it paid.` });
    };
    if (isParent) run(); else pinGate(kid, run);
  };
  const setCashout = (id, patch) => setWorkCashouts(prev => {
    const u = { ...prev }; delete u._empty;
    if (patch === null) delete u[id]; else u[id] = { ...u[id], ...patch };
    if (Object.keys(u).length === 0) u._empty = true;
    return u;
  });
  const fmtDate = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); };
  const cashedText = !w.beforeStart && w.cashedThisMonth > 0 ? `${formatMinutes(w.cashedThisMonth)} cashed out` : null;
  const carryText = w.beforeStart ? null
    : w.carryIn > 0 ? `12h − ${formatMinutes(w.carryIn)} credit from earlier`
    : w.carryIn < 0 ? `12h + ${formatMinutes(-w.carryIn)} carried from last month` : null;
  const pct = w.beforeStart ? 0 : (w.target > 0 ? Math.min(100, Math.round((w.logged / w.target) * 100)) : 100);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal work-modal" onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div className="modal-title" style={{ margin: 0 }}>⏱️ {getMemberEmoji(kid)} {kid}'s work hours</div>
          <button onClick={onClose} className="reminders-close" aria-label="Close">&times;</button>
        </div>
        <div className="work-month-nav">
          <button className="week-nav-btn" onClick={() => setMonthKey(m => addMonths(m, -1))} aria-label="Previous month"><Icons.ChevronLeft size={18} /></button>
          <span>{monthLabel(monthKey)}</span>
          <button className="week-nav-btn" disabled={monthKey >= currentMonth} onClick={() => setMonthKey(m => addMonths(m, 1))} aria-label="Next month"><Icons.ChevronRight size={18} /></button>
        </div>
        {w.beforeStart ? (
          <div className="work-summary-note">Tracking starts <b>{monthName(w.start)} 1</b>. Time logged before then counts as credit toward {monthName(w.start)}{w.creditTowardStart ? <> — <b>{formatMinutes(w.creditTowardStart)}</b> so far</> : null}.</div>
        ) : (<>
          <div className="work-stats">
            <div><div className="stat-value">{formatMinutes(w.target)}</div><div className="stat-label">Owed</div></div>
            <div><div className="stat-value" style={{ color: "var(--success)" }}>{formatMinutes(w.logged)}</div><div className="stat-label">Done</div></div>
            <div><div className="stat-value" style={{ color: w.remaining ? "var(--danger)" : "var(--success)" }}>{w.remaining ? formatMinutes(w.remaining) : "✓"}</div><div className="stat-label">{w.remaining ? "Left" : "Done!"}</div></div>
          </div>
          <div className="work-bar-track big"><span className="work-bar-fill" style={{ width: `${pct}%`, background: w.remaining ? "var(--accent)" : "var(--success)" }} /></div>
          {(carryText || cashedText || w.extra > 0) && <div className="work-summary-note">{[carryText, cashedText, w.extra > 0 ? `+${formatMinutes(w.extra)} extra — cash out or keep it on the 1st` : null].filter(Boolean).join(" · ")}</div>}
        </>)}

        {monthKey === currentMonth && w.cashable > 0 && (
          <div className="work-cash">
            <div className="work-cash-title">🎉 You have {formatMinutes(w.cashable)} extra</div>
            <div className="work-cash-sub">Cash some out at {money(w.cashRate)}/hr, or keep it as credit — whatever you don't cash out rolls over and lowers what you owe.</div>
            <div className="work-form-row" style={{ marginTop: 10, marginBottom: 0 }}>
              <select className="form-select" value={cashChoice} onChange={e => setCashMins(Number(e.target.value))} aria-label="Time to cash out">
                {cashSteps.map(m => <option key={m} value={m}>{formatMinutes(m)}</option>)}
              </select>
              <button className="btn btn-primary work-cash-btn" onClick={cashOut}>💵 Cash out {money(cashoutAmount(kid, cashChoice))}</button>
            </div>
          </div>
        )}
        {monthKey === currentMonth && (
          <div className="work-form">
            <div className="reminders-label">{editing ? "Edit entry" : "Log time"}</div>
            <div className="work-form-row">
              <select className="form-select" value={hours} onChange={e => setHours(e.target.value)} aria-label="Hours">{Array.from({ length: 9 }, (_, i) => <option key={i} value={i}>{i} hr</option>)}</select>
              <select className="form-select" value={mins} onChange={e => setMins(e.target.value)} aria-label="Minutes">{[0, 15, 30, 45].map(m => <option key={m} value={m}>{m} min</option>)}</select>
              <input type="date" className="date-night-date" value={date} min={isParent ? undefined : monthStart} max={todayKey} onChange={e => setDate(e.target.value || todayKey)} aria-label="Date" />
            </div>
            <input className="form-input" placeholder="What did you do? (e.g. mowed the back lawn)" value={note} maxLength={140} onChange={e => setNote(e.target.value)} />
            <div className="reminders-actions" style={{ marginTop: 10 }}>
              <button className="btn btn-primary" onClick={submit}>{editing ? "Save changes" : "Log time"}</button>
              {editing && <button className="btn btn-ghost" onClick={resetForm}>Cancel</button>}
            </div>
          </div>
        )}
        {msg && <div className="reminders-msg" style={{ color: msg.ok ? "var(--success)" : "var(--danger)" }}>{msg.text}</div>}

        {w.cashouts.length > 0 && (
          <div className="work-cashouts">
            <div className="reminders-label">Cash-outs</div>
            {w.cashouts.slice(0, 6).map(c => {
              const canUndo = !c.paid && (isParent || (c.by === kid && Date.now() - (c.at || 0) < UNDO_MS));
              return (
                <div key={c.id} className="work-entry">
                  <div className="work-entry-when">{new Date(c.at || 0).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
                  <div className="work-entry-what">💵 {formatMinutes(c.minutes)} × {money(c.rate)}/hr</div>
                  <div className="work-entry-mins">{money(c.amount)}</div>
                  {c.paid ? <span className="work-paid">✓ Paid</span>
                    : isParent ? <button className="btn btn-ghost work-mark-paid" onClick={() => setCashout(c.id, { paid: true, paidAt: Date.now() })}>Mark paid</button>
                    : <span className="work-unpaid">Unpaid</span>}
                  {canUndo && <button className="chore-delete-btn" onClick={() => setCashout(c.id, null)} title="Undo cash-out">{isParent ? <Icons.X size={14} /> : "Undo"}</button>}
                </div>
              );
            })}
          </div>
        )}
        <div className="work-entries">
          <div className="reminders-label">{w.entries.length ? `${w.entries.length} entr${w.entries.length === 1 ? "y" : "ies"} in ${monthName(monthKey)}` : `Nothing logged in ${monthName(monthKey)} yet`}</div>
          {w.entries.map(e => {
            const canUndo = !isParent && e.by === kid && Date.now() - (e.loggedAt || 0) < UNDO_MS;
            return (
              <div key={e.id} className="work-entry">
                <div className="work-entry-when">{fmtDate(e.date)}</div>
                <div className="work-entry-what">{e.note}</div>
                <div className="work-entry-mins">{formatMinutes(e.minutes)}</div>
                {isParent && <button className="chore-delete-btn" onClick={() => startEdit(e)} title="Edit">✏️</button>}
                {(isParent || canUndo) && <button className="chore-delete-btn" onClick={() => remove(e.id)} title={isParent ? "Remove" : "Undo"}>{isParent ? <Icons.X size={14} /> : "Undo"}</button>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// DATE NIGHT CARD — whose week it is to go out with Mom & Dad (rotation in
// schedule.js). Everyone sees it; only parents can mark it scheduled.
// ============================================================
function DateNightCard({ today, dateNights, setDateNights, isParent, getMemberEmoji }) {
  const info = getDateNight(today, dateNights || {});
  const [picking, setPicking] = useState(false);
  const [day, setDay] = useState("");
  if (!info) return null;
  const kid = FAMILY_MEMBERS.find(m => m.name === info.kid);
  const next = FAMILY_MEMBERS.find(m => m.name === info.upNext);
  const rec = info.record;
  const scheduled = rec && rec.status === "scheduled";
  const missed = rec && rec.status === "missed";
  const isSunday = today.getDay() === 0;
  const weekStart = getWeekStart(today);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
  const fmtDay = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }); };

  const save = (patch) => setDateNights(prev => {
    const u = { ...prev }; delete u._empty;
    if (patch === null) delete u[info.weekKey];
    else u[info.weekKey] = { ...(u[info.weekKey] || {}), kid: info.kid, ...patch, updatedAt: Date.now() };
    if (Object.keys(u).length === 0) u._empty = true;
    return u;
  });
  const markScheduled = () => { save({ status: "scheduled", day: day || null }); setPicking(false); };

  return (
    <div className={`date-night ${scheduled ? "scheduled" : ""} ${isSunday && !scheduled ? "fresh" : ""}`}>
      <div className="date-night-icon">🍔</div>
      <div className="date-night-body">
        <div className="date-night-label">One-on-one this week{isSunday && !scheduled ? <span className="date-night-new">New this week</span> : null}</div>
        <div className="date-night-who">
          <span className="date-night-kid" style={{ background: kid?.color }}>{getMemberEmoji(info.kid)} {info.kid}</span>
          <span className="date-night-with">with Mom &amp; Dad</span>
        </div>
        <div className="date-night-status">
          {scheduled ? <>✓ Scheduled{rec.day ? ` · ${fmtDay(rec.day)}` : ""}</>
            : missed ? <>Didn't happen this week — {info.kid} keeps the turn next week</>
            : <>Not scheduled yet{info.carriedOver ? ` · carried over from last week` : ""}</>}
          {!missed && <span className="date-night-next"> · Up next: <b style={{ color: next?.color }}>{info.upNext}</b></span>}
        </div>
        {isParent && (
          <div className="date-night-actions">
            {picking ? (<>
              <input type="date" className="date-night-date" value={day} min={dateToKey(weekStart)} max={dateToKey(weekEnd)} onChange={e => setDay(e.target.value)} />
              <button className="btn btn-primary" onClick={markScheduled}>{day ? "Save" : "Save without a day"}</button>
              <button className="btn btn-ghost" onClick={() => setPicking(false)}>Cancel</button>
            </>) : scheduled ? (<>
              <button className="btn btn-ghost" onClick={() => { setDay(rec.day || ""); setPicking(true); }}>Change day</button>
              <button className="btn btn-ghost" onClick={() => save({ status: "missed", day: null })}>It didn't happen</button>
              <button className="btn btn-ghost" onClick={() => save(null)}>Undo</button>
            </>) : (<>
              <button className="btn btn-primary date-night-btn" onClick={() => { setDay(""); setPicking(true); }}>🍔 We've scheduled it</button>
              {missed && <button className="btn btn-ghost" onClick={() => save(null)}>Undo</button>}
            </>)}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// REMINDERS — pick which kids this device gets a 6 o'clock reminder for.
// Sender: api/remind.js. One device can follow several kids (the family iPad).
// ============================================================
function RemindersModal({ pushSubscriptions, setPushSubscriptions, isParent, getMemberEmoji, onClose }) {
  const [support] = useState(() => pushSupport());
  const [subId, setSubId] = useState(null);
  const [members, setMembers] = useState([]);
  const [parent, setParent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }
  const record = subId ? pushSubscriptions?.[subId] : null;

  // Find this device's existing registration (if any) and preload its choices.
  useEffect(() => {
    let alive = true;
    currentSubscriptionId().then(id => {
      if (!alive || !id) return;
      setSubId(id);
      const rec = pushSubscriptions?.[id];
      if (rec) { setMembers(rec.members || []); setParent(!!rec.parent); }
    });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMember = (name) => setMembers(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);

  const save = async () => {
    if (members.length === 0 && !parent) return turnOff();
    setBusy(true); setMsg(null);
    try {
      const subscription = await subscribeThisDevice();
      const id = subscriptionId(subscription.endpoint);
      const ordered = FAMILY_MEMBERS.map(m => m.name).filter(n => members.includes(n));
      setPushSubscriptions(prev => {
        const u = { ...prev }; delete u._empty;
        u[id] = { members: ordered, parent: !!parent, subscription, device: deviceLabel(), updatedAt: Date.now() };
        return u;
      });
      setSubId(id);
      setMsg({ ok: true, text: "Reminders are on for this device. Tap “Send a test” to make sure it works." });
    } catch (err) {
      setMsg({ ok: false, text: err.message === "denied"
        ? "Notifications are blocked for this app. Turn them on in the device's Settings → Notifications, then try again."
        : `Couldn't turn on reminders (${err.message}).` });
    } finally { setBusy(false); }
  };

  const turnOff = async () => {
    setBusy(true); setMsg(null);
    try {
      await unsubscribeThisDevice();
      if (subId) setPushSubscriptions(prev => { const u = { ...prev }; delete u[subId]; if (Object.keys(u).length === 0) u._empty = true; return u; });
      setSubId(null); setMembers([]); setParent(false);
      setMsg({ ok: true, text: "Reminders are off on this device." });
    } catch (err) { setMsg({ ok: false, text: `Couldn't turn off (${err.message}).` }); }
    finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setMsg(null);
    try {
      await new Promise(r => setTimeout(r, 1200)); // let a just-saved registration reach the server
      await sendTestReminder(subId);
      setMsg({ ok: true, text: "Test sent — it should pop up in a few seconds." });
    } catch (err) { setMsg({ ok: false, text: `Test didn't go through (${err.message}).` }); }
    finally { setBusy(false); }
  };

  const removeDevice = (id) => setPushSubscriptions(prev => { const u = { ...prev }; delete u[id]; if (Object.keys(u).length === 0) u._empty = true; return u; });
  const devices = Object.entries(pushSubscriptions || {}).filter(([k, v]) => k !== "_empty" && v && v.subscription);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal reminders-modal" onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div className="modal-title" style={{ margin: 0 }}>🔔 Evening reminders</div>
          <button onClick={onClose} className="reminders-close" aria-label="Close">&times;</button>
        </div>
        <div className="reminders-sub">Once a day, in the 6 o'clock hour, this device gets a note listing any jobs still left. Kids who are all done don't get one.</div>

        {!support.ok ? (
          <div className="reminders-help">
            {support.reason === "ios-home-screen" ? (<>
              <b>First, add Family HQ to this {deviceLabel() === "iPad" ? "iPad" : "iPhone"}'s Home Screen</b> — Apple only allows notifications from apps opened there:
              <ol><li>Tap the <b>Share</b> button (square with an arrow) in Safari.</li><li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open Family HQ from the new Home Screen icon and tap 🔔 again.</li></ol>
            </>) : support.reason === "denied" ? (
              <>Notifications are blocked for this app. Turn them on in the device's <b>Settings → Notifications</b> (or the browser's site settings), then come back.</>
            ) : (<>This browser can't receive notifications. Try Chrome on Android, or Safari on an iPhone/iPad (from the Home Screen).</>)}
          </div>
        ) : (<>
          <div className="reminders-label">Remind this device about</div>
          <div className="reminders-kids">
            {FAMILY_MEMBERS.map(m => (
              <label key={m.name} className={`reminders-kid ${members.includes(m.name) ? "on" : ""}`} style={members.includes(m.name) ? { borderColor: m.color } : {}}>
                <input type="checkbox" checked={members.includes(m.name)} onChange={() => toggleMember(m.name)} />
                <span>{getMemberEmoji(m.name)}</span> {m.name}
              </label>
            ))}
            {isParent && (
              <label className={`reminders-kid ${parent ? "on" : ""}`}>
                <input type="checkbox" checked={parent} onChange={() => setParent(p => !p)} />
                <span>👪</span> Parent summary
              </label>
            )}
          </div>
          <div className="reminders-actions">
            <button className="btn btn-primary" disabled={busy} onClick={save}>{record ? "Save" : "Turn on reminders"}</button>
            {record && <button className="btn btn-ghost" disabled={busy} onClick={test}>Send a test</button>}
            {record && <button className="btn btn-ghost" disabled={busy} onClick={turnOff}>Turn off</button>}
          </div>
        </>)}
        {msg && <div className="reminders-msg" style={{ color: msg.ok ? "var(--success)" : "var(--danger)" }}>{msg.text}</div>}

        {isParent && devices.length > 0 && (
          <div className="reminders-devices">
            <div className="reminders-label">Devices with reminders</div>
            {devices.map(([id, d]) => (
              <div key={id} className="reminders-device">
                <span>{d.device || "Device"}{id === subId ? " (this one)" : ""}</span>
                <span className="reminders-device-who">{[...(d.members || []), ...(d.parent ? ["Parent summary"] : [])].join(", ") || "—"}</span>
                <button className="chore-delete-btn" onClick={() => removeDevice(id)} title="Remove"><Icons.X size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// PARENT PIN — change card (Admin). Stores only the fingerprint, never the digits.
// ============================================================
function ParentPinCard({ parentSettings, setParentSettings }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState(null); // { ok: bool, text }
  const usingDefault = !parentSettings?.pinHash;
  const inputStyle = { width: 100, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-secondary)", color: "var(--text-primary)", fontFamily: "monospace", fontSize: "1rem", textAlign: "center", letterSpacing: "0.2em" };
  const digits = (v) => v.replace(/[^0-9]/g, "").slice(0, 4);
  const save = async () => {
    if (next.length !== 4) return setMsg({ ok: false, text: "New PIN must be 4 digits." });
    if (next !== confirm) return setMsg({ ok: false, text: "New PINs don't match." });
    const result = await verifyParentPin(current, parentSettings);
    if (result !== "ok") return setMsg({ ok: false, text: result === "locked" ? "Too many tries — wait a minute." : "Current PIN is wrong." });
    const pinHash = await hashParentPin(next);
    setParentSettings(prev => { const u = { ...prev }; delete u._empty; u.pinHash = pinHash; u.changedAt = Date.now(); return u; });
    setCurrent(""); setNext(""); setConfirm("");
    setMsg({ ok: true, text: "Parent PIN updated on all devices." });
  };
  return (
    <div className="card">
      <div className="card-title"><Icons.Lock size={22} color="var(--accent)" /> Parent PIN</div>
      <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: 12 }}>
        {usingDefault ? "Still using the original default PIN — change it so the kids can't guess it." : "Change the 4-digit PIN used to unlock parent mode."} After 5 wrong tries a device is locked out for 1 minute.
      </div>
      <div className="admin-row"><label>Current PIN</label><input type="password" inputMode="numeric" maxLength={4} value={current} onChange={e => { setCurrent(digits(e.target.value)); setMsg(null); }} style={inputStyle} /></div>
      <div className="admin-row"><label>New PIN</label><input type="password" inputMode="numeric" maxLength={4} value={next} onChange={e => { setNext(digits(e.target.value)); setMsg(null); }} style={inputStyle} /></div>
      <div className="admin-row"><label>Confirm new PIN</label><input type="password" inputMode="numeric" maxLength={4} value={confirm} onChange={e => { setConfirm(digits(e.target.value)); setMsg(null); }} style={inputStyle} /></div>
      {msg && <div style={{ fontSize: "0.85rem", fontWeight: 600, marginTop: 8, color: msg.ok ? "var(--success)" : "var(--danger)" }}>{msg.text}</div>}
      <button className="btn btn-primary" onClick={save} style={{ marginTop: 12 }}>Update PIN</button>
    </div>
  );
}

// ============================================================
// KID PIN DIALOG — required to check/uncheck a chore (per-kid PIN, 5-min cache)
// ============================================================
function KidPinDialog({ member, memberEmoji, memberColor, expectedPin, onSuccess, onClose }) {
  const maxLen = String(expectedPin || "").length || 4;
  const [pin, setPin] = useState(Array(maxLen).fill(""));
  const [error, setError] = useState(false);
  const refs = useRef(Array(maxLen).fill(null).map(() => null));
  useEffect(() => { setTimeout(() => refs.current[0]?.focus(), 50); }, []);
  const handleChange = (i, val) => {
    if (!/^\d*$/.test(val)) return;
    const newPin = [...pin]; newPin[i] = val.slice(-1);
    setPin(newPin); setError(false);
    if (val && i < maxLen - 1) refs.current[i + 1]?.focus();
    const full = newPin.join("");
    if (full.length === maxLen) {
      if (full === String(expectedPin)) onSuccess();
      else { setError(true); setTimeout(() => { setPin(Array(maxLen).fill("")); refs.current[0]?.focus(); }, 600); }
    }
  };
  return (
    <div className="pin-overlay" onClick={onClose}>
      <div className="pin-dialog" onClick={e => e.stopPropagation()} style={{ borderTop: `4px solid ${memberColor || "var(--accent)"}` }}>
        <div style={{ fontSize: "2.5rem", marginBottom: 4 }}>{memberEmoji}</div>
        <div className="pin-title" style={{ color: memberColor }}>{member}&apos;s PIN</div>
        <div className="pin-subtitle">Enter your {maxLen}-digit PIN to confirm</div>
        <div className="pin-input">
          {pin.map((d, i) => (
            <input key={i} ref={el => refs.current[i] = el} type="tel" inputMode="numeric" className="pin-digit" value={d} onChange={e => handleChange(i, e.target.value)} onKeyDown={e => { if (e.key === "Backspace" && !pin[i] && i > 0) refs.current[i-1]?.focus(); }} maxLength={1} />
          ))}
        </div>
        {error && <div className="pin-error">Wrong PIN — try again</div>}
        <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 8 }}>PIN saved for 5 minutes on this device</div>
        <button className="btn btn-ghost" onClick={onClose} style={{ marginTop: 8 }}>Cancel</button>
      </div>
    </div>
  );
}

import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";
import { db, storage } from "./firebase";
import { doc, setDoc, onSnapshot, deleteField, increment, FieldPath } from "firebase/firestore";
import {
  isVideoGameDay, getDailyAssignment, getRoutineForItemId, FAMILY_MEMBERS, getToday, getDayName,
  formatDate, getWeekStart, dateToKey, getCurrentWeekRotation, getWeekNumber, isTeamWeek,
  getChartAssignment, getWeekStartKey, getMonthKey, getYearKey, calculateStreak, STREAK_MILESTONES,
  CHORE_TIME_GROUPS, buildChoreList, getDateNight, MONTHLY_WORK, addMonths, formatMinutes,
  getWorkMonth,
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
  List: ({ size = 20, color = "currentColor" }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>),
};

const styles = `
@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=Fredoka:wght@400;500;600;700&display=swap');
:root{--bg-primary:#0d111a;--bg-secondary:#131a26;--bg-card:#161e2c;--bg-card-hover:#1b243a;--text-primary:#f0f4f8;--text-secondary:#8899aa;--text-muted:#5a6a7a;--border:#222d44;--accent:#3B82F6;--success:#10B981;--warning:#F59E0B;--danger:#EF4444}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Nunito',sans-serif;background:var(--bg-primary);color:var(--text-primary);min-height:100vh;overflow-x:hidden}
.app{min-height:100vh;display:flex;flex-direction:column}
.header{background:var(--bg-primary);border-bottom:1px solid var(--border);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.header-left{display:flex;align-items:center;gap:12px}
.header-logo{font-family:'Fredoka',sans-serif;font-size:1.4rem;font-weight:600;color:var(--text-primary);display:inline-flex;align-items:center;gap:10px;white-space:nowrap}
.header-logo .hq-logo{flex-shrink:0;border-radius:8px}
@media (max-width:560px){.header{padding:12px 14px}.header-date{display:none}.sync-label{display:none}.header-logo{font-size:1.3rem}}
.header-logo-hq{margin-left:-4px;background:linear-gradient(90deg,#3B82F6,#8B5CF6);-webkit-background-clip:text;background-clip:text;color:transparent}
.header-date{font-size:0.9rem;color:var(--text-secondary);font-weight:600}
.header-right{display:flex;align-items:center;gap:8px}
.sync-indicator{display:flex;align-items:center;gap:4px;font-size:0.7rem;font-weight:600;padding:4px 8px;border-radius:8px}
.sync-online{color:#34d399;background:rgba(16,185,129,0.1)}.sync-offline{color:#f87171;background:rgba(239,68,68,0.1)}
.nav{display:flex;background:var(--bg-secondary);border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch}
.nav-btn{flex:1;min-width:80px;padding:12px 8px;background:none;border:none;color:var(--text-muted);font-family:'Nunito',sans-serif;font-size:0.75rem;font-weight:700;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;transition:all 0.2s;border-bottom:3px solid transparent;text-transform:uppercase;letter-spacing:0.5px}
.nav-btn.active{color:var(--accent);border-bottom-color:var(--accent);background:rgba(59,130,246,0.05)}
.nav-btn:hover{color:var(--text-primary);background:rgba(255,255,255,0.03)}
.main{flex:1;padding:16px;max-width:1400px;width:100%;margin:0 auto}
.section-label{color:var(--text-muted);font-size:0.7rem;letter-spacing:0.6px;font-weight:600;text-transform:uppercase;margin-bottom:6px}
.section-title{font-family:'Fredoka',sans-serif;font-weight:500;font-size:1.5rem;color:var(--text-primary);margin-bottom:16px}
@media(min-width:768px){.today-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.today-grid .member-card{margin-bottom:0}}
@media(min-width:1100px){.today-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
.day-list{display:flex;flex-direction:column;gap:6px}
.day-row{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:12px 14px;cursor:pointer;transition:all 0.15s;display:flex;justify-content:space-between;align-items:center;gap:12px}
.day-row:hover{background:var(--bg-card-hover)}
.day-row.today{border-color:var(--accent);background:rgba(59,130,246,0.06)}
.day-row.selected{background:rgba(59,130,246,0.10);border-color:var(--accent);box-shadow:0 0 0 2px rgba(59,130,246,0.25)}
.day-row-label{font-size:0.7rem;color:var(--text-muted);letter-spacing:0.5px;font-weight:600;text-transform:uppercase}
.day-row.today .day-row-label{color:#60a5fa}
.day-row-status{font-size:0.85rem;font-weight:500;color:var(--text-primary)}
.day-row-dots{display:flex;gap:4px}
.day-dot{width:9px;height:9px;border-radius:50%;border:1.5px solid;box-sizing:border-box}
.day-dot.done{border-color:transparent}
.day-dot.missed{background:transparent !important;opacity:0.45}
.card{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:14px;transition:all 0.2s}
.card-title{font-family:'Fredoka',sans-serif;font-size:1.05rem;font-weight:600;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.member-card{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:14px 16px;margin-bottom:10px;transition:all 0.15s;border-left:none}
.member-stack .member-card{margin-bottom:0}
@media(min-width:768px){.today-grid .member-stack{align-self:start}}
.member-card:active{transform:scale(0.995)}
.member-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:10px}
.member-name-row{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.member-emoji{font-size:1.05rem;width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:50%;flex-shrink:0}
.member-name{font-family:'Fredoka',sans-serif;font-size:1.05rem;font-weight:500;color:var(--text-primary)}
.member-meta{font-size:0.72rem;color:var(--text-muted);font-weight:500;margin-top:1px}
.member-points{display:flex;align-items:center;gap:4px;font-weight:500;font-size:1rem;color:var(--text-primary)}
.member-progress{height:3px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;margin-top:8px}
.member-progress-fill{height:100%;border-radius:2px;transition:width 0.4s ease}
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
.chore-info-btn{width:22px;height:22px;border-radius:50%;border:1.5px solid var(--border);background:none;color:var(--text-muted);font-size:0.72rem;font-weight:800;font-style:italic;font-family:Georgia,serif;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;padding:0}
.chore-info-btn.open{color:var(--accent);border-color:var(--accent)}
@media (max-width:560px){.chore-list .chore-tag{display:none}}
.nightly-row{display:flex;gap:12px;align-items:flex-start;padding:10px 6px;border-top:1px solid var(--border)}
.nightly-row:nth-of-type(2){border-top:none}
.nightly-row.today{background:rgba(59,130,246,0.08);border-radius:10px;border-top-color:transparent}
.nightly-row.today .nightly-day{color:var(--accent)}
.nightly-day{width:48px;flex-shrink:0;font-weight:800;font-size:0.9rem;line-height:1.15}
.nightly-day small{display:block;font-weight:600;font-size:0.7rem;color:var(--text-muted)}
.nightly-jobs{display:flex;flex-wrap:wrap;gap:6px;flex:1;min-width:0}
.nightly-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:8px;background:rgba(255,255,255,0.04);font-size:0.8rem;font-weight:700}
.nightly-job{color:var(--text-muted);font-weight:600}
.header-bell{padding:6px 8px}
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
.date-night{display:flex;gap:14px;align-items:flex-start;padding:16px 18px;margin-bottom:16px;border-radius:16px;border:1px solid rgba(20,184,166,0.35);border-left:4px solid #14B8A6;background:linear-gradient(135deg,rgba(20,184,166,0.14),rgba(139,92,246,0.08))}
.date-night.scheduled{border-color:rgba(16,185,129,0.35);border-left-color:var(--success);background:linear-gradient(135deg,rgba(16,185,129,0.12),rgba(20,184,166,0.06))}
.date-night.fresh{box-shadow:0 0 0 3px rgba(20,184,166,0.18)}
.date-night-icon{font-size:1.9rem;line-height:1}
.date-night-body{flex:1;min-width:0}
.date-night-label{font-size:0.72rem;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:#5eead4;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.date-night-new{font-size:0.65rem;letter-spacing:0.06em;background:#0d9488;color:#fff;padding:2px 8px;border-radius:999px}
.date-night-who{display:flex;align-items:center;gap:10px;margin:8px 0 6px;flex-wrap:wrap}
.date-night-kid{font-family:'Fredoka',sans-serif;font-weight:700;font-size:1.15rem;color:#fff;padding:5px 14px;border-radius:999px}
.date-night-with{font-weight:700;color:var(--text-secondary)}
.date-night-status{font-size:0.85rem;color:var(--text-secondary);font-weight:600}
.date-night-next{color:var(--text-muted)}
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
.duty-label{font-size:0.68rem;font-weight:900;letter-spacing:1.2px;text-transform:uppercase;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.duty-chips{display:flex;flex-direction:column;align-items:stretch;gap:6px;min-width:0;max-width:210px}
.duty-chip{display:flex;align-items:center;justify-content:center;gap:5px;width:100%;min-width:0;padding:5px 10px;border-radius:999px;font-family:'Fredoka',sans-serif;font-size:1.02rem;font-weight:600;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.25);white-space:nowrap}
.duty-chip-name{overflow:hidden;text-overflow:ellipsis}
.duty-chip.done{background:rgba(16,185,129,0.22);color:#6ee7b7;text-shadow:none}
.duty-chip-count{font-size:0.75rem;font-weight:800;opacity:0.85}
.duty-chip-check{font-weight:900}
.duty-none{font-family:'Fredoka',sans-serif;font-size:1rem;color:var(--text-secondary);padding:5px 0}
@media (max-width:560px){.dishes-banner{padding:12px}.dishes-banner .dishes-banner-icon,.dishes-banner .dishes-banner-status{display:none}.duty-grid{gap:8px}.duty-label{font-size:0.6rem;letter-spacing:0.6px}.duty-chip{font-size:0.95rem;padding:5px 6px;gap:3px}.duty-chip-emoji{display:none}}
@media (max-width:400px){.duty-chip{font-size:0.88rem;padding:4px 4px}.duty-chip-count{font-size:0.68rem}}
.chore-done-toggle{background:none;border:none;color:var(--success);font-size:0.8rem;font-weight:700;text-align:left;padding:6px 2px 2px;cursor:pointer;font-family:inherit}
.chore-empty{font-size:0.85rem;color:var(--text-muted);padding:8px 12px;font-style:italic}
/* --- "Dishes today" hero banner --- */
.dishes-banner{display:flex;align-items:center;gap:14px;padding:14px 16px;margin-bottom:16px;border-radius:16px;background:linear-gradient(135deg,rgba(59,130,246,0.18),rgba(59,130,246,0.06));border:1px solid rgba(59,130,246,0.4);border-left:5px solid var(--accent)}
.dishes-banner.done{background:linear-gradient(135deg,rgba(16,185,129,0.16),rgba(16,185,129,0.05));border-color:rgba(16,185,129,0.4);border-left-color:var(--success)}
.dishes-banner.none{background:var(--bg-card);border-color:var(--border);border-left-color:var(--text-muted);opacity:0.75}
.dishes-banner-icon{font-size:1.9rem;line-height:1;flex-shrink:0}
.dishes-banner-body{flex:1;min-width:0}
.dishes-banner-label{font-size:0.68rem;font-weight:900;letter-spacing:1.4px;text-transform:uppercase;color:var(--text-muted);margin-bottom:5px}
.dishes-banner-names{display:flex;flex-wrap:wrap;gap:7px}
.dishes-kid{display:inline-flex;align-items:center;gap:6px;padding:5px 13px 5px 9px;border-radius:999px;font-family:'Fredoka',sans-serif;font-size:1.05rem;font-weight:600;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.25)}
.dishes-kid.done{background:rgba(16,185,129,0.2);color:#34d399;text-shadow:none}
.dishes-kid-emoji{font-size:1.1rem}
.dishes-kid-check{font-weight:900}
.dishes-kid-count{font-size:0.78rem;font-weight:800;opacity:0.85}
.dishes-banner-none-text{font-family:'Fredoka',sans-serif;font-size:1.05rem;font-weight:500;color:var(--text-secondary)}
.dishes-banner-status{font-size:0.7rem;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:#34d399;flex-shrink:0}
.dishes-chip{font-size:0.6rem;font-weight:900;letter-spacing:0.6px;padding:3px 7px;border-radius:6px;background:var(--accent);color:#fff;white-space:nowrap;margin-left:2px}
.dishes-chip.done{background:rgba(16,185,129,0.2);color:#34d399}
/* --- Routine summary chips on the collapsed card --- */
.routine-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.routine-chip{font-size:0.68rem;font-weight:800;padding:2px 7px;border-radius:6px;background:rgba(56,189,248,0.13);color:#38bdf8;white-space:nowrap}
.routine-chip.done{background:rgba(16,185,129,0.15);color:#34d399}
/* --- Daily routine sections (morning / bedtime), nested in the card --- */
.member-card .routine-card{margin-top:10px}
.member-stack{display:flex;flex-direction:column;gap:10px;margin-bottom:12px}
.today-grid .member-stack{margin-bottom:0}
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
.week-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px}
.week-nav-btn{background:var(--bg-card);border:1px solid var(--border);border-radius:10px;color:var(--text-primary);width:40px;height:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s;padding:0}
.week-nav-btn:hover{background:var(--bg-card-hover)}
.week-label{font-family:'Fredoka',sans-serif;font-size:1.05rem;font-weight:500;text-align:center;flex:1}
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
.my-jobs-btn{display:flex;align-items:center;gap:4px;padding:4px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-secondary);font-family:'Nunito',sans-serif;font-size:0.75rem;font-weight:700;cursor:pointer;transition:all 0.15s;white-space:nowrap}
.my-jobs-btn:hover{background:var(--bg-card-hover);color:var(--text-primary)}
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
  // Tapping a reminder opens /?kid=Carter — expand that kid's card on Today.
  const [focusKid] = useState(() => { try { return new URLSearchParams(window.location.search).get("kid"); } catch { return null; } });
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

  useEffect(() => { saveData("fcc_memberPins", memberPins); }, [memberPins]);
  useEffect(() => { saveData("fcc_parentSettings", parentSettings); }, [parentSettings]);
  useEffect(() => { saveData("fcc_pushSubscriptions", pushSubscriptions); }, [pushSubscriptions]);
  useEffect(() => { saveData("fcc_dateNights", dateNights); }, [dateNights]);
  useEffect(() => { saveData("fcc_workLogs", workLogs); }, [workLogs]);
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

  return (
    <><style>{styles}</style>
      {showSplash && <LaunchSplash onDone={() => setShowSplash(false)} />}
      <div className="app">
        <header className="header">
          <div className="header-left">
            <span className="header-logo"><LogoMark size={34} />Family <span className="header-logo-hq">HQ</span></span>
            <span className="header-date">{formatDate(today)}</span>
          </div>
          <div className="header-right">
            <button className="btn btn-ghost header-bell" onClick={() => setShowReminders(true)} title="Reminders" aria-label="Reminders"><Icons.Bell size={18} /></button>
            <div className={`sync-indicator ${isOnline ? "sync-online" : "sync-offline"}`}>
              {isOnline ? <Icons.Cloud size={14} /> : <Icons.CloudOff size={14} />}
              <span className="sync-label">{isOnline ? "Synced" : "Offline"}</span>
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
          {currentTab === "today" && <TodayView focusKid={focusKid} dateNights={dateNights} setDateNights={setDateNights} workLogs={workLogs} setWorkLogs={setWorkLogs} pinGate={pinGate} members={FAMILY_MEMBERS} getMemberChores={getMemberChores} isChoreComplete={isChoreComplete} toggleChore={toggleChore} getCompletionCount={getCompletionCount} getPoints={getPoints} isParent={isParent} deleteCustomTask={deleteCustomTask} computedStreaks={computedStreaks} getMemberEmoji={getMemberEmoji} setMemberEmoji={setMemberEmoji} teamWeek={teamWeek} getTeamForMember={getTeamForMember} getTeamName={getTeamName} getTeamColor={getTeamColor} getVideoGameStatus={getVideoGameStatus} uploadChorePhoto={uploadChorePhoto} getChorePhoto={getChorePhoto} photoUploading={photoUploading} setPhotoViewer={setPhotoViewer} getChoresForDate={getChoresForDate} isChoreCompleteForDate={isChoreCompleteForDate} today={today} />}
          {currentTab === "week" && <WeekView today={today} weekOffset={weekOffset} setWeekOffset={setWeekOffset} getChoresForDate={getChoresForDate} isChoreCompleteForDate={isChoreCompleteForDate} toggleChoreForDate={toggleChoreForDate} getMemberEmoji={getMemberEmoji} getPoints={getPoints} computedStreaks={computedStreaks} isParent={isParent} deleteCustomTask={deleteCustomTask} teamWeek={teamWeek} getTeamForMember={getTeamForMember} getTeamName={getTeamName} getTeamColor={getTeamColor} />}
          {currentTab === "rotation" && <RotationView today={today} weekRotation={weekRotation} />}
          {currentTab === "leaderboard" && <LeaderboardView getPoints={getPoints} computedStreaks={computedStreaks} teamWeek={teamWeek} teams={teams} getTeamName={getTeamName} setTeamName={setTeamName} weekStartKey={weekStartKey} getAwardCounts={getAwardCounts} prizes={prizes} setPrizes={setPrizes} awards={awards} getMemberEmoji={getMemberEmoji} getTeamColor={getTeamColor} setTeamColor={setTeamColor} />}
          {currentTab === "games" && <GameView members={FAMILY_MEMBERS} getVideoGameStatus={getVideoGameStatus} getMemberEmoji={getMemberEmoji} gameTimers={gameTimers} startTimer={startTimer} pauseTimer={pauseTimer} stopTimer={stopTimer} adjustTimer={adjustTimer} isParent={isParent} toggleGameUnlock={toggleGameUnlock} setTimesUpMember={setTimesUpMember} />}
          {currentTab === "history" && <HistoryView awards={awards} points={points} teamNames={teamNames} getMemberEmoji={getMemberEmoji} today={today} />}
          {currentTab === "admin" && isParent && <AdminView points={points} setPoints={setPoints} completedChores={completedChores} setCompletedChores={setCompletedChores} streaks={streaks} setStreaks={setStreaks} customTasks={customTasks} deleteCustomTask={deleteCustomTask} getPoints={getPoints} addPoints={addPoints} recordWeekAwards={recordWeekAwards} prizes={prizes} setPrizes={setPrizes} weekStartKey={weekStartKey} monthKey={monthKey} awards={awards} setAwards={setAwards} getVideoGameStatus={getVideoGameStatus} toggleGameUnlock={toggleGameUnlock} chorePhotos={chorePhotos} deleteChorePhoto={deleteChorePhoto} setPhotoViewer={setPhotoViewer} getMemberEmoji={getMemberEmoji} memberPins={memberPins} setMemberPins={setMemberPins} parentSettings={parentSettings} setParentSettings={setParentSettings} />}
        </main>
        {isParent && currentTab === "today" && <button className="add-task-fab" onClick={() => setShowAddTask(true)} title="Add Custom Task"><Icons.Plus size={28} /></button>}
        {showReminders && <RemindersModal pushSubscriptions={pushSubscriptions} setPushSubscriptions={setPushSubscriptions} isParent={isParent} getMemberEmoji={getMemberEmoji} onClose={() => setShowReminders(false)} />}
        {showPinDialog && <PinDialog parentSettings={parentSettings} onSuccess={() => { setIsParent(true); setShowPinDialog(false); }} onClose={() => setShowPinDialog(false)} />}
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

function TodayView({ focusKid, dateNights, setDateNights, workLogs, setWorkLogs, pinGate, members, getMemberChores, isChoreComplete, toggleChore, getCompletionCount, getPoints, isParent, deleteCustomTask, computedStreaks, getMemberEmoji, setMemberEmoji, teamWeek, getTeamForMember, getTeamName, getTeamColor, getVideoGameStatus, uploadChorePhoto, getChorePhoto, photoUploading, setPhotoViewer, getChoresForDate, isChoreCompleteForDate, today }) {
  const [emojiPicker, setEmojiPicker] = useState(null); // member name or null
  const [jobsModal, setJobsModal] = useState(null); // member name or null
  const [workModal, setWorkModal] = useState(null); // kid name for the work-hours log
  const [expanded, setExpanded] = useState(() => new Set(focusKid ? [focusKid] : [])); // collapsed by default (except a kid opened from a reminder)
  useEffect(() => {
    if (!focusKid) return;
    const t = setTimeout(() => document.getElementById(`member-${focusKid}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
    return () => clearTimeout(t);
  }, [focusKid]);
  const toggleExpanded = (name) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

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
      const chores = getChoresForDate(jobsModal, d);
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

  const headerDate = today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }).toUpperCase();
  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <div className="section-label">{headerDate}</div>
        <div className="section-title">Today</div>
      </div>
      {(() => {
        // Tonight's three "whose turn is it" jobs — dishes, clear table, trash —
        // side by side in equal columns so everyone can see them at a glance.
        const isDishChore = (c) => c.id === "dishes" || c.id.startsWith("dishes_");
        const COLUMNS = [
          { key: "dishes", label: "Dishes", icon: "🍽️", match: isDishChore },
          { key: "clear", label: "Clear Table", icon: "🧽", match: c => c.id === "dinner_clear" },
          { key: "trash", label: "Trash", icon: "🗑️", match: c => c.id === "dinner_trash" },
        ].map(col => ({
          ...col,
          kids: members.map(m => {
            const jobs = getMemberChores(m.name).filter(col.match);
            if (!jobs.length) return null;
            const doneCount = jobs.filter(c => isChoreComplete(m.name, c.id)).length;
            return { m, total: jobs.length, doneCount, done: doneCount === jobs.length };
          }).filter(Boolean),
        }));
        const assigned = COLUMNS.flatMap(c => c.kids);
        const allDone = assigned.length > 0 && assigned.every(k => k.done);
        return (
          <div className={`dishes-banner ${allDone ? "done" : ""}`}>
            <div className="dishes-banner-icon">{allDone ? "✨" : "🍽️"}</div>
            <div className="duty-grid">
              {COLUMNS.map(col => (
                <div key={col.key} className="duty-col">
                  <div className="duty-label">{col.icon} {col.label}</div>
                  <div className="duty-chips">
                    {col.kids.length === 0 && <span className="duty-none">{col.key === "dishes" ? "Day off" : "—"}</span>}
                    {col.kids.map(({ m, total, doneCount, done }) => (
                      <span key={m.name} className={`duty-chip ${done ? "done" : ""}`} style={done ? undefined : { background: m.color }}>
                        <span className="duty-chip-emoji">{getMemberEmoji(m.name)}</span>
                        <span className="duty-chip-name">{m.name}</span>
                        {done ? <span className="duty-chip-check">✓</span> : total > 1 && <span className="duty-chip-count">{doneCount}/{total}</span>}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {allDone && <div className="dishes-banner-status">Done</div>}
          </div>
        );
      })()}
      <DateNightCard today={today} dateNights={dateNights} setDateNights={setDateNights} isParent={isParent} getMemberEmoji={getMemberEmoji} />
      <StreakSpotlight members={members} computedStreaks={computedStreaks} getMemberEmoji={getMemberEmoji} />
      <div className="today-grid">
      {members.map((member) => {
        const allChores = getMemberChores(member.name);
        // Routine items render as their own sections inside the expanded card,
        // not mixed into the main chore list.
        const chores = allChores.filter(c => !c.routine);
        const routineGroups = [];
        allChores.filter(c => c.routine).forEach(c => {
          let g = routineGroups.find(r => r.key === c.routine);
          if (!g) { g = { key: c.routine, label: c.routineLabel, icon: c.routineIcon, bonus: c.routineBonus, items: [] }; routineGroups.push(g); }
          g.items.push(c);
        });
        const done = chores.filter(c => isChoreComplete(member.name, c.id)).length;
        const total = chores.length;
        const allDone = total > 0 && done === total;
        // No-miss jobs still outstanding — shown on the collapsed header.
        const priorityOpen = chores.filter(c => c.priority && !isChoreComplete(member.name, c.id));
        const weeklyPts = getPoints(member.name, "weekly");
        const streak = computedStreaks?.[member.name] || 0;
        const emoji = getMemberEmoji(member.name);
        const gameStatus = getVideoGameStatus(member.name);
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const isExpanded = expanded.has(member.name);
        return (
          <div key={member.name} id={`member-${member.name}`} className="member-stack">
          <div className="member-card animate-in">
            <div className="member-header" onClick={() => toggleExpanded(member.name)} style={{ cursor: "pointer" }}>
              <div className="member-name-row">
                <button className="emoji-picker-btn" onClick={(e) => { e.stopPropagation(); setEmojiPicker(emojiPicker === member.name ? null : member.name); }}>
                  <div className="member-emoji" style={{ background: member.color }}>{emoji}</div>
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="member-name">
                    {member.name}
                    {chores.some(c => c.id === "dishes" || c.id.startsWith("dishes_")) && (
                      <span className={`dishes-chip ${chores.filter(c => c.id === "dishes" || c.id.startsWith("dishes_")).every(c => isChoreComplete(member.name, c.id)) ? "done" : ""}`}>
                        🍽️ DISHES
                      </span>
                    )}
                    {streak >= 30 ? <span className="streak-on-fire">🔥 {streak}d ON FIRE</span>
                     : streak >= 14 ? <span className="streak-fire streak-fire-3" title={`${streak}-day streak!`}>🔥🔥🔥 {streak}d</span>
                     : streak >= 7 ? <span className="streak-fire streak-fire-2" title={`${streak}-day streak!`}>🔥🔥 {streak}d</span>
                     : streak >= 3 ? <span className="streak-fire streak-fire-1" title={`${streak}-day streak!`}>🔥 {streak}d</span>
                     : null}
                    <span className={`game-unlock-badge ${gameStatus.unlocked ? (gameStatus.parentOverride ? "override" : "unlocked") : "locked"}`} title={gameStatus.unlocked ? (gameStatus.parentOverride ? "Unlocked by parent" : `Video games unlocked!`) : `Locked — HK: ${gameStatus.housekeepingPct}% · Dinner: ${gameStatus.dinnerPct}%`}>
                      <span className="game-unlock-icon">🎮</span>
                      <span className="game-lock-icon">{gameStatus.unlocked ? "🔓" : "🔒"}</span>
                    </span>
                  </div>
                  <div className="member-meta" style={{ color: allDone ? "#34d399" : "var(--text-muted)" }}>
                    {allDone ? "All done" : `${done} of ${total} done`}
                  </div>
                  {routineGroups.length > 0 && !isExpanded && (
                    <div className="routine-chips">
                      {routineGroups.map(rg => {
                        const d = rg.items.filter(it => isChoreComplete(member.name, it.id)).length;
                        return (
                          <span key={rg.key} className={`routine-chip ${d === rg.items.length ? "done" : ""}`}>
                            {rg.icon} {rg.label} {d}/{rg.items.length}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {priorityOpen.length > 0 && (
                    <div className="must-do-alert">
                      <span className="must-do-alert-icon">⚠</span>
                      <span className="must-do-alert-text">
                        {priorityOpen.length === 1
                          ? priorityOpen[0].text
                          : `${priorityOpen.length} must-do jobs today`}
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button className="my-jobs-btn" onClick={(e) => { e.stopPropagation(); setJobsModal(member.name); }} title="View weekly jobs">
                  <Icons.List size={14} />
                </button>
                <div className="member-points">{weeklyPts}</div>
                <div className="expand-chevron" style={{ transform: isExpanded ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.2s", color: "var(--text-muted)", display: "flex", alignItems: "center" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                </div>
              </div>
            </div>
            <div className="member-progress">
              <div className="member-progress-fill" style={{ width: `${pct}%`, background: member.color }} />
            </div>
            {MONTHLY_WORK[member.name] && <WorkHoursBar kid={member.name} color={member.color} today={today} workLogs={workLogs} onOpen={() => setWorkModal(member.name)} />}
            {emojiPicker === member.name && (
              <div className="emoji-grid" style={{ marginBottom: 12 }}>
                {EMOJI_OPTIONS.map(e => (
                  <div key={e} className={`emoji-option ${emoji === e ? "selected" : ""}`} onClick={() => { setMemberEmoji(member.name, e); setEmojiPicker(null); }}>{e}</div>
                ))}
              </div>
            )}
            {isExpanded && (() => {
              // Open chores grouped by time of day (must-do jobs stay first within
              // their group); finished chores collapse into one "done" row at the
              // bottom so what's left is always on top.
              const isWeekend = today.getDay() === 0 || today.getDay() === 6;
              const openChores = chores.filter(c => !isChoreComplete(member.name, c.id));
              const doneChores = chores.filter(c => isChoreComplete(member.name, c.id));
              const doneKey = `${member.name}::done`;
              const showDone = expanded.has(doneKey);
              const renderChore = (chore) => {
                const completed = isChoreComplete(member.name, chore.id);
                const isCustom = chore.tag === "custom";
                const infoKey = `${member.name}::info::${chore.id}`;
                const infoOpen = expanded.has(infoKey);
                return (
                  <div key={chore.id} className={`chore-item ${completed ? "completed" : ""} ${chore.priority ? "priority" : ""}`}>
                    <div className={`chore-checkbox ${completed ? "checked check-pop" : ""}`} onClick={() => toggleChore(member.name, chore.id, chore.pointValue || 1)}>{completed && <Icons.Check size={16} color="white" />}</div>
                    <div className="chore-body">
                      <span className="chore-text" onClick={() => toggleChore(member.name, chore.id, chore.pointValue || 1)}>{chore.text}</span>
                      {infoOpen && chore.details && <div className="chore-details" onClick={() => toggleExpanded(infoKey)}>{chore.details}</div>}
                    </div>
                    {chore.details && <button className={`chore-info-btn ${infoOpen ? "open" : ""}`} onClick={(e) => { e.stopPropagation(); toggleExpanded(infoKey); }} title={infoOpen ? "Hide details" : "Show details"} aria-label="Show details">i</button>}
                    {isCustom && chore.pointValue > 1 && <span className="chore-points-badge">+{chore.pointValue}</span>}
                    {chore.priority && <span className="must-do-badge">⚠ MUST DO</span>}
                    <span className={`chore-tag tag-${chore.tag}`}>{chore.tag}</span>
                    {isParent && isCustom && <button className="chore-delete-btn" onClick={(e) => { e.stopPropagation(); deleteCustomTask(chore.taskKey); }} title="Delete task"><Icons.X size={16} /></button>}
                  </div>
                );
              };
              return (
                <div className="chore-list" style={{ marginTop: 10 }}>
                  {CHORE_TIME_GROUPS.map(group => {
                    const items = openChores.filter(c => (c.when || "day") === group.key);
                    if (items.length === 0) return null;
                    return (
                      <Fragment key={group.key}>
                        <div className="chore-group-label">
                          <span>{isWeekend && group.weekendIcon ? group.weekendIcon : group.icon}</span>
                          {isWeekend && group.weekendLabel ? group.weekendLabel : group.label}
                        </div>
                        {items.map(renderChore)}
                      </Fragment>
                    );
                  })}
                  {chores.length === 0 && <div className="chore-empty">Nothing assigned today</div>}
                  {chores.length > 0 && openChores.length === 0 && <div className="chore-empty">Everything's done — nice work! 🎉</div>}
                  {doneChores.length > 0 && (
                    <>
                      <button className="chore-done-toggle" onClick={() => toggleExpanded(doneKey)}>
                        ✓ {doneChores.length} done <span style={{ opacity: 0.7 }}>{showDone ? "· hide" : "· show"}</span>
                      </button>
                      {showDone && doneChores.map(renderChore)}
                    </>
                  )}
                </div>
              );
            })()}
            {isExpanded && routineGroups.map((rg) => {
            const rKey = `${member.name}::${rg.key}`;
            const rOpen = expanded.has(rKey);
            const rDone = rg.items.filter(it => isChoreComplete(member.name, it.id)).length;
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
                  <div className="expand-chevron" style={{ transform: rOpen ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.2s", color: "var(--text-muted)", display: "flex", alignItems: "center" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                  </div>
                </div>
                <div className="member-progress">
                  <div className="member-progress-fill" style={{ width: `${rPct}%`, background: rComplete ? "#10B981" : member.color }} />
                </div>
                {rOpen && (
                  <div className="chore-list" style={{ marginTop: 10 }}>
                    {rg.items.map((item) => {
                      const completed = isChoreComplete(member.name, item.id);
                      return (
                        <div key={item.id} className={`chore-item ${completed ? "completed" : ""}`}>
                          <div className={`chore-checkbox ${completed ? "checked check-pop" : ""}`} onClick={() => toggleChore(member.name, item.id, item.pointValue ?? 0)}>{completed && <Icons.Check size={16} color="white" />}</div>
                          <span className="chore-text" onClick={() => toggleChore(member.name, item.id, item.pointValue ?? 0)}>{item.text}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          </div>
          </div>
        );
      })}
      </div>
      {workModal && <WorkHoursModal kid={workModal} today={today} workLogs={workLogs} setWorkLogs={setWorkLogs} isParent={isParent} pinGate={pinGate} getMemberEmoji={getMemberEmoji} onClose={() => setWorkModal(null)} />}
      {jobsModal && weeklyJobsData && (
        <div className="modal-overlay" onClick={() => setJobsModal(null)}>
          <div className="my-jobs-modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontFamily: "'Fredoka', sans-serif", fontSize: "1.2rem", fontWeight: 700 }}>
                {getMemberEmoji(jobsModal)} {jobsModal}'s Week
              </div>
              <button onClick={() => setJobsModal(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "1.5rem" }}>&times;</button>
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
                  <span style={{ marginLeft: "auto", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                    {day.chores.filter(c => c.done).length}/{day.chores.length}
                  </span>
                </div>
                {day.chores.length === 0 && <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", paddingLeft: 10 }}>No chores</div>}
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
      <div className="day-list">
        {days.map((date) => {
          const dn = getDayName(date);
          const dk = dateToKey(date);
          const isToday = dk === dateToKey(today);
          const isSelected = dk === selectedDayKey;
          // Per-kid status dot: outline ring if missed/incomplete, solid if all due chores done
          const kidStatus = FAMILY_MEMBERS.map(member => {
            const chores = getChoresForDate(member.name, date);
            if (chores.length === 0) return { member, state: "none" };
            const doneCount = chores.filter(c => isChoreCompleteForDate(member.name, c.id, date)).length;
            const allDone = doneCount === chores.length;
            return { member, state: allDone ? "done" : (isToday || date > today ? "pending" : "missed") };
          });
          const summary = (() => {
            const total = kidStatus.filter(k => k.state !== "none").length;
            const done = kidStatus.filter(k => k.state === "done").length;
            if (isToday) return done === total && total > 0 ? "Today · all done" : "Today · in progress";
            if (date > today) return "Upcoming";
            return `${done} of ${total} done`;
          })();
          return (
            <div key={dk} className={`day-row ${isToday ? "today" : ""} ${isSelected ? "selected" : ""}`} onClick={() => setSelectedDay(isSelected ? null : date)}>
              <div>
                <div className="day-row-label">{dn.slice(0, 3).toUpperCase()} · {date.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase()}{isToday ? " · TODAY" : ""}</div>
                <div className="day-row-status">{summary}</div>
              </div>
              <div className="day-row-dots">
                {kidStatus.filter(k => k.state !== "none").map(k => (
                  <div
                    key={k.member.name}
                    className={`day-dot ${k.state === "done" ? "done" : ""} ${k.state === "missed" ? "missed" : ""}`}
                    style={{ background: k.state === "done" ? k.member.color : "transparent", borderColor: k.member.color }}
                    title={`${k.member.name}: ${k.state}`}
                  />
                ))}
              </div>
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
                      <div key={chore.id} className={`chore-item ${completed ? "completed" : ""} ${chore.priority ? "priority" : ""}`} onClick={(e) => { e.stopPropagation(); toggleChoreForDate(member.name, chore.id, selectedDay, chore.pointValue ?? 1); }}>
                        <div className={`chore-checkbox ${completed ? "checked check-pop" : ""}`}>{completed && <Icons.Check size={16} color="white" />}</div>
                        <span className="chore-text">{chore.text}</span>
                        {isCustom && chore.pointValue > 1 && <span className="chore-points-badge">+{chore.pointValue}</span>}
                        {chore.priority && <span className="must-do-badge">⚠ MUST DO</span>}
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
const NIGHTLY_JOB_DISPLAY = [
  { key: "Dishes", label: "Dishes", icon: "🍽️" },
  { key: "Take Out Trash", label: "Trash", icon: "🗑️" },
  { key: "Clear Table", label: "Clear", icon: "🧽" },
  { key: "Floor Pickup", label: "Floor", icon: "🧹" },
  { key: "Set Table", label: "Set", icon: "🍴" },
];

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

  // Nightly jobs (dishes + dinner jobs) for the first week shown. Built from the
  // same getDailyAssignment() the Today screen uses, so the two can't disagree.
  const nightly = useMemo(() => {
    const ws = weeks[0]?.date;
    if (!ws) return null;
    const todayKey = dateToKey(today);
    const rows = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(ws); d.setDate(d.getDate() + i);
      const jobs = {};
      FAMILY_MEMBERS.forEach(m => {
        const a = getDailyAssignment(m.name, d);
        if (!a) return;
        if (a.dishes) (jobs["Dishes"] = jobs["Dishes"] || []).push(m.name);
        a.dinnerJobs.forEach(dj => { (jobs[dj.job] = jobs[dj.job] || []).push(m.name); });
      });
      rows.push({ date: d, key: dateToKey(d), isToday: dateToKey(d) === todayKey, jobs });
    }
    return { weekStart: ws, rows };
  }, [weeks, today]);

  return (
    <div>
      <div className="week-nav">
        <button className="week-nav-btn" onClick={() => setRotationOffset(o => o - 4)}><Icons.ChevronLeft size={20} /></button>
        <span className="week-label">Rotation Schedule</span>
        <button className="week-nav-btn" onClick={() => setRotationOffset(o => o + 4)}><Icons.ChevronRight size={20} /></button>
      </div>
      {nightly && (
        <div className="card animate-in">
          <div className="card-title">
            <span>🍽️</span>
            <span>Nightly Jobs · week of {nightly.weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
          </div>
          {nightly.rows.map(row => (
            <div key={row.key} className={`nightly-row ${row.isToday ? "today" : ""}`}>
              <div className="nightly-day">
                {row.date.toLocaleDateString("en-US", { weekday: "short" })}
                <small>{row.isToday ? "Today" : row.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</small>
              </div>
              <div className="nightly-jobs">
                {NIGHTLY_JOB_DISPLAY.filter(j => row.jobs[j.key]).map(j => (
                  <span key={j.key} className="nightly-chip">
                    <span>{j.icon}</span>
                    <span className="nightly-job">{j.label}</span>
                    {row.jobs[j.key].map(name => {
                      const m = member(name);
                      return <span key={name} style={{ color: m?.color }}>{name}</span>;
                    })}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
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
                🔒 This week's Mon-Thu chores incomplete — HK: {gs.housekeepingPct}% (need 100%) · Dinner: {gs.dinnerPct}% (need 90%)
              </div>
            )}
            {gs.unlocked && (
              <div className="game-status-msg" style={{ color: "#34d399" }}>
                ✅ Unlocked! {gs.parentOverride ? "(Parent override)" : ""}
              </div>
            )}
            {isParent && (
              <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
                <button className={`admin-unlock-toggle ${gs.unlocked ? "lock" : "unlock"}`} onClick={() => toggleGameUnlock(member.name)}>
                  {gs.parentOverride ? "↩️ Remove Override" : gs.unlocked ? "🔒 Lock Games" : "🔓 Override Unlock"}
                </button>
              </div>
            )}

          </div>
        );
      })}
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

function WorkHoursBar({ kid, color, today, workLogs, onOpen }) {
  const mk = getMonthKey(today);
  const w = getWorkMonth(kid, mk, workLogs);
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
      <span className="work-bar-track"><span className="work-bar-fill" style={{ width: `${pct}%`, background: !w.beforeStart && w.remaining === 0 ? "var(--success)" : color }} /></span>
    </button>
  );
}

function WorkHoursModal({ kid, today, workLogs, setWorkLogs, isParent, pinGate, getMemberEmoji, onClose }) {
  const currentMonth = getMonthKey(today);
  const [monthKey, setMonthKey] = useState(currentMonth);
  const [hours, setHours] = useState(1);
  const [mins, setMins] = useState(0);
  const [date, setDate] = useState(dateToKey(today));
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(null); // entry id being edited (parents)
  const [msg, setMsg] = useState(null);
  const w = getWorkMonth(kid, monthKey, workLogs);
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
  const fmtDate = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); };
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
          {(carryText || w.extra > 0) && <div className="work-summary-note">{carryText}{carryText && w.extra > 0 ? " · " : ""}{w.extra > 0 ? `+${formatMinutes(w.extra)} extra carries to next month` : ""}</div>}
        </>)}

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

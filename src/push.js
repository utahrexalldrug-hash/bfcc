// Browser side of the evening reminders (see api/remind.js for the sender).
import { VAPID_PUBLIC_KEY } from "./pushConfig";

export function isIOSLike() {
  const ua = navigator.userAgent || "";
  // iPadOS reports itself as a Mac; a touch screen gives it away.
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
export function isInstalledApp() {
  return window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
}

// { ok: true } or { ok: false, reason: "ios-home-screen" | "unsupported" | "denied" }
export function pushSupport() {
  if (isIOSLike() && !isInstalledApp()) return { ok: false, reason: "ios-home-screen" };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return { ok: false, reason: "unsupported" };
  if (Notification.permission === "denied") return { ok: false, reason: "denied" };
  return { ok: true };
}

function keyToBytes(base64url) {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

// Stable id for this device's subscription (same device → same id).
export function subscriptionId(endpoint) {
  let h = 0x811c9dc5;
  for (let i = 0; i < endpoint.length; i++) { h ^= endpoint.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return "s" + h.toString(16).padStart(8, "0");
}

export function deviceLabel() {
  const ua = navigator.userAgent || "";
  if (/iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android phone";
  return "Computer";
}

// Ask permission (if needed) and return this device's push subscription as JSON.
export async function subscribeThisDevice() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error(perm === "denied" ? "denied" : "dismissed");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(VAPID_PUBLIC_KEY) });
  return JSON.parse(JSON.stringify(sub)); // { endpoint, expirationTime, keys: { p256dh, auth } }
}

export async function currentSubscriptionId() {
  try {
    if (!("serviceWorker" in navigator)) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    return sub ? subscriptionId(sub.endpoint) : null;
  } catch { return null; }
}

export async function unsubscribeThisDevice() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
}

export async function sendTestReminder(subId) {
  const r = await fetch("/api/remind", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ test: subId }) });
  let body = {};
  try { body = await r.json(); } catch { /* non-JSON error page */ }
  if (!r.ok || !body.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

import { useEffect, useId, useRef, useState } from "react";

// ============================================================
// FAMILY HQ LOGO — "Family Ring"
// Six circles — one per kid, in their app colors (Emilie = pink) — huddled
// around a check. Geometry is on a 512×512 grid; public/icon.svg and the PNG
// app icons are drawn from the same numbers — keep them in sync if it changes.
// ============================================================

// One circle per kid, clockwise from the top.
export const LOGO_KID_COLORS = ["#E85D4A", "#EC4899", "#3B82F6", "#10B981", "#F59E0B", "#8B5CF6"];

const RING_R = 150;   // distance of each kid circle from the center
const DOT_R = 38;
const CHECK_PATH = "M198 260 L240 302 L320 216";
const dotPos = (i) => {
  const a = (Math.PI / 3) * i; // 60° apart, starting at 12 o'clock
  return { x: 256 + RING_R * Math.sin(a), y: 256 - RING_R * Math.cos(a) };
};

export function LogoMark({ size = 32, tile = true, className = "" }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const bg = `${uid}-bg`;
  return (
    <svg className={`hq-logo ${className}`} width={size} height={size} viewBox="0 0 512 512" role="img" aria-label="Family HQ">
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#18223a" /><stop offset="1" stopColor="#0c1220" /></linearGradient>
      </defs>
      {tile && (
        <g className="hq-tile">
          <rect width="512" height="512" rx="112" fill={`url(#${bg})`} />
          <rect x="6" y="6" width="500" height="500" rx="106" fill="none" stroke="#ffffff" strokeOpacity="0.07" strokeWidth="4" />
        </g>
      )}
      <circle className="hq-ring" cx="256" cy="256" r={RING_R} pathLength="1" fill="none" stroke="#ffffff" strokeOpacity="0.08" strokeWidth="10" transform="rotate(-90 256 256)" />
      <g className="hq-dots">
        {LOGO_KID_COLORS.map((c, i) => {
          const { x, y } = dotPos(i);
          return <circle key={c} className="hq-dot" style={{ "--i": i, "--dx": `${256 - x}px`, "--dy": `${256 - y}px` }} cx={x.toFixed(1)} cy={y.toFixed(1)} r={DOT_R} fill={c} />;
        })}
      </g>
      <path className="hq-check" d={CHECK_PATH} pathLength="1" fill="none" stroke="#ffffff" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ============================================================
// LAUNCH ANIMATION — plays once per session when the app opens.
//   ring draws → six kid circles burst out and spin into place → check snaps
//   in → "Family HQ" rises
//   with a time-of-day greeting → everything lifts away to reveal the app.
// Tap anywhere to skip. Respects the phone's "reduce motion" setting.
// ============================================================
const SPLASH_SEEN_KEY = "fcc_splashSeen";
const SPLASH_HOLD_MS = 2100;   // when the exit starts
const SPLASH_EXIT_MS = 450;    // exit fade duration

export function shouldShowSplash() {
  try { return !sessionStorage.getItem(SPLASH_SEEN_KEY); } catch { return true; }
}

function greeting(date) {
  const h = date.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export function LaunchSplash({ onDone }) {
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(false);
  const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const leave = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    try { sessionStorage.setItem(SPLASH_SEEN_KEY, "1"); } catch { /* private mode */ }
    setLeaving(true);
    setTimeout(onDone, reduceMotion ? 200 : SPLASH_EXIT_MS);
  };

  useEffect(() => {
    const t = setTimeout(leave, reduceMotion ? 700 : SPLASH_HOLD_MS);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`hq-splash ${leaving ? "leaving" : ""} ${reduceMotion ? "reduced" : ""}`} onClick={leave} role="presentation">
      <style>{SPLASH_CSS}</style>
      <div className="hq-splash-glow" />
      <div className="hq-splash-inner">
        <LogoMark size={148} className="hq-logo-animate" />
        <div className="hq-splash-word">Family <span>HQ</span></div>
        <div className="hq-splash-greet">{greeting(new Date())} — let's get it done</div>
      </div>
    </div>
  );
}

const SPLASH_CSS = `
.hq-splash{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:radial-gradient(120% 90% at 50% 40%,#141d31 0%,#0b0f18 60%,#080b12 100%);cursor:pointer;transition:opacity ${SPLASH_EXIT_MS}ms ease,transform ${SPLASH_EXIT_MS}ms ease;-webkit-tap-highlight-color:transparent}
.hq-splash.leaving{opacity:0;pointer-events:none}
.hq-splash.leaving .hq-splash-inner{transform:translateY(-18px) scale(1.04);transition:transform ${SPLASH_EXIT_MS}ms cubic-bezier(.4,0,.2,1)}
.hq-splash-inner{display:flex;flex-direction:column;align-items:center;gap:14px;padding:24px}
.hq-splash-glow{position:absolute;width:340px;height:340px;border-radius:50%;background:radial-gradient(circle,rgba(99,102,241,.35) 0%,rgba(59,130,246,.12) 45%,transparent 70%);filter:blur(10px);opacity:0;animation:hqGlow 1.4s .75s ease-out forwards}
.hq-logo-animate{filter:drop-shadow(0 18px 40px rgba(0,0,0,.45));overflow:visible}
.hq-logo-animate .hq-tile{transform-box:fill-box;transform-origin:center;animation:hqTile .45s cubic-bezier(.2,.8,.2,1.2) both}
.hq-logo-animate .hq-ring{stroke-dasharray:1;stroke-dashoffset:1;animation:hqDraw .6s .15s cubic-bezier(.65,0,.35,1) forwards}
.hq-logo-animate .hq-dots{transform-box:view-box;transform-origin:256px 256px;animation:hqSpin .85s .25s cubic-bezier(.2,.9,.25,1) both}
.hq-logo-animate .hq-dot{transform-box:fill-box;transform-origin:center;opacity:0;transform:translate(var(--dx),var(--dy)) scale(.2);animation:hqBurst .55s cubic-bezier(.3,1.5,.5,1) forwards;animation-delay:calc(.25s + var(--i) * 65ms)}
.hq-logo-animate .hq-check{stroke-dasharray:1;stroke-dashoffset:1;animation:hqDraw .3s .8s cubic-bezier(.3,0,.2,1) forwards}
.hq-splash-word{font-family:'Fredoka','Nunito',system-ui,sans-serif;font-weight:700;font-size:2.4rem;letter-spacing:.01em;color:#f0f4f8;opacity:0;transform:translateY(12px);animation:hqRise .45s .95s cubic-bezier(.2,.8,.2,1) forwards}
.hq-splash-word span{background:linear-gradient(90deg,#3B82F6,#8B5CF6);-webkit-background-clip:text;background-clip:text;color:transparent}
.hq-splash-greet{font-family:'Nunito',system-ui,sans-serif;font-weight:700;font-size:1rem;color:#8899aa;opacity:0;transform:translateY(8px);animation:hqRise .45s 1.1s cubic-bezier(.2,.8,.2,1) forwards}
@keyframes hqDraw{to{stroke-dashoffset:0}}
@keyframes hqBurst{0%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(.2)}60%{opacity:1}100%{opacity:1;transform:translate(0,0) scale(1)}}
@keyframes hqSpin{from{transform:rotate(-120deg)}to{transform:rotate(0deg)}}
@keyframes hqTile{from{opacity:0;transform:scale(.82)}to{opacity:1;transform:scale(1)}}
@keyframes hqRise{to{opacity:1;transform:translateY(0)}}
@keyframes hqGlow{0%{opacity:0;transform:scale(.7)}40%{opacity:1}100%{opacity:.55;transform:scale(1.05)}}
.hq-splash.reduced *{animation:none!important;opacity:1!important;transform:none!important;stroke-dashoffset:0!important}
.hq-splash.reduced .hq-splash-glow{opacity:.5!important}
`;

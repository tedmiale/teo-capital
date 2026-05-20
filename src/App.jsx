import React, { useState, useEffect, createContext, useContext } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

const _fl = document.createElement("link");
_fl.rel = "stylesheet";
_fl.href = "https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=JetBrains+Mono:wght@400;500;700&display=swap";
document.head.appendChild(_fl);

const _st = document.createElement("style");
_st.textContent = [
  "* {box-sizing:border-box;margin:0;padding:0}",
  "html,body{background:var(--bg);transition:background .25s ease}",
  ":root[data-theme='dark']{--bg:#07070f;--scrollbar:#2a2a40}",
  ":root[data-theme='light']{--bg:#f7f8fa;--scrollbar:#cfd2d8}",
  "::-webkit-scrollbar{width:6px}",
  "::-webkit-scrollbar-thumb{background:var(--scrollbar);border-radius:3px}",
  "@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}",
  "@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}",
  "@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}",
  ".fu{animation:fadeUp .45s ease both}",
  ".pulse{animation:pulse 1.5s ease infinite}",
  ".shake{animation:shake .4s ease}",
  "input:focus{outline:none}",
].join(" ");
document.head.appendChild(_st);

const SEED = 5000;

// Two color palettes. Dark = original "digital terminal" vibe. Light = modern clean.
const THEMES = {
  dark: {
    bg:"#07070f", bg2:"#0d0d1a", bg3:"#111120", border:"#1e1e35",
    gold:"#c9a84c", gold2:"#f0c95e", green:"#00e5a0", red:"#ff4d6d",
    blue:"#4d8fff", orange:"#ff8844", purple:"#9d6fff",
    text:"#d4d4f0", muted:"#5a5a8a", dim:"#2a2a45", textdim:"#6060a0",
    bgScrim:"rgba(0,0,0,0.8)", chartGrid:"#1e1e35", benchLine:"#9d6fff",
  },
  light: {
    bg:"#f7f8fa", bg2:"#ffffff", bg3:"#f1f2f5", border:"#e3e5ea",
    gold:"#a16207", gold2:"#b45309", green:"#16a34a", red:"#dc2626",
    blue:"#2563eb", orange:"#ea580c", purple:"#7c3aed",
    text:"#111827", muted:"#6b7280", dim:"#cbd0d8", textdim:"#4b5563",
    bgScrim:"rgba(15,23,42,0.45)", chartGrid:"#e3e5ea", benchLine:"#7c3aed",
  },
};

const ThemeContext = createContext(THEMES.dark);
const useC = () => useContext(ThemeContext);

const F = "'JetBrains Mono',monospace";
const FS = "'Syne',sans-serif";
const fmt = n => "$" + Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtp = n => (n>=0?"+":"") + Number(n).toFixed(2) + "%";


// JSON Schemas for structured output via tool use.
// Permissive on nested objects (additionalProperties allowed) — only the fields
// the app actually reads are listed in `required`. Anything missing falls back to
// safe defaults in the call sites.
const DECISION_SCHEMA = {
  type: "object",
  properties: {
    fetched_prices: { type: "object", additionalProperties: { type: "number" } },
    macro: { type: "string" },
    priced_in: { type: "array", items: { type: "string" } },
    opportunities: { type: "array", items: { type: "string" } },
    earnings_nearby: { type: "array", items: { type: "object", additionalProperties: true } },
    themes: { type: "array", items: { type: "object", additionalProperties: true } },
    triggered_stops: { type: "array", items: { type: "object", additionalProperties: true } },
    transactions: { type: "array", items: { type: "object", additionalProperties: true } },
    holdings_after: { type: "array", items: { type: "object", additionalProperties: true } },
    stop_limits: { type: "array", items: { type: "object", additionalProperties: true } },
    cash_after: { type: "number" },
    cash_reserved: { type: "number" },
    reserve_reason: { type: "string" },
    thesis: { type: "string" },
    watching: { type: "array", items: { type: "string" } },
  },
  required: ["fetched_prices", "holdings_after", "cash_after"],
};

const GRADE_SCHEMA = {
  type: "object",
  properties: {
    grade: { type: "string" },
    score: { type: "number" },
    headline: { type: "string" },
    what_worked: { type: "array", items: { type: "string" } },
    what_failed: { type: "array", items: { type: "string" } },
    missed_opportunities: { type: "array", items: { type: "string" } },
    would_do_differently: { type: "array", items: { type: "string" } },
    benchmark: { type: "string" },
    lesson: { type: "string" },
  },
  required: ["grade", "score", "headline"],
};


// Strip anything that won't survive JSON.stringify (DOM nodes, functions,
// Window/Element instances). Real circular refs will throw — that's a bug to
// fix at the source, not silently mangle. We don't have any in our state shape.
//
// Earlier versions of this used a WeakSet to "detect circular references" but
// that incorrectly flagged any object referenced from two locations in the tree
// as circular, silently dropping legitimate fields. Removed.
function safeClone(obj) {
  const dropped = [];
  const replacer = function(key, value) {
    if (typeof window !== "undefined" && value === window) { dropped.push(key + " (Window)"); return undefined; }
    if (typeof Element !== "undefined" && value instanceof Element) { dropped.push(key + " (Element)"); return undefined; }
    if (typeof Node !== "undefined" && value instanceof Node) { dropped.push(key + " (Node)"); return undefined; }
    if (typeof Event !== "undefined" && value instanceof Event) { dropped.push(key + " (Event)"); return undefined; }
    if (typeof value === "function") { dropped.push(key + " (function)"); return undefined; }
    return value;
  };
  const str = JSON.stringify(obj, replacer);
  if (dropped.length) console.warn("safeClone dropped:", dropped);
  return JSON.parse(str);
}

async function callTeo(system, user, schema, operatorCode, timeoutMs = 240000) {
  const tools = [{ type: "web_search_20250305", name: "web_search" }];
  if (schema) {
    tools.push({
      name: "submit",
      description: "Submit your final structured answer. Call this exactly once at the end, after any web_search research is complete.",
      input_schema: schema,
    });
    system = system + "\n\nIMPORTANT: After any research with web_search, you MUST submit your final answer by calling the `submit` tool exactly once with all required fields. Do not write the JSON as plain text — use the tool.";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let data;
  try {
    const res = await fetch("/api/teo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-operator-code": operatorCode || "",
      },
      body: JSON.stringify(safeClone({
        model: "claude-sonnet-4-6",
        max_tokens: 8000,
        system,
        tools,
        messages: [{ role: "user", content: user }],
      })),
      signal: controller.signal,
    });
    if (res.status === 403) {
      throw new Error("Operator code rejected — not authorized to spend tokens.");
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error("API error " + res.status + (errBody ? ": " + errBody.slice(0, 200) : ""));
    }
    data = await res.json();
  } catch (e) {
    if (e.name === "AbortError") {
      const err = new Error("Request timed out after " + Math.round(timeoutMs/1000) + "s. The model or web search may be slow right now — wait a minute and try again.");
      err.timedOut = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (schema) {
    const submit = data.content.find(b => b.type === "tool_use" && b.name === "submit");
    if (submit && submit.input) return JSON.stringify(submit.input);
    const text = data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    if (text.trim()) return text;
    throw new Error("Model returned no usable response (stop_reason: " + (data.stop_reason || "unknown") + ")");
  }

  return data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

function parseJSON(raw) {
  const clean = raw.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{");
  const e = clean.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("No JSON found");
  let str = clean.slice(s, e + 1);

  // Attempt 1
  try { return JSON.parse(str); } catch(e1) {}

  // Attempt 2: fix common issues
  try {
    let fixed = str.replace(/,\s*([}\]])/g, "$1").replace(/\/\/.*/g, "");
    return JSON.parse(fixed);
  } catch(e2) {}

  // Attempt 3: extract required fields via regex
  try {
    const pm = str.match(/"fetched_prices"\s*:\s*(\{[^}]+\})/);
    const hm = str.match(/"holdings_after"\s*:\s*(\[[\s\S]*?\])\s*,\s*"/);
    const cm = str.match(/"cash_after"\s*:\s*([\d.]+)/);
    if (pm && hm && cm) {
      let obj = '{"fetched_prices":' + pm[1] + ',"holdings_after":' + hm[1] + ',"cash_after":' + cm[1];
      const tm = str.match(/"thesis"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (tm) obj += ',"thesis":"' + tm[1] + '"';
      const txm = str.match(/"transactions"\s*:\s*(\[[\s\S]*?\])\s*,\s*"/);
      if (txm) obj += ',"transactions":' + txm[1];
      const slm = str.match(/"stop_limits"\s*:\s*(\[[\s\S]*?\])\s*,\s*"/);
      if (slm) obj += ',"stop_limits":' + slm[1];
      obj += '}';
      return JSON.parse(obj.replace(/,\s*([}\]])/g, "$1"));
    }
  } catch(e3) {}

  throw new Error("Could not parse response — try again");
}


async function makeDecision(holdings, cash, snapNum, priorStops, operatorCode, config) {
  const seedAmt = (config && config.seed) || SEED;
  const weeks   = (config && config.weeks) || 4;
  const riskDir = (config && RISK_PRESETS[config.risk]) || RISK_PRESETS.Aggressive;
  const focusDirectives = (config && Array.isArray(config.focusIds) ? config.focusIds : [])
    .map(id => (FOCUS_CHIPS.find(c => c.id === id) || {}).directive)
    .filter(Boolean);
  const focusBlock = focusDirectives.length
    ? "\n\nSTRATEGY DIRECTIVES (operator-specified, all must be honored):\n- " + focusDirectives.join("\n- ")
    : "";

  const isFirst = holdings.length === 0 && cash >= seedAmt - 0.01;
  const now = new Date().toLocaleString("en-US", {
    weekday:"short", month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit"
  });
  const tickers = holdings.map(h => h.ticker);
  const desc = isFirst
    ? "Starting capital: $" + Number(cash || 0).toFixed(2) + " cash. No positions."
    : holdings.map(h => {
        const last = h.lastPrice != null ? h.lastPrice : h.boughtAt;
        const bought = h.boughtAt != null ? h.boughtAt : 0;
        return h.ticker + ": " + (h.shares || 0) + "sh @ $" + Number(bought).toFixed(2) + " last $" + Number(last).toFixed(2);
      }).join("\n") + "\nCash: $" + Number(cash || 0).toFixed(2);

  const system = "You are an elite AI portfolio manager. MAXIMIZE $" + seedAmt + " over " + weeks + " weeks. " + riskDir + " Max 6 positions. Schwab-compatible (stocks, ETFs, standard options).\n\nFRAMEWORK:\n- Assess if news is ALREADY PRICED IN or a GENUINE SURPRISE before acting\n- Size by conviction: HIGH=25-35%, MEDIUM=15-20%, SPECULATIVE=5-8% (adjust per the risk tolerance above)\n- Diversify by THEME not just ticker count\n- Check earnings calendar for held names (5 day lookahead)\n- Set stops 7-10% below entry, profit targets +12-25%\n- Trail stops on winners. Hold cash when uncertain.\n- If prior stop was crossed, treat as triggered." + focusBlock + "\n\nSearch real prices via web search. Read today's news.\n\nRESPOND WITH ONLY THIS JSON (no other text):\n{\"fetched_prices\":{\"TICKER\":123.45},\"macro\":\"market conditions sentence\",\"priced_in\":[\"things baked in\"],\"opportunities\":[\"genuine edges\"],\"earnings_nearby\":[{\"ticker\":\"X\",\"date\":\"May 5\",\"action\":\"HOLD\",\"why\":\"reason\"}],\"themes\":[{\"name\":\"AI\",\"tickers\":[\"NVDA\"],\"pct\":30}],\"triggered_stops\":[],\"transactions\":[{\"action\":\"BUY\",\"ticker\":\"X\",\"name\":\"Name\",\"instrument\":\"STOCK\",\"shares\":10,\"price\":100,\"strike\":null,\"expiry\":null,\"total_cost\":1000,\"size_pct\":20,\"conviction\":\"HIGH\",\"rr\":\"3:1\",\"edge\":\"not priced in yet\",\"reason\":\"one sentence\"}],\"holdings_after\":[{\"ticker\":\"X\",\"name\":\"Name\",\"instrument\":\"STOCK\",\"shares\":10,\"boughtAt\":100,\"lastPrice\":100,\"strike\":null,\"expiry\":null,\"theme\":\"AI\"}],\"stop_limits\":[{\"ticker\":\"X\",\"order\":\"STOP_LOSS\",\"shares\":10,\"stop_price\":90,\"limit_price\":89,\"notes\":\"protect\"}],\"cash_after\":0,\"cash_reserved\":0,\"reserve_reason\":\"\",\"thesis\":\"3 sentences\",\"watching\":[\"SPY\"]}\n\nCRITICAL: valid JSON only. holdings_after=ALL positions. fetched_prices=every held ticker.";

  const stopList = (priorStops || []).length
    ? priorStops.map(s => s.order + " " + s.ticker + ": stop $" + s.stop_price + " / limit $" + s.limit_price).join("\n")
    : "None";

  const user = isFirst
    ? "It's " + now + ". Deploy $" + Number(cash || 0).toFixed(2) + " into up to 6 positions. Search best opportunities. Set stops. Return JSON only."
    : "It's " + now + ". Portfolio:\n" + desc + "\n\nPrior stops:\n" + stopList + "\n\nSearch prices for: " + tickers.join(", ") + ". Check if stops crossed. Read news. Decide. Return JSON only.";

  let data = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callTeo(system, user, DECISION_SCHEMA, operatorCode);
      data = parseJSON(raw);
      if (data.holdings_after && data.fetched_prices) break;
      data = null;
      lastErr = new Error("Missing required fields");
    } catch(e) {
      lastErr = e;
      data = null;
      if (e.timedOut) break; // don't retry timeouts — would just hang again
      if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (!data || !data.holdings_after || !data.fetched_prices) throw lastErr || new Error("Failed after retries");

  const prevTickers = new Set(holdings.map(h => h.ticker));
  const prices = Object.assign({}, data.fetched_prices);
  (data.holdings_after || []).forEach(h => {
    if (!prevTickers.has(h.ticker)) prices[h.ticker] = h.boughtAt;
  });
  const totalValue = parseFloat(
    (data.holdings_after.reduce((sum, h) => {
      const p = prevTickers.has(h.ticker) ? (data.fetched_prices[h.ticker] || h.lastPrice || h.boughtAt) : h.boughtAt;
      return sum + h.shares * p;
    }, 0) + (data.cash_after || 0)).toFixed(2)
  );

  return { data, prices, totalValue };
}

async function runGrade(state, operatorCode) {
  const cfg = state.config || DEFAULT_CONFIG;
  const seedAmt = cfg.seed;
  const weeks = cfg.weeks;
  const hist = (state.snapshots || []).map((s, i) =>
    "#" + (i+1) + " (" + s.timestamp + "): $" + s.totalValue.toFixed(2) + " | " +
    (s.transactions.length ? s.transactions.map(t => t.action + " " + t.ticker).join(", ") : "hold") +
    " | " + s.thesis
  ).join("\n");
  const system = "Grade this " + weeks + "-week trading record. Be brutally honest. Respond ONLY with JSON: {\"grade\":\"A-F\",\"score\":0-100,\"headline\":\"verdict\",\"what_worked\":[\"...\"],\"what_failed\":[\"...\"],\"missed_opportunities\":[\"...\"],\"would_do_differently\":[\"...\"],\"benchmark\":\"vs SPY\",\"lesson\":\"takeaway\"}";
  const user = "Started $" + seedAmt + ". Now $" + state.totalValue.toFixed(2) + " (" + ((state.totalValue/seedAmt-1)*100).toFixed(2) + "%). " + (state.snapshots||[]).length + " decisions over " + weeks + "-week target.\n\n" + hist + "\n\nSearch market context. Grade honestly.";
  return parseJSON(await callTeo(system, user, GRADE_SCHEMA, operatorCode));
}


const ChartTip = ({ active, payload, seed, benchTicker }) => {
  const C = useC();
  if (!active || !payload || !payload.length) return null;
  const teoPt = payload.find(p => p.dataKey === "value");
  const benchPt = payload.find(p => p.dataKey === "bench");
  const baseline = seed || SEED;
  const teoV = teoPt ? teoPt.value : null;
  const benchV = benchPt ? benchPt.value : null;
  return (
    <div style={{background:C.bg2,border:"1px solid " + C.border,padding:"10px 12px",borderRadius:6,fontFamily:F,fontSize:11,minWidth:140}}>
      <div style={{color:C.muted,marginBottom:6,fontSize:10}}>{(payload[0] && payload[0].payload && payload[0].payload.label) || ""}</div>
      {teoV != null && (
        <div style={{display:"flex",justifyContent:"space-between",gap:14,marginBottom:benchV!=null?4:0}}>
          <span style={{color:C.muted}}>Teo</span>
          <span style={{color:teoV>=baseline?C.green:C.red,fontWeight:700}}>{fmt(teoV)} <span style={{color:C.muted,fontWeight:400}}>({((teoV/baseline-1)*100).toFixed(2)}%)</span></span>
        </div>
      )}
      {benchV != null && (
        <div style={{display:"flex",justifyContent:"space-between",gap:14}}>
          <span style={{color:C.muted}}>{benchTicker || "Bench"}</span>
          <span style={{color:benchV>=baseline?C.green:C.red,fontWeight:700}}>{fmt(benchV)} <span style={{color:C.muted,fontWeight:400}}>({((benchV/baseline-1)*100).toFixed(2)}%)</span></span>
        </div>
      )}
    </div>
  );
};

function TxRow({ tx }) {
  const C = useC();
  const isBuy = (tx.action || "").startsWith("BUY");
  const ac = isBuy ? C.green : C.red;
  const convColor = tx.conviction === "HIGH" ? C.green : tx.conviction === "MEDIUM" ? C.gold : C.muted;
  return (
    <div style={{padding:"10px 12px",marginBottom:3,borderRadius:6,background:ac + "12",borderLeft:"2px solid " + ac + "55",fontFamily:F}}>
      <div style={{display:"flex",flexWrap:"wrap",gap:8,alignItems:"center",marginBottom:4}}>
        <span style={{color:ac,fontWeight:700,fontSize:11,minWidth:50}}>{tx.action}</span>
        <span style={{color:C.text,fontWeight:700,fontSize:13}}>{tx.ticker}</span>
        <span style={{color:C.muted,fontSize:9}}>{tx.instrument}</span>
        <span style={{color:C.text,fontSize:11}}>{fmt(tx.price)}</span>
        <span style={{color:C.gold,fontSize:11,fontWeight:600}}>{fmt(tx.total_cost)}</span>
        <span style={{color:C.dim,fontSize:9,flex:1}}>{tx.reason}</span>
      </div>
      {(tx.conviction || tx.size_pct || tx.rr) && (
        <div style={{display:"flex",gap:10,fontSize:9,color:C.muted,paddingTop:4,borderTop:"1px dashed " + C.dim}}>
          {tx.conviction && <span>Conviction: <span style={{color:convColor,fontWeight:600}}>{tx.conviction}</span></span>}
          {tx.size_pct > 0 && <span>Size: <span style={{color:C.text}}>{tx.size_pct}%</span></span>}
          {tx.rr && <span>R/R: <span style={{color:C.green}}>{tx.rr}</span></span>}
        </div>
      )}
      {tx.edge && <div style={{fontSize:9,color:C.blue,marginTop:4,fontStyle:"italic"}}>{"\u21b3"} {tx.edge}</div>}
    </div>
  );
}

function StopRow({ s }) {
  const C = useC();
  const ac = s.order === "TAKE_PROFIT" ? C.green : C.orange;
  const label = s.order === "STOP_LOSS" ? "STOP LOSS" : s.order === "TAKE_PROFIT" ? "TAKE PROFIT" : "TRAILING";
  return (
    <div style={{display:"flex",flexWrap:"wrap",gap:8,padding:"9px 12px",marginBottom:3,borderRadius:6,background:C.bg2,borderLeft:"2px solid " + ac + "66",fontFamily:F,alignItems:"center"}}>
      <span style={{color:ac,fontWeight:700,fontSize:10,letterSpacing:1,minWidth:90}}>{label}</span>
      <span style={{color:C.text,fontWeight:700,fontSize:12,minWidth:50}}>{s.ticker}</span>
      <span style={{color:C.muted,fontSize:10,minWidth:60}}>SELL {s.shares}sh</span>
      <span style={{color:ac,fontSize:11}}>Stop ${Number(s.stop_price).toFixed(2)}</span>
      <span style={{color:C.text,fontSize:11}}>Limit ${Number(s.limit_price).toFixed(2)}</span>
      <span style={{color:C.dim,fontSize:9,flex:1}}>{s.notes}</span>
    </div>
  );
}

function TriggeredRow({ t }) {
  const C = useC();
  const isLoss = t.type === "STOP_LOSS";
  const ac = isLoss ? C.red : C.green;
  return (
    <div style={{display:"flex",flexWrap:"wrap",gap:8,padding:"9px 12px",marginBottom:3,borderRadius:6,background:ac + "15",borderLeft:"2px solid " + ac,fontFamily:F,alignItems:"center"}}>
      <span style={{fontSize:9,fontWeight:700,letterSpacing:1,color:ac}}>{isLoss ? "\u26a1 STOP HIT" : "\u2713 TARGET HIT"}</span>
      <span style={{color:C.text,fontWeight:700,fontSize:12}}>{t.ticker}</span>
      <span style={{fontSize:10,color:C.muted}}>@ ${Number(t.trigger_price).toFixed(2)}</span>
      <span style={{fontSize:10,color:C.dim,flex:1}}>{t.note}</span>
    </div>
  );
}

function HoldingRow({ h, price }) {
  const C = useC();
  const p = price || h.lastPrice || h.boughtAt;
  const mv = h.shares * p;
  const pnl = mv - h.shares * h.boughtAt;
  const pnlP = (pnl / (h.shares * h.boughtAt)) * 100;
  return (
    <div style={{display:"flex",flexWrap:"wrap",gap:8,padding:"11px 12px",marginBottom:3,borderRadius:6,background:C.bg3,borderLeft:"2px solid " + (pnl>=0 ? C.green + "44" : C.red + "44"),fontFamily:F,alignItems:"center"}}>
      <div style={{minWidth:65}}>
        <div style={{color:C.text,fontWeight:700,fontSize:13}}>{h.ticker}</div>
        {h.theme && <div style={{color:C.blue,fontSize:8}}>{h.theme}</div>}
      </div>
      <div style={{flex:1,minWidth:100}}>
        <div style={{color:C.muted,fontSize:9}}>{h.name}</div>
        <div style={{color:C.dim,fontSize:9}}>{h.shares}sh @ {fmt(h.boughtAt)}</div>
      </div>
      <span style={{color:C.textdim,fontSize:11,minWidth:70,textAlign:"right"}}>{fmt(p)}</span>
      <span style={{color:C.text,fontSize:12,fontWeight:600,minWidth:80,textAlign:"right"}}>{fmt(mv)}</span>
      <span style={{color:pnl>=0?C.green:C.red,fontSize:11,fontWeight:600,minWidth:60,textAlign:"right"}}>{fmtp(pnlP)}</span>
    </div>
  );
}


function GradeCard({ grade }) {
  const C = useC();
  const gc = ({A:C.green,B:"#88ff44",C:C.gold,D:C.orange,F:C.red})[grade.grade] || C.muted;
  return (
    <div style={{background:C.bg2,border:"1px solid " + gc + "33",borderRadius:12,padding:22,fontFamily:F}} className="fu">
      <div style={{display:"flex",alignItems:"center",gap:18,marginBottom:18,flexWrap:"wrap"}}>
        <div style={{width:70,height:70,borderRadius:"50%",background:"conic-gradient(" + gc + " " + (grade.score*3.6) + "deg, " + C.bg3 + " 0deg)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <div style={{width:56,height:56,borderRadius:"50%",background:C.bg2,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
            <div style={{fontSize:22,fontWeight:800,fontFamily:FS,color:gc}}>{grade.grade}</div>
            <div style={{fontSize:9,color:C.muted}}>{grade.score}/100</div>
          </div>
        </div>
        <div>
          <div style={{fontSize:16,fontWeight:700,fontFamily:FS,color:C.text,marginBottom:4}}>{grade.headline}</div>
          <div style={{fontSize:11,color:C.muted}}>{grade.benchmark}</div>
        </div>
      </div>
      {[
        ["what_worked", C.green, "\u2713 WHAT WORKED"],
        ["what_failed", C.red, "\u2717 WHAT FAILED"],
        ["missed_opportunities", C.gold, "\u25ce MISSED"],
        ["would_do_differently", C.blue, "\u21bb DO DIFFERENTLY"],
      ].map(function([key, color, title]) {
        return (
          <div key={key} style={{background:C.bg3,borderRadius:8,padding:"12px 14px",marginBottom:8,border:"1px solid " + color + "22"}}>
            <div style={{fontSize:9,letterSpacing:2,color:color,marginBottom:8}}>{title}</div>
            {(grade[key]||[]).map(function(w,i) {
              return <div key={i} style={{fontSize:10,color:C.text,marginBottom:5,lineHeight:1.5}}>{"\u2022"} {w}</div>;
            })}
          </div>
        );
      })}
      <div style={{background:gc + "11",border:"1px solid " + gc + "33",borderRadius:8,padding:"12px 14px"}}>
        <div style={{fontSize:9,letterSpacing:2,color:gc,marginBottom:6}}>{"\u2605"} KEY LESSON</div>
        <div style={{fontSize:11,color:C.text,lineHeight:1.7}}>{grade.lesson}</div>
      </div>
    </div>
  );
}


function OperatorLogin({ onSubmit, onCancel }) {
  const C = useC();
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [shk, setShk] = useState(false);

  const submit = function() {
    if (!code.trim()) { setErr("Enter the operator code"); setShk(true); setTimeout(function(){setShk(false);},400); return; }
    onSubmit(code.trim());
  };

  const inp = {background:C.bg3,border:"1px solid " + C.border,color:C.text,padding:"14px 16px",borderRadius:8,fontSize:15,letterSpacing:1,width:"100%",textAlign:"center"};

  return (
    <div style={{position:"fixed",inset:0,background:C.bgScrim,display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:20}}>
      <div className={shk ? "shake" : "fu"} style={{background:C.bg2,border:"1px solid " + C.gold + "55",borderRadius:14,padding:28,maxWidth:380,width:"100%",fontFamily:F}}>
        <div style={{textAlign:"center",marginBottom:20}}>
          <div style={{fontSize:28,marginBottom:8}}>{"\ud83d\udd11"}</div>
          <div style={{fontSize:17,fontWeight:700,fontFamily:FS,color:C.text,marginBottom:6}}>Operator Mode</div>
          <div style={{fontSize:11,color:C.muted,lineHeight:1.6}}>Enter the operator code to deploy capital and run checks. Visitors without the code can only view.</div>
        </div>
        <input type="password" value={code} onChange={function(e){setCode(e.target.value);}} placeholder="operator code" autoFocus
          onKeyDown={function(e){if(e.key==="Enter")submit();}} style={inp} />
        {err && <div style={{color:C.red,fontSize:11,marginTop:10,textAlign:"center"}}>{err}</div>}
        <div style={{display:"flex",gap:8,marginTop:18}}>
          <button onClick={onCancel} style={{flex:1,background:"transparent",color:C.muted,border:"1px solid " + C.border,padding:12,borderRadius:8,cursor:"pointer",fontSize:12,fontFamily:F}}>CANCEL</button>
          <button onClick={submit} style={{flex:2,background:"linear-gradient(135deg," + C.gold + "," + C.gold2 + ")",color:"#0a0800",border:"none",padding:12,borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:FS,letterSpacing:1}}>UNLOCK</button>
        </div>
      </div>
    </div>
  );
}


// Sprint configuration presets. Each maps a UI choice to a directive that gets
// woven into the model's system prompt.
const RISK_PRESETS = {
  Aggressive:    "HIGH risk tolerance. Position sizes can stretch to 35-40% on highest convictions. Smaller cash buffer OK. Take asymmetric bets when edge is real.",
  Moderate:      "MODERATE risk tolerance. Position sizes 15-30%. Standard diversification. Keep at least 5-10% cash reserve.",
  Conservative:  "CONSERVATIVE risk tolerance. Position sizes 10-20%. Keep 15-25% cash reserve. Prefer ETFs and large-caps over single-stock concentration.",
};

const FOCUS_CHIPS = [
  { id: "dividend",     label: "Dividend income", directive: "Prioritize dividend-paying stocks where conviction is otherwise equal; pay attention to ex-dividend dates." },
  { id: "options",      label: "Options active",  directive: "Use standard options strategies (calls, puts, vertical spreads) when conviction and risk-reward warrant; do not exceed 20% of capital in options at once." },
  { id: "tech",         label: "Tech focus",      directive: "Tilt the universe toward technology stocks and tech-heavy ETFs." },
  { id: "etf",          label: "ETFs only",       directive: "Limit positions to ETFs only — no individual stocks." },
  { id: "smallcap",     label: "Small-cap tilt",  directive: "Bias toward small-cap and micro-cap opportunities; accept higher volatility for higher upside." },
  { id: "international",label: "International",   directive: "Include international exposure via ADRs and country/region ETFs alongside US names." },
];

const BENCHMARK_OPTIONS = [
  { id: "VTI", label: "VTI", desc: "Total US market" },
  { id: "SPY", label: "SPY", desc: "S&P 500" },
  { id: "QQQ", label: "QQQ", desc: "Nasdaq 100" },
];

// Tickers we always track, regardless of which is the operator's primary pick.
// Allows the Track Record view to compare against all three indexes for every sprint.
const BENCHMARK_TICKERS = ["VTI", "SPY", "QQQ"];

// Read a snapshot's benchmark price for a given ticker, with legacy fallback for
// snapshots saved before multi-benchmark tracking existed.
function snapBenchPx(snap, ticker, configBenchmark) {
  if (snap && snap.benchmarkPrices && typeof snap.benchmarkPrices[ticker] === "number") {
    return snap.benchmarkPrices[ticker];
  }
  if (snap && typeof snap.benchmarkPrice === "number" && configBenchmark === ticker) {
    return snap.benchmarkPrice;
  }
  return null;
}

// Read a config's starting benchmark price for a given ticker, with legacy fallback.
function configBenchStart(config, ticker) {
  if (config && config.benchmarkStarts && typeof config.benchmarkStarts[ticker] === "number") {
    return config.benchmarkStarts[ticker];
  }
  if (config && typeof config.benchmarkStart === "number" && config.benchmark === ticker) {
    return config.benchmarkStart;
  }
  return null;
}

const DEFAULT_CONFIG = {
  sprintName: "4-Week Sprint",
  seed: 5000,
  weeks: 4,
  risk: "Aggressive",
  focusIds: [],
  benchmark: "VTI",
  benchmarkStart: null, // set on first deploy
};

const BLANK = {config:null,holdings:[],cash:0,totalValue:0,snapshots:[],history:[],grade:null};

function ConfigForm({ initial, onDeploy }) {
  const C = useC();
  const [name, setName] = useState((initial && initial.sprintName) || DEFAULT_CONFIG.sprintName);
  const [seed, setSeed] = useState((initial && initial.seed) || DEFAULT_CONFIG.seed);
  const [weeks, setWeeks] = useState((initial && initial.weeks) || DEFAULT_CONFIG.weeks);
  const [risk, setRisk] = useState((initial && initial.risk) || DEFAULT_CONFIG.risk);
  const [focusIds, setFocusIds] = useState((initial && initial.focusIds) || []);
  const [benchmark, setBenchmark] = useState((initial && initial.benchmark) || DEFAULT_CONFIG.benchmark);
  const [err, setErr] = useState("");

  const toggleChip = function(id) {
    setFocusIds(function(prev) {
      return prev.indexOf(id) >= 0 ? prev.filter(x => x !== id) : prev.concat([id]);
    });
  };

  const submit = function() {
    if (!name.trim()) { setErr("Sprint needs a name"); return; }
    const sd = Number(seed), wk = Number(weeks);
    if (!Number.isFinite(sd) || sd < 100) { setErr("Seed must be at least $100"); return; }
    if (!Number.isFinite(wk) || wk < 1 || wk > 52) { setErr("Duration must be 1-52 weeks"); return; }
    onDeploy({ sprintName: name.trim(), seed: sd, weeks: wk, risk: risk, focusIds: focusIds, benchmark: benchmark });
  };

  const lbl = {fontSize:10,letterSpacing:2,color:C.muted,marginBottom:6,textTransform:"uppercase"};
  const inp = {background:C.bg3,border:"1px solid " + C.border,color:C.text,padding:"10px 12px",borderRadius:6,fontSize:13,width:"100%",fontFamily:F};

  return (
    <div style={{background:C.bg2,border:"1px solid " + C.border,borderRadius:12,padding:"20px 22px",marginBottom:18,fontFamily:F}}>
      <div style={{fontSize:11,letterSpacing:3,color:C.gold,marginBottom:14,textAlign:"center"}}>{"\u25c8"} SPRINT CONFIG {"\u25c8"}</div>

      <div style={{marginBottom:14}}>
        <div style={lbl}>Sprint name</div>
        <input value={name} onChange={function(e){setName(e.target.value);}} style={inp} placeholder="e.g. May Aggressive Test" />
      </div>

      <div style={{display:"flex",gap:12,marginBottom:14,flexWrap:"wrap"}}>
        <div style={{flex:"1 1 140px"}}>
          <div style={lbl}>Starting capital ($)</div>
          <input type="number" value={seed} onChange={function(e){setSeed(e.target.value);}} style={inp} />
        </div>
        <div style={{flex:"1 1 100px"}}>
          <div style={lbl}>Duration (weeks)</div>
          <input type="number" min="1" max="52" value={weeks} onChange={function(e){setWeeks(e.target.value);}} style={inp} />
        </div>
      </div>

      <div style={{marginBottom:14}}>
        <div style={lbl}>Risk tolerance</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {Object.keys(RISK_PRESETS).map(function(r){
            const active = r === risk;
            return (
              <button key={r} onClick={function(){setRisk(r);}} style={{
                flex:"1 1 90px",background:active?"linear-gradient(135deg," + C.gold + "," + C.gold2 + ")":"transparent",
                color:active?"#0a0800":C.text,border:"1px solid " + (active?"transparent":C.border),
                padding:"9px 10px",borderRadius:6,cursor:"pointer",fontSize:11,fontFamily:F,fontWeight:active?700:400,letterSpacing:.5,
              }}>{r}</button>
            );
          })}
        </div>
      </div>

      <div style={{marginBottom:14}}>
        <div style={lbl}>Focus chips (multi-select, optional)</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {FOCUS_CHIPS.map(function(c){
            const active = focusIds.indexOf(c.id) >= 0;
            return (
              <button key={c.id} onClick={function(){toggleChip(c.id);}} style={{
                background:active?C.gold + "22":"transparent",
                color:active?C.gold:C.muted,border:"1px solid " + (active?C.gold + "66":C.border),
                padding:"7px 12px",borderRadius:14,cursor:"pointer",fontSize:11,fontFamily:F,
              }}>{active?"\u2713 ":""}{c.label}</button>
            );
          })}
        </div>
      </div>

      <div style={{marginBottom:14}}>
        <div style={lbl}>Benchmark (locked in at deploy)</div>
        <div style={{display:"flex",gap:6}}>
          {BENCHMARK_OPTIONS.map(function(b){
            const active = b.id === benchmark;
            return (
              <button key={b.id} onClick={function(){setBenchmark(b.id);}} style={{
                flex:1,background:active?"linear-gradient(135deg," + C.gold + "," + C.gold2 + ")":"transparent",
                color:active?"#0a0800":C.text,border:"1px solid " + (active?"transparent":C.border),
                padding:"9px 6px",borderRadius:6,cursor:"pointer",fontSize:11,fontFamily:F,fontWeight:active?700:400,
                display:"flex",flexDirection:"column",gap:2,
              }}>
                <span style={{letterSpacing:1}}>{b.label}</span>
                <span style={{fontSize:8,color:active?"#0a0800":C.muted,fontWeight:400}}>{b.desc}</span>
              </button>
            );
          })}
        </div>
      </div>

      {err && <div style={{color:C.red,fontSize:11,marginBottom:10,textAlign:"center"}}>{err}</div>}

      <button onClick={submit} style={{
        width:"100%",background:"linear-gradient(135deg," + C.gold + "," + C.gold2 + ")",color:"#0a0800",
        border:"none",padding:14,borderRadius:10,cursor:"pointer",fontSize:13,fontWeight:700,fontFamily:FS,letterSpacing:1.5,
      }}>{"\u25b6"}  DEPLOY ${Number(seed).toLocaleString()}</button>
    </div>
  );
}


// HistoryView — public track record showing all archived sprints and their performance
// vs all three benchmarks (VTI, SPY, QQQ). Operators get a "Clear all history" button at bottom.
function HistoryView({ archive, loading, isOperator, expandedIdx, setExpandedIdx, onClearRequest }) {
  const C = useC();

  const sprints = (archive && archive.sprints) || [];

  if (loading) {
    return (
      <div style={{textAlign:"center",padding:"40px 20px",color:C.muted,fontSize:12,fontFamily:F}}>
        Loading sprint history...
      </div>
    );
  }

  if (!sprints.length) {
    return (
      <div style={{textAlign:"center",padding:"40px 20px",fontFamily:F}}>
        <div style={{fontSize:32,marginBottom:14}}>{"\ud83d\udcd6"}</div>
        <div style={{fontSize:14,fontWeight:700,fontFamily:FS,color:C.text,marginBottom:8}}>No history yet</div>
        <div style={{fontSize:11,color:C.muted,lineHeight:1.8,maxWidth:340,margin:"0 auto"}}>
          When a sprint ends (via RESET), it'll be archived here with full performance vs each benchmark. Run a few sprints and Teo's track record starts to tell a story.
        </div>
      </div>
    );
  }

  // Compute summary stats across all sprints.
  const sprintReturns = sprints.map(function(sp) {
    const seed = (sp.config && sp.config.seed) || 5000;
    const teoReturn = ((sp.totalValue / seed) - 1) * 100;
    const benchReturns = {};
    BENCHMARK_TICKERS.forEach(function(t) {
      const start = configBenchStart(sp.config, t);
      const lastSnap = sp.snapshots && sp.snapshots.length ? sp.snapshots[sp.snapshots.length - 1] : null;
      const end = lastSnap ? snapBenchPx(lastSnap, t, sp.config && sp.config.benchmark) : null;
      if (start != null && end != null) {
        benchReturns[t] = ((end / start) - 1) * 100;
      } else {
        benchReturns[t] = null;
      }
    });
    return { sprint: sp, teoReturn: teoReturn, benchReturns: benchReturns };
  });

  const avgReturn = sprintReturns.reduce(function(s, r) { return s + r.teoReturn; }, 0) / sprintReturns.length;
  const winRates = {};
  BENCHMARK_TICKERS.forEach(function(t) {
    const eligible = sprintReturns.filter(function(r) { return r.benchReturns[t] != null; });
    const wins = eligible.filter(function(r) { return r.teoReturn > r.benchReturns[t]; }).length;
    winRates[t] = eligible.length ? { wins: wins, total: eligible.length, pct: (wins / eligible.length) * 100 } : null;
  });

  return (
    <div className="fu">
      {/* Summary strip */}
      <div style={{background:C.bg2,border:"1px solid " + C.border,borderRadius:10,padding:"14px 18px",marginBottom:14}}>
        <div style={{fontSize:9,letterSpacing:3,color:C.gold,marginBottom:10}}>{"\u25c8"} TRACK RECORD</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:18,marginBottom:6}}>
          <div>
            <div style={{fontSize:8,letterSpacing:2,color:C.muted,marginBottom:3}}>SPRINTS</div>
            <div style={{fontSize:20,fontWeight:700,fontFamily:FS,color:C.text}}>{sprints.length}</div>
          </div>
          <div>
            <div style={{fontSize:8,letterSpacing:2,color:C.muted,marginBottom:3}}>AVG RETURN</div>
            <div style={{fontSize:20,fontWeight:700,fontFamily:FS,color:avgReturn>=0?C.green:C.red}}>{(avgReturn>=0?"+":"") + avgReturn.toFixed(2) + "%"}</div>
          </div>
          {BENCHMARK_TICKERS.map(function(t) {
            const wr = winRates[t];
            return (
              <div key={t}>
                <div style={{fontSize:8,letterSpacing:2,color:C.muted,marginBottom:3}}>vs {t}</div>
                {wr ? (
                  <div style={{fontSize:14,fontWeight:700,fontFamily:FS,color:wr.pct>=50?C.green:C.red}}>
                    {wr.wins}/{wr.total} <span style={{fontSize:10,color:C.muted,fontWeight:400}}>({wr.pct.toFixed(0)}%)</span>
                  </div>
                ) : (
                  <div style={{fontSize:14,color:C.dim,fontStyle:"italic"}}>—</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Per-sprint cards */}
      {sprintReturns.slice().reverse().map(function(r, revIdx) {
        const i = sprintReturns.length - 1 - revIdx; // original index in sprintReturns
        const sp = r.sprint;
        const cfg = sp.config || {};
        const expanded = expandedIdx === i;
        const seed = cfg.seed || 5000;
        const startDate = sp.snapshots && sp.snapshots.length ? sp.snapshots[0].timestamp : "";
        const endDate = sp.archivedAt ? new Date(sp.archivedAt).toLocaleDateString() : "";
        const numDecisions = (sp.snapshots && sp.snapshots.length) || 0;

        return (
          <div key={i} style={{background:C.bg2,border:"1px solid " + (r.teoReturn>=0?C.green+"33":C.red+"33"),borderRadius:10,padding:"14px 18px",marginBottom:10}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,flexWrap:"wrap",cursor:"pointer"}} onClick={function(){ setExpandedIdx(expanded ? null : i); }}>
              <div style={{flex:"1 1 200px"}}>
                <div style={{fontSize:13,fontWeight:700,fontFamily:FS,color:C.text,marginBottom:2}}>{cfg.sprintName || "Untitled Sprint"}</div>
                <div style={{fontSize:9,color:C.muted,letterSpacing:.5}}>
                  ${Number(seed).toLocaleString()} {"\u00b7"} {cfg.weeks || "?"}wk {"\u00b7"} {cfg.risk || "—"} {"\u00b7"} {numDecisions} decision{numDecisions===1?"":"s"}
                </div>
                {endDate && <div style={{fontSize:9,color:C.dim,marginTop:2}}>ended {endDate}</div>}
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:18,fontWeight:700,fontFamily:FS,color:r.teoReturn>=0?C.green:C.red,lineHeight:1}}>
                  {(r.teoReturn>=0?"+":"") + r.teoReturn.toFixed(2) + "%"}
                </div>
                <div style={{fontSize:9,color:C.muted,marginTop:3}}>{fmt(sp.totalValue)}</div>
              </div>
            </div>

            {/* Benchmark comparison row */}
            <div style={{display:"flex",gap:6,marginTop:10,flexWrap:"wrap"}}>
              {BENCHMARK_TICKERS.map(function(t) {
                const br = r.benchReturns[t];
                const teoBeatBench = br != null && r.teoReturn > br;
                return (
                  <div key={t} style={{flex:"1 1 90px",background:C.bg3,border:"1px solid " + C.border,borderRadius:6,padding:"6px 10px"}}>
                    <div style={{fontSize:8,letterSpacing:1,color:C.muted}}>{t}</div>
                    {br != null ? (
                      <div style={{fontSize:11,fontWeight:700,fontFamily:FS,color:teoBeatBench?C.green:C.red}}>
                        {(br>=0?"+":"") + br.toFixed(2) + "%"} <span style={{fontSize:9,fontWeight:400,color:C.muted}}>{teoBeatBench?"\u2713":"\u2717"}</span>
                      </div>
                    ) : (
                      <div style={{fontSize:11,color:C.dim,fontStyle:"italic"}}>not tracked</div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Expanded detail */}
            {expanded && (
              <div style={{marginTop:14,paddingTop:14,borderTop:"1px solid " + C.border}}>
                {sp.snapshots && sp.snapshots.length > 1 && (
                  <div style={{marginBottom:14}}>
                    <ResponsiveContainer width="100%" height={120}>
                      <LineChart data={(function() {
                        const benchStart = cfg.benchmark ? configBenchStart(cfg, cfg.benchmark) : null;
                        return [{ label: "Start", value: seed, bench: benchStart ? seed : null }].concat(
                          sp.snapshots.map(function(s) {
                            const benchPx = cfg.benchmark ? snapBenchPx(s, cfg.benchmark, cfg.benchmark) : null;
                            return {
                              label: s.timestamp,
                              value: s.totalValue,
                              bench: (benchStart && benchPx) ? seed * (benchPx / benchStart) : null,
                            };
                          })
                        );
                      })()}>
                        <XAxis dataKey="label" tick={{fill:C.muted,fontSize:8}} axisLine={false} tickLine={false} />
                        <YAxis domain={["auto","auto"]} tick={{fill:C.muted,fontSize:8}} axisLine={false} tickLine={false} width={56} tickFormatter={function(v){return "$"+Math.round(v);}} />
                        <Tooltip content={function(props){ return <ChartTip {...props} seed={seed} benchTicker={cfg.benchmark} />; }} />
                        <ReferenceLine y={seed} stroke={C.dim} strokeDasharray="3 3" />
                        <Line type="monotone" dataKey="bench" stroke={C.benchLine} strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
                        <Line type="monotone" dataKey="value" stroke={r.teoReturn>=0?C.green:C.red} strokeWidth={2} dot={{r:2,fill:r.teoReturn>=0?C.green:C.red}} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
                {sp.grade && (
                  <div style={{marginBottom:10}}>
                    <GradeCard grade={sp.grade} />
                  </div>
                )}
                {(!sp.grade) && (
                  <div style={{fontSize:10,color:C.dim,fontStyle:"italic",textAlign:"center"}}>No grade was run for this sprint.</div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Clear all history (operator only) */}
      {isOperator && sprints.length > 0 && (
        <div style={{marginTop:20,paddingTop:16,borderTop:"1px solid " + C.border,textAlign:"center"}}>
          <button onClick={onClearRequest} style={{background:"transparent",color:C.red,border:"1px solid " + C.red + "55",padding:"8px 16px",borderRadius:6,cursor:"pointer",fontSize:10,fontFamily:F,letterSpacing:1}}>
            {"\u26a0"} CLEAR ALL HISTORY
          </button>
        </div>
      )}
    </div>
  );
}


// Modal asking the operator to type "WIPE" to confirm clearing all sprint history.
function WipeConfirm({ onConfirm, onCancel }) {
  const C = useC();
  const [text, setText] = useState("");
  const inp = {background:C.bg3,border:"1px solid " + C.border,color:C.text,padding:"10px 14px",borderRadius:6,fontSize:13,width:"100%",textAlign:"center",letterSpacing:2,fontFamily:F};
  return (
    <div style={{position:"fixed",inset:0,background:C.bgScrim,display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:20}}>
      <div style={{background:C.bg2,border:"1px solid " + C.red + "55",borderRadius:14,padding:24,maxWidth:380,width:"100%",fontFamily:F}}>
        <div style={{textAlign:"center",marginBottom:18}}>
          <div style={{fontSize:28,marginBottom:8}}>{"\u26a0"}</div>
          <div style={{fontSize:15,fontWeight:700,fontFamily:FS,color:C.text,marginBottom:8}}>Clear all sprint history?</div>
          <div style={{fontSize:11,color:C.muted,lineHeight:1.7}}>This wipes every archived sprint permanently. The active sprint is not affected. Cannot be undone.</div>
        </div>
        <input type="text" value={text} onChange={function(e){setText(e.target.value);}} placeholder="type WIPE to confirm" autoFocus style={inp} />
        <div style={{display:"flex",gap:8,marginTop:14}}>
          <button onClick={onCancel} style={{flex:1,background:"transparent",color:C.muted,border:"1px solid " + C.border,padding:11,borderRadius:6,cursor:"pointer",fontSize:11,fontFamily:F}}>CANCEL</button>
          <button onClick={function(){ if(text==="WIPE") onConfirm(); }} disabled={text!=="WIPE"} style={{flex:1,background:text==="WIPE"?C.red:"transparent",color:text==="WIPE"?"#fff":C.dim,border:"1px solid " + (text==="WIPE"?C.red:C.border),padding:11,borderRadius:6,cursor:text==="WIPE"?"pointer":"not-allowed",fontSize:11,fontWeight:700,fontFamily:F,letterSpacing:1}}>WIPE</button>
        </div>
      </div>
    </div>
  );
}


// React Error Boundary — catches errors during rendering, mounting, or in lifecycle methods,
// and shows them on screen instead of unmounting to a blank page.
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null, info: null }; }
  static getDerivedStateFromError(err) { return { err: err }; }
  componentDidCatch(err, info) { this.setState({ err: err, info: info }); console.error("Teo render error:", err, info); }
  render() {
    if (this.state.err) {
      const stack = (this.state.info && this.state.info.componentStack) || "";
      return (
        <div style={{minHeight:"100vh",background:"#0a0a14",color:"#ff4d6d",fontFamily:"'JetBrains Mono',monospace",padding:24,overflow:"auto"}}>
          <div style={{maxWidth:780,margin:"0 auto"}}>
            <div style={{fontSize:14,fontWeight:700,letterSpacing:2,color:"#ff4d6d",marginBottom:12}}>{"\u26a0"} RENDER ERROR</div>
            <div style={{fontSize:12,color:"#d4d4f0",marginBottom:18,lineHeight:1.6}}>Something in the dashboard crashed while rendering. Details below. The good news: this is now visible instead of a blank screen.</div>
            <div style={{background:"#150808",border:"1px solid #ff4d6d33",borderRadius:8,padding:"14px 18px",marginBottom:12}}>
              <div style={{fontSize:11,color:"#ff4d6d",fontWeight:700,marginBottom:6}}>Message</div>
              <div style={{fontSize:12,color:"#d4d4f0",wordBreak:"break-word"}}>{String(this.state.err && this.state.err.message || this.state.err)}</div>
            </div>
            {stack && (
              <div style={{background:"#0d0d1a",border:"1px solid #1e1e35",borderRadius:8,padding:"14px 18px",marginBottom:12}}>
                <div style={{fontSize:11,color:"#5a5a8a",fontWeight:700,marginBottom:6}}>Where</div>
                <pre style={{fontSize:10,color:"#9da5b4",whiteSpace:"pre-wrap",margin:0}}>{stack}</pre>
              </div>
            )}
            <button onClick={() => window.location.reload()} style={{background:"#c9a84c",color:"#0a0800",border:"none",padding:"10px 20px",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>RELOAD</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}


export default function AppWithBoundary() {
  return <ErrorBoundary><App /></ErrorBoundary>;
}


function App() {
  const [theme, setTheme] = useState("dark");
  const C = THEMES[theme];
  const [state, setState] = useState(null);
  const [tab, setTab] = useState("latest");
  const [snapIdx, setSnapIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState(null);
  const [operatorCode, setOperatorCode] = useState(null);
  const [showOpLogin, setShowOpLogin] = useState(false);
  const [livePrices, setLivePrices] = useState({});
  const [lastRefresh, setLastRefresh] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [, refreshTick] = useState(0); // forces re-render so "X seconds ago" updates
  const [archive, setArchive] = useState({ sprints: [] });
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [expandedSprintIdx, setExpandedSprintIdx] = useState(null);
  const [showWipeConfirm, setShowWipeConfirm] = useState(false);
  const [archiving, setArchiving] = useState(false);

  // Restore theme choice from device on mount.
  useEffect(function() {
    try {
      const saved = localStorage.getItem("teo_theme");
      if (saved === "light" || saved === "dark") setTheme(saved);
    } catch(e) {}
  }, []);

  // Reflect theme on the root element so global CSS variables can switch.
  useEffect(function() {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", theme);
    }
    try { localStorage.setItem("teo_theme", theme); } catch(e) {}
  }, [theme]);

  const toggleTheme = function() { setTheme(t => t === "dark" ? "light" : "dark"); };

  // On mount: fetch shared state + archive from server, and try to restore operator code from this device.
  useEffect(function() {
    (async function() {
      try {
        const r = await fetch("/api/state");
        if (r.ok) {
          const body = await r.json();
          setState(body && body.state ? body.state : BLANK);
        } else {
          setState(BLANK);
        }
      } catch(e) { setState(BLANK); }
      // Archive loads in parallel — failure here doesn't block the dashboard.
      loadArchive();
      try {
        const saved = localStorage.getItem("teo_op_code");
        if (saved) setOperatorCode(saved);
      } catch(e) {}
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refetch archive from server. Safe to call anytime.
  const loadArchive = async function() {
    setArchiveLoading(true);
    try {
      const r = await fetch("/api/archive");
      if (r.ok) {
        const body = await r.json();
        setArchive(body && Array.isArray(body.sprints) ? body : { sprints: [] });
      }
    } catch(e) { /* silent */ }
    setArchiveLoading(false);
  };

  useEffect(function() {
    if (state && state.snapshots && state.snapshots.length) setSnapIdx(state.snapshots.length - 1);
  }, [state && state.snapshots && state.snapshots.length]);

  // Persist state to server. Requires operator code.
  // Throws on failure. Callers must handle the throw — don't update local state if save fails.
  const save = async function(next) {
    const clean = safeClone(next);
    const r = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-operator-code": operatorCode || "" },
      body: JSON.stringify({ state: clean }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error("Save failed: " + r.status + (t ? " " + t.slice(0,200) : ""));
    }
  };

  const handleOpSubmit = function(code) {
    setOperatorCode(code);
    try { localStorage.setItem("teo_op_code", code); } catch(e) {}
    setShowOpLogin(false);
  };

  const handleOpLogout = function() {
    setOperatorCode(null);
    try { localStorage.removeItem("teo_op_code"); } catch(e) {}
  };

  const isOperator = !!operatorCode;

  // Fetch live prices for current holdings AND all three benchmarks always.
  // Free, no Anthropic, no tokens.
  const refreshPrices = async function() {
    if (!state) return;
    if (refreshing) return;
    const heldTickers = (state.holdings || []).map(h => h.ticker).filter(Boolean);
    const allTickers = Array.from(new Set(heldTickers.concat(BENCHMARK_TICKERS)));
    if (!allTickers.length) return;
    setRefreshing(true);
    try {
      const r = await fetch("/api/prices?tickers=" + encodeURIComponent(allTickers.join(",")));
      if (r.ok) {
        const body = await r.json();
        if (body && body.prices) {
          setLivePrices(prev => Object.assign({}, prev, body.prices));
          setLastRefresh(new Date());
        }
      }
    } catch(e) { /* silent — price refresh shouldn't show errors */ }
    setRefreshing(false);
  };

  // Auto-refresh prices every 60s. Benchmarks are always fetched so this runs
  // whenever we have a loaded state, regardless of whether the operator has deployed yet.
  useEffect(function() {
    if (!state) return;
    refreshPrices();
    const id = setInterval(function() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        refreshPrices();
      }
    }, 60000);
    return function() { clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state && state.holdings && state.holdings.map(h => h.ticker).join(","),
  ]);

  // Tick every 15s so the "Xs ago" label stays fresh between refreshes.
  useEffect(function() {
    const id = setInterval(function() { refreshTick(x => x + 1); }, 15000);
    return function() { clearInterval(id); };
  }, []);

  // Fetch current price for a single ticker. Used as a one-shot helper.
  const fetchOnePrice = async function(ticker) {
    if (!ticker) return null;
    try {
      const r = await fetch("/api/prices?tickers=" + encodeURIComponent(ticker));
      if (!r.ok) return null;
      const body = await r.json();
      const px = body && body.prices && body.prices[ticker];
      return typeof px === "number" ? px : null;
    } catch(e) { return null; }
  };

  // Fetch current prices for all three benchmarks in one batched call. Returns
  // a map { VTI: x, SPY: y, QQQ: z } with any failed fetches simply omitted.
  const fetchAllBenchmarks = async function() {
    try {
      const r = await fetch("/api/prices?tickers=" + BENCHMARK_TICKERS.join(","));
      if (!r.ok) return {};
      const body = await r.json();
      return (body && body.prices) || {};
    } catch(e) { return {}; }
  };

  // For the first deploy, doDecision is called with a config object — that config
  // is what was just selected on the ConfigForm. For subsequent CHECK & DECIDE calls,
  // config is omitted and we use whatever was baked into state on the first deploy.
  const doDecision = async function(deployConfig) {
    if (busy) return; setBusy(true); setError(null);

    let baseState = state;
    if (deployConfig) {
      baseState = Object.assign({}, BLANK, {
        config: deployConfig,
        cash: deployConfig.seed,
        totalValue: deployConfig.seed,
        history: [{ label: "Start", value: deployConfig.seed }],
      });
    }
    let effectiveConfig = (baseState && baseState.config) || deployConfig || DEFAULT_CONFIG;

    // Capture benchmark prices (all three) for this snapshot. On first deploy,
    // also lock in the starting prices so the Track Record has a baseline for each.
    const benchPrices = await fetchAllBenchmarks();
    const primaryTicker = effectiveConfig.benchmark;
    const benchPxNow = primaryTicker && typeof benchPrices[primaryTicker] === "number"
      ? benchPrices[primaryTicker]
      : null;
    if (deployConfig) {
      const starts = {};
      BENCHMARK_TICKERS.forEach(function(t) {
        if (typeof benchPrices[t] === "number") starts[t] = benchPrices[t];
      });
      effectiveConfig = Object.assign({}, effectiveConfig, {
        benchmarkStart: benchPxNow, // legacy field, kept for backward compat
        benchmarkStarts: starts,    // new shape
      });
      baseState = Object.assign({}, baseState, { config: effectiveConfig });
    }

    try {
      const priorStops = baseState.snapshots && baseState.snapshots.length ? baseState.snapshots[baseState.snapshots.length-1].stopLimits || [] : [];
      const res = await makeDecision(baseState.holdings, baseState.cash, baseState.snapshots.length, priorStops, operatorCode, effectiveConfig);
      var d = res.data;
      var macro = d.macro || "";
      var snap = {
        index: baseState.snapshots.length,
        timestamp: new Date().toLocaleString(),
        macro: macro,
        benchmarkPrice: benchPxNow,          // legacy primary
        benchmarkPrices: benchPrices,         // new shape — all three
        pricedIn: d.priced_in || [],
        opportunities: d.opportunities || [],
        earningsNearby: d.earnings_nearby || [],
        themes: d.themes || [],
        triggeredStops: d.triggered_stops || [],
        transactions: d.transactions || [],
        stopLimits: d.stop_limits || [],
        thesis: d.thesis || "",
        watching: d.watching || [],
        cashReserved: d.cash_reserved || 0,
        reserveReason: d.reserve_reason || "",
        fetchedPrices: res.prices,
        holdingsAfter: d.holdings_after || [],
        cashAfter: d.cash_after || 0,
        totalValue: res.totalValue,
        prevValue: baseState.totalValue,
      };
      var next = Object.assign({}, baseState, {
        config: effectiveConfig, // explicit — don't rely on Object.assign inheritance
        holdings: d.holdings_after || [],
        cash: d.cash_after || 0,
        totalValue: res.totalValue,
        snapshots: baseState.snapshots.concat([snap]),
        history: baseState.history.concat([{
          label: new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"}),
          value: res.totalValue,
        }]),
      });
      await save(next); setState(next); setTab("latest");
    } catch(e) { setError(e.message); }
    setBusy(false);
  };

  const doGrade = async function() {
    if (grading || !state.snapshots.length) return; setGrading(true); setError(null);
    try {
      var g = await runGrade(state, operatorCode);
      var next = Object.assign({}, state, {grade:g});
      await save(next); setState(next); setTab("grade");
    } catch(e) { setError(e.message); }
    setGrading(false);
  };

  // RESET = archive current sprint + clear active state. Server does both atomically.
  // On success, refetch archive (so the new entry appears in Track Record immediately)
  // and reset local state to BLANK so the splash shows.
  const doReset = async function() {
    if (!isOperator) return;
    if (archiving) return;
    setArchiving(true);
    setError(null);
    try {
      const r = await fetch("/api/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-operator-code": operatorCode || "" },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error("Archive failed: " + r.status + (t ? " " + t.slice(0,200) : ""));
      }
      await loadArchive();
      setState(BLANK);
      setTab("latest");
      setSnapIdx(0);
      setLivePrices({});
    } catch(e) {
      setError(e.message);
    }
    setArchiving(false);
  };

  // Nuclear — wipe the entire sprint history. Requires explicit WIPE confirmation.
  const doClearArchive = async function() {
    if (!isOperator) return;
    setError(null);
    try {
      const r = await fetch("/api/clear-archive", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-operator-code": operatorCode || "" },
        body: JSON.stringify({ confirm: "WIPE" }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error("Clear archive failed: " + r.status + (t ? " " + t.slice(0,200) : ""));
      }
      setArchive({ sprints: [] });
      setShowWipeConfirm(false);
      setExpandedSprintIdx(null);
    } catch(e) {
      setError(e.message);
    }
  };

  if (loading || !state) return (
    <ThemeContext.Provider value={C}>
      <div style={{background:C.bg,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{color:C.gold,fontFamily:F,fontSize:12,letterSpacing:3}} className="pulse">LOADING...</div>
      </div>
    </ThemeContext.Provider>
  );

  var cfg = Object.assign({}, DEFAULT_CONFIG, state.config || {});
  var seedAmt = Number.isFinite(cfg.seed) ? cfg.seed : DEFAULT_CONFIG.seed;
  var sprintName = cfg.sprintName || (cfg.weeks + "-Week Sprint");
  var latest = state.snapshots.length ? state.snapshots[state.snapshots.length-1] : null;
  var viewSnap = state.snapshots[snapIdx] || null;
  var latestPrices = latest ? (latest.fetchedPrices || {}) : {};

  // Effective price for a holding: live > last decision > stored last > entry.
  var effectivePrice = function(h) {
    return livePrices[h.ticker] != null ? livePrices[h.ticker]
      : latestPrices[h.ticker] != null ? latestPrices[h.ticker]
      : h.lastPrice != null ? h.lastPrice
      : h.boughtAt;
  };

  // Live portfolio total = sum(shares × effective price) + cash. Falls back to stored.
  var haveAnyLive = state.holdings.some(function(h){ return livePrices[h.ticker] != null; });
  var liveTotal = haveAnyLive
    ? (state.holdings.reduce(function(s, h){ return s + h.shares * effectivePrice(h); }, 0) + state.cash)
    : state.totalValue;
  var totalReturn = ((liveTotal / seedAmt - 1) * 100);
  var isUp = totalReturn >= 0;
  var isFirst = !state.snapshots.length;
  var opEl = showOpLogin ? <OperatorLogin onSubmit={handleOpSubmit} onCancel={function(){setShowOpLogin(false);}} /> : null;
  var wipeEl = showWipeConfirm ? <WipeConfirm onConfirm={doClearArchive} onCancel={function(){setShowWipeConfirm(false);}} /> : null;

  // ── Benchmark comparison ────────────────────────────────────────────────
  // Compute the benchmark's live value (normalized so it starts at seedAmt) and
  // its return %. Also build chartData with both Teo and benchmark series.
  var benchTicker = cfg.benchmark;
  var benchStart = cfg.benchmarkStart;
  var benchLivePx = benchTicker ? livePrices[benchTicker] : null;
  var benchLiveValue = null;
  var benchReturn = null;
  if (benchStart && benchLivePx != null) {
    benchLiveValue = seedAmt * (benchLivePx / benchStart);
    benchReturn = (benchLivePx / benchStart - 1) * 100;
  }
  var edgeReturn = (benchReturn != null) ? totalReturn - benchReturn : null;

  // Chart data: combine Teo's history with benchmark values at each snapshot.
  // First point is always "Start" — both lines start at seedAmt.
  var chartData = [];
  if (state.history && state.history.length) {
    var snapsByIdx = state.snapshots || [];
    chartData = state.history.map(function(point, i) {
      var row = { label: point.label, value: point.value };
      if (i === 0 && benchStart) {
        row.bench = seedAmt;
      } else if (benchStart && snapsByIdx[i-1] && typeof snapsByIdx[i-1].benchmarkPrice === "number") {
        row.bench = seedAmt * (snapsByIdx[i-1].benchmarkPrice / benchStart);
      }
      return row;
    });
    // Append a "live" point at the end so the lines update in real-time on the chart.
    if (benchLiveValue != null && haveAnyLive) {
      chartData.push({ label: "now", value: liveTotal, bench: benchLiveValue });
    }
  }

  // "Last refreshed Xs ago" helper.
  var refreshLabel = "";
  if (lastRefresh) {
    var secs = Math.max(0, Math.floor((Date.now() - lastRefresh.getTime()) / 1000));
    refreshLabel = secs < 60 ? (secs + "s ago") : (Math.floor(secs/60) + "m ago");
  }

  /* ── SPLASH ── */
  if (isFirst && !busy) return (
    <ThemeContext.Provider value={C}>
      <div>
        {opEl}
        {wipeEl}
        <div style={{position:"fixed",top:14,right:14,zIndex:50}}>
          <button onClick={toggleTheme} style={{background:C.bg2,color:C.text,border:"1px solid " + C.border,borderRadius:20,padding:"6px 12px",cursor:"pointer",fontSize:11,fontFamily:F}}>{theme==="dark"?"\u263c light":"\u263e dark"}</button>
        </div>
        <div style={{background:C.bg,minHeight:"100vh",padding:"24px 16px 60px",fontFamily:F}}>
          <div style={{maxWidth:archive.sprints.length>0?700:480,width:"100%",margin:"0 auto"}} className="fu">
            <div style={{textAlign:"center",marginBottom:28}}>
              <div style={{fontSize:10,letterSpacing:5,color:C.gold,marginBottom:10}}>{"\u25c8"} TEO CAPITAL {"\u25c8"}</div>
              <div style={{fontSize:34,fontWeight:800,fontFamily:FS,color:C.text,lineHeight:1.1,marginBottom:10}}>{archive.sprints.length>0 ? "Between Sprints" : "New Sprint"}</div>
              <div style={{fontSize:12,color:C.textdim,lineHeight:1.9,marginTop:8}}>Elite AI trader. Real prices. Risk-managed framework.</div>
            </div>
            {!isOperator && archive.sprints.length === 0 && (
              <div style={{background:C.bg2,border:"1px solid " + C.border,borderRadius:12,padding:"18px 20px",marginBottom:22}}>
                {[
                  "Position sizing by conviction & risk-reward",
                  "Correlation-aware diversification",
                  "Earnings calendar awareness",
                  "Priced-in vs genuine opportunity analysis",
                  "Stop-limit orders on every position",
                  "Cash reserves when uncertain",
                ].map(function(t, i) {
                  return <div key={i} style={{display:"flex",gap:10,marginBottom:i<5?8:0,alignItems:"flex-start"}}>
                    <span style={{color:C.gold,fontSize:10,flexShrink:0}}>{"\u25c8"}</span>
                    <span style={{fontSize:11,color:C.text,lineHeight:1.6}}>{t}</span>
                  </div>;
                })}
              </div>
            )}
            {isOperator ? (
              <ConfigForm onDeploy={function(cfg){ doDecision(cfg); }} />
            ) : (
              <div style={{background:C.bg2,border:"1px dashed " + C.border,borderRadius:10,padding:"18px 20px",textAlign:"center",marginBottom:archive.sprints.length>0?22:0}}>
                <div style={{fontSize:11,color:C.textdim,lineHeight:1.8,marginBottom:14}}>{archive.sprints.length>0 ? "No active sprint right now. Past sprints are shown below." : "Teo hasn't deployed capital yet. Only the operator can start a sprint."}</div>
                <button onClick={function(){setShowOpLogin(true);}} style={{background:"transparent",color:C.gold,border:"1px solid " + C.gold + "55",padding:"10px 20px",borderRadius:8,cursor:"pointer",fontSize:11,fontFamily:F,letterSpacing:1}}>{"\ud83d\udd11"} OPERATOR LOGIN</button>
              </div>
            )}
            {error && <div style={{marginTop:10,padding:10,background:C.red+"15",border:"1px solid " + C.red + "33",borderRadius:6,color:C.red,fontSize:10}}>{error}</div>}
            {archive.sprints.length > 0 && (
              <div style={{marginTop:24}}>
                <HistoryView
                  archive={archive}
                  loading={archiveLoading}
                  isOperator={isOperator}
                  expandedIdx={expandedSprintIdx}
                  setExpandedIdx={setExpandedSprintIdx}
                  onClearRequest={function(){ setShowWipeConfirm(true); }}
                />
              </div>
            )}
            <div style={{textAlign:"center",marginTop:14,fontSize:9,color:C.dim}}>SIMULATED {"\u00b7"} REAL PRICES {"\u00b7"} NOT FINANCIAL ADVICE</div>
          </div>
        </div>
      </div>
    </ThemeContext.Provider>
  );

  /* ── LOADING ── */
  if (busy) return (
    <ThemeContext.Provider value={C}>
      <div style={{background:C.bg,minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:F,gap:18}}>
        <div style={{fontSize:36}}>{"\u26a1"}</div>
        <div style={{fontSize:14,fontWeight:700,fontFamily:FS,color:C.text}}>{isFirst ? "Deploying capital..." : "Checking markets..."}</div>
        <div style={{fontSize:11,color:C.textdim,textAlign:"center",lineHeight:1.9}}>Searching prices {"\u00b7"} Reading news {"\u00b7"} Analyzing correlations</div>
        <div style={{display:"flex",gap:6}}>{[0,1,2].map(function(i){return <div key={i} style={{width:8,height:8,borderRadius:"50%",background:C.gold,animation:"pulse 1.5s ease " + (i*0.3) + "s infinite"}} />;})}</div>
      </div>
    </ThemeContext.Provider>
  );

  /* ── MAIN DASHBOARD ── */
  return (
    <ThemeContext.Provider value={C}>
      <div>
        {opEl}
        {wipeEl}
        <div style={{background:C.bg,minHeight:"100vh",color:C.text,fontFamily:F,padding:"16px 16px 90px",maxWidth:900,margin:"0 auto"}}>
          <div style={{position:"fixed",top:14,right:14,zIndex:50}}>
            <button onClick={toggleTheme} style={{background:C.bg2,color:C.text,border:"1px solid " + C.border,borderRadius:20,padding:"6px 12px",cursor:"pointer",fontSize:11,fontFamily:F}}>{theme==="dark"?"\u263c light":"\u263e dark"}</button>
          </div>

        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14,flexWrap:"wrap",gap:10}}>
          <div>
            <div style={{fontSize:9,letterSpacing:4,color:C.gold,marginBottom:3}}>{"\u25c8"} TEO CAPITAL {"\u00b7"} {sprintName.toUpperCase()}</div>
            <div style={{fontSize:9,color:C.muted}}>{state.snapshots.length} decision{state.snapshots.length!==1?"s":""} {"\u00b7"} {cfg.weeks}-week target {latest ? " \u00b7 last decided " + latest.timestamp : ""}</div>
            <div style={{fontSize:9,color:isOperator?C.green:C.muted,marginTop:4,cursor:"pointer"}} onClick={function(){ if(isOperator){ if(confirm("Log out of operator mode on this device?")) handleOpLogout(); } else { setShowOpLogin(true); } }}>
              {isOperator ? "\u25cf OPERATOR \u00b7 click to log out" : "\u25cb viewer mode \u00b7 click to operate"}
            </div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:28,fontWeight:800,fontFamily:FS,color:isUp?C.green:C.red,lineHeight:1}}>{fmt(liveTotal)}</div>
            <div style={{fontSize:12,color:isUp?C.green:C.red,marginTop:2}}>{fmtp(totalReturn)} on ${Number(seedAmt || 0).toLocaleString()}</div>
            {state.holdings.length > 0 && (
              <div style={{display:"flex",gap:8,alignItems:"center",justifyContent:"flex-end",marginTop:6}}>
                <button onClick={refreshPrices} disabled={refreshing} style={{background:"transparent",color:refreshing?C.muted:C.gold,border:"1px solid " + C.gold + "44",padding:"5px 10px",borderRadius:6,cursor:refreshing?"not-allowed":"pointer",fontSize:9,fontFamily:F,letterSpacing:1}}>
                  {refreshing ? "\u21bb refreshing..." : "\u21bb refresh prices"}
                </button>
                {refreshLabel && <span style={{fontSize:9,color:C.dim}}>{refreshLabel}</span>}
              </div>
            )}
          </div>
        </div>

        {/* Benchmark comparison pills */}
        {benchTicker && benchReturn != null && (
          <div style={{display:"flex",gap:8,marginBottom:18,flexWrap:"wrap"}}>
            <div style={{flex:"1 1 110px",background:C.bg2,border:"1px solid " + (isUp?C.green+"33":C.red+"33"),borderRadius:8,padding:"10px 14px"}}>
              <div style={{fontSize:8,letterSpacing:2,color:C.muted,marginBottom:3}}>TEO</div>
              <div style={{fontSize:18,fontWeight:700,fontFamily:FS,color:isUp?C.green:C.red}}>{fmtp(totalReturn)}</div>
            </div>
            <div style={{flex:"1 1 110px",background:C.bg2,border:"1px solid " + C.border,borderRadius:8,padding:"10px 14px"}}>
              <div style={{fontSize:8,letterSpacing:2,color:C.muted,marginBottom:3}}>{benchTicker}</div>
              <div style={{fontSize:18,fontWeight:700,fontFamily:FS,color:benchReturn>=0?C.green:C.red}}>{fmtp(benchReturn)}</div>
            </div>
            <div style={{flex:"1 1 110px",background:C.bg2,border:"1px solid " + ((edgeReturn||0)>=0?C.gold+"55":C.muted+"33"),borderRadius:8,padding:"10px 14px"}}>
              <div style={{fontSize:8,letterSpacing:2,color:C.muted,marginBottom:3}}>EDGE vs {benchTicker}</div>
              <div style={{fontSize:18,fontWeight:700,fontFamily:FS,color:(edgeReturn||0)>=0?C.gold:C.muted}}>{fmtp(edgeReturn)}</div>
            </div>
          </div>
        )}

        {/* Chart */}
        {chartData.length > 1 && (
          <div style={{background:C.bg2,border:"1px solid " + C.border,borderRadius:10,padding:"14px 10px 8px",marginBottom:18}}>
            <ResponsiveContainer width="100%" height={140}>
              <LineChart data={chartData}>
                <XAxis dataKey="label" tick={{fill:C.muted,fontSize:9}} axisLine={false} tickLine={false} />
                <YAxis domain={["auto","auto"]} tick={{fill:C.muted,fontSize:9}} axisLine={false} tickLine={false} width={62} tickFormatter={function(v){return "$"+Math.round(v);}} />
                <Tooltip content={function(props){ return <ChartTip {...props} seed={seedAmt} benchTicker={benchTicker} />; }} />
                <ReferenceLine y={seedAmt} stroke={C.dim} strokeDasharray="3 3" />
                {benchTicker && benchStart && (
                  <Line type="monotone" dataKey="bench" stroke={C.benchLine} strokeWidth={1.8} strokeDasharray="4 3" dot={false} name={benchTicker} />
                )}
                <Line type="monotone" dataKey="value" stroke={isUp?C.green:C.red} strokeWidth={2.5} dot={{r:3,fill:isUp?C.green:C.red}} name="Teo" />
              </LineChart>
            </ResponsiveContainer>
            {benchTicker && benchStart && (
              <div style={{display:"flex",gap:14,justifyContent:"center",fontSize:9,color:C.muted,marginTop:4}}>
                <span style={{display:"flex",alignItems:"center",gap:5}}><span style={{display:"inline-block",width:14,height:2,background:isUp?C.green:C.red}}/>Teo</span>
                <span style={{display:"flex",alignItems:"center",gap:5}}><span style={{display:"inline-block",width:14,height:2,background:C.benchLine,borderTop:"1px dashed transparent"}}/>{benchTicker}</span>
              </div>
            )}
          </div>
        )}

        {/* Holdings strip */}
        {state.holdings.length > 0 && (
          <div style={{display:"flex",gap:6,marginBottom:18,overflowX:"auto",paddingBottom:4}}>
            {state.holdings.map(function(h) {
              var price = latestPrices[h.ticker] || h.lastPrice || h.boughtAt;
              var pnlP = ((price - h.boughtAt) / h.boughtAt * 100);
              return <div key={h.ticker} style={{background:C.bg2,border:"1px solid " + (pnlP>=0?C.green+"33":C.red+"33"),borderRadius:8,padding:"8px 12px",minWidth:88,flexShrink:0}}>
                <div style={{fontSize:9,color:C.muted,marginBottom:2}}>{h.ticker}</div>
                <div style={{fontSize:13,fontWeight:700,color:C.text}}>{fmt(price)}</div>
                <div style={{fontSize:9,color:pnlP>=0?C.green:C.red}}>{fmtp(pnlP)}</div>
              </div>;
            })}
            {state.cash > 0.01 && <div style={{background:C.bg2,border:"1px solid " + C.border,borderRadius:8,padding:"8px 12px",minWidth:88,flexShrink:0}}>
              <div style={{fontSize:9,color:C.muted,marginBottom:2}}>CASH</div>
              <div style={{fontSize:13,fontWeight:700,color:C.text}}>{fmt(state.cash)}</div>
            </div>}
          </div>
        )}

        {/* Tabs */}
        <div style={{display:"flex",gap:4,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
          {[["latest","LATEST"],["positions","POSITIONS"],["decisions","DECISIONS"],["record","RECORD"],["grade","GRADE"]].map(function(pair) {
            var t = pair[0], label = pair[1];
            const showStar = t==="grade" && state.grade;
            const showCount = t==="record" && archive.sprints.length > 0;
            return <button key={t} onClick={function(){setTab(t);}} style={{
              background:tab===t?C.bg2:"transparent",border:"1px solid " + (tab===t?C.gold+"55":C.border),
              color:tab===t?C.gold:C.muted,padding:"5px 14px",borderRadius:6,cursor:"pointer",
              fontSize:10,letterSpacing:1,fontFamily:F,
            }}>{label}{showStar?" \u2605":""}{showCount?" " + archive.sprints.length:""}</button>;
          })}
          {tab==="decisions" && state.snapshots.length > 0 && (
            <div style={{display:"flex",gap:3,marginLeft:6,overflowX:"auto"}}>
              {state.snapshots.map(function(s,i) {
                return <button key={i} onClick={function(){setSnapIdx(i);}} style={{
                  background:snapIdx===i?C.bg3:"transparent",border:"1px solid " + (snapIdx===i?C.border:"transparent"),
                  color:snapIdx===i?C.text:C.dim,padding:"3px 8px",borderRadius:4,cursor:"pointer",fontSize:9,fontFamily:F,
                }}>#{i+1}</button>;
              })}
            </div>
          )}
        </div>

        {/* ── LATEST ── */}
        {tab==="latest" && latest && (
          <div className="fu">
            {latest.prevValue && (
              <div style={{display:"flex",gap:12,marginBottom:14,flexWrap:"wrap"}}>
                {[["SINCE LAST", latest.totalValue, latest.prevValue||seedAmt], ["TOTAL", latest.totalValue, seedAmt]].map(function(arr) {
                  var label=arr[0], val=arr[1], base=arr[2];
                  var pct = ((val/base-1)*100).toFixed(2);
                  var up = val >= base;
                  return <div key={label} style={{background:C.bg2,border:"1px solid " + (up?C.green+"33":C.red+"33"),borderRadius:8,padding:"10px 16px",flex:1,minWidth:140}}>
                    <div style={{fontSize:8,letterSpacing:2,color:C.muted,marginBottom:4}}>{label}</div>
                    <div style={{fontSize:20,fontWeight:700,fontFamily:FS,color:up?C.green:C.red}}>{(pct>=0?"+":"") + pct}%</div>
                  </div>;
                })}
              </div>
            )}

            {/* Macro + priced in */}
            {latest.macro && (
              <div style={{background:C.bg2,border:"1px solid " + C.border,borderRadius:10,padding:"14px 16px",marginBottom:12}}>
                <div style={{fontSize:9,letterSpacing:3,color:C.blue,marginBottom:10}}>{"\u25c8"} MARKET ASSESSMENT</div>
                <div style={{fontSize:11,color:C.text,lineHeight:1.7,marginBottom:10,borderBottom:"1px solid " + C.border,paddingBottom:10}}>{latest.macro}</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <div>
                    <div style={{fontSize:8,letterSpacing:2,color:C.orange,marginBottom:6}}>ALREADY PRICED IN</div>
                    {(latest.pricedIn||[]).map(function(item,i){return <div key={i} style={{fontSize:10,color:C.muted,marginBottom:4,lineHeight:1.5}}>{"\u2717"} {item}</div>;})}
                  </div>
                  <div>
                    <div style={{fontSize:8,letterSpacing:2,color:C.green,marginBottom:6}}>GENUINE OPPORTUNITY</div>
                    {(latest.opportunities||[]).map(function(item,i){return <div key={i} style={{fontSize:10,color:C.muted,marginBottom:4,lineHeight:1.5}}>{"\u2713"} {item}</div>;})}
                  </div>
                </div>
              </div>
            )}

            {/* Earnings */}
            {latest.earningsNearby && latest.earningsNearby.length > 0 && (
              <div style={{background:C.bg2,border:"1px solid " + C.purple + "33",borderRadius:10,padding:"12px 14px",marginBottom:12}}>
                <div style={{fontSize:9,letterSpacing:3,color:C.purple,marginBottom:8}}>{"\ud83d\udcc5"} EARNINGS NEARBY</div>
                {latest.earningsNearby.map(function(e,i){
                  return <div key={i} style={{display:"flex",gap:10,padding:"6px 0",fontSize:10,alignItems:"center",flexWrap:"wrap"}}>
                    <span style={{color:C.text,fontWeight:700,minWidth:50}}>{e.ticker}</span>
                    <span style={{color:C.muted,minWidth:50}}>{e.date}</span>
                    <span style={{color:e.action==="EXIT"?C.red:e.action==="TRIM"?C.orange:C.green,fontWeight:600,minWidth:45}}>{e.action}</span>
                    <span style={{color:C.dim,flex:1}}>{e.why}</span>
                  </div>;
                })}
              </div>
            )}

            {/* Correlation */}
            {latest.themes && latest.themes.length > 0 && (
              <div style={{background:C.bg2,border:"1px solid " + C.blue + "22",borderRadius:10,padding:"12px 14px",marginBottom:12}}>
                <div style={{fontSize:9,letterSpacing:3,color:C.blue,marginBottom:8}}>{"\u2295"} THEME DIVERSIFICATION</div>
                {latest.themes.map(function(t,i){
                  return <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:10}}>
                    <span style={{color:C.text}}>{t.name} <span style={{color:C.dim}}>({(t.tickers||[]).join(", ")})</span></span>
                    <span style={{color:C.gold,fontWeight:600}}>{t.pct}%</span>
                  </div>;
                })}
              </div>
            )}

            {/* Thesis */}
            <div style={{background:C.bg2,border:"1px solid " + C.border,borderRadius:10,padding:"14px 16px",marginBottom:14}}>
              <div style={{fontSize:9,color:C.muted,marginBottom:6}}>{latest.timestamp}{latest.watching && latest.watching.length > 0 ? " \u00b7 Watching: " + latest.watching.join(", ") : ""}</div>
              <div style={{fontSize:12,color:C.text,lineHeight:1.85}}>{latest.thesis}</div>
            </div>

            {/* Triggered stops */}
            {latest.triggeredStops && latest.triggeredStops.length > 0 && (
              <div style={{marginBottom:14}}>
                <div style={{fontSize:9,letterSpacing:3,color:C.orange,marginBottom:8}}>{"\u26a1"} STOPS TRIGGERED</div>
                {latest.triggeredStops.map(function(t,i){return <TriggeredRow key={i} t={t} />;})}
              </div>
            )}

            {/* Transactions */}
            {latest.transactions && latest.transactions.length > 0 ? (
              <div style={{marginBottom:14}}>
                <div style={{fontSize:9,letterSpacing:3,color:C.muted,marginBottom:8}}>TRANSACTIONS</div>
                {latest.transactions.map(function(tx,i){return <TxRow key={i} tx={tx} />;})}
              </div>
            ) : (
              <div style={{padding:"12px 16px",background:C.bg3,borderRadius:8,fontSize:11,color:C.muted,marginBottom:14,textAlign:"center"}}>No trades {"\u2014"} held all positions.</div>
            )}

            {/* Stop-limits */}
            {latest.stopLimits && latest.stopLimits.length > 0 && (
              <div style={{marginBottom:14}}>
                <div style={{fontSize:9,letterSpacing:3,color:C.orange,marginBottom:6}}>STANDING ORDERS {"\u2014"} SCHWAB</div>
                <div style={{background:C.orange+"15",border:"1px solid " + C.orange + "22",borderRadius:8,padding:"10px 12px",marginBottom:8,fontSize:10,color:C.orange}}>{"\u26a0"} Simulated. Enter these stop-limits manually if following along.</div>
                {latest.stopLimits.map(function(s,i){return <StopRow key={i} s={s} />;})}
              </div>
            )}

            {/* Cash reserve */}
            {latest.cashReserved > 0 && (
              <div style={{background:C.gold+"15",border:"1px solid " + C.gold + "33",borderRadius:8,padding:"12px 14px"}}>
                <div style={{fontSize:9,letterSpacing:2,color:C.gold,marginBottom:4}}>{"\ud83d\udcb0"} CASH RESERVED</div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:11,color:C.text}}>{latest.reserveReason}</span>
                  <span style={{fontSize:16,fontWeight:700,color:C.gold}}>{fmt(latest.cashReserved)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* POSITIONS */}
        {tab==="positions" && (
          <div className="fu">
            <div style={{fontSize:9,letterSpacing:3,color:C.muted,marginBottom:10}}>HOLDINGS ({state.holdings.length}/6)</div>
            {!state.holdings.length && <div style={{color:C.muted,fontSize:11,padding:"12px 0"}}>No positions.</div>}
            {state.holdings.map(function(h,i){return <HoldingRow key={i} h={h} price={effectivePrice(h)} />;})}
            {state.cash > 0.01 && <div style={{display:"flex",justifyContent:"space-between",padding:"10px 12px",background:C.bg3,borderRadius:6,borderLeft:"2px solid " + C.dim}}>
              <span style={{color:C.muted,fontSize:12}}>CASH</span><span style={{color:C.text,fontSize:13,fontWeight:600}}>{fmt(state.cash)}</span>
            </div>}
            <div style={{borderTop:"1px solid " + C.border,marginTop:12,paddingTop:12,display:"flex",justifyContent:"space-between"}}>
              <span style={{fontSize:10,color:C.muted}}>TOTAL</span>
              <span style={{fontSize:18,fontWeight:700,fontFamily:FS,color:isUp?C.green:C.red}}>{fmt(state.totalValue)}</span>
            </div>
          </div>
        )}

        {/* DECISIONS — walk through each snapshot of the current sprint */}
        {tab==="decisions" && (
          <div className="fu">
            {!state.snapshots.length && <div style={{color:C.muted,fontSize:11}}>No decisions yet.</div>}
            {viewSnap && (
              <div>
                <div style={{background:C.bg2,border:"1px solid " + C.border,borderRadius:10,padding:14,marginBottom:12}}>
                  <div style={{fontSize:9,color:C.muted,marginBottom:4}}>#{viewSnap.index+1} {"\u00b7"} {viewSnap.timestamp}</div>
                  <div style={{fontSize:16,fontWeight:700,fontFamily:FS,marginBottom:8,color:viewSnap.totalValue>=(viewSnap.prevValue||seedAmt)?C.green:C.red}}>{fmt(viewSnap.totalValue)}</div>
                  <div style={{fontSize:11,color:C.text,lineHeight:1.8}}>{viewSnap.thesis}</div>
                </div>
                {viewSnap.transactions && viewSnap.transactions.length > 0 && viewSnap.transactions.map(function(tx,i){return <TxRow key={i} tx={tx} />;})}
              </div>
            )}
          </div>
        )}

        {/* RECORD — track record across all archived sprints */}
        {tab==="record" && (
          <HistoryView
            archive={archive}
            loading={archiveLoading}
            isOperator={isOperator}
            expandedIdx={expandedSprintIdx}
            setExpandedIdx={setExpandedSprintIdx}
            onClearRequest={function(){ setShowWipeConfirm(true); }}
          />
        )}

        {/* GRADE */}
        {tab==="grade" && (
          <div className="fu">
            {state.grade ? (
              <div>
                <GradeCard grade={state.grade} />
                {isOperator && (
                  <button onClick={doGrade} disabled={grading} style={{background:"transparent",color:C.muted,border:"1px solid " + C.border,padding:"9px 18px",borderRadius:6,cursor:"pointer",fontSize:10,fontFamily:F,marginTop:12}}>
                    {grading ? "Updating..." : "Re-grade"}
                  </button>
                )}
              </div>
            ) : (
              <div style={{background:C.bg2,border:"1px solid " + C.border,borderRadius:10,padding:28,textAlign:"center"}}>
                <div style={{fontSize:28,marginBottom:12}}>{"\ud83d\udcca"}</div>
                <div style={{fontSize:15,fontWeight:700,fontFamily:FS,color:C.text,marginBottom:8}}>Report Card</div>
                <div style={{fontSize:11,color:C.muted,lineHeight:1.9,marginBottom:20}}>Teo reviews every decision against actual outcomes.</div>
                {isOperator ? (
                  <button onClick={doGrade} disabled={grading||!state.snapshots.length} style={{
                    background:grading?"transparent":"linear-gradient(135deg," + C.gold + "," + C.gold2 + ")",color:grading?C.muted:"#0a0800",
                    border:"1px solid " + (grading?C.border:"transparent"),padding:"12px 28px",borderRadius:8,
                    cursor:grading||!state.snapshots.length?"not-allowed":"pointer",fontSize:13,fontWeight:700,fontFamily:FS,
                  }}>{"\u2605"} GRADE</button>
                ) : (
                  <div style={{fontSize:10,color:C.dim,fontStyle:"italic"}}>No grade yet — only the operator can run a grade pass.</div>
                )}
              </div>
            )}
          </div>
        )}

        {error && <div style={{marginTop:12,padding:"10px 14px",background:C.red+"15",border:"1px solid " + C.red + "33",borderRadius:8,color:C.red,fontSize:11}}>{"\u26a0"} {error}</div>}

        {/* Bottom bar — operator only */}
        {isOperator ? (
          <div style={{position:"fixed",bottom:0,left:0,right:0,background:C.bg2 + "f2",backdropFilter:"blur(8px)",borderTop:"1px solid " + C.border,padding:"12px 20px",display:"flex",gap:8,alignItems:"center",justifyContent:"center",flexWrap:"wrap",zIndex:100}}>
            <button onClick={doDecision} disabled={busy} style={{
              background:busy?"transparent":"linear-gradient(135deg," + C.gold + "," + C.gold2 + ")",
              color:busy?C.muted:"#0a0800",border:"1px solid " + (busy?C.border:"transparent"),
              padding:"12px 28px",borderRadius:8,cursor:busy?"not-allowed":"pointer",
              fontSize:13,fontWeight:700,fontFamily:FS,letterSpacing:1,minWidth:240,
            }}>{busy ? "Checking..." : isFirst ? ("DEPLOY $" + Number(seedAmt || 0).toLocaleString()) : "CHECK & DECIDE"}</button>
            <button onClick={doGrade} disabled={grading||!state.snapshots.length} style={{
              background:"transparent",color:grading?C.muted:C.gold,border:"1px solid " + C.gold + "44",
              padding:"12px 16px",borderRadius:8,cursor:grading||!state.snapshots.length?"not-allowed":"pointer",fontSize:11,fontFamily:F,
            }}>{"\u2605"} GRADE</button>
            <button onClick={function(){ if(confirm("End this sprint and archive it to Track Record? Active state will be cleared. This cannot be undone.")) doReset(); }} disabled={archiving} style={{background:"transparent",color:archiving?C.muted:C.dim,border:"1px solid " + (archiving?C.muted:C.dim),padding:"12px 10px",borderRadius:8,cursor:archiving?"not-allowed":"pointer",fontSize:9,fontFamily:F}}>{archiving ? "ARCHIVING..." : "END SPRINT"}</button>
          </div>
        ) : null}
      </div>
      </div>
    </ThemeContext.Provider>
  );
}

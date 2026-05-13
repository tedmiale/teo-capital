import { useState, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

const _fl = document.createElement("link");
_fl.rel = "stylesheet";
_fl.href = "https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=JetBrains+Mono:wght@400;500;700&display=swap";
document.head.appendChild(_fl);

const _st = document.createElement("style");
_st.textContent = "* {box-sizing:border-box;margin:0;padding:0} body{background:#07070f} ::-webkit-scrollbar{width:3px} ::-webkit-scrollbar-thumb{background:#2a2a40;border-radius:2px} @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}} @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}} @keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}} .fu{animation:fadeUp .45s ease both} .pulse{animation:pulse 1.5s ease infinite} .shake{animation:shake .4s ease} input{font-family:'JetBrains Mono',monospace} input:focus{outline:none}";
document.head.appendChild(_st);

const SEED = 5000;
const C = {
  bg:"#07070f", bg2:"#0d0d1a", bg3:"#111120", border:"#1e1e35",
  gold:"#c9a84c", gold2:"#f0c95e", green:"#00e5a0", red:"#ff4d6d",
  blue:"#4d8fff", orange:"#ff8844", purple:"#9d6fff",
  text:"#d4d4f0", muted:"#5a5a8a", dim:"#2a2a45", textdim:"#6060a0",
};
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


async function hashPIN(pin) {
  const enc = new TextEncoder().encode(pin + "ccm2026");
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}


async function callTeo(system, user, schema, timeoutMs = 240000) {
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 8000,
        system,
        tools,
        messages: [{ role: "user", content: user }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error("API error " + res.status + (errBody ? ": " + errBody.slice(0, 200) : ""));
    }
    data = await res.json();
  } catch (e) {
    if (e.name === "AbortError") {
      const err = new Error("Request timed out after " + Math.round(timeoutMs/1000) + "s. The model or web search may be slow right now — wait a minute and tap CHECK & DECIDE again.");
      err.timedOut = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (schema) {
    // Preferred path: model called the submit tool — input is guaranteed valid JSON.
    const submit = data.content.find(b => b.type === "tool_use" && b.name === "submit");
    if (submit && submit.input) return JSON.stringify(submit.input);
    // Fallback: model ignored the tool and wrote JSON as text. Let parseJSON try.
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


async function makeDecision(holdings, cash, snapNum, priorStops) {
  const isFirst = holdings.length === 0 && cash >= SEED;
  const now = new Date().toLocaleString("en-US", {
    weekday:"short", month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit"
  });
  const tickers = holdings.map(h => h.ticker);
  const desc = isFirst
    ? "Starting capital: $" + cash.toFixed(2) + " cash. No positions."
    : holdings.map(h => h.ticker + ": " + h.shares + "sh @ $" + h.boughtAt.toFixed(2) + " last $" + h.lastPrice.toFixed(2)).join("\n") + "\nCash: $" + cash.toFixed(2);

  const system = "You are an elite AI portfolio manager. MAXIMIZE $5000 over 4 weeks. HIGH risk tolerance. Max 6 positions. Schwab-compatible (stocks, ETFs, standard options).\n\nFRAMEWORK:\n- Assess if news is ALREADY PRICED IN or a GENUINE SURPRISE before acting\n- Size by conviction: HIGH=25-35%, MEDIUM=15-20%, SPECULATIVE=5-8%\n- Diversify by THEME not just ticker count\n- Check earnings calendar for held names (5 day lookahead)\n- Set stops 7-10% below entry, profit targets +12-25%\n- Trail stops on winners. Hold cash when uncertain.\n- If prior stop was crossed, treat as triggered.\n\nSearch real prices via web search. Read today's news.\n\nRESPOND WITH ONLY THIS JSON (no other text):\n{\"fetched_prices\":{\"TICKER\":123.45},\"macro\":\"market conditions sentence\",\"priced_in\":[\"things baked in\"],\"opportunities\":[\"genuine edges\"],\"earnings_nearby\":[{\"ticker\":\"X\",\"date\":\"May 5\",\"action\":\"HOLD\",\"why\":\"reason\"}],\"themes\":[{\"name\":\"AI\",\"tickers\":[\"NVDA\"],\"pct\":30}],\"triggered_stops\":[],\"transactions\":[{\"action\":\"BUY\",\"ticker\":\"X\",\"name\":\"Name\",\"instrument\":\"STOCK\",\"shares\":10,\"price\":100,\"strike\":null,\"expiry\":null,\"total_cost\":1000,\"size_pct\":20,\"conviction\":\"HIGH\",\"rr\":\"3:1\",\"edge\":\"not priced in yet\",\"reason\":\"one sentence\"}],\"holdings_after\":[{\"ticker\":\"X\",\"name\":\"Name\",\"instrument\":\"STOCK\",\"shares\":10,\"boughtAt\":100,\"lastPrice\":100,\"strike\":null,\"expiry\":null,\"theme\":\"AI\"}],\"stop_limits\":[{\"ticker\":\"X\",\"order\":\"STOP_LOSS\",\"shares\":10,\"stop_price\":90,\"limit_price\":89,\"notes\":\"protect\"}],\"cash_after\":0,\"cash_reserved\":0,\"reserve_reason\":\"\",\"thesis\":\"3 sentences\",\"watching\":[\"SPY\"]}\n\nCRITICAL: valid JSON only. holdings_after=ALL positions. fetched_prices=every held ticker.";

  const stopList = (priorStops || []).length
    ? priorStops.map(s => s.order + " " + s.ticker + ": stop $" + s.stop_price + " / limit $" + s.limit_price).join("\n")
    : "None";

  const user = isFirst
    ? "It's " + now + ". Deploy $" + cash.toFixed(2) + " into up to 6 positions. Search best opportunities. Set stops. Return JSON only."
    : "It's " + now + ". Portfolio:\n" + desc + "\n\nPrior stops:\n" + stopList + "\n\nSearch prices for: " + tickers.join(", ") + ". Check if stops crossed. Read news. Decide. Return JSON only.";

  let data = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callTeo(system, user, DECISION_SCHEMA);
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

async function runGrade(state) {
  const hist = (state.snapshots || []).map((s, i) =>
    "#" + (i+1) + " (" + s.timestamp + "): $" + s.totalValue.toFixed(2) + " | " +
    (s.transactions.length ? s.transactions.map(t => t.action + " " + t.ticker).join(", ") : "hold") +
    " | " + s.thesis
  ).join("\n");
  const system = "Grade this 4-week trading record. Be brutally honest. Respond ONLY with JSON: {\"grade\":\"A-F\",\"score\":0-100,\"headline\":\"verdict\",\"what_worked\":[\"...\"],\"what_failed\":[\"...\"],\"missed_opportunities\":[\"...\"],\"would_do_differently\":[\"...\"],\"benchmark\":\"vs SPY\",\"lesson\":\"takeaway\"}";
  const user = "Started $5000. Now $" + state.totalValue.toFixed(2) + " (" + ((state.totalValue/SEED-1)*100).toFixed(2) + "%). " + (state.snapshots||[]).length + " decisions.\n\n" + hist + "\n\nSearch market context. Grade honestly.";
  return parseJSON(await callTeo(system, user, GRADE_SCHEMA));
}


const ChartTip = ({ active, payload }) => {
  if (!active || !payload || !payload.length) return null;
  const v = payload[0].value;
  return (
    <div style={{background:"#0c0c1c",border:"1px solid " + C.border,padding:"8px 12px",borderRadius:6,fontFamily:F,fontSize:11}}>
      <div style={{color:C.muted,marginBottom:3}}>{payload[0].payload.label}</div>
      <div style={{color:v>=SEED?C.green:C.red,fontSize:15,fontWeight:700}}>{fmt(v)}</div>
      <div style={{color:C.muted,fontSize:10}}>{((v/SEED-1)*100).toFixed(2)}% vs $5K</div>
    </div>
  );
};

function TxRow({ tx }) {
  const isBuy = (tx.action || "").startsWith("BUY");
  const ac = isBuy ? C.green : C.red;
  const convColor = tx.conviction === "HIGH" ? C.green : tx.conviction === "MEDIUM" ? C.gold : C.muted;
  return (
    <div style={{padding:"10px 12px",marginBottom:3,borderRadius:6,background:isBuy?"#091209":"#120909",borderLeft:"2px solid " + ac + "55",fontFamily:F}}>
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
  const ac = s.order === "TAKE_PROFIT" ? C.green : C.orange;
  const label = s.order === "STOP_LOSS" ? "STOP LOSS" : s.order === "TAKE_PROFIT" ? "TAKE PROFIT" : "TRAILING";
  return (
    <div style={{display:"flex",flexWrap:"wrap",gap:8,padding:"9px 12px",marginBottom:3,borderRadius:6,background:"#0d0d10",borderLeft:"2px solid " + ac + "66",fontFamily:F,alignItems:"center"}}>
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
  const isLoss = t.type === "STOP_LOSS";
  const ac = isLoss ? C.red : C.green;
  return (
    <div style={{display:"flex",flexWrap:"wrap",gap:8,padding:"9px 12px",marginBottom:3,borderRadius:6,background:isLoss?"#1a0808":"#081a08",borderLeft:"2px solid " + ac,fontFamily:F,alignItems:"center"}}>
      <span style={{fontSize:9,fontWeight:700,letterSpacing:1,color:ac}}>{isLoss ? "\u26a1 STOP HIT" : "\u2713 TARGET HIT"}</span>
      <span style={{color:C.text,fontWeight:700,fontSize:12}}>{t.ticker}</span>
      <span style={{fontSize:10,color:C.muted}}>@ ${Number(t.trigger_price).toFixed(2)}</span>
      <span style={{fontSize:10,color:C.dim,flex:1}}>{t.note}</span>
    </div>
  );
}

function HoldingRow({ h, price }) {
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


function PinModal({ mode, onSubmit, onCancel, onNuclear, lockoutUntil }) {
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [err, setErr] = useState("");
  const [shk, setShk] = useState(false);
  const [nuke, setNuke] = useState(false);
  const [nukeText, setNukeText] = useState("");
  const isLocked = lockoutUntil && Date.now() < lockoutUntil;
  const lockSec = isLocked ? Math.ceil((lockoutUntil - Date.now()) / 1000) : 0;
  const [, tick] = useState(0);
  useEffect(function() {
    if (!isLocked) return;
    const t = setInterval(function() { tick(function(x) { return x+1; }); }, 500);
    return function() { clearInterval(t); };
  }, [isLocked]);

  const submit = function() {
    if (mode === "create") {
      if (pin.length !== 4) { setErr("4 digits required"); setShk(true); setTimeout(function(){setShk(false);},400); return; }
      if (pin !== pin2) { setErr("PINs don't match"); setShk(true); setTimeout(function(){setShk(false);},400); return; }
      onSubmit(pin);
    } else {
      if (pin.length !== 4) { setErr("Enter PIN"); setShk(true); setTimeout(function(){setShk(false);},400); return; }
      onSubmit(pin);
    }
  };

  const inp = {background:C.bg3,border:"1px solid " + C.border,color:C.text,padding:"14px 16px",borderRadius:8,fontSize:24,letterSpacing:8,width:"100%",textAlign:"center",fontWeight:700};

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:20}}>
      <div className={shk ? "shake" : "fu"} style={{background:C.bg2,border:"1px solid " + C.gold + "55",borderRadius:14,padding:28,maxWidth:380,width:"100%",fontFamily:F}}>
        <div style={{textAlign:"center",marginBottom:20}}>
          <div style={{fontSize:28,marginBottom:8}}>{mode==="create" ? "\ud83d\udd10" : isLocked ? "\u23f0" : "\ud83d\udd13"}</div>
          <div style={{fontSize:17,fontWeight:700,fontFamily:FS,color:C.text,marginBottom:6}}>
            {mode==="create" ? "Set Your PIN" : isLocked ? "Locked Out" : "Enter PIN"}
          </div>
          <div style={{fontSize:11,color:C.muted,lineHeight:1.6}}>
            {mode==="create" ? "Choose a 4-digit PIN to protect your portfolio." : isLocked ? "Too many attempts. Wait " + lockSec + "s." : "Enter PIN to authorize."}
          </div>
        </div>
        {!isLocked && (
          <div>
            <input type="password" inputMode="numeric" maxLength={4} value={pin} onChange={function(e){setPin(e.target.value.replace(/\D/g,""));}} placeholder="••••" autoFocus style={inp} />
            {mode === "create" && <input type="password" inputMode="numeric" maxLength={4} value={pin2} onChange={function(e){setPin2(e.target.value.replace(/\D/g,""));}} placeholder="confirm" style={Object.assign({},inp,{marginTop:10})} />}
            {err && <div style={{color:C.red,fontSize:11,marginTop:10,textAlign:"center"}}>{err}</div>}
            <div style={{display:"flex",gap:8,marginTop:18}}>
              <button onClick={onCancel} style={{flex:1,background:"transparent",color:C.muted,border:"1px solid " + C.border,padding:12,borderRadius:8,cursor:"pointer",fontSize:12,fontFamily:F}}>CANCEL</button>
              <button onClick={submit} style={{flex:2,background:"linear-gradient(135deg," + C.gold + "," + C.gold2 + ")",color:"#0a0800",border:"none",padding:12,borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:FS,letterSpacing:1}}>
                {mode==="create" ? "SET PIN" : "AUTHORIZE"}
              </button>
            </div>
          </div>
        )}
        {mode !== "create" && (
          <div style={{marginTop:20,paddingTop:18,borderTop:"1px solid " + C.border,textAlign:"center"}}>
            {!nuke ? (
              <button onClick={function(){setNuke(true);}} style={{background:"transparent",color:C.dim,border:"none",fontSize:10,fontFamily:F,cursor:"pointer",textDecoration:"underline"}}>Forgot PIN? Nuclear reset</button>
            ) : (
              <div>
                <div style={{fontSize:11,color:C.red,marginBottom:10,lineHeight:1.6}}>This wipes EVERYTHING. Cannot be undone.</div>
                <input type="text" value={nukeText} onChange={function(e){setNukeText(e.target.value);}} placeholder="type WIPE to confirm" style={Object.assign({},inp,{fontSize:14,letterSpacing:2,padding:"10px 14px"})} />
                <div style={{display:"flex",gap:8,marginTop:10}}>
                  <button onClick={function(){setNuke(false);setNukeText("");}} style={{flex:1,background:"transparent",color:C.muted,border:"1px solid " + C.border,padding:10,borderRadius:6,cursor:"pointer",fontSize:11,fontFamily:F}}>BACK</button>
                  <button onClick={function(){if(nukeText==="WIPE")onNuclear();}} disabled={nukeText!=="WIPE"} style={{flex:1,background:nukeText==="WIPE"?C.red:"transparent",color:nukeText==="WIPE"?"#fff":C.dim,border:"1px solid " + (nukeText==="WIPE"?C.red:C.border),padding:10,borderRadius:6,cursor:nukeText==="WIPE"?"pointer":"not-allowed",fontSize:11,fontFamily:F,fontWeight:700}}>NUKE IT</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


const BLANK = {pinHash:null,holdings:[],cash:SEED,totalValue:SEED,snapshots:[],history:[{label:"Start",value:SEED}],grade:null,failedAttempts:0,lockoutUntil:0};

export default function App() {
  const [state, setState] = useState(null);
  const [tab, setTab] = useState("latest");
  const [snapIdx, setSnapIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState(null);
  const [pinModal, setPinModal] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);

  useEffect(function() {
    (async function() {
      try {
        const s = localStorage.getItem("ccm_adv_v2");
        setState(s ? JSON.parse(s) : BLANK);
      } catch(e) { setState(BLANK); }
      setLoading(false);
    })();
  }, []);

  useEffect(function() {
    if (state && state.snapshots && state.snapshots.length) setSnapIdx(state.snapshots.length - 1);
  }, [state && state.snapshots && state.snapshots.length]);

  const save = async function(next) { try { localStorage.setItem("ccm_adv_v2", JSON.stringify(next)); } catch(e) {} };

  const guard = function(action) {
    if (!state.pinHash) { setPendingAction(function(){return action;}); setPinModal("create"); }
    else { setPendingAction(function(){return action;}); setPinModal("verify"); }
  };

  const handlePinSubmit = async function(pin) {
    const hash = await hashPIN(pin);
    if (pinModal === "create") {
      const next = Object.assign({}, state, {pinHash:hash, failedAttempts:0, lockoutUntil:0});
      await save(next); setState(next); setPinModal(null);
      if (pendingAction) { pendingAction(); setPendingAction(null); }
    } else {
      if (hash === state.pinHash) {
        const next = Object.assign({}, state, {failedAttempts:0, lockoutUntil:0});
        await save(next); setState(next); setPinModal(null);
        if (pendingAction) { pendingAction(); setPendingAction(null); }
      } else {
        const fa = (state.failedAttempts || 0) + 1;
        const lo = fa >= 5 ? Date.now() + 60000 : 0;
        const next = Object.assign({}, state, {failedAttempts:fa, lockoutUntil:lo});
        await save(next); setState(next);
        setError(fa >= 5 ? "Locked 60s" : "Wrong PIN (" + fa + "/5)");
        setTimeout(function(){setError(null);}, 3000);
      }
    }
  };

  const handleNuclear = async function() {
    try { localStorage.removeItem("ccm_adv_v2"); } catch(e) {}
    setState(BLANK); setPinModal(null); setPendingAction(null); setError(null);
  };

  const doDecision = async function() {
    if (busy) return; setBusy(true); setError(null);
    try {
      const priorStops = state.snapshots && state.snapshots.length ? state.snapshots[state.snapshots.length-1].stopLimits || [] : [];
      const res = await makeDecision(state.holdings, state.cash, state.snapshots.length, priorStops);
      var d = res.data;
      var macro = d.macro || "";
      var snap = {
        index: state.snapshots.length,
        timestamp: new Date().toLocaleString(),
        macro: macro,
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
        prevValue: state.totalValue,
      };
      var next = Object.assign({}, state, {
        holdings: d.holdings_after || [],
        cash: d.cash_after || 0,
        totalValue: res.totalValue,
        snapshots: state.snapshots.concat([snap]),
        history: state.history.concat([{
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
      var g = await runGrade(state);
      var next = Object.assign({}, state, {grade:g});
      await save(next); setState(next); setTab("grade");
    } catch(e) { setError(e.message); }
    setGrading(false);
  };

  const doReset = async function() {
    try { localStorage.removeItem("ccm_adv_v2"); } catch(e) {}
    setState(BLANK); setError(null); setTab("latest");
  };

  if (loading || !state) return (
    <div style={{background:C.bg,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{color:C.gold,fontFamily:F,fontSize:12,letterSpacing:3}} className="pulse">LOADING...</div>
    </div>
  );

  var totalReturn = ((state.totalValue / SEED - 1) * 100);
  var isUp = totalReturn >= 0;
  var isFirst = !state.snapshots.length;
  var latest = state.snapshots.length ? state.snapshots[state.snapshots.length-1] : null;
  var viewSnap = state.snapshots[snapIdx] || null;
  var latestPrices = latest ? (latest.fetchedPrices || {}) : {};
  var pinEl = pinModal ? <PinModal mode={pinModal} lockoutUntil={state.lockoutUntil} onSubmit={handlePinSubmit} onCancel={function(){setPinModal(null);setPendingAction(null);}} onNuclear={handleNuclear} /> : null;

  /* ── SPLASH ── */
  if (isFirst && !busy) return (
    <div>
      {pinEl}
      <div style={{background:C.bg,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:"24px 16px",fontFamily:F}}>
        <div style={{maxWidth:480,width:"100%"}} className="fu">
          <div style={{textAlign:"center",marginBottom:32}}>
            <div style={{fontSize:10,letterSpacing:5,color:C.gold,marginBottom:10}}>{"\u25c8"} TEO CAPITAL {"\u25c8"}</div>
            <div style={{fontSize:34,fontWeight:800,fontFamily:FS,color:C.text,lineHeight:1.1,marginBottom:10}}>4-Week Sprint</div>
            <div style={{fontSize:24,fontWeight:800,fontFamily:FS,background:"linear-gradient(135deg," + C.gold + "," + C.gold2 + ")",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>$5,000</div>
            <div style={{fontSize:12,color:C.textdim,lineHeight:1.9,marginTop:8}}>Elite AI trader. Real prices. Risk-managed framework.</div>
          </div>
          <div style={{background:C.bg2,border:"1px solid " + C.border,borderRadius:12,padding:"18px 20px",marginBottom:22}}>
            {[
              "Position sizing by conviction & risk-reward",
              "Correlation-aware diversification",
              "Earnings calendar awareness",
              "Priced-in vs genuine opportunity analysis",
              "Stop-limit orders on every position",
              "Cash reserves when uncertain",
              "PIN-protected from accidental changes",
            ].map(function(t, i) {
              return <div key={i} style={{display:"flex",gap:10,marginBottom:i<6?8:0,alignItems:"flex-start"}}>
                <span style={{color:C.gold,fontSize:10,flexShrink:0}}>{"\u25c8"}</span>
                <span style={{fontSize:11,color:C.text,lineHeight:1.6}}>{t}</span>
              </div>;
            })}
          </div>
          <button onClick={function(){guard(doDecision);}} disabled={busy} style={{width:"100%",background:"linear-gradient(135deg," + C.gold + "," + C.gold2 + ")",color:"#0a0800",border:"none",padding:15,borderRadius:10,cursor:"pointer",fontSize:14,fontWeight:700,fontFamily:FS,letterSpacing:1}}>
            {"\u25b6"}  DEPLOY $5,000 NOW
          </button>
          {error && <div style={{marginTop:10,padding:10,background:"#1a0808",border:"1px solid " + C.red + "33",borderRadius:6,color:C.red,fontSize:10}}>{error}</div>}
          <div style={{textAlign:"center",marginTop:14,fontSize:9,color:C.dim}}>SIMULATED {"\u00b7"} REAL PRICES {"\u00b7"} NOT FINANCIAL ADVICE</div>
        </div>
      </div>
    </div>
  );

  /* ── LOADING ── */
  if (busy) return (
    <div style={{background:C.bg,minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:F,gap:18}}>
      <div style={{fontSize:36}}>{"\u26a1"}</div>
      <div style={{fontSize:14,fontWeight:700,fontFamily:FS,color:C.text}}>{isFirst ? "Deploying $5,000..." : "Checking markets..."}</div>
      <div style={{fontSize:11,color:C.textdim,textAlign:"center",lineHeight:1.9}}>Searching prices {"\u00b7"} Reading news {"\u00b7"} Analyzing correlations</div>
      <div style={{display:"flex",gap:6}}>{[0,1,2].map(function(i){return <div key={i} style={{width:8,height:8,borderRadius:"50%",background:C.gold,animation:"pulse 1.5s ease " + (i*0.3) + "s infinite"}} />;})}</div>
    </div>
  );

  /* ── MAIN DASHBOARD ── */
  return (
    <div>
      {pinEl}
      <div style={{background:C.bg,minHeight:"100vh",color:C.text,fontFamily:F,padding:"16px 16px 90px",maxWidth:900,margin:"0 auto"}}>

        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20,flexWrap:"wrap",gap:10}}>
          <div>
            <div style={{fontSize:9,letterSpacing:4,color:C.gold,marginBottom:3}}>{"\u25c8"} TEO CAPITAL {"\u00b7"} 4-WEEK SPRINT {"\ud83d\udd10"}</div>
            <div style={{fontSize:9,color:C.muted}}>{state.snapshots.length} decision{state.snapshots.length!==1?"s":""}{latest ? " \u00b7 " + latest.timestamp : ""}</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:28,fontWeight:800,fontFamily:FS,color:isUp?C.green:C.red,lineHeight:1}}>{fmt(state.totalValue)}</div>
            <div style={{fontSize:12,color:isUp?"#00bb66":"#cc3333",marginTop:2}}>{fmtp(totalReturn)} on $5,000</div>
          </div>
        </div>

        {/* Chart */}
        {state.history.length > 1 && (
          <div style={{background:C.bg2,border:"1px solid " + C.border,borderRadius:10,padding:"14px 10px 8px",marginBottom:18}}>
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={state.history}>
                <XAxis dataKey="label" tick={{fill:C.muted,fontSize:9}} axisLine={false} tickLine={false} />
                <YAxis domain={["auto","auto"]} tick={{fill:C.muted,fontSize:9}} axisLine={false} tickLine={false} width={62} tickFormatter={function(v){return "$"+v;}} />
                <Tooltip content={<ChartTip />} />
                <ReferenceLine y={SEED} stroke={C.dim} strokeDasharray="3 3" />
                <Line type="monotone" dataKey="value" stroke={isUp?C.green:C.red} strokeWidth={2.5} dot={{r:3,fill:isUp?C.green:C.red}} />
              </LineChart>
            </ResponsiveContainer>
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
          {[["latest","LATEST"],["positions","POSITIONS"],["history","HISTORY"],["grade","GRADE"]].map(function(pair) {
            var t = pair[0], label = pair[1];
            return <button key={t} onClick={function(){setTab(t);}} style={{
              background:tab===t?C.bg2:"transparent",border:"1px solid " + (tab===t?C.gold+"55":C.border),
              color:tab===t?C.gold:C.muted,padding:"5px 14px",borderRadius:6,cursor:"pointer",
              fontSize:10,letterSpacing:1,fontFamily:F,
            }}>{label}{t==="grade"&&state.grade?" \u2605":""}</button>;
          })}
          {tab==="history" && state.snapshots.length > 0 && (
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
                {[["SINCE LAST", latest.totalValue, latest.prevValue||SEED], ["TOTAL", latest.totalValue, SEED]].map(function(arr) {
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
              <div style={{background:"#0a0a14",border:"1px solid " + C.border,borderRadius:10,padding:"14px 16px",marginBottom:12}}>
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
                <div style={{background:"#0d0808",border:"1px solid " + C.orange + "22",borderRadius:8,padding:"10px 12px",marginBottom:8,fontSize:10,color:C.orange}}>{"\u26a0"} Simulated. Enter these stop-limits manually if following along.</div>
                {latest.stopLimits.map(function(s,i){return <StopRow key={i} s={s} />;})}
              </div>
            )}

            {/* Cash reserve */}
            {latest.cashReserved > 0 && (
              <div style={{background:"#0d0d08",border:"1px solid " + C.gold + "33",borderRadius:8,padding:"12px 14px"}}>
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
            {state.holdings.map(function(h,i){return <HoldingRow key={i} h={h} price={latestPrices[h.ticker]} />;})}
            {state.cash > 0.01 && <div style={{display:"flex",justifyContent:"space-between",padding:"10px 12px",background:C.bg3,borderRadius:6,borderLeft:"2px solid " + C.dim}}>
              <span style={{color:C.muted,fontSize:12}}>CASH</span><span style={{color:C.text,fontSize:13,fontWeight:600}}>{fmt(state.cash)}</span>
            </div>}
            <div style={{borderTop:"1px solid " + C.border,marginTop:12,paddingTop:12,display:"flex",justifyContent:"space-between"}}>
              <span style={{fontSize:10,color:C.muted}}>TOTAL</span>
              <span style={{fontSize:18,fontWeight:700,fontFamily:FS,color:isUp?C.green:C.red}}>{fmt(state.totalValue)}</span>
            </div>
          </div>
        )}

        {/* HISTORY */}
        {tab==="history" && (
          <div className="fu">
            {!state.snapshots.length && <div style={{color:C.muted,fontSize:11}}>No history.</div>}
            {viewSnap && (
              <div>
                <div style={{background:C.bg2,border:"1px solid " + C.border,borderRadius:10,padding:14,marginBottom:12}}>
                  <div style={{fontSize:9,color:C.muted,marginBottom:4}}>#{viewSnap.index+1} {"\u00b7"} {viewSnap.timestamp}</div>
                  <div style={{fontSize:16,fontWeight:700,fontFamily:FS,marginBottom:8,color:viewSnap.totalValue>=(viewSnap.prevValue||SEED)?C.green:C.red}}>{fmt(viewSnap.totalValue)}</div>
                  <div style={{fontSize:11,color:C.text,lineHeight:1.8}}>{viewSnap.thesis}</div>
                </div>
                {viewSnap.transactions && viewSnap.transactions.length > 0 && viewSnap.transactions.map(function(tx,i){return <TxRow key={i} tx={tx} />;})}
              </div>
            )}
          </div>
        )}

        {/* GRADE */}
        {tab==="grade" && (
          <div className="fu">
            {state.grade ? (
              <div>
                <GradeCard grade={state.grade} />
                <button onClick={function(){guard(doGrade);}} disabled={grading} style={{background:"transparent",color:C.muted,border:"1px solid " + C.border,padding:"9px 18px",borderRadius:6,cursor:"pointer",fontSize:10,fontFamily:F,marginTop:12}}>
                  {grading ? "Updating..." : "Re-grade"}
                </button>
              </div>
            ) : (
              <div style={{background:C.bg2,border:"1px solid " + C.border,borderRadius:10,padding:28,textAlign:"center"}}>
                <div style={{fontSize:28,marginBottom:12}}>{"\ud83d\udcca"}</div>
                <div style={{fontSize:15,fontWeight:700,fontFamily:FS,color:C.text,marginBottom:8}}>Report Card</div>
                <div style={{fontSize:11,color:C.muted,lineHeight:1.9,marginBottom:20}}>Teo reviews every decision against actual outcomes.</div>
                <button onClick={function(){guard(doGrade);}} disabled={grading||!state.snapshots.length} style={{
                  background:grading?"transparent":"linear-gradient(135deg," + C.gold + "," + C.gold2 + ")",color:grading?C.muted:"#0a0800",
                  border:"1px solid " + (grading?C.border:"transparent"),padding:"12px 28px",borderRadius:8,
                  cursor:grading||!state.snapshots.length?"not-allowed":"pointer",fontSize:13,fontWeight:700,fontFamily:FS,
                }}>{"\u2605"} GRADE</button>
              </div>
            )}
          </div>
        )}

        {error && <div style={{marginTop:12,padding:"10px 14px",background:"#150808",border:"1px solid " + C.red + "33",borderRadius:8,color:C.red,fontSize:11}}>{"\u26a0"} {error}</div>}

        {/* Bottom bar */}
        <div style={{position:"fixed",bottom:0,left:0,right:0,background:"#07070fee",borderTop:"1px solid " + C.border,padding:"12px 20px",display:"flex",gap:8,alignItems:"center",justifyContent:"center",flexWrap:"wrap",zIndex:100}}>
          <button onClick={function(){guard(doDecision);}} disabled={busy} style={{
            background:busy?"transparent":"linear-gradient(135deg," + C.gold + "," + C.gold2 + ")",
            color:busy?C.muted:"#0a0800",border:"1px solid " + (busy?C.border:"transparent"),
            padding:"12px 28px",borderRadius:8,cursor:busy?"not-allowed":"pointer",
            fontSize:13,fontWeight:700,fontFamily:FS,letterSpacing:1,minWidth:240,
          }}>{busy ? "Checking..." : isFirst ? "\ud83d\udd10 DEPLOY $5,000" : "\ud83d\udd10 CHECK & DECIDE"}</button>
          <button onClick={function(){guard(doGrade);}} disabled={grading||!state.snapshots.length} style={{
            background:"transparent",color:grading?C.muted:C.gold,border:"1px solid " + C.gold + "44",
            padding:"12px 16px",borderRadius:8,cursor:grading||!state.snapshots.length?"not-allowed":"pointer",fontSize:11,fontFamily:F,
          }}>{"\u2605"} GRADE</button>
          <button onClick={function(){guard(doReset);}} style={{background:"transparent",color:C.dim,border:"1px solid " + C.dim,padding:"12px 10px",borderRadius:8,cursor:"pointer",fontSize:9,fontFamily:F}}>{"\ud83d\udd10"} RESET</button>
        </div>
      </div>
    </div>
  );
}

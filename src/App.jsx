import { useState, useRef, useCallback, useEffect } from "react";

const OPENROUTER_API_KEY = import.meta.env.VITE_OPENROUTER_API_KEY;
const PROMPT = `Describe every object you can see in this image in one or two sentences. Start with "I can see". Only output the description sentence, nothing else.`;

function cleanText(raw = "") {
  if (!raw) return "";
  let t = raw;
  t = t.replace(/<\|[^|]*\|>/g, "");
  t = t.replace(/<[^>]+>/g, " ");
  t = t.split("\n")
    .filter(line => !line.trim().match(/^(safe|unsafe|s\d+\.?|rating\s*:?.*)$/i))
    .join(" ");
  t = t.replace(/\bunsafe\b/gi, "").replace(/\bsafe\b/gi, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  if (t.length < 6) return "";
  return t;
}

export default function VisionSpeak() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const nextScanTimer = useRef(null);
  const recognitionRef = useRef(null);
  const isActiveRef = useRef(false);

  const [status, setStatus] = useState("idle");
  const [detected, setDetected] = useState("");
  const [history, setHistory] = useState([]);
  const [scanProgress, setScanProgress] = useState(0);
  const [glitch, setGlitch] = useState(false);
  const [error, setError] = useState("");
  const [voiceCmd, setVoiceCmd] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  const speak = useCallback((text, onDone) => {
    if (!text) { if (onDone) onDone(); return; }
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 0.93; utt.pitch = 1.0; utt.volume = 1;
    utt.onend = () => { if (onDone) onDone(); };
    utt.onerror = () => { if (onDone) onDone(); };
    const trySpeak = () => {
      const voices = window.speechSynthesis.getVoices();
      const v = voices.find(v => v.name.includes("Google UK English Female"))
             || voices.find(v => v.name.includes("Samantha"))
             || voices.find(v => v.lang.startsWith("en"));
      if (v) utt.voice = v;
      window.speechSynthesis.speak(utt);
    };
    window.speechSynthesis.getVoices().length === 0
      ? (window.speechSynthesis.onvoiceschanged = trySpeak)
      : trySpeak();
  }, []);

  const doScan = useCallback(async () => {
    if (!isActiveRef.current || !videoRef.current || !canvasRef.current) return;

    const canvas = canvasRef.current;
    canvas.width = videoRef.current.videoWidth || 640;
    canvas.height = videoRef.current.videoHeight || 480;
    canvas.getContext("2d").drawImage(videoRef.current, 0, 0);
    const base64 = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];

    setStatus("scanning"); setGlitch(true); setError("");
    setTimeout(() => setGlitch(false), 300);

    let progress = 0;
    const pInt = setInterval(() => { progress = Math.min(progress + 8, 88); setScanProgress(progress); }, 200);

    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": "http://localhost:5173",
          "X-Title": "SceneSpeak"
        },
        body: JSON.stringify({
          model: "meta-llama/llama-3.2-11b-vision-instruct",
          max_tokens: 200,
          temperature: 0.3,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } }
            ]
          }]
        })
      });

      clearInterval(pInt); setScanProgress(100);
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

      const raw = data?.choices?.[0]?.message?.content || "";
      const text = cleanText(raw) || "I can see the scene but could not describe it clearly.";

      setDetected(text);
      setHistory(prev => [{ text, time: new Date().toLocaleTimeString() }, ...prev.slice(0, 6)]);
      setStatus("active");
      setTimeout(() => setScanProgress(0), 500);

      speak(text, () => {
        if (isActiveRef.current) nextScanTimer.current = setTimeout(doScan, 2000);
      });

    } catch (err) {
      clearInterval(pInt); setScanProgress(0); setStatus("active");
      setError("❌ " + (err.message || "Analysis failed."));
      if (isActiveRef.current) nextScanTimer.current = setTimeout(doScan, 10000);
    }
  }, [speak]);

  const startCamera = useCallback(async () => {
    if (isActiveRef.current) return;
    setStatus("starting"); setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      isActiveRef.current = true;
      setStatus("active");
      nextScanTimer.current = setTimeout(doScan, 1200);
    } catch {
      setStatus("error");
      setError("Camera access denied or unavailable.");
    }
  }, [doScan]);

  const stopCamera = useCallback(() => {
    isActiveRef.current = false;
    clearTimeout(nextScanTimer.current);
    window.speechSynthesis.cancel();
    if (videoRef.current?.srcObject) {
      videoRef.current.srcObject.getTracks().forEach(t => t.stop());
      videoRef.current.srcObject = null;
    }
    setStatus("idle"); setDetected(""); setScanProgress(0); setError("");
  }, []);

  const scanNow = useCallback(() => {
    if (!isActiveRef.current) return;
    clearTimeout(nextScanTimer.current);
    window.speechSynthesis.cancel();
    doScan();
  }, [doScan]);

  const startVoice = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || recognitionRef.current) return;
    const rec = new SR();
    rec.continuous = true; rec.interimResults = false; rec.lang = "en-US";
    recognitionRef.current = rec;
    rec.onresult = (e) => {
      const t = e.results[e.results.length - 1][0].transcript.toLowerCase().trim();
      setVoiceCmd(t);
      setTimeout(() => setVoiceCmd(""), 2000);
      if (t.match(/start|open|begin|camera on/)) startCamera();
      else if (t.match(/stop|close|end|camera off/)) stopCamera();
      else if (t.match(/scan|analyze|look|check/)) scanNow();
      else if (t.match(/history|log/)) setShowHistory(h => !h);
    };
    rec.onerror = () => {};
    rec.onend = () => { if (recognitionRef.current) try { recognitionRef.current.start(); } catch {} };
    try { rec.start(); } catch {}
  }, [startCamera, stopCamera, scanNow]);

  useEffect(() => { const t = setTimeout(startVoice, 800); return () => clearTimeout(t); }, [startVoice]);

  useEffect(() => () => {
    isActiveRef.current = false;
    clearTimeout(nextScanTimer.current);
    if (videoRef.current?.srcObject) videoRef.current.srcObject.getTracks().forEach(t => t.stop());
    if (recognitionRef.current) { recognitionRef.current.onend = null; try { recognitionRef.current.stop(); } catch {} }
  }, []);

  const isActive = status === "active" || status === "scanning";

  return (
    <div style={{ width:"100vw", height:"100vh", height:"100dvh", background:"#020408", overflow:"hidden", position:"fixed", inset:0, fontFamily:"'Courier New',monospace" }}>

      <style>{`
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        html,body,#root{width:100%;height:100%;overflow:hidden}
        @keyframes gridScroll{to{transform:translateY(40px)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
        @keyframes glitch{0%{transform:translate(0)}25%{transform:translate(-2px,1px)}75%{transform:translate(2px,-1px)}100%{transform:translate(0)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
        @keyframes scanVert{0%{top:-4%}100%{top:104%}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes slideUp{from{transform:translateY(100%);opacity:0}to{transform:translateY(0);opacity:1}}
        .btn{background:rgba(2,4,8,0.85);font-family:'Courier New',monospace;letter-spacing:2px;text-transform:uppercase;cursor:pointer;transition:all 0.18s;white-space:nowrap;font-size:clamp(9px,1.1vw,12px);padding:clamp(8px,1.5vh,12px) clamp(14px,2.5vw,24px);border-radius:2px}
        .btn-green{border:1.5px solid #00ff64;color:#00ff64}
        .btn-green:hover{background:#00ff64;color:#020408}
        .btn-green:disabled{opacity:0.35;cursor:not-allowed;pointer-events:none}
        .btn-red{border:1.5px solid #ff4444;color:#ff4444}
        .btn-red:hover{background:#ff4444;color:#020408}
        .btn-blue{border:1.5px solid #00aaff;color:#00aaff}
        .btn-blue:hover{background:#00aaff;color:#020408}
      `}</style>

      {/* ── BACKGROUND GRID ── */}
      <div style={{ position:"fixed", inset:0, zIndex:0, backgroundImage:`linear-gradient(rgba(0,255,100,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,100,0.025) 1px,transparent 1px)`, backgroundSize:"40px 40px", animation:"gridScroll 20s linear infinite", pointerEvents:"none" }} />

      {/* ── VIDEO — fills entire screen ── */}
      <video ref={videoRef} autoPlay muted playsInline style={{
        position: "absolute", inset: 0,
        width: "100%", height: "100%",
        objectFit: "cover",
        display: "block",
        background: "#000",
        filter: isActive ? "none" : "brightness(0.08)",
        animation: glitch ? "glitch 0.3s ease" : "none",
        zIndex: 1
      }} />
      <canvas ref={canvasRef} style={{ display:"none" }} />

      {/* ── SCAN SWEEP ── */}
      {status === "scanning" && (
        <div style={{ position:"absolute", left:0, right:0, height:"3px", background:"linear-gradient(90deg,transparent,#00ff64,rgba(0,255,100,0.3),#00ff64,transparent)", zIndex:6, boxShadow:"0 0 16px #00ff64, 0 0 40px rgba(0,255,100,0.3)", animation:"scanVert 1.6s linear infinite" }} />
      )}

      {/* ── PROGRESS BAR ── */}
      {scanProgress > 0 && (
        <div style={{ position:"absolute", top:0, left:0, zIndex:7, height:"3px", background:"#00ff64", width:`${scanProgress}%`, transition:"width 0.2s", boxShadow:"0 0 10px #00ff64" }} />
      )}

      {/* ── TOP BAR ── */}
      <div style={{
        position: "absolute", top:0, left:0, right:0, zIndex:8,
        padding: "clamp(10px,2vh,18px) clamp(14px,3vw,28px)",
        background: "linear-gradient(to bottom, rgba(2,4,8,0.85) 0%, rgba(2,4,8,0.4) 70%, transparent 100%)",
        display: "flex", alignItems: "flex-start", justifyContent: "space-between"
      }}>
        {/* Title */}
        <div>
          <div style={{ fontSize:"clamp(7px,0.85vw,9px)", letterSpacing:"4px", color:"rgba(0,255,100,0.6)", marginBottom:"3px" }}>VISION AI · FREE</div>
          <div style={{ fontSize:"clamp(15px,2.5vw,24px)", letterSpacing:"3px", fontWeight:"bold", color:"#00ff64", textShadow:"0 0 20px rgba(0,255,100,0.5)" }}>SCENE.SPEAK</div>
        </div>

        {/* Status + Voice */}
        <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:"6px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:"7px", background:"rgba(2,4,8,0.7)", padding:"5px 10px", border:"1px solid rgba(0,170,255,0.25)" }}>
            <div style={{ width:"6px", height:"6px", borderRadius:"50%", background:voiceCmd?"#ffcc00":"#00aaff", boxShadow:`0 0 8px ${voiceCmd?"#ffcc00":"#00aaff"}`, animation:"pulse 1.2s infinite" }} />
            <span style={{ fontSize:"clamp(7px,0.85vw,9px)", letterSpacing:"2px", color:"rgba(0,170,255,0.8)" }}>
              {voiceCmd ? `"${voiceCmd}"` : "MIC ON"}
            </span>
          </div>
          <div style={{
            fontSize:"clamp(9px,1vw,11px)", letterSpacing:"2px", padding:"4px 10px",
            background:"rgba(2,4,8,0.7)",
            border:`1px solid ${status==="error"?"rgba(255,68,68,0.4)":status==="scanning"?"rgba(255,204,0,0.4)":isActive?"rgba(0,255,100,0.4)":"rgba(0,255,100,0.15)"}`,
            color:status==="error"?"#ff4444":status==="scanning"?"#ffcc00":isActive?"#00ff64":"rgba(0,255,100,0.4)",
            animation:isActive?"pulse 1.5s infinite":"none"
          }}>
            {status==="idle"?"● STANDBY":status==="starting"?"◌ INIT...":status==="scanning"?"◈ ANALYZING...":status==="error"?"✕ ERROR":"● LIVE"}
          </div>
        </div>
      </div>

      {/* ── CORNER BRACKETS ── */}
      {isActive && [["top","left","2px 0 0 2px"],["top","right","2px 2px 0 0"],["bottom","left","0 0 2px 2px"],["bottom","right","0 2px 2px 0"]].map(([v,h,bw]) => (
        <div key={v+h} style={{ position:"absolute", width:"28px", height:"28px", borderColor:"rgba(0,255,100,0.6)", borderStyle:"solid", borderWidth:bw, zIndex:8, [v]:"16px", [h]:"16px", boxShadow:`${h==="left"?"-":""}4px ${v==="top"?"-":""}4px 12px rgba(0,255,100,0.15)` }} />
      ))}

      {/* ── IDLE OVERLAY ── */}
      {!isActive && status !== "starting" && (
        <div style={{ position:"absolute", inset:0, zIndex:5, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:"16px" }}>
          <div style={{ fontSize:"clamp(48px,10vw,80px)", opacity:0.06, color:"#00ff64" }}>◉</div>
          <div style={{ fontSize:"clamp(11px,1.5vw,14px)", letterSpacing:"5px", color:"rgba(0,255,100,0.25)" }}>
            {status==="error"?"CAMERA ERROR":"CAMERA OFFLINE"}
          </div>
          <div style={{ fontSize:"clamp(9px,1.1vw,11px)", letterSpacing:"3px", color:"rgba(0,255,100,0.13)", marginTop:"4px" }}>
            SAY "START" OR CLICK BUTTON BELOW
          </div>
        </div>
      )}

      {/* ── STARTING OVERLAY ── */}
      {status === "starting" && (
        <div style={{ position:"absolute", inset:0, zIndex:5, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:"16px" }}>
          <div style={{ width:"32px", height:"32px", border:"2px solid rgba(0,255,100,0.15)", borderTop:"2px solid #00ff64", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
          <div style={{ fontSize:"clamp(9px,1.2vw,12px)", letterSpacing:"5px", color:"rgba(0,255,100,0.55)" }}>STARTING CAMERA...</div>
        </div>
      )}

      {/* ── HISTORY PANEL (slide up on toggle) ── */}
      {showHistory && history.length > 0 && (
        <div style={{
          position:"absolute", left:0, right:0, bottom:"clamp(120px,20vh,160px)", zIndex:9,
          background:"rgba(2,4,8,0.92)", borderTop:"1px solid rgba(0,255,100,0.15)",
          padding:"clamp(12px,2vh,18px) clamp(14px,3vw,28px)",
          animation:"slideUp 0.3s ease",
          maxHeight:"40vh", overflowY:"auto"
        }}>
          <div style={{ fontSize:"clamp(7px,0.85vw,9px)", letterSpacing:"4px", color:"rgba(0,255,100,0.35)", marginBottom:"10px" }}>SCAN HISTORY</div>
          <div style={{ display:"flex", flexDirection:"column", gap:"8px" }}>
            {history.map((h,i) => (
              <div key={i} style={{ display:"flex", gap:"14px", padding:"8px 12px", border:"1px solid rgba(0,255,100,0.08)", background:"rgba(0,255,100,0.02)" }}>
                <span style={{ fontSize:"clamp(8px,0.9vw,10px)", color:"rgba(0,255,100,0.3)", whiteSpace:"nowrap", flexShrink:0 }}>{h.time}</span>
                <span style={{ fontSize:"clamp(10px,1.2vw,12px)", color:"rgba(200,255,218,0.6)", lineHeight:"1.5" }}>{h.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── BOTTOM PANEL — output + controls always visible ── */}
      <div style={{
        position: "absolute", bottom:0, left:0, right:0, zIndex:8,
        background: "linear-gradient(to top, rgba(2,4,8,0.95) 0%, rgba(2,4,8,0.8) 80%, transparent 100%)",
        padding: "clamp(24px,4vh,40px) clamp(14px,3vw,28px) clamp(14px,2.5vh,22px)"
      }}>

        {/* Detected text */}
        <div style={{ marginBottom:"clamp(10px,1.8vh,16px)", minHeight:"clamp(40px,6vh,60px)" }}>
          {detected ? (
            <div style={{ fontSize:"clamp(13px,1.8vw,18px)", lineHeight:"1.65", color:"#c8ffda", textShadow:"0 0 20px rgba(0,255,100,0.3)", animation:"fadeUp 0.4s ease" }}>
              {detected}
              <span style={{ animation:"blink 1s infinite", marginLeft:"3px", color:"#00ff64" }}>█</span>
            </div>
          ) : (
            <div style={{ fontSize:"clamp(11px,1.4vw,14px)", color:"rgba(0,255,100,0.2)", fontStyle:"italic" }}>
              {status==="starting"?"Warming up...":status==="idle"?"Say 'start' or click Start Camera...":"Scanning scene..."}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div style={{ marginBottom:"10px", padding:"8px 14px", border:"1px solid rgba(255,68,68,0.35)", background:"rgba(255,68,68,0.07)", color:"#ff7777", fontSize:"clamp(9px,1.1vw,11px)", lineHeight:"1.6" }}>
            {error}
          </div>
        )}

        {/* Controls row */}
        <div style={{ display:"flex", gap:"clamp(8px,1.5vw,12px)", alignItems:"center", flexWrap:"wrap" }}>
          {!isActive && status !== "starting" ? (
            <button className="btn btn-green" onClick={startCamera}>▶ START CAMERA</button>
          ) : (
            <>
              <button className="btn btn-red" onClick={stopCamera}>■ STOP</button>
              <button className="btn btn-green" onClick={scanNow} disabled={status==="scanning"}>⟳ SCAN NOW</button>
            </>
          )}

          {/* History toggle */}
          <button className="btn btn-blue" onClick={() => setShowHistory(h => !h)}>
            {showHistory ? "✕ HISTORY" : "☰ HISTORY"}
          </button>

          {/* Voice hint */}
          <div style={{ marginLeft:"auto", fontSize:"clamp(7px,0.85vw,9px)", letterSpacing:"2px", color:"rgba(0,170,255,0.4)" }}>
            🎙 "START" · "STOP" · "SCAN"
          </div>
        </div>
      </div>
    </div>
  );
}
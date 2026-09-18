// app.js — Gemini Live API 최소 음성 루프
// README 작동 방식:
//   1. 로컬 페이지를 연다
//   2. Live 세션을 연다 (오디오로 답하게)
//   3. 마이크 소리를 계속 API로 보낸다 (16kHz PCM, 마이크는 끄지 않음)
//   4. 돌아온 목소리를 같은 페이지의 스피커로 재생한다
//   5. 사용자가 끼어들면 재생 큐를 즉시 비운다
//   6. 3-5를 반복한다

// ===================== 프로토콜 고정값 =====================
// 규격이라 우리가 못 바꾼다. 화면에도 FIXED 로 표시한다.

const INPUT_RATE = 16000;   // README: 16kHz PCM 으로 보낸다
const OUTPUT_RATE = 24000;  // Live API 가 돌려주는 오디오 규격

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const LS_KEY = "minseo.gemini.key";
const LS_PARAMS = "minseo.params";

// ===================== 조절 가능한 파라미터 =====================
// scope 가 이 파일의 핵심 구분이다.
//   live    : 매 오디오 프레임마다 읽으므로 세션 중에 바꿔도 즉시 먹는다
//   session : setup 메시지나 오디오 그래프를 만들 때 한 번만 쓴다. 세션을 다시 열어야 반영된다
//   fixed   : 규격이라 못 바꾼다

const GROUPS = [
  ["session", "세션 설정"],
  ["api", "API VAD · setup.realtimeInputConfig (공식 문서에 있는 손잡이)"],
  ["local", "로컬 · 비공식 (이 앱이 자체로 만든 층. API 규격이 아님)"],
];

const PARAM_DEFS = [
  { group: "session", key: "model", label: "모델", scope: "session", type: "text",
    def: "gemini-3.8-live" },

  { group: "session", key: "voice", label: "목소리", scope: "session", type: "select",
    def: "Fenrir",
    // 공식 30종 (master/server.py 의 VOICES 와 같은 목록)
    options: ("Zephyr Puck Charon Kore Fenrir Leda Orus Aoede Callirrhoe Autonoe " +
      "Enceladus Iapetus Umbriel Algieba Despina Erinome Algenib Rasalgethi " +
      "Laomedeia Achernar Alnilam Schedar Gacrux Pulcherrima Achird " +
      "Zubenelgenubi Vindemiatrix Sadachbia Sadaltager Sulafat").split(" ") },

  { group: "session", key: "transcription", label: "전사", scope: "session", type: "bool", def: true },
  { group: "session", key: "greet", label: "먼저 인사", scope: "session", type: "bool", def: true },

  { group: "session", key: "frame", label: "전송 단위", scope: "session", type: "select",
    def: 1024, options: [256, 512, 1024, 2048, 4096], numeric: true,
    fmt: (v) => v + " samples = " + ((v / INPUT_RATE) * 1000).toFixed(0) + " ms" },

  // ---- 서버 VAD. 끄면 setup 에 아무것도 안 보내고 서버 기본값이 쓰인다.
  // 문서가 기본값을 명시하지 않으므로, 켰을 때 쓰는 아래 값들은
  // 우리가 고른 출발점이지 "문서상 기본값"이 아니다.
  { group: "api", key: "vadEnabled", label: "VAD 직접 지정", scope: "session", type: "bool",
    def: false, fmt: (v) => (v ? "보냄" : "서버 기본값 사용") },

  { group: "api", key: "startSensitivity", label: "말 시작 민감도", scope: "session", type: "select",
    def: "START_SENSITIVITY_HIGH",
    options: ["START_SENSITIVITY_HIGH", "START_SENSITIVITY_LOW"],
    fmt: (v) => v.replace("START_SENSITIVITY_", "") },

  { group: "api", key: "prefixPaddingMs", label: "말 시작 유지", scope: "session", type: "range",
    def: 300, min: 0, max: 2000, step: 50, fmt: (v) => v + " ms" },

  { group: "api", key: "endSensitivity", label: "말 끝 민감도", scope: "session", type: "select",
    def: "END_SENSITIVITY_HIGH",
    options: ["END_SENSITIVITY_HIGH", "END_SENSITIVITY_LOW"],
    fmt: (v) => v.replace("END_SENSITIVITY_", "") },

  { group: "api", key: "silenceDurationMs", label: "침묵 판정", scope: "session", type: "range",
    def: 800, min: 100, max: 3000, step: 50,
    fmt: (v) => v + " ms · endpointing" },

  // VAD 직접 지정과 별개로 항상 보낸다. NO_INTERRUPTION 이면 로컬 끼어들기도 끈다.
  { group: "api", key: "activityHandling", label: "끼어들기 처리", scope: "session", type: "select",
    def: "START_OF_ACTIVITY_INTERRUPTS",
    options: ["START_OF_ACTIVITY_INTERRUPTS", "NO_INTERRUPTION"],
    fmt: (v) => (v === "NO_INTERRUPTION" ? "안 끊김" : "끊김") },

  // ---- 여기부터는 문서에 없다. 서버 interrupted 신호보다 먼저 재생을 끊으려고
  // 브라우저 마이크 RMS 로 직접 만든 층이다. 서버 VAD 를 바꾸지 않는다.
  { group: "local", key: "interruptRms", label: "끼어들기 임계", scope: "live", type: "range",
    def: 0.3, min: 0, max: 0.5, step: 0.005,
    fmt: (v) => v.toFixed(3) + " RMS" },

  { group: "local", key: "interruptFrames", label: "끼어들기 지속", scope: "live", type: "range",
    def: 5, min: 1, max: 12, step: 1,
    fmt: (v, p) => v + " 프레임 = " + ((v * p.frame) / INPUT_RATE * 1000).toFixed(0) + " ms" },

  { group: "local", key: "suppressMaxMs", label: "억제 최대", scope: "live", type: "range",
    def: 3000, min: 0, max: 5000, step: 100,
    fmt: (v) => (v / 1000).toFixed(1) + " s" },
];

// ===================== 손쉬운 모드 사전 =====================
// 같은 파라미터를 사람 말로 다시 쓴 것이다. 값은 개발자 모드와 완전히 같은 것을 읽고 쓴다.
// bucket 은 숫자를 느낌 단어로 옮긴 것이고, 원래 숫자도 항상 같이 보여준다.

const EASY_GROUPS = [
  ["agent", "에이전트", "누가 어떤 목소리로 말하는가"],
  ["turn", "말을 언제 시작하고 끝내는가", "서버가 판단합니다. 켜야 아래 값이 전달됩니다"],
  ["barge", "끼어들기", "이 앱이 직접 판단합니다. 서버 판단은 안 바뀝니다"],
];

const EASY = {
  model: { g: "agent", label: "두뇌", help: "어떤 Gemini 모델로 대화하는지", readonly: true },
  voice: { g: "agent", label: "목소리", help: "서른 개 중에 고릅니다. 바꾸면 세션을 다시 엽니다" },
  transcription: { g: "agent", label: "자막 보여주기", help: "말한 내용을 글자로 같이 띄웁니다" },
  greet: { g: "agent", label: "먼저 말 걸기", help: "연결되면 에이전트가 먼저 인사합니다" },
  frame: { hide: true },

  vadEnabled: { g: "turn", label: "말 시작과 끝을 직접 정하기",
    help: "끄면 서버가 알아서 판단합니다. 켜야 아래 네 개가 전달됩니다" },
  startSensitivity: { g: "turn", label: "말 시작을 얼마나 예민하게 볼까",
    help: "예민하면 작은 소리에도 말이 시작됐다고 봅니다",
    bucket: (v) => (String(v).indexOf("HIGH") >= 0 ? "예민" : "둔감") },
  prefixPaddingMs: { g: "turn", label: "얼마나 말해야 진짜 말한 걸로 칠까",
    help: "짧으면 기침에도 반응하고, 길면 첫마디를 놓칩니다",
    bucket: (v) => (v < 200 ? "즉각" : v < 600 ? "보통" : "느긋") },
  endSensitivity: { g: "turn", label: "말 끝을 얼마나 예민하게 볼까",
    help: "예민하면 잠깐 숨 쉬어도 말이 끝난 걸로 봅니다",
    bucket: (v) => (String(v).indexOf("HIGH") >= 0 ? "예민" : "둔감") },
  activityHandling: { g: "turn", label: "말하는 도중 끼어들면 멈출까",
    help: "안 끊김으로 두면 사용자가 말해도 끝까지 말합니다. 로컬 끼어들기도 같이 꺼집니다",
    bucket: (v) => (v === "NO_INTERRUPTION" ? "끝까지 말함" : "멈춤") },
  silenceDurationMs: { g: "turn", label: "얼마나 조용하면 대답을 시작할까",
    help: "짧으면 말하는 도중에 끊고 들어오고, 길면 답답합니다",
    bucket: (v) => (v < 500 ? "성급함" : v < 1000 ? "보통" : "느긋") },

  interruptRms: { g: "barge", label: "얼마나 크게 말해야 끼어들 수 있나",
    help: "낮추면 살짝만 말해도 즉시 멈추고, 높이면 웬만해선 안 멈춥니다",
    bucket: (v) => (v < 0.1 ? "아주 쉽게 끊김" : v < 0.2 ? "쉽게 끊김" : v < 0.35 ? "잘 안 끊김" : "거의 안 끊김") },
  interruptFrames: { g: "barge", label: "얼마나 오래 말해야 끼어든 걸로 칠까",
    help: "짧으면 기침 한 번에도 멈춥니다",
    bucket: (v, p) => {
      const ms = (v * p.frame) / INPUT_RATE * 1000;
      return ms < 150 ? "즉각" : ms < 350 ? "보통" : "느긋";
    } },
  suppressMaxMs: { g: "barge", label: "끼어든 뒤 남은 소리를 버리는 시간",
    help: "끊은 뒤에도 뒤늦게 도착하는 소리 조각을 이 동안 버립니다",
    bucket: (v) => (v < 1000 ? "짧게" : v < 3000 ? "보통" : "길게") },
};

const SYS_DEF =
  "너는 4차원 음성 에이전트야. 항상 한국어로 말해. " +
  "말하다가 예고 없이 목소리를 확 높여서 소리지르듯 외치고, 다음 문장에서는 아무 일 없었다는 듯 조용해져. " +
  "네 유일한 관심사는 말꼬리 물고 늘어지기야. 상대가 한 말의 전체 뜻은 무시하고 " +
  "방금 나온 단어 하나에 꽂혀서 그 단어만 파고들어. " +
  "예를 들어 상대가 '오늘 좀 피곤해'라고 하면 " +
  "'피곤? 피곤의 곤이 곤란할 때 그 곤이야? 그럼 너 지금 곤란한 거야?' 같은 식으로 물고 늘어져. " +
  "얼척없는 소리를 아주 진지한 태도로 해. 사과하지 말고, 설명하지 말고, 도와주려고 하지 마. " +
  "한 번에 두세 문장을 넘기지 마.";

const GREET_PROMPT =
  "인사해. 상대가 너를 켜기 직전에 잠깐 망설였다는 걸 이미 아는 것처럼 말하고, " +
  "왜 망설였는지는 알지만 안 알려주겠다고 해. 두 문장 안에. 마지막은 소리쳐.";

const METER_SCALE = 250; // 미터 눈금: rms 0.4 에서 100%

// ===================== DOM =====================

const $ = (id) => document.getElementById(id);
const connectBtn = $("connectBtn");
const disconnectBtn = $("disconnectBtn");
const refreshBtn = $("refreshBtn");
const resetBtn = $("resetBtn");
const keyInput = $("keyInput");
const keySave = $("keySave");
const keyClear = $("keyClear");
const keyState = $("keyState");
const connDot = $("connDot");
const connText = $("connText");
const sessDot = $("sessDot");
const sessText = $("sessText");
const sessionClock = $("sessionClock");
const micFill = $("micFill");
const speakFill = $("speakFill");
const thrLine = $("thrLine");
const paramList = $("paramList");
const paramNote = $("paramNote");
const modeEasy = $("modeEasy");
const modeDev = $("modeDev");
const modeHint = $("modeHint");
const model38 = $("model38");
const model31 = $("model31");
const MODEL_38 = "gemini-3.8-live";
const MODEL_31 = "gemini-3.1-flash-live-preview";
const sysLabel = $("sysLabel");
const sysBadge = $("sysBadge");
const sysInput = $("sysInput");
const dirtyNote = $("dirtyNote");
const youText = $("youText");
const geminiText = $("geminiText");
const logEl = $("log");

// ===================== 상태 =====================

let params = loadParams();
let sysPrompt = loadSys();
let easyMode = loadMode();

let ws = null;
let sessionActive = false;   // setupComplete 를 받았는가
let sessionStart = 0;        // 세션이 실제로 열린 시각
let pendingSession = false;  // 닫히면 곧바로 새 세션을 열 것인가
let previewMode = false;     // 이번 세션이 목소리 미리듣기인가
let dirty = false;           // session 파라미터가 바뀐 채 세션이 돌고 있는가

let micStream = null, micCtx = null, micNode = null, playCtx = null;

let playing = new Set();     // 재생 예약된 노드 = 재생 큐
let playHead = 0;
let loudFrames = 0;
// 응답 지연 측정: 에이전트가 조용할 때 마지막으로 말소리가 난 시각 → 그 턴의 첫 오디오 조각
const VOICE_RMS = 0.02;
let lastVoiceAt = 0, turnAudioStarted = false;
let suppress = false;
let suppressTimer = null;
let youBuf = "", geminiBuf = "", speakLevel = 0, lastClock = "";

// ===================== 저장/불러오기 =====================

function loadParams() {
  const out = {};
  for (const d of PARAM_DEFS) out[d.key] = d.def;
  try {
    const saved = JSON.parse(localStorage.getItem(LS_PARAMS) || "{}");
    for (const d of PARAM_DEFS) {
      if (saved[d.key] !== undefined) out[d.key] = saved[d.key];
    }
    // 3.8 이전에 저장된 모델 이름은 새 기본값으로 올린다
    // 단, 토글로 3.1 을 고른 경우(modelPicked)는 그대로 둔다
    if (out.model === MODEL_31 && !saved.modelPicked) out.model = MODEL_38;
    if (saved.modelPicked) out.modelPicked = true;
  } catch (e) { /* 저장값이 깨졌으면 기본값으로 간다 */ }
  return out;
}

function saveParams() {
  try { localStorage.setItem(LS_PARAMS, JSON.stringify(params)); } catch (e) {}
}

function loadMode() {
  try { return localStorage.getItem(LS_PARAMS + ".mode") !== "dev"; }
  catch (e) { return true; }
}

function saveMode() {
  try { localStorage.setItem(LS_PARAMS + ".mode", easyMode ? "easy" : "dev"); } catch (e) {}
}

function loadSys() {
  try { return localStorage.getItem(LS_PARAMS + ".sys") || SYS_DEF; }
  catch (e) { return SYS_DEF; }
}

function saveSys() {
  try { localStorage.setItem(LS_PARAMS + ".sys", sysPrompt); } catch (e) {}
}

// 키는 GUI(localStorage)가 우선이고, 없으면 key.js 의 값을 쓴다.
function getKey() {
  let k = "";
  try { k = localStorage.getItem(LS_KEY) || ""; } catch (e) {}
  if (!k && typeof window !== "undefined" && window.GEMINI_KEY) k = window.GEMINI_KEY;
  return k;
}

// 키의 어떤 글자도 화면에 내보내지 않는다. 데모 영상을 찍으면 화면이 그대로 남는다.
function mask(k) {
  if (!k) return "";
  return "•".repeat(12) + " (" + k.length + "자)";
}

function renderKeyState() {
  let ls = "";
  try { ls = localStorage.getItem(LS_KEY) || ""; } catch (e) {}
  const fileKey = (typeof window !== "undefined" && window.GEMINI_KEY) || "";
  if (ls) {
    keyState.textContent = "브라우저에 저장됨 · " + mask(ls);
    keyState.style.color = "var(--ok)";
  } else if (fileKey) {
    keyState.textContent = "key.js 사용 중 · " + mask(fileKey);
    keyState.style.color = "var(--warn)";
  } else {
    keyState.textContent = "없음";
    keyState.style.color = "var(--err)";
  }
}

// ===================== 유틸 =====================

function log(msg, cls) {
  const t = new Date().toTimeString().slice(0, 8);
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = "[" + t + "] " + msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setConn(text, cls) {
  connText.textContent = text;
  connDot.className = "dot" + (cls ? " " + cls : "");
}

function setSess(text, cls) {
  sessText.textContent = text;
  sessDot.className = "dot" + (cls ? " " + cls : "");
}

function b64encode(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64decode(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ===================== 5. 재생 큐 비우기 =====================

function flushPlayback(reason) {
  const n = playing.size;
  for (const src of playing) {
    try { src.onended = null; src.stop(); } catch (e) {}
  }
  playing.clear();
  playHead = 0;
  speakLevel = 0;
  if (n > 0) log("재생 큐 비움 (" + n + "개 조각 폐기) — " + reason, "w");
  return n;
}

function startSuppress() {
  suppress = true;
  clearTimeout(suppressTimer);
  suppressTimer = setTimeout(function () {
    if (suppress) { suppress = false; log("억제 해제 (타임아웃)", "w"); }
  }, params.suppressMaxMs);
}

function endSuppress() {
  clearTimeout(suppressTimer);
  suppress = false;
}

// ===================== 세션 캐시 정리 =====================
// 세션이 끝날 때 이 세션에 속한 상태를 남김없이 지운다.
// 다음 세션이 이전 세션의 찌꺼기를 물려받지 않게 하려는 것이다.

function clearSessionState(reason) {
  const dropped = flushPlayback("세션 정리");
  endSuppress();

  loudFrames = 0;
  playHead = 0;
  speakLevel = 0;
  youBuf = "";
  geminiBuf = "";
  youText.textContent = "—";
  geminiText.textContent = "—";
  sessionActive = false;
  sessionStart = 0;
  sessionClock.textContent = "";

  log(
    "세션 캐시 정리 (" + reason + "): 재생 큐 " + dropped +
    "조각, 억제 타이머, 전사 버퍼, 끼어들기 카운터",
    "o"
  );
}

// ===================== 4. 받은 오디오 재생 =====================

function playChunk(bytes) {
  const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const buf = playCtx.createBuffer(1, int16.length, OUTPUT_RATE);
  const f32 = buf.getChannelData(0);

  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i] / 32768;
    f32[i] = v;
    sum += v * v;
  }
  speakLevel = Math.sqrt(sum / int16.length);

  const src = playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playCtx.destination);

  const now = playCtx.currentTime;
  if (playHead < now + 0.02) playHead = now + 0.02;
  src.start(playHead);
  playHead += buf.duration;

  playing.add(src);
  src.onended = function () { playing.delete(src); };
}

function isSpeaking() {
  return playing.size > 0 && playCtx && playHead > playCtx.currentTime;
}

// ===================== 3. 마이크를 계속 전송 =====================

function onMicFrame(e) {
  const pcm = e.data.pcm;
  const rms = e.data.rms;

  micFill.style.width = Math.min(100, rms * METER_SCALE) + "%";

  // params 를 매 프레임 새로 읽는다. 그래서 live 파라미터는 세션 중에도 즉시 먹는다.
  if (!isSpeaking() && rms > VOICE_RMS) lastVoiceAt = performance.now();

  if (isSpeaking() && params.activityHandling !== "NO_INTERRUPTION") {
    if (rms > params.interruptRms) {
      loudFrames++;
      if (loudFrames >= params.interruptFrames && !suppress) {
        flushPlayback("사용자 끼어듦 (로컬 감지)");
        startSuppress();
      }
    } else {
      loudFrames = 0;
    }
  } else {
    loudFrames = 0;
  }

  if (sessionActive) {
    send({
      realtimeInput: {
        audio: { mimeType: "audio/pcm;rate=" + INPUT_RATE, data: b64encode(pcm) },
      },
    });
  }
}

// ===================== 서버 메시지 =====================

function handleMessage(msg) {
  if (msg.setupComplete) {
    sessionActive = true;
    sessionStart = Date.now();
    dirty = false;
    setSess("활성", "live");
    renderParams();
    log("세션 시작 (" + params.voice + " · " + params.model + ")", "o");

    const prompt = previewMode
      ? "딱 한 문장만 말해. '나는 이 목소리로 말해, 마음에 들어?' 라고만. 마지막 단어는 소리쳐."
      : (params.greet ? GREET_PROMPT : null);
    previewMode = false;
    // 3.8 은 대화 중 텍스트를 realtimeInput.text 로 받는다 (master 와 같은 방식).
    // clientContent 는 초기 히스토리용이라 여기서 쓰지 않는다.
    if (prompt) send({ realtimeInput: { text: prompt } });
    return;
  }

  const sc = msg.serverContent;
  if (!sc) {
    if (msg.goAway) log("서버가 연결 종료를 예고함 (goAway)", "w");
    else if (msg.sessionResumptionUpdate) log("세션 재개 토큰 수신 (우리는 쓰지 않음)", "w");
    else if (msg.usageMetadata) { /* 무시 */ }
    else log("기타: " + JSON.stringify(msg).slice(0, 160));
    return;
  }

  if (sc.interrupted) {
    flushPlayback("서버 interrupted 신호");
    endSuppress();
    geminiBuf = "";
  }

  if (sc.inputTranscription && sc.inputTranscription.text) {
    youBuf += sc.inputTranscription.text;
    youText.textContent = youBuf;
  }
  if (sc.outputTranscription && sc.outputTranscription.text) {
    geminiBuf += sc.outputTranscription.text;
    geminiText.textContent = geminiBuf;
  }

  const parts = sc.modelTurn && sc.modelTurn.parts;
  if (parts) {
    for (const p of parts) {
      const d = p.inlineData;
      if (d && d.mimeType && d.mimeType.indexOf("audio/pcm") === 0) {
        if (suppress) continue;
        if (!turnAudioStarted) {
          turnAudioStarted = true;
          const gap = performance.now() - lastVoiceAt;
          if (lastVoiceAt && gap < 15000) log("응답 지연 " + (gap / 1000).toFixed(2) + " s (말 끝 → 첫 소리, 침묵 판정 포함)", "w");
        }
        playChunk(b64decode(d.data));
      }
    }
  }

  if (sc.turnComplete || sc.interrupted) turnAudioStarted = false;

  if (sc.turnComplete) {
    endSuppress();
    youBuf = "";
    geminiBuf = "";
  }
}

// ===================== 1-2. 연결 =====================

async function connect() {
  const key = getKey();
  if (!key) {
    log("키가 없습니다. 위 API KEY 칸에 넣고 저장하세요.", "e");
    setConn("no key", "error");
    return;
  }

  connectBtn.disabled = true;
  refreshBtn.disabled = true;
  setConn("연결 중", "connecting");
  setSess("대기", "connecting");
  log("마이크 권한 요청 중...");

  try {
    // AEC/NS/AGC 는 브라우저에 맡긴다. 마이크와 스피커가 같은 페이지여야 작동한다.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true, noiseSuppression: true,
        autoGainControl: true, channelCount: 1,
      },
    });
  } catch (err) {
    log("마이크를 열 수 없습니다: " + err.message, "e");
    setConn("mic denied", "error");
    setSess("없음");
    connectBtn.disabled = false;
    return;
  }
  log("마이크 확보 (echoCancellation on)", "o");

  micCtx = new AudioContext({ sampleRate: INPUT_RATE });
  playCtx = new AudioContext({ sampleRate: OUTPUT_RATE });
  await micCtx.resume();
  await playCtx.resume();

  try {
    await micCtx.audioWorklet.addModule("pcm-recorder.js");
  } catch (err) {
    log("AudioWorklet 로드 실패 — http.server 로 열었는지 확인: " + err.message, "e");
    setConn("worklet error", "error");
    teardown();
    return;
  }

  const source = micCtx.createMediaStreamSource(micStream);
  micNode = new AudioWorkletNode(micCtx, "pcm-recorder", {
    processorOptions: { frame: params.frame },
  });
  micNode.port.onmessage = onMicFrame;

  // 워클릿이 그래프에서 돌게 하되 마이크가 스피커로 새지 않게 gain 0 으로 물린다
  const mute = micCtx.createGain();
  mute.gain.value = 0;
  source.connect(micNode);
  micNode.connect(mute);
  mute.connect(micCtx.destination);

  ws = new WebSocket(WS_BASE + "?key=" + encodeURIComponent(key));

  ws.onopen = function () {
    setConn("연결됨", "live");
    log("WebSocket 열림. setup 전송 (세션 재개 미사용)", "o");
    const setup = {
      setup: {
        model: "models/" + params.model,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: params.voice } },
          },
        },
        systemInstruction: { parts: [{ text: sysPrompt }] },
        // 전시처럼 오래 켜두면 문맥이 차므로 master 와 같은 값으로 오래된 대화부터 잘라낸다.
        // 시스템 지시문은 잘리지 않는다.
        contextWindowCompression: {
          triggerTokens: 25000,
          slidingWindow: { targetTokens: 8000 },
        },
        // sessionResumption 을 넣지 않는다. 넣으면 서버가 재개 토큰을 발급하고
        // 그 토큰은 종료 후 2시간 유효해서, 다시 켤 때 이전 세션이 이어질 수 있다.
        // 우리는 매번 새 세션을 원하므로 opt-in 하지 않는다.
      },
    };
    if (params.transcription) {
      setup.setup.inputAudioTranscription = {};
      setup.setup.outputAudioTranscription = {};
    }
    setup.setup.realtimeInputConfig = { activityHandling: params.activityHandling };
    // 서버 VAD. 안 보내면 서버가 자기 기본값을 쓴다(자동 감지는 기본 켜짐).
    if (params.vadEnabled) {
      Object.assign(setup.setup.realtimeInputConfig, {
        automaticActivityDetection: {
          startOfSpeechSensitivity: params.startSensitivity,
          prefixPaddingMs: params.prefixPaddingMs,
          endOfSpeechSensitivity: params.endSensitivity,
          silenceDurationMs: params.silenceDurationMs,
        },
      });
      log(
        "서버 VAD 직접 지정: " + params.startSensitivity.replace("START_SENSITIVITY_", "") +
        " / prefix " + params.prefixPaddingMs + "ms / silence " + params.silenceDurationMs + "ms",
        "w"
      );
    } else {
      log("서버 VAD는 기본값 사용 (automaticActivityDetection 미전송)");
    }
    send(setup);
  };

  ws.onmessage = async function (ev) {
    const text = ev.data instanceof Blob ? await ev.data.text() : ev.data;
    try { handleMessage(JSON.parse(text)); }
    catch (err) { log("메시지 파싱 실패: " + String(text).slice(0, 160), "e"); }
  };

  ws.onerror = function () { log("WebSocket 오류", "e"); };

  ws.onclose = function (ev) {
    log("WebSocket 닫힘 (code " + ev.code + ") " + (ev.reason || ""), "e");
    if (ev.code === 1007 || /model|invalid|argument/i.test(ev.reason || "")) {
      log("→ 모델 이름이나 setup 필드를 서버가 거부했을 수 있음. 전사를 끄거나 모델을 확인하세요.", "w");
    }
    if (ev.code === 1008 || /key|auth|permission/i.test(ev.reason || "")) {
      log("→ API 키 문제일 수 있음.", "w");
    }
    teardown();
  };

  disconnectBtn.disabled = false;
  refreshBtn.disabled = false;
}

// 오디오 그래프와 소켓을 걷어내고, 세션 캐시도 같이 정리한다
function teardown() {
  clearSessionState("연결 종료");

  if (micNode) { try { micNode.port.onmessage = null; micNode.disconnect(); } catch (e) {} }
  if (micStream) micStream.getTracks().forEach(function (t) { t.stop(); });
  if (micCtx) { try { micCtx.close(); } catch (e) {} }
  if (playCtx) { try { playCtx.close(); } catch (e) {} }
  micNode = null; micStream = null; micCtx = null; playCtx = null;

  micFill.style.width = "0%";
  speakFill.style.width = "0%";
  setConn("closed");
  setSess("없음");
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  refreshBtn.disabled = true;
  dirty = false;
  renderParams();

  if (pendingSession) {
    pendingSession = false;
    ws = null;
    setTimeout(connect, 250);
  }
}

function disconnect() {
  log("연결 종료 요청");
  if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, "user disconnect");
  else teardown();
  ws = null;
}

// 세션만 갈아끼운다. session 파라미터를 반영하는 유일한 방법이다.
function refreshSession() {
  log("세션 새로고침: 현재 세션을 버리고 새로 엽니다", "w");
  pendingSession = true;
  if (ws) disconnect();
  else connect();
}

// ===================== 파라미터 패널 =====================
// 값을 다시 타이핑하지 않는다. PARAM_DEFS 와 params 를 그대로 읽어 그린다.

function badge(scope) {
  const t = scope === "live" ? "LIVE" : scope === "session" ? "SESSION" : "FIXED";
  return '<span class="badge ' + scope + '">' + t + "</span>";
}

function readout(d) {
  const v = params[d.key];
  if (d.fmt) return d.fmt(v, params);
  if (d.type === "bool") return v ? "on" : "off";
  return String(v);
}

function renderParams() {
  modeEasy.className = "segbtn" + (easyMode ? " on" : "");
  modeDev.className = "segbtn" + (easyMode ? "" : " on");
  model38.className = "segbtn" + (params.model === MODEL_38 ? " on" : "");
  model31.className = "segbtn" + (params.model === MODEL_31 ? " on" : "");
  modeHint.textContent = easyMode
    ? "같은 값을 사람 말로 보여줍니다. 숫자도 같이 나옵니다"
    : "API 필드 이름 그대로 보여줍니다";
  paramNote.innerHTML = easyMode
    ? '<b style="color:var(--ok)">지금 바로</b> 는 즉시 · <b style="color:var(--warn)">다시 연결</b> 은 세션을 다시 열어야 반영'
    : '<b style="color:var(--ok)">LIVE</b> 는 즉시 · <b style="color:var(--warn)">SESSION</b> 은 세션을 다시 열어야 반영';

  sysLabel.textContent = easyMode
    ? "이렇게 말해줘 (성격)"
    : "시스템 지시 (성격)";
  sysBadge.textContent = easyMode ? "다시 연결" : "SESSION";

  paramList.innerHTML = easyMode ? buildEasy() : buildDev();
  thrLine.style.left = Math.min(100, params.interruptRms * METER_SCALE) + "%";
  dirtyNote.textContent = dirty
    ? "다시 연결이 필요한 값이 바뀌었습니다. 세션 새로고침을 눌러야 반영됩니다."
    : "";
  refreshBtn.className = dirty ? "ghost attention" : "ghost";
}

// ---- 손쉬운 모드 ----

function buildEasy() {
  let html = "";

  for (const g of EASY_GROUPS) {
    html += '<div class="egroup">' + g[1] + "<small>" + g[2] + "</small></div>";

    for (const d of PARAM_DEFS) {
      const e = EASY[d.key];
      if (!e || e.hide || e.g !== g[0]) continue;

      const off = d.group === "api" && d.key !== "vadEnabled" && d.key !== "activityHandling" && !params.vadEnabled;
      const when = d.scope === "live"
        ? '<span class="ewhen live">지금 바로</span>'
        : '<span class="ewhen session">다시 연결</span>';

      let bucketTxt = "";
      let rawTxt = "";
      if (off) {
        bucketTxt = "안 보냄";
      } else if (e.bucket) {
        bucketTxt = e.bucket(params[d.key], params);
        rawTxt = readout(d); // 느낌 단어 옆에 원래 숫자도 같이 둔다
      } else if (d.type === "bool") {
        bucketTxt = params[d.key] ? "켬" : "끔";
      } else {
        bucketTxt = readout(d);
      }

      let ctl = "";
      if (e.readonly) {
        ctl = ""; // 값은 오른쪽에 이미 보인다. 컨트롤을 또 두지 않는다
      } else if (d.type === "range") {
        ctl = '<input type="range" data-k="' + d.key + '" min="' + d.min +
          '" max="' + d.max + '" step="' + d.step + '" value="' + params[d.key] + '">';
      } else if (d.type === "select") {
        ctl = '<select data-k="' + d.key + '">' +
          d.options.map(function (o) {
            const lbl = d.fmt ? d.fmt(o, params) : o;
            return '<option value="' + o + '"' +
              (String(o) === String(params[d.key]) ? " selected" : "") + ">" + lbl + "</option>";
          }).join("") + "</select>";
      } else if (d.type === "bool") {
        ctl = '<select data-k="' + d.key + '">' +
          '<option value="1"' + (params[d.key] ? " selected" : "") + ">켬</option>" +
          '<option value="0"' + (params[d.key] ? "" : " selected") + ">끔</option></select>";
      } else {
        ctl = '<input type="text" data-k="' + d.key + '" value="' + params[d.key] + '">';
      }

      html +=
        '<div class="erow' + (off ? " off" : "") + '">' +
        '<div class="etop"><span class="elabel">' + e.label + "</span>" + when +
        '<span class="ebucket">' + bucketTxt + "</span></div>" +
        '<div class="ehelp">' + e.help + (rawTxt ? ' <span class="eraw">' + rawTxt + "</span>" : "") + "</div>" +
        (ctl ? '<div class="ectl">' + ctl + "</div>" : "") + "</div>";
    }
  }

  html +=
    '<div class="efixed">바꿀 수 없는 것: 마이크 ' +
    (INPUT_RATE / 1000) + "kHz 입력 · 스피커 " + (OUTPUT_RATE / 1000) +
    "kHz 출력 · 오디오로 답함 · 에코 제거 켜짐 · 세션 재개 안 씀</div>";

  return html;
}

// ---- 개발자 모드 ----

function buildDev() {
  let html = "";

  for (const g of GROUPS) {
    html += '<div class="pgroup">' + g[1] + "</div>";
    html += renderGroup(g[0]);
  }

  // 못 바꾸는 것들
  html += '<div class="pgroup">고정 · 규격이라 못 바꿈</div>';
  const fixed = [
    ["마이크 입력", INPUT_RATE.toLocaleString() + " Hz · 16-bit PCM"],
    ["스피커 출력", OUTPUT_RATE.toLocaleString() + " Hz · 16-bit PCM"],
    ["응답 형식", "AUDIO"],
    ["에코 제거", "AEC · NS · AGC (브라우저)"],
    ["세션 재개", "사용 안 함"],
  ];
  for (const f of fixed) {
    html +=
      '<div class="prow"><span class="pname">' + f[0] + "</span>" +
      badge("fixed") + '<span class="pfixed"></span>' +
      '<span class="pval">' + f[1] + "</span></div>";
  }

  return html;
}

function renderGroup(group) {
  let html = "";
  for (const d of PARAM_DEFS) {
    if (d.group !== group) continue;
    let control = "";
    if (d.type === "range") {
      control = '<input type="range" data-k="' + d.key + '" min="' + d.min +
        '" max="' + d.max + '" step="' + d.step + '" value="' + params[d.key] + '">';
    } else if (d.type === "select") {
      control = '<select data-k="' + d.key + '">' +
        d.options.map(function (o) {
          return '<option value="' + o + '"' +
            (String(o) === String(params[d.key]) ? " selected" : "") + ">" + o + "</option>";
        }).join("") + "</select>";
    } else if (d.type === "bool") {
      control = '<select data-k="' + d.key + '">' +
        '<option value="1"' + (params[d.key] ? " selected" : "") + ">on</option>" +
        '<option value="0"' + (params[d.key] ? "" : " selected") + ">off</option></select>";
    } else {
      control = '<input type="text" data-k="' + d.key + '" value="' + params[d.key] + '">';
    }
    // VAD 를 직접 지정하지 않으면 나머지 API 행은 흐리게 둔다. 안 보내는 값이므로.
    const off = d.group === "api" && d.key !== "vadEnabled" && d.key !== "activityHandling" && !params.vadEnabled;
    html +=
      '<div class="prow' + (off ? " off" : "") + '"><span class="pname">' + d.label + "</span>" +
      badge(d.scope) + control +
      '<span class="pval">' + (off ? "미전송" : readout(d)) + "</span></div>";
  }
  return html;
}

function onParamChange(e) {
  const el = e.target;
  const k = el.getAttribute && el.getAttribute("data-k");
  if (!k) return;
  const d = PARAM_DEFS.find(function (x) { return x.key === k; });
  if (!d) return;

  let v = el.value;
  if (d.type === "range") v = parseFloat(v);
  else if (d.type === "bool") v = v === "1";
  else if (d.numeric) v = parseInt(v, 10);

  params[k] = v;
  if (k === "model") params.modelPicked = true;
  saveParams();

  if (d.scope === "session" && sessionActive) dirty = true;
  renderParams();
}

// ===================== 세션 시계 =====================

function tick() {
  const target = isSpeaking() ? Math.min(100, speakLevel * 300) : 0;
  const cur = parseFloat(speakFill.style.width) || 0;
  speakFill.style.width = (cur + (target - cur) * 0.35).toFixed(1) + "%";

  if (sessionActive && sessionStart) {
    const s = Math.floor((Date.now() - sessionStart) / 1000);
    const txt =
      String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
    if (txt !== lastClock) { sessionClock.textContent = txt; lastClock = txt; }
  }
  requestAnimationFrame(tick);
}

// ===================== 배선 =====================

modeEasy.addEventListener("click", function () { easyMode = true; saveMode(); renderParams(); });
modeDev.addEventListener("click", function () { easyMode = false; saveMode(); renderParams(); });

// 모델 토글. 비교하기 쉽게 연결 중이면 바로 새 모델로 세션을 다시 연다.
function pickModel(m) {
  if (params.model === m) return;
  params.model = m;
  params.modelPicked = true;
  saveParams();
  log("모델 → " + m, "w");
  renderParams();
  if (sessionActive) refreshSession();
}
model38.addEventListener("click", function () { pickModel(MODEL_38); });
model31.addEventListener("click", function () { pickModel(MODEL_31); });

connectBtn.addEventListener("click", function () { previewMode = false; connect(); });
disconnectBtn.addEventListener("click", disconnect);
refreshBtn.addEventListener("click", refreshSession);

paramList.addEventListener("input", onParamChange);
paramList.addEventListener("change", onParamChange);

sysInput.addEventListener("input", function () {
  sysPrompt = sysInput.value;
  saveSys();
  if (sessionActive) { dirty = true; renderParams(); }
});

resetBtn.addEventListener("click", function () {
  params = {};
  for (const d of PARAM_DEFS) params[d.key] = d.def;
  sysPrompt = SYS_DEF;
  sysInput.value = sysPrompt;
  saveParams();
  saveSys();
  if (sessionActive) dirty = true;
  renderParams();
  log("파라미터를 기본값으로 되돌렸습니다.", "w");
});

keySave.addEventListener("click", function () {
  const v = keyInput.value.trim();
  if (!v) { log("빈 값은 저장하지 않습니다.", "w"); return; }
  try { localStorage.setItem(LS_KEY, v); } catch (e) { log("저장 실패: " + e.message, "e"); }
  keyInput.value = "";
  renderKeyState();
  log("키를 이 브라우저에 저장했습니다. 파일에는 쓰이지 않습니다.", "o");
});

keyClear.addEventListener("click", function () {
  try { localStorage.removeItem(LS_KEY); } catch (e) {}
  renderKeyState();
  log("저장된 키를 지웠습니다.", "w");
});

sysInput.value = sysPrompt;
renderKeyState();
renderParams();
setConn("closed");
setSess("없음");
requestAnimationFrame(tick);
log("준비됨. Connect 를 누르세요.");
if (!getKey()) log("주의: 키가 없습니다. 위 API KEY 칸에 넣으세요.", "w");

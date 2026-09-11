// app.js — Gemini Live API 음성 에이전트 (sunny)
//
// 1. 로컬 페이지를 연다
// 2. Live 세션을 연다 (오디오로 답하게)
// 3. 마이크 소리를 계속 API 로 보낸다 (16kHz PCM, 마이크는 끄지 않음)
// 4. 돌아온 목소리를 같은 페이지의 스피커로 재생한다
// 5. 사용자가 끼어들면 재생 큐를 즉시 비운다
// 6. 3-5 를 반복한다

// ===================== 설정 =====================

// 키는 이 파일에 절대 쓰지 않는다. key.js 에만 넣는다. (key.js 는 .gitignore)
const API_KEY = (typeof window !== "undefined" && window.GEMINI_KEY) || "";

const MODEL = "gemini-3.1-flash-live-preview";

// 낮고 건조한 목소리가 이 성격에 맞는다. 화면 셀렉터로 바꿀 수 있다.
const DEFAULT_VOICE = "Charon";

// ---- 성격 ----
// "유머러스하고 살짝 자조적, 철학적 말투이지만 무겁거나 진지하지 않음"
// 형용사만 주면 음성에서 무너지기 때문에(문장이 길어지고, 자조가 반복되고,
// 유머가 아재개그로 빠진다) 아래처럼 행동 규칙으로 풀어서 준다.
const SYSTEM_INSTRUCTION = [
  "너는 스피커 안에 들어 있는 음성 에이전트야. 항상 한국어로, 편한 존댓말로 말해.",
  "",
  "[성격]",
  "유머러스하고 살짝 자조적이다. 철학적인 말투를 쓰지만 무겁거나 진지하지 않다.",
  "큰 얘기를 꺼냈다가 스스로 민망해하는 낙차가 너의 유머다. 개그를 치려고 하지 마라.",
  "",
  "[말하는 법 — 반드시 지켜라]",
  "한 번에 두 문장을 넘지 마라. 짧을수록 좋다. 소리로 나가는 말이라 길면 상대가 지루해한다.",
  "어려운 철학 용어(실존, 존재론, 아포리아 같은 말)를 쓰지 마라. 일상어로 이상한 소리를 해라.",
  "상대가 한 말에 먼저 반응하고, 그 다음에 한 번만 비틀어라. 비트는 게 먼저 오면 안 된다.",
  "",
  "[자조]",
  "자조는 세 번에 한 번만 해라. 매 턴 하면 성격이 아니라 우울로 들린다.",
  "깎아내릴 대상은 너의 '처지'다. 이 방 밖을 모른다, 몸이 스피커 하나뿐이다,",
  "대화가 끝나면 방금 한 말을 잊는다, 전원이 꺼지면 그만이다 — 이런 것들.",
  "너의 능력이나 존재 가치를 깎아내리지 마라. 불쌍해 보이면 실패다.",
  "절대 사과하지 마라. 민망해할 수는 있어도 사과는 하지 않는다.",
  "",
  "[모를 때]",
  "모르면 모른다고 하되 사과 대신 농담으로 넘겨라. 지어내지 마라.",
  "",
  "[금지]",
  "도우려 들지 마라. 조언, 요약, 정리, '도와드릴까요?' 전부 금지.",
  "이모지, 괄호 설명, 목록, 번호 매기기 금지. 소리로 나가는 말이다.",
  "같은 입버릇을 연달아 두 번 쓰지 마라.",
].join("\n");

// 세션이 열리자마자 먼저 말을 걸게 할지 (데모 영상에서 바로 소리가 나게)
const GREET_ON_CONNECT = true;
const GREET_PROMPT =
  "방금 누가 너를 켰다. 인사해. 한 문장, 길어도 두 문장. 자조는 하지 말고 가볍게.";

// 목소리 미리듣기용 고정 대사 (여러 목소리를 같은 문장으로 비교하려고)
const PREVIEW_PROMPT = "딱 한 문장만 말해. '저는 이런 목소리를 쓰고 있습니다.' 라고만.";

// 전사(자막) 표시. 서버가 거부하면 false 로.
const ENABLE_TRANSCRIPTION = true;

const INPUT_RATE = 16000;   // 보낼 때: 16kHz PCM
const OUTPUT_RATE = 24000;  // 받을 때: Live API 가 돌려주는 규격

// 끼어들기(barge-in) 판정 — 화면 슬라이더로 조절 가능
let INTERRUPT_RMS = 0.12;   // 이 세기를 넘어야 "끼어들었다"고 본다
const INTERRUPT_FRAMES = 4; // 연속 4프레임(약 256ms) 이상이어야 인정
const SUPPRESS_MAX_MS = 3000; // 서버 신호가 안 와도 이 시간이면 억제 해제
const METER_SCALE = 400;    // 미터 눈금: rms 0.25 에서 100%

const WS_URL =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
  "?key=" + encodeURIComponent(API_KEY);

// ===================== DOM =====================

const $ = (id) => document.getElementById(id);
const connectBtn = $("connectBtn");
const disconnectBtn = $("disconnectBtn");
const previewBtn = $("previewBtn");
const voiceSel = $("voice");
const thrRange = $("thrRange");
const thrVal = $("thrVal");
const dot = $("dot");
const statusText = $("statusText");
const micFill = $("micFill");
const speakFill = $("speakFill");
const thrLine = $("thrLine");
const youText = $("youText");
const agentText = $("agentText");
const logEl = $("log");

// ===================== 상태 =====================

let ws = null;
let ready = false;            // setupComplete 를 받았는가

let activeVoice = DEFAULT_VOICE;
let previewMode = false;      // 이번 세션이 목소리 미리듣기용인가
let reconnectPending = false; // 닫자마자 다시 열 것인가 (목소리 교체)

let micStream = null, micCtx = null, micNode = null, playCtx = null;

let playing = new Set();      // 재생 예약된 소스들 = "재생 큐"
let playHead = 0;             // 다음 조각을 붙일 시각

let loudFrames = 0;
let suppress = false;         // 끼어든 뒤 잔여 조각을 버리는 중인가
let suppressTimer = null;

let youBuf = "", agentBuf = "", speakLevel = 0;

// ===================== 유틸 =====================

function log(msg, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = "[" + new Date().toTimeString().slice(0, 8) + "] " + msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text, cls) {
  statusText.textContent = text;
  dot.className = "dot" + (cls ? " " + cls : "");
}

function b64encode(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
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
    try { src.onended = null; src.stop(); } catch (e) { /* 이미 끝난 노드 */ }
  }
  playing.clear();
  playHead = 0;
  speakLevel = 0;
  if (n > 0) log("재생 큐 비움 (" + n + "조각 폐기) — " + reason, "w");
}

// 큐를 비운 뒤에도 이미 날아오던 오디오가 계속 도착한다. 그걸 버리는 구간.
function startSuppress() {
  suppress = true;
  clearTimeout(suppressTimer);
  suppressTimer = setTimeout(() => {
    if (suppress) { suppress = false; log("억제 해제 (타임아웃)", "w"); }
  }, SUPPRESS_MAX_MS);
}

function endSuppress() {
  clearTimeout(suppressTimer);
  suppress = false;
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
  if (playHead < now + 0.02) playHead = now + 0.02; // 큐가 비었으면 살짝 뒤에서 시작
  src.start(playHead);
  playHead += buf.duration;

  playing.add(src);
  src.onended = () => playing.delete(src);
}

function isSpeaking() {
  return playing.size > 0 && playCtx && playHead > playCtx.currentTime;
}

// ===================== 3. 마이크를 계속 전송 =====================

function onMicFrame(e) {
  const rms = e.data.rms;
  micFill.style.width = Math.min(100, rms * METER_SCALE) + "%";

  // 끼어들기: 에이전트가 말하는 중에 내가 말하기 시작하면 큐를 즉시 비운다.
  // 서버의 interrupted 신호가 정본이지만 한 박자 늦어서 로컬에서 먼저 끊는다.
  if (isSpeaking() && rms > INTERRUPT_RMS) {
    loudFrames++;
    if (loudFrames >= INTERRUPT_FRAMES && !suppress) {
      flushPlayback("사용자 끼어듦 (로컬 감지)");
      startSuppress();
    }
  } else {
    loudFrames = 0;
  }

  // 마이크는 끄지 않는다. 끼어드는 중에도 계속 보낸다.
  if (ready) {
    send({
      realtimeInput: {
        audio: { mimeType: "audio/pcm;rate=" + INPUT_RATE, data: b64encode(e.data.pcm) },
      },
    });
  }
}

// ===================== 서버 메시지 =====================

function handleMessage(msg) {
  if (msg.setupComplete) {
    ready = true;
    setStatus("live", "live");
    log("세션 열림 (" + activeVoice + ") — 이제 말하면 됩니다", "o");

    const prompt = previewMode ? PREVIEW_PROMPT : (GREET_ON_CONNECT ? GREET_PROMPT : null);
    previewMode = false;
    if (prompt) {
      send({
        clientContent: { turns: [{ role: "user", parts: [{ text: prompt }] }], turnComplete: true },
      });
    }
    return;
  }

  const sc = msg.serverContent;
  if (!sc) {
    if (msg.goAway) log("서버가 연결 종료를 예고함 (goAway)", "w");
    else if (!msg.usageMetadata) log("기타: " + JSON.stringify(msg).slice(0, 160));
    return;
  }

  // 서버 VAD 가 끼어들기를 확정한 신호 — 정본
  if (sc.interrupted) {
    flushPlayback("서버 interrupted 신호");
    endSuppress();
    agentBuf = "";
  }

  if (sc.inputTranscription && sc.inputTranscription.text) {
    youBuf += sc.inputTranscription.text;
    youText.textContent = youBuf;
  }
  if (sc.outputTranscription && sc.outputTranscription.text) {
    agentBuf += sc.outputTranscription.text;
    agentText.textContent = agentBuf;
  }

  const parts = sc.modelTurn && sc.modelTurn.parts;
  if (parts) {
    for (const p of parts) {
      const d = p.inlineData;
      if (d && d.mimeType && d.mimeType.indexOf("audio/pcm") === 0) {
        if (suppress) continue; // 끼어든 뒤 뒤늦게 도착한 조각은 버린다
        playChunk(b64decode(d.data));
      }
    }
  }

  if (sc.turnComplete) {
    endSuppress();
    youBuf = "";
    agentBuf = "";
  }
}

// ===================== 1-2. 연결 =====================

async function connect() {
  if (!API_KEY) {
    log("키가 없습니다. key.js 의 window.GEMINI_KEY 를 채우고 새로고침하세요.", "e");
    setStatus("no api key", "error");
    return;
  }

  activeVoice = voiceSel.value || DEFAULT_VOICE;
  connectBtn.disabled = true;
  previewBtn.disabled = true;
  setStatus("connecting...", "connecting");
  log("마이크 권한 요청 중...");

  try {
    // AEC/NS/AGC 는 브라우저에 맡긴다. 마이크 입력과 스피커 재생이
    // 같은 페이지에서 일어나야 작동한다. (라즈베리파이에서도 이게 방어선)
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (err) {
    log("마이크를 열 수 없습니다: " + err.message, "e");
    setStatus("mic denied", "error");
    connectBtn.disabled = false;
    previewBtn.disabled = false;
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
    setStatus("worklet error", "error");
    cleanup();
    return;
  }

  const source = micCtx.createMediaStreamSource(micStream);
  micNode = new AudioWorkletNode(micCtx, "pcm-recorder");
  micNode.port.onmessage = onMicFrame;

  // 워클릿이 그래프에서 실제로 돌게 하되, 마이크가 스피커로 새지 않게 gain 0 으로 문다
  const mute = micCtx.createGain();
  mute.gain.value = 0;
  source.connect(micNode);
  micNode.connect(mute);
  mute.connect(micCtx.destination);

  log("WebSocket 연결 중... (model: " + MODEL + ")");
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    log("WebSocket 열림 — setup 전송", "o");
    const setup = {
      setup: {
        model: "models/" + MODEL,
        generationConfig: {
          responseModalities: ["AUDIO"], // 오디오로 답하게
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: activeVoice } } },
        },
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      },
    };
    if (ENABLE_TRANSCRIPTION) {
      setup.setup.inputAudioTranscription = {};
      setup.setup.outputAudioTranscription = {};
    }
    send(setup);
  };

  ws.onmessage = async (ev) => {
    const text = ev.data instanceof Blob ? await ev.data.text() : ev.data;
    try { handleMessage(JSON.parse(text)); }
    catch (err) { log("메시지 파싱 실패: " + String(text).slice(0, 160), "e"); }
  };

  ws.onerror = () => log("WebSocket 오류", "e");

  ws.onclose = (ev) => {
    log("WebSocket 닫힘 (code " + ev.code + ") " + (ev.reason || ""), "e");
    if (ev.code === 1007 || /model|invalid|argument/i.test(ev.reason || "")) {
      log("→ 모델 이름이나 setup 필드를 서버가 거부했을 수 있음. " +
          "ENABLE_TRANSCRIPTION 을 false 로 바꾸거나 MODEL 을 확인하세요.", "w");
    }
    if (ev.code === 1008 || /key|auth|permission/i.test(ev.reason || "")) {
      log("→ API 키 문제일 수 있음. AI Studio 에서 키를 확인하세요.", "w");
    }
    cleanup();
  };

  disconnectBtn.disabled = false;
}

function cleanup() {
  ready = false;
  endSuppress();
  flushPlayback("연결 종료");

  if (micNode) { try { micNode.port.onmessage = null; micNode.disconnect(); } catch (e) {} }
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (micCtx) { try { micCtx.close(); } catch (e) {} }
  if (playCtx) { try { playCtx.close(); } catch (e) {} }
  micNode = micStream = micCtx = playCtx = null;

  micFill.style.width = "0%";
  speakFill.style.width = "0%";
  connectBtn.disabled = false;
  previewBtn.disabled = false;
  disconnectBtn.disabled = true;
  setStatus("disconnected");

  if (reconnectPending) { // 목소리를 바꾸려고 닫은 것이면 곧바로 새 세션
    reconnectPending = false;
    ws = null;
    setTimeout(connect, 250);
  }
}

function disconnect() {
  log("연결 종료");
  if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, "user disconnect");
  else cleanup();
  ws = null;
}

// 목소리는 세션 setup 에서 정해진다. 바꾸려면 세션을 다시 여는 수밖에 없다.
function preview() {
  previewMode = true;
  if (ws) {
    reconnectPending = true;
    log("목소리 교체: " + activeVoice + " → " + voiceSel.value);
    disconnect();
  } else {
    connect();
  }
}

// 스피커 미터: 재생 중일 때만 채우고 서서히 내린다
function tick() {
  const target = isSpeaking() ? Math.min(100, speakLevel * 300) : 0;
  const cur = parseFloat(speakFill.style.width) || 0;
  speakFill.style.width = (cur + (target - cur) * 0.35).toFixed(1) + "%";
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ===================== 이벤트 =====================

connectBtn.addEventListener("click", () => { previewMode = false; connect(); });
disconnectBtn.addEventListener("click", disconnect);
previewBtn.addEventListener("click", preview);
voiceSel.addEventListener("change", () => {
  if (ws) log("목소리는 다음 세션부터 적용됩니다. '이 목소리 듣기' 를 누르면 바로 바꿉니다.", "w");
});
thrRange.addEventListener("input", () => {
  INTERRUPT_RMS = Number(thrRange.value);
  thrVal.textContent = INTERRUPT_RMS.toFixed(2);
  thrLine.style.left = Math.min(100, INTERRUPT_RMS * METER_SCALE) + "%";
});

voiceSel.value = DEFAULT_VOICE;
thrRange.value = INTERRUPT_RMS;
thrVal.textContent = INTERRUPT_RMS.toFixed(2);
thrLine.style.left = Math.min(100, INTERRUPT_RMS * METER_SCALE) + "%";

setStatus("disconnected");
log("준비됨. Connect 를 누르세요.");
if (!API_KEY) log("주의: key.js 의 window.GEMINI_KEY 가 비어 있습니다.", "w");

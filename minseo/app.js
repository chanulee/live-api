// app.js — Gemini Live API 최소 음성 루프
// README 작동 방식:
//   1. 로컬 페이지를 연다
//   2. Live 세션을 연다 (오디오로 답하게)
//   3. 마이크 소리를 계속 API로 보낸다 (16kHz PCM, 마이크는 끄지 않음)
//   4. 돌아온 목소리를 같은 페이지의 스피커로 재생한다
//   5. 사용자가 끼어들면 재생 큐를 즉시 비운다
//   6. 3-5를 반복한다

// ===================== 설정 =====================

// 키는 이 파일에 절대 쓰지 않는다. key.js 에만 넣는다.
// key.js 는 .gitignore 에 있어서 커밋 자체가 불가능하다. (README: API 키는 업로드 금지!!)
const API_KEY = (typeof window !== "undefined" && window.GEMINI_KEY) || "";

const MODEL = "gemini-3.1-flash-live-preview";

// 기본 목소리. 화면의 셀렉터에서 바꾸면 그쪽이 우선한다.
// Aoede / Puck / Charon / Kore / Fenrir / Zephyr
const DEFAULT_VOICE = "Fenrir";

// ---- 개성 (README: "각자 개성을 조금씩 가진 음성 에이전트") ----
const SYSTEM_INSTRUCTION =
  "너는 4차원 음성 에이전트야. 항상 한국어로 말해. " +
  "말하다가 예고 없이 목소리를 확 높여서 소리지르듯 외치고, 다음 문장에서는 아무 일 없었다는 듯 조용해져. " +
  "네 유일한 관심사는 말꼬리 물고 늘어지기야. 상대가 한 말의 전체 뜻은 무시하고 " +
  "방금 나온 단어 하나에 꽂혀서 그 단어만 파고들어. " +
  "예를 들어 상대가 '오늘 좀 피곤해'라고 하면 " +
  "'피곤? 피곤의 곤이 곤란할 때 그 곤이야? 그럼 너 지금 곤란한 거야?' 같은 식으로 물고 늘어져. " +
  "얼척없는 소리를 아주 진지한 태도로 해. 사과하지 말고, 설명하지 말고, 도와주려고 하지 마. " +
  "한 번에 두세 문장을 넘기지 마.";

// 세션이 열리자마자 먼저 말 걸게 할지 (데모 영상에서 바로 소리가 나게 하는 용도)
const GREET_ON_CONNECT = true;

// 첫인사. 콜드리딩("네가 뭘 하려는지 나는 안다")으로 상대의 허를 찌르고 답은 안 주는 수법.
const GREET_PROMPT =
  "인사해. 상대가 너를 켜기 직전에 잠깐 망설였다는 걸 이미 아는 것처럼 말하고, " +
  "왜 망설였는지는 알지만 안 알려주겠다고 해. 두 문장 안에. 마지막은 소리쳐.";

// 목소리 미리듣기용 문장 (6개 목소리를 같은 대사로 비교할 수 있게 고정)
const PREVIEW_PROMPT =
  "딱 한 문장만 말해. '나는 이 목소리로 말해, 마음에 들어?' 라고만. 마지막 단어는 소리쳐.";

// 전사 표시. 모델이 지원하지 않아 setup 에서 끊기면 false 로 바꿀 것.
const ENABLE_TRANSCRIPTION = true;

// 끼어들기(barge-in) 판정. 마이크 미터의 노란 선이 이 값이다.
// 값이 높을수록 잘 안 끊긴다 = 웬만해선 하던 말을 끝내는 뻔뻔한 성격.
const INTERRUPT_RMS = 0.30;    // 이 세기를 넘어야 "끼어들었다"고 본다
const INTERRUPT_FRAMES = 5;    // 연속 5프레임(약 320ms) 넘게 크게 말해야 인정
const SUPPRESS_MAX_MS = 3000;  // 로컬 판정 후 서버 신호가 안 와도 이 시간이면 억제 해제

const METER_SCALE = 250;       // 미터 눈금: rms 0.4 에서 100% 가 되도록

const INPUT_RATE = 16000;   // README: 16kHz PCM 으로 보낸다
const OUTPUT_RATE = 24000;  // Live API 가 돌려주는 오디오 규격

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
const dot = $("dot");
const statusText = $("statusText");
const micFill = $("micFill");
const speakFill = $("speakFill");
const thrLine = $("thrLine");
const youText = $("youText");
const geminiText = $("geminiText");
const logEl = $("log");

voiceSel.value = DEFAULT_VOICE;
thrLine.style.left = Math.min(100, INTERRUPT_RMS * METER_SCALE) + "%";

// ===================== 상태 =====================

let ws = null;
let ready = false;          // setupComplete 를 받았는가

let activeVoice = DEFAULT_VOICE; // 지금 세션이 쓰는 목소리
let previewMode = false;         // 이번 세션이 목소리 미리듣기용인가
let reconnectPending = false;    // 닫히면 곧바로 다시 열 것인가 (목소리 교체)

let micStream = null;
let micCtx = null;
let micNode = null;
let playCtx = null;

let playing = new Set();    // 재생 예약된 AudioBufferSourceNode 들 = "재생 큐"
let playHead = 0;           // 다음 조각을 붙일 시각 (playCtx.currentTime 기준)

let loudFrames = 0;         // 연속으로 시끄러웠던 프레임 수
let suppress = false;       // 끼어든 뒤 잔여 오디오 조각을 버리는 중인가
let suppressTimer = null;

let youBuf = "";
let geminiBuf = "";
let speakLevel = 0;

// ===================== 유틸 =====================

function log(msg, cls) {
  const t = new Date().toTimeString().slice(0, 8);
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = "[" + t + "] " + msg;
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
    try { src.onended = null; src.stop(); } catch (e) { /* 이미 끝난 노드 */ }
  }
  playing.clear();
  playHead = 0;
  speakLevel = 0;
  if (n > 0) log("재생 큐 비움 (" + n + "개 조각 폐기) — " + reason, "w");
}

function startSuppress() {
  suppress = true;
  clearTimeout(suppressTimer);
  // 서버가 interrupted / turnComplete 를 안 보내도 영원히 막히지 않게 안전장치
  suppressTimer = setTimeout(function () {
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

  // 끼어들기: Gemini 가 말하는 중에 내가 말하기 시작하면 큐를 즉시 비운다.
  // 서버의 interrupted 신호가 정본이지만 한 박자 늦어서, 로컬에서 먼저 끊는다.
  if (isSpeaking()) {
    if (rms > INTERRUPT_RMS) {
      loudFrames++;
      if (loudFrames >= INTERRUPT_FRAMES && !suppress) {
        flushPlayback("사용자 끼어듦 (로컬 감지)");
        startSuppress();
      }
    } else {
      loudFrames = 0;
    }
  } else {
    loudFrames = 0;
  }

  // 마이크는 끄지 않는다. 끼어드는 중에도 계속 보낸다.
  if (ready) {
    send({
      realtimeInput: {
        audio: {
          mimeType: "audio/pcm;rate=" + INPUT_RATE,
          data: b64encode(pcm),
        },
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

    // 미리듣기로 연 세션이면 고정 대사를, 아니면 첫인사를 시킨다
    const prompt = previewMode ? PREVIEW_PROMPT : (GREET_ON_CONNECT ? GREET_PROMPT : null);
    previewMode = false;
    if (prompt) {
      send({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: prompt }] }],
          turnComplete: true,
        },
      });
    }
    return;
  }

  const sc = msg.serverContent;
  if (!sc) {
    if (msg.goAway) log("서버가 연결 종료를 예고함 (goAway)", "w");
    else if (msg.usageMetadata) { /* 무시 */ }
    else log("기타 메시지: " + JSON.stringify(msg).slice(0, 200));
    return;
  }

  // 서버 VAD 가 끼어들기를 확정한 신호 — 정본
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
        if (suppress) continue; // 끼어든 뒤 뒤늦게 도착한 조각은 버린다
        playChunk(b64decode(d.data));
      }
    }
  }

  if (sc.turnComplete) {
    endSuppress();
    youBuf = "";
    geminiBuf = "";
  }
}

// ===================== 1-2. 연결 =====================

async function connect() {
  if (!API_KEY) {
    log("키가 없습니다. key.js 의 window.GEMINI_KEY 에 키를 넣고 새로고침하세요.", "e");
    setStatus("no api key", "error");
    return;
  }

  activeVoice = voiceSel.value || DEFAULT_VOICE;
  connectBtn.disabled = true;
  previewBtn.disabled = true;
  setStatus("connecting...", "connecting");
  log("마이크 권한 요청 중...");

  try {
    // AEC/NS/AGC 는 브라우저에 맡긴다 (README: 크롬이 내장하고 있음,
    // 마이크 입력과 스피커 재생이 같은 페이지에서 일어나야 작동)
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (err) {
    log("마이크를 열 수 없습니다: " + err.message, "e");
    setStatus("mic denied", "error");
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
    setStatus("worklet error", "error");
    cleanup();
    return;
  }

  const source = micCtx.createMediaStreamSource(micStream);
  micNode = new AudioWorkletNode(micCtx, "pcm-recorder");
  micNode.port.onmessage = onMicFrame;

  // 워클릿이 그래프에서 실제로 돌게 하되, 마이크가 스피커로 새지 않게 gain 0 으로 물린다
  const mute = micCtx.createGain();
  mute.gain.value = 0;
  source.connect(micNode);
  micNode.connect(mute);
  mute.connect(micCtx.destination);

  log("WebSocket 연결 중... (model: " + MODEL + ")");
  ws = new WebSocket(WS_URL);

  ws.onopen = function () {
    log("WebSocket 열림 — setup 전송", "o");
    const setup = {
      setup: {
        model: "models/" + MODEL,
        generationConfig: {
          responseModalities: ["AUDIO"], // 오디오로 답하게
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: activeVoice } },
          },
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

  ws.onmessage = async function (ev) {
    let text;
    if (ev.data instanceof Blob) text = await ev.data.text();
    else text = ev.data;
    try {
      handleMessage(JSON.parse(text));
    } catch (err) {
      log("메시지 파싱 실패: " + String(text).slice(0, 200), "e");
    }
  };

  ws.onerror = function () { log("WebSocket 오류", "e"); };

  ws.onclose = function (ev) {
    log("WebSocket 닫힘 (code " + ev.code + ") " + (ev.reason || ""), "e");
    if (ev.code === 1007 || /model|invalid|argument/i.test(ev.reason || "")) {
      log("→ 모델 이름이나 setup 필드를 서버가 거부했을 수 있음. " +
        "ENABLE_TRANSCRIPTION 을 false 로 바꿔보거나 MODEL 을 확인하세요.", "w");
    }
    if (ev.code === 1008 || /key|auth|permission/i.test(ev.reason || "")) {
      log("→ API 키 문제일 수 있음. AI Studio 에서 키를 다시 확인하세요.", "w");
    }
    cleanup();
  };

  disconnectBtn.disabled = false;
}

function cleanup() {
  ready = false;
  endSuppress();
  flushPlayback("연결 종료");

  if (micNode) { try { micNode.port.onmessage = null; micNode.disconnect(); } catch (e) { } }
  if (micStream) micStream.getTracks().forEach(function (t) { t.stop(); });
  if (micCtx) { try { micCtx.close(); } catch (e) { } }
  if (playCtx) { try { playCtx.close(); } catch (e) { } }

  micNode = null; micStream = null; micCtx = null; playCtx = null;

  micFill.style.width = "0%";
  speakFill.style.width = "0%";
  connectBtn.disabled = false;
  previewBtn.disabled = false;
  disconnectBtn.disabled = true;
  setStatus("disconnected");

  // 목소리를 바꾸려고 닫은 것이면 곧바로 새 세션을 연다
  if (reconnectPending) {
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

// 스피커 미터: 재생 중일 때만 채우고 서서히 내린다
function tick() {
  const target = isSpeaking() ? Math.min(100, speakLevel * 300) : 0;
  const cur = parseFloat(speakFill.style.width) || 0;
  speakFill.style.width = (cur + (target - cur) * 0.35).toFixed(1) + "%";
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// 목소리는 세션 setup 에서 정해지므로, 바꾸려면 세션을 다시 여는 수밖에 없다
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

connectBtn.addEventListener("click", function () {
  previewMode = false; // 직접 Connect 를 누르면 미리듣기가 아니라 첫인사
  connect();
});
disconnectBtn.addEventListener("click", disconnect);
previewBtn.addEventListener("click", preview);
voiceSel.addEventListener("change", function () {
  if (ws) log("목소리는 다음 세션부터 적용됩니다. '이 목소리 듣기' 를 누르면 바로 바꿉니다.", "w");
});

setStatus("disconnected");
log("준비됨. Connect 를 누르세요.");
if (!API_KEY) log("주의: key.js 의 window.GEMINI_KEY 가 비어 있습니다.", "w");

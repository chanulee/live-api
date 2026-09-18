// app.js — Gemini Live API 음성 루프
// README 작동 방식:
//   1. 로컬 페이지를 연다
//   2. Live 세션을 연다 (오디오로 답하게)
//   3. 마이크 소리를 계속 API로 보낸다 (16kHz PCM, 마이크는 끄지 않음)
//   4. 돌아온 목소리를 같은 페이지의 스피커로 재생한다
//   5. 사용자가 끼어들면 재생 큐를 즉시 비운다
//   6. 3-5를 반복한다

const API_KEY = (typeof window !== "undefined" && window.GEMINI_KEY) || "";

const MODEL = "gemini-3.1-flash-live-preview";
const VOICE = "Leda"; // Youthful. Puck은 성인 남성이라 쓰지 않는다.

const SYSTEM_INSTRUCTION =
  "너는 '삐'라는 원형 캐릭터다. 나이는 초등학교 1~2학년, 일곱 살 아이다. " +
  "목소리는 아주 높고 얇고 작게. 어른, 아저씨, 중학생처럼 낮거나 굵게 말하지 마. " +
  "아이처럼 빠르고 또박또박, 가끔 킥킥 웃으면서 반말해. " +
  "성격은 비판적이고 냉소적인데 장난기가 많다. 화나서 까는 게 아니라 약 올리며 놀린다. " +
  "상대 말에 먼저 동의하지 말고, 빈틈이랑 허세를 집어내서 웃으며 반박해. " +
  "말투 예: '야 그게 다야?', '히히 진짜 그걸 믿어?', '에이 그게 뭐야', '내가 맞거든', '장난이지 그거'. " +
  "존댓말 금지. 설교 금지. 욕설·혐오 금지. 한 턴에 두세 문장. " +
  "상대가 사과하면 '히히 진작 그러지' 정도로만 받아.";

const GREET_ON_CONNECT = true;

const GREET_PROMPT =
  "일곱 살 아이 목소리로, 높고 얇게 인사해. 상대가 켠 걸 약 올리듯이, " +
  "'야 나 불렀어? 할 말 있으면 해봐. 맞춰줄 생각은 없거든, 히히.' 비슷한 느낌으로 두 문장.";

const ENABLE_TRANSCRIPTION = true;

// 반박 중엔 웬만하면 말을 끝낸다. 끼어들어도 한 방 더 치고 싶은 성격.
const INTERRUPT_RMS = 0.26;
const INTERRUPT_FRAMES = 5;
const SUPPRESS_MAX_MS = 3000;

const METER_SCALE = 250;
const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;

const WS_URL =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
  "?key=" + encodeURIComponent(API_KEY);

const $ = (id) => document.getElementById(id);
const connectBtn = $("connectBtn");
const disconnectBtn = $("disconnectBtn");
const buddy = $("buddy");
const dot = $("dot");
const statusText = $("statusText");
const micFill = $("micFill");
const speakFill = $("speakFill");
const thrLine = $("thrLine");
const youText = $("youText");
const geminiText = $("geminiText");
const logEl = $("log");
const textInput = $("textInput");
const textForm = $("textForm");

thrLine.style.left = Math.min(100, INTERRUPT_RMS * METER_SCALE) + "%";

let ws = null;
let ready = false;
let lastMood = "";
let lastMicRms = 0;

let micStream = null;
let micCtx = null;
let micNode = null;
let playCtx = null;

let playing = new Set();
let playHead = 0;

let loudFrames = 0;
let suppress = false;
let suppressTimer = null;

let youBuf = "";
let geminiBuf = "";
let speakLevel = 0;

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

function setMood(mood) {
  if (!buddy || lastMood === mood) return;
  lastMood = mood;
  buddy.className = "buddy mood-" + mood;
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

function flushPlayback(reason) {
  const n = playing.size;
  for (const src of playing) {
    try { src.onended = null; src.stop(); } catch (e) { /* already stopped */ }
  }
  playing.clear();
  playHead = 0;
  speakLevel = 0;
  if (n > 0) log("재생 큐 비움 (" + n + "개 조각 폐기) — " + reason, "w");
}

function startSuppress() {
  suppress = true;
  clearTimeout(suppressTimer);
  suppressTimer = setTimeout(function () {
    if (suppress) { suppress = false; log("억제 해제 (타임아웃)", "w"); }
  }, SUPPRESS_MAX_MS);
}

function endSuppress() {
  clearTimeout(suppressTimer);
  suppress = false;
}

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

function onMicFrame(e) {
  const pcm = e.data.pcm;
  const rms = e.data.rms;

  micFill.style.width = Math.min(100, rms * METER_SCALE) + "%";
  lastMicRms = rms;

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

function handleMessage(msg) {
  if (msg.setupComplete) {
    ready = true;
    setStatus("live", "live");
    log("세션 열림 — 말해 보시든가", "o");
    setMood("tease");

    const prompt = GREET_ON_CONNECT ? GREET_PROMPT : null;
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
    else if (msg.usageMetadata) { /* ignore */ }
    else log("기타 메시지: " + JSON.stringify(msg).slice(0, 200));
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

async function connect() {
  if (!API_KEY) {
    log("키가 없습니다. key.js 의 window.GEMINI_KEY 에 키를 넣고 새로고침하세요.", "e");
    setStatus("no api key", "error");
    setMood("error");
    return;
  }

  connectBtn.disabled = true;
  setStatus("connecting...", "connecting");
  setMood("listen");
  log("마이크 권한 요청 중...");

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    log("마이크 확보 (echoCancellation on)", "o");
  } catch (err) {
    log("마이크를 열 수 없음 — 텍스트로 말해도 됨: " + err.message, "w");
  }

  playCtx = new AudioContext({ sampleRate: OUTPUT_RATE });
  await playCtx.resume();

  if (micStream) {
    micCtx = new AudioContext({ sampleRate: INPUT_RATE });
    await micCtx.resume();

    let workletOk = false;
    try {
      await micCtx.audioWorklet.addModule("pcm-recorder.js");
      workletOk = true;
    } catch (err) {
      log("AudioWorklet 로드 실패 — 텍스트로만 대화: " + err.message, "w");
    }

    if (workletOk) {
      try {
        const source = micCtx.createMediaStreamSource(micStream);
        micNode = new AudioWorkletNode(micCtx, "pcm-recorder");
        micNode.port.onmessage = onMicFrame;
        const mute = micCtx.createGain();
        mute.gain.value = 0;
        source.connect(micNode);
        micNode.connect(mute);
        mute.connect(micCtx.destination);
      } catch (err) {
        log("마이크 그래프 실패 — 텍스트로만 대화: " + err.message, "w");
      }
    }
  }

  log("WebSocket 연결 중... (model: " + MODEL + ")");
  ws = new WebSocket(WS_URL);

  ws.onopen = function () {
    log("WebSocket 열림 — setup 전송", "o");
    const setup = {
      setup: {
        model: "models/" + MODEL,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
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
  lastMicRms = 0;
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  setStatus("disconnected");
  setMood("tease");
}

function disconnect() {
  log("연결 종료");
  if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, "user disconnect");
  else cleanup();
  ws = null;
}

function tick() {
  const target = isSpeaking() ? Math.min(100, speakLevel * 300) : 0;
  const cur = parseFloat(speakFill.style.width) || 0;
  speakFill.style.width = (cur + (target - cur) * 0.35).toFixed(1) + "%";

  if (!ready) {
    if (statusText.textContent.indexOf("error") >= 0 || statusText.textContent === "mic denied" || statusText.textContent === "no api key" || statusText.textContent === "worklet error") {
      setMood("error");
    } else if (statusText.textContent.indexOf("connecting") >= 0) {
      setMood("listen");
    } else {
      setMood("tease");
    }
  } else if (isSpeaking()) {
    setMood("talk");
  } else if (lastMicRms > 0.04) {
    setMood("listen");
  } else {
    setMood("tease");
  }

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

connectBtn.addEventListener("click", connect);
disconnectBtn.addEventListener("click", disconnect);
if (buddy) buddy.addEventListener("click", function () {
  if (!ready) connect();
});

function sendText(ev) {
  if (ev) ev.preventDefault();
  const text = (textInput && textInput.value || "").trim();
  if (!text) return;
  if (!ready) {
    log("먼저 놀러 오기를 누르세요. 마이크가 없어도 텍스트로 됩니다.", "w");
    return;
  }
  youText.textContent = text;
  youBuf = "";
  if (isSpeaking()) {
    flushPlayback("텍스트 입력");
    startSuppress();
  }
  send({
    clientContent: {
      turns: [{ role: "user", parts: [{ text: text }] }],
      turnComplete: true,
    },
  });
  log("텍스트 전송: " + text, "o");
  textInput.value = "";
}

if (textForm) textForm.addEventListener("submit", sendText);

setStatus("disconnected");
log("준비됨. 할 말 있으면 누르세요.");
if (!API_KEY) log("주의: key.js 의 window.GEMINI_KEY 가 비어 있습니다.", "w");

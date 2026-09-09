# minseo · Gemini Live Voice Agent

인터랙션디자인융합 2 · 1주차 과제.
맥 브라우저에서 마이크로 말하면 Gemini가 음성으로 답하고, 말을 끊으면 즉시 멈추는 최소 음성 에이전트.

## 실행

```bash
# 저장소 루트에서
python3 -m http.server 8000
```

브라우저에서 `http://localhost:8000/minseo/` 를 연다.
`index.html` 을 더블클릭해서 `file://` 로 열면 마이크와 AudioWorklet이 동작하지 않는다.

실행 전에 키를 넣는다. **`app.js` 에는 절대 쓰지 않는다.**

```bash
cp key.example.js key.js
# key.js 를 열어 window.GEMINI_KEY 에 키를 넣는다
```

키는 [Google AI Studio](https://aistudio.google.com/api-keys) 에서 발급받는다.
`key.js` 는 `.gitignore` 에 있어서 커밋 자체가 되지 않는다. 커밋 전에 지우는 걸
기억할 필요가 없다 — 기억에 의존하는 방법은 한 번 실패했다.

## 구조

| 파일 | 역할 |
| --- | --- |
| `index.html` | Connect 버튼, 목소리 셀렉터, 레벨 미터, 전사, 로그 |
| `app.js` | Live API 세션, 마이크 전송, 재생 큐, 끼어들기 처리 |
| `pcm-recorder.js` | AudioWorklet. 마이크를 16kHz 16-bit PCM 64ms 조각으로 잘라 넘김 |
| `key.example.js` | 키 파일 템플릿. `key.js` 로 복사해서 쓴다 |
| `key.js` | **커밋 안 됨.** 여기에만 키가 들어간다 |

## 동작 흐름

README의 6단계를 그대로 따른다.

1. `python3 -m http.server` 로 띄운 로컬 페이지를 연다.
2. `wss://generativelanguage.googleapis.com/ws/...BidiGenerateContent` 로 세션을 열고
   `setup` 에 `responseModalities: ["AUDIO"]` 를 넣어 오디오로 답하게 한다.
3. 마이크를 16kHz PCM 으로 계속 `realtimeInput.audio` 에 실어 보낸다. 마이크는 끄지 않는다.
4. 돌아온 `serverContent.modelTurn.parts[].inlineData` (24kHz PCM) 를 같은 페이지의 스피커로 재생한다.
5. 끼어들면 예약된 `AudioBufferSourceNode` 를 전부 `stop()` 하고 큐를 비운다.
6. 3-5를 반복한다.

### 에코 (AEC)

`getUserMedia` 에서 `echoCancellation` / `noiseSuppression` / `autoGainControl` 을 켜서
브라우저 내장 AEC에 맡긴다. 마이크 입력과 스피커 재생이 **같은 페이지**에서 일어나야 작동하므로
재생도 이 페이지의 Web Audio로 한다.

### 버퍼 플러시 (끼어들기)

Gemini는 음성을 작은 조각으로 계속 보내기 때문에, 끊긴 뒤에도 잔여 조각이 도착한다.
두 겹으로 처리한다.

- **로컬 감지** — 재생 중에 마이크 RMS가 `INTERRUPT_RMS`(0.30)를 연속 5프레임(약 320ms) 넘으면
  즉시 큐를 비운다. 서버 신호보다 빨라서 체감상 바로 멈춘다.
- **서버 신호** — `serverContent.interrupted` 가 정본이다. 이게 오면 큐를 비우고 억제를 푼다.

로컬로 먼저 끊은 뒤에는 뒤늦게 도착하는 조각을 버리는 억제 구간에 들어간다.
`interrupted` 또는 `turnComplete` 가 오면 풀리고, 둘 다 안 와도 3초 뒤 자동으로 풀려서
영구히 벙어리가 되는 일은 없다.

## 개성

README의 "각자 개성을 조금씩 가진 음성 에이전트"에 대한 이번 주 답.

**자주 소리지르면서 얼척없게 말하는 4차원 에이전트.** 관심사는 말꼬리 물고 늘어지기 하나뿐이라,
상대가 한 말의 전체 뜻은 무시하고 방금 나온 단어 하나에 꽂혀서 그것만 파고든다.
첫인사는 콜드리딩이다 — 상대가 켜기 직전에 망설였다는 걸 아는 척하고, 이유는 안 알려준다.

개성을 프롬프트에만 두지 않았다. **끼어들기 임계값도 성격의 일부로 썼다.**
`INTERRUPT_RMS` 를 0.045에서 0.30으로 크게 올려서, 웬만큼 큰 소리로 말하지 않으면
하던 말을 끝까지 하고 만다. 소심하게 물러서지 않는 뻔뻔함이 수치로 들어가 있다.
VAD·barge-in 이라는 기술 요소를 그대로 캐릭터로 번역한 부분이다.

목소리는 화면 상단 셀렉터에서 6종을 바꿔가며 들어볼 수 있다. Live API는 목소리를
세션 `setup` 에서 정하기 때문에, `이 목소리 듣기` 는 세션을 다시 열어 같은 대사를 말하게 한다.

## 설정

`app.js` 맨 위에서 바꾼다.

| 상수 | 기본값 | 설명 |
| --- | --- | --- |
| `MODEL` | `gemini-3.1-flash-live-preview` | 수업 지정 모델 |
| `DEFAULT_VOICE` | `Fenrir` | 화면 셀렉터에서 6종 중 고를 수 있음 |
| `SYSTEM_INSTRUCTION` | 4차원 · 말꼬리 | 에이전트 성격 |
| `GREET_PROMPT` | 콜드리딩 인사 | 첫인사로 시킬 말 |
| `PREVIEW_PROMPT` | 고정 한 문장 | 목소리 미리듣기용 대사 |
| `GREET_ON_CONNECT` | `true` | 연결되자마자 먼저 말 검 |
| `ENABLE_TRANSCRIPTION` | `true` | 전사 표시. setup이 거부되면 `false` |
| `INTERRUPT_RMS` | `0.30` | 끼어들기 임계값. 미터의 노란 선 |
| `INTERRUPT_FRAMES` | `5` | 연속 몇 프레임 넘어야 인정할지 |

## 문제가 생기면

로그 창을 먼저 본다. WebSocket이 닫힌 코드가 찍힌다.

- **`code 1007`** — 모델 이름이나 `setup` 필드를 서버가 거부. `ENABLE_TRANSCRIPTION` 을 `false` 로
  바꿔보거나 `MODEL` 을 확인한다.
- **`code 1008`** / auth 관련 reason — API 키 문제.
- **AudioWorklet 로드 실패** — `file://` 로 열었을 가능성. `http.server` 로 다시 연다.
- **에코가 돈다 (Gemini가 자기 소리에 반응)** — 헤드폰을 쓰거나 `INTERRUPT_RMS` 를 올린다.
- **너무 쉽게 끊긴다** — `INTERRUPT_RMS` 를 올리거나 `INTERRUPT_FRAMES` 를 늘린다.

## 다음 (2주차)

Raspberry Pi 4B 위에 얹는다. 파이에서는 macOS/브라우저가 해주던 AEC가 없어서
`speexdsp` 등으로 직접 처리해야 할 수 있다.

# Eunseol · 이의 있음

**에이전트 기획**  
캐릭터: **삐** — 노란 원형. 표정이 귀엽고 장난스럽게 약 올린다.  
성격: **비판적** + **냉소적** + **장난스러움**. 화나서 까는 게 아니라 놀리며 반박한다.  
목소리: **Leda**(Youthful) 하나 고정. 초등 저학년처럼 높고 얇은 아이 톤.

## 실행

```bash
# 저장소 루트에서
python3 -m http.server 8000
```

브라우저에서 `http://localhost:8000/Eunseol/` 를 연다.  
`index.html` 을 더블클릭해서 `file://` 로 열면 마이크와 AudioWorklet이 동작하지 않는다.

실행 전에 키를 넣는다. **`app.js` 에는 절대 쓰지 않는다.**

```bash
cp key.example.js key.js
# key.js 를 열어 window.GEMINI_KEY 에 키를 넣는다
```

키는 [Google AI Studio](https://aistudio.google.com/api-keys) 에서 발급받는다.  
`key.js` 는 `.gitignore` 에 있어서 커밋되지 않는다.

## 구조

| 파일 | 역할 |
| --- | --- |
| `index.html` | 원형 캐릭터 UI, Connect, 미터, 전사, 로그 |
| `app.js` | Live API 세션, 마이크 전송, 재생 큐, 끼어들기 |
| `pcm-recorder.js` | AudioWorklet. 마이크를 16kHz 16-bit PCM 64ms 조각으로 자름 |
| `key.example.js` | 키 파일 템플릿. `key.js` 로 복사해서 쓴다 |
| `key.js` | **커밋 안 됨.** 여기에만 키가 들어간다 |

## 동작 흐름

루트 README의 6단계를 따른다.

1. `python3 -m http.server` 로 띄운 로컬 페이지를 연다.
2. Live 세션을 열고 `responseModalities: ["AUDIO"]` 로 오디오 답변을 받는다.
3. 마이크를 16kHz PCM으로 계속 보낸다. 마이크는 끄지 않는다.
4. 돌아온 24kHz PCM을 같은 페이지의 스피커로 재생한다.
5. 끼어들면 재생 큐를 즉시 비운다.
6. 3–5를 반복한다.

에코는 브라우저 내장 AEC에 맡긴다 (`echoCancellation: true`). 마이크와 스피커가 같은 페이지에 있어야 한다.

끼어들기는 로컬 RMS 감지 + 서버 `interrupted` 신호 두 겹이다. 로컬로 먼저 끊은 뒤 잔여 조각은 버리고, 신호가 안 와도 3초면 억제가 풀린다.

## 개성

프롬프트만 성격이 아니다. **끼어들기 임계값도 성격이다.**  
`INTERRUPT_RMS` 를 0.26으로 올려서, 반박 중인 말은 웬만하면 끝까지 한다. 쉽게 물러서지 않는 태도를 수치로 넣었다.

목소리는 `Leda`(Youthful) 하나로 고정한다. 초등 저학년 아이 톤.

## 설정

`app.js` 맨 위.

| 상수 | 기본값 | 설명 |
| --- | --- | --- |
| `MODEL` | `gemini-3.1-flash-live-preview` | 수업 지정 모델 |
| `VOICE` | `Leda` | Youthful. 저학년 아이 톤. 화면에서 바꾸지 않음 |
| `SYSTEM_INSTRUCTION` | 비판·냉소·장난 | 에이전트 성격 |
| `INTERRUPT_RMS` | `0.26` | 끼어들기 임계값. 미터의 노란 선 |

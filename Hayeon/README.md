# Hayeon — Voice Agent

인터융합2 과제. Mac 마이크와 스피커로 말하고 듣는 음성 에이전트를 만들고, 이후 Raspberry Pi로 옮길 예정입니다.

**1주차 목표:** 브라우저에서 Gemini Live API와 연결해, 같은 페이지에서 듣고 말하는 기본 루프를 돌리기.

## 작동 방식

1. 로컬 서버로 페이지를 연다. (`index.html`을 더블클릭하지 않음)
2. Live 세션을 연다. 답은 음성으로 온다.
3. 마이크 소리를 계속 API로 보낸다. (16kHz PCM, 마이크는 끄지 않음)
4. 돌아온 목소리를 같은 페이지의 스피커로 재생한다.
5. 사용자가 끼어들면 재생 큐를 즉시 비운다.
6. 3–5를 반복한다.

## 로컬에서 켜는 방법

이 폴더(`Hayeon/`)에서:

```bash
python3 -m http.server
```

브라우저에서 `http://localhost:8000` 을 연다.

API 키는 [Google AI Studio](https://aistudio.google.com/api-keys)에서 발급한다.  
모델은 `gemini-3.1-flash-live-preview` (free tier).  
**키는 코드·GitHub에 올리지 않는다.**

문서: [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api)

## 이번 주에 챙길 것

- **같은 페이지에서 입출력:** 마이크와 스피커가 한 페이지에 있어야 브라우저 AEC(`echoCancellation`)가 동작하기 쉽다.
- **끼어들기:** Gemini가 음성을 조각내서 보내므로, 사용자가 말하면 재생 큐를 비운다.
- **세션:** 한 번 열면 음성 연결이 유지되고, 그 안에서 턴이 이어진다.

## 폴더

| 파일 | 역할 |
|------|------|
| `index.html` | 에이전트 UI + Live 세션 (예정) |

## 제출

- 톡방에 짧은 데모 영상
- 이 저장소 `Hayeon/` 폴더에 프로젝트 올리기 (API 키 제외)

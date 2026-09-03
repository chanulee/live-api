# live-api
본 프로젝트는 학생들이 각자 개성을 조금씩 가진 음성 에이전트를 만들어 보는 프로젝트입니다. 라즈베리 파이+마이크+스피커를 플랫폼으로 Gemini Live API를 사용하여 각각의 음성 에이전트 디바이스들이 인간과, 그리고 서로 대화할 수 있도록 구현합니다. 10월 초 온소에서 전시될 예정입니다. 

``` 인터융합2 9월 9일 과제: 기반 로직 구현```

## 교육목표
- Raspberry Pi 4B와 친해지기 / 피지컬 컴퓨팅에 대한 기본적인 이해
- gemini live api 사용 익히기
- 음성 인터랙션 디자인의 감성적/기술적 요소들을 이해하기
- 음성 인터랙션의 요소들을 이해하기 (AEC, Earcon, delay, VAD, Endpointing, WWD 등)

## 주차별 진행

### 1주차 - 맥에서 일단 기본 로직 구현하기 (과제)

이번 주 목표: Mac 마이크+스피커로 말하고 듣는 Voice 에이전트 만들기

#### Considerations

- 에코: 맥은 macOS가 정리를 좀 잘 해주는 편인데, 라즈베리 파이에서 스피커랑 마이크를 연결해서 쓰면 마이크가 스스로에서 나온 소리인지, 아니면 다른 기기에서 나온 소리인지를 인지를 못하는 경우가 있음. 그래서 시스템 상에서 내 기기에서 나온 소리를 SW로 그걸 정리를 해줘야 함  (AEC)
- 이 AEC를 내가 SW로 따로 해줄 수도 있긴 하지만 크롬같은 브라우저들이 이 기능을 내장하고 있는 경우가 많음. 이게 작동하려면 마이크 입력과 스피커 재생이 같은 페이지에서 이뤄져야 함. (getUserMedia에서 echoCancellation: true를 켜는 식으로)
- 버퍼 플러쉬: Gemini API쪽에서 음성을 조각내서 보내는데, 사용자가 끼어들어도 막 배달이 들어오니까 그 때 큐(대기열)를 비워야됨.
- 로컬 서버: html 파일을 더블클릭해서 여는게 아니라, 파이썬이 직접 `python3 -m http.server`로 페이지를 띄워야 함
- Gemini Live: 대화 주고받고 를 한 턴이라고 부르고, 그 턴들이 이루어지는 세팅을 한 세션이라고 부름. 한 번 세션을 열면 음성 주고받는 연결이 유지됨. 키는 [Google AI Studio](https://aistudio.google.com/api-keys), 문서는 [Live API](https://ai.google.dev/gemini-api/docs/live-api), 모델은 [gemini-3.1-flash-live-preview](https://aistudio.google.com/docs/models/gemini-3.1-flash-live-preview) (free tier).

#### 작동 방식

1. 로컬 페이지를 연다.
2. Live 세션을 연다. (오디오로 답하게)
3. 마이크 소리를 계속 API로 보낸다. (16kHz PCM, 마이크는 끄지 않음)
4. 돌아온 목소리를 같은 페이지의 스피커로 재생한다.
5. 사용자가 끼어들면 재생 큐를 즉시 비운다.
6. 3–5를 반복한다.

#### 제출
- 톡방에 이거 작동하는거 짧은 데모 영상 올리기
- 이 GitHub 저장소에 자기 이름 폴더를 만들어서 프로젝트 올리기 (영어, 띄어쓰기 없이. 예: `chanwoo/`). **API 키는 업로드 금지!!**

올리는 방법 (Fork 이후부터는 GitHub 웹 말고, 꼭 GitHub Desktop 사용하기:)

1. [chanulee/live-api](https://github.com/chanulee/live-api) 들어가서 오른쪽 위 **Fork** 하면 자기 계정에 복사본이 생김
2. 내 계정에 포크된 저장소를 **GitHub Desktop**으로 클론(클라우드에 있는 이 repo를 내 컴퓨터에 똑같이 만들고 동기화시키는거).
   - GitHub Desktop: [다운로드](https://desktop.github.com/)
3. 클론된 폴더(finder에서 열기 누르면 됨) 안에서 자기 이름(영어, 띄어쓰기 없이)으로 폴더를 만들고 그 안에 프로젝트 파일을 넣습니다. (예: `chanwoo/index.html`)
4. GitHub Desktop에서 변경사항을 **Commit**한 다음, 위쪽 **Push origin**을 누릅니다. (터미널에서 `git push` 할 필요 없음. 내 포크 저장소로 올라감)
5. 푸시가 끝나고 **Create Pull Request** 눌러서 원래 저장소(`chanulee/live-api`)로 PR이 열림. 자기 폴더만 추가하고, 남의 파일은 건들지 말기!

---

### 2주차 예고 - Raspberry Pi 준비
- 아마 RPI가 이 때 배송이 올 예정이라, 셋업을 해볼 예정
- 각자 컴퓨터실에서 Raspberry Pi 운영체제(OS) 설치 및 기기 세팅을 진행할 예정입니다.
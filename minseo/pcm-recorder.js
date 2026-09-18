// pcm-recorder.js
// 마이크 입력을 16-bit PCM 조각으로 잘라서 메인 스레드로 넘기는 AudioWorklet.
// AudioContext를 16000Hz로 열어두면 여기 들어오는 샘플은 이미 16kHz다.

// 프레임 크기는 app.js 의 FRAME 상수가 단일 출처다.
// 여기서 따로 정의하면 두 값이 갈라져 화면에 표시되는 수치가 실제와 달라진다.

class PCMRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.frame = opts.frame || 1024;
    this.buf = new Float32Array(this.frame);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];

      if (this.n === this.frame) {
        const pcm = new Int16Array(this.frame);
        let sum = 0;
        for (let j = 0; j < this.frame; j++) {
          const s = Math.max(-1, Math.min(1, this.buf[j]));
          pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
          sum += s * s;
        }
        // rms는 로컬 VAD(끼어들기 감지)와 레벨 미터에 쓴다.
        this.port.postMessage({ pcm: pcm.buffer, rms: Math.sqrt(sum / this.frame) }, [pcm.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-recorder', PCMRecorder);

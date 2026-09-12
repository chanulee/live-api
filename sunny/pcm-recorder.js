// pcm-recorder.js
// 마이크 입력을 16-bit PCM 조각으로 잘라 메인 스레드로 넘기는 AudioWorklet.
// AudioContext 를 16000Hz 로 열어두면 여기 들어오는 샘플은 이미 16kHz 라
// 따로 리샘플링할 필요가 없다.

const FRAME = 1024; // 1024 samples @ 16kHz = 64ms

class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(FRAME);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n < FRAME) continue;

      const pcm = new Int16Array(FRAME);
      let sum = 0;
      for (let j = 0; j < FRAME; j++) {
        const s = Math.max(-1, Math.min(1, this.buf[j]));
        pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
        sum += s * s;
      }
      // rms 는 레벨 미터와 끼어들기(로컬 VAD) 판정에 쓴다.
      this.port.postMessage({ pcm: pcm.buffer, rms: Math.sqrt(sum / FRAME) }, [pcm.buffer]);
      this.n = 0;
    }
    return true;
  }
}

registerProcessor('pcm-recorder', PCMRecorder);

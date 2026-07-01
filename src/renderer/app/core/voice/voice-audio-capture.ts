import { NgZone, WritableSignal } from '@angular/core';

export interface AudioMeter {
  stop(): void;
}

export function stopMediaStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

export function createAudioMeter(
  audioContext: AudioContext,
  stream: MediaStream,
  level: WritableSignal<number>,
  zone: NgZone
): AudioMeter {
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let frame = 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const centered = value - 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / data.length) / 128;
    zone.run(() => level.set(Math.min(1, rms * 3)));
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(frame);
      source.disconnect();
      analyser.disconnect();
      level.set(0);
    },
  };
}

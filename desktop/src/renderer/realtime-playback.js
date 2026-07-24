(function exposeRealtimeAudio(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FloatingPetRealtimeAudio = api;
})(typeof globalThis === 'object' ? globalThis : this, function createRealtimeAudio(root) {
  'use strict';

  const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
  const DEFAULT_RESUME_TIMEOUT_MS = 1_500;
  const DEFAULT_MAX_BUFFERED_CHUNKS = 30;

  function bytesFromBase64(value) {
    if (typeof value !== 'string' || !value || !BASE64.test(value)) throw new Error('invalid_audio_base64');
    if (typeof Buffer === 'function') return Uint8Array.from(Buffer.from(value, 'base64'));
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function base64FromBytes(bytes) {
    if (typeof Buffer === 'function') return Buffer.from(bytes).toString('base64');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function decodeFloat32Base64(value, maxSamples = 240_000) {
    const bytes = bytesFromBase64(value);
    if (!bytes.length || bytes.length % 4 !== 0 || bytes.length / 4 > maxSamples) throw new Error('invalid_audio_length');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Float32Array(bytes.length / 4);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = view.getFloat32(index * 4, true);
      if (!Number.isFinite(sample)) throw new Error('invalid_audio_sample');
      samples[index] = Math.max(-1, Math.min(1, sample));
    }
    return samples;
  }

  function encodeFloat32Base64(samples) {
    if (!(samples instanceof Float32Array) || !samples.length) throw new Error('invalid_audio_samples');
    const bytes = new Uint8Array(samples.length * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      if (!Number.isFinite(sample)) throw new Error('invalid_audio_sample');
      view.setFloat32(index * 4, Math.max(-1, Math.min(1, sample)), true);
    }
    return base64FromBytes(bytes);
  }

  function resampleFloat32(samples, sourceRate, targetRate) {
    if (!(samples instanceof Float32Array) || !samples.length) return new Float32Array();
    if (!Number.isFinite(sourceRate) || !Number.isFinite(targetRate) || sourceRate < 8000 || targetRate < 8000) {
      throw new Error('invalid_sample_rate');
    }
    if (sourceRate === targetRate) return samples.slice();
    const output = new Float32Array(Math.max(1, Math.round(samples.length * targetRate / sourceRate)));
    const ratio = sourceRate / targetRate;
    for (let index = 0; index < output.length; index += 1) {
      const position = index * ratio;
      const left = Math.min(samples.length - 1, Math.floor(position));
      const right = Math.min(samples.length - 1, left + 1);
      const mix = position - left;
      output[index] = samples[left] + (samples[right] - samples[left]) * mix;
    }
    return output;
  }

  async function resumeAudioContext(context, timeoutMs = DEFAULT_RESUME_TIMEOUT_MS) {
    if (!context || context.state !== 'suspended') return;
    let timer;
    try {
      await Promise.race([
        context.resume(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('audio_context_resume_timeout')), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  class BoundedAudioInputQueue {
    constructor(send, {
      maxBufferedChunks = DEFAULT_MAX_BUFFERED_CHUNKS,
      onError = () => undefined,
      discard = (samples) => samples?.fill?.(0)
    } = {}) {
      if (typeof send !== 'function' || typeof onError !== 'function' || typeof discard !== 'function') {
        throw new TypeError('invalid_realtime_input_queue');
      }
      if (!Number.isInteger(maxBufferedChunks) || maxBufferedChunks < 1 || maxBufferedChunks > 300) {
        throw new TypeError('invalid_realtime_input_queue');
      }
      this.send = send;
      this.onError = onError;
      this.discard = discard;
      this.maxBufferedChunks = maxBufferedChunks;
      this.pending = [];
      this.active = null;
      this.running = false;
      this.stopped = false;
      this.drainPromise = null;
    }

    push(samples) {
      if (!(samples instanceof Float32Array) || !samples.length) throw new TypeError('invalid_audio_samples');
      if (this.stopped) {
        this._discard(samples);
        return false;
      }
      if (this.pending.length + (this.running ? 1 : 0) >= this.maxBufferedChunks) {
        this._discard(samples);
        const error = new Error('audio_input_overflow');
        error.code = 'audio_input_overflow';
        this.stop();
        try { void Promise.resolve(this.onError(error)).catch(() => undefined); } catch { /* error reporting is best effort */ }
        return false;
      }
      this.pending.push(samples);
      if (this.running) return true;
      this.running = true;
      const draining = this._drain();
      const tracked = draining.finally(() => {
        if (this.drainPromise === tracked) this.drainPromise = null;
      });
      this.drainPromise = tracked;
      return true;
    }

    stop() {
      if (this.stopped) return;
      this.stopped = true;
      this._discard(this.active);
      for (const samples of this.pending.splice(0)) this._discard(samples);
    }

    whenIdle() {
      return this.drainPromise || Promise.resolve();
    }

    async _drain() {
      while (this.pending.length && !this.stopped) {
        const current = this.pending.shift();
        this.active = current;
        try {
          await this.send(current);
        } catch (error) {
          const notify = !this.stopped;
          this.stop();
          if (notify) {
            try { await this.onError(error); } catch { /* error reporting is best effort */ }
          }
          break;
        } finally {
          this._discard(current);
          if (this.active === current) this.active = null;
        }
      }
      this.running = false;
    }

    _discard(samples) {
      if (!samples) return;
      try { this.discard(samples); } catch { /* discard is best effort */ }
    }
  }

  class PcmPlayback {
    constructor({ AudioContextClass = root.AudioContext || root.webkitAudioContext, maxQueuedSeconds = 10 } = {}) {
      this.AudioContextClass = AudioContextClass;
      this.maxQueuedSeconds = maxQueuedSeconds;
      this.context = null;
      this.nextTime = 0;
      this.sources = new Set();
      this.generation = 0;
      this.closed = false;
    }

    async enqueueBase64(value, sampleRate = 24_000) {
      return this.enqueue(decodeFloat32Base64(value), sampleRate);
    }

    async enqueue(samples, sampleRate = 24_000) {
      if (this.closed || !this.AudioContextClass || !(samples instanceof Float32Array) || !samples.length) return false;
      const generation = this.generation;
      const context = this.context || (this.context = new this.AudioContextClass());
      await resumeAudioContext(context);
      if (this.closed || generation !== this.generation || context !== this.context || context.state === 'closed') return false;
      const startAt = Math.max(context.currentTime, this.nextTime);
      const duration = samples.length / sampleRate;
      if (startAt - context.currentTime + duration > this.maxQueuedSeconds) return false;
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        this.sources.delete(source);
        source.disconnect();
      };
      this.sources.add(source);
      source.start(startAt);
      this.nextTime = startAt + duration;
      return true;
    }

    clear() {
      this.generation += 1;
      for (const source of this.sources) {
        try { source.stop(); } catch { /* already ended */ }
        source.disconnect();
      }
      this.sources.clear();
      this.nextTime = this.context?.currentTime || 0;
    }

    async close() {
      this.closed = true;
      this.clear();
      const context = this.context;
      this.context = null;
      if (context && context.state !== 'closed') await context.close().catch(() => undefined);
    }
  }

  return { BoundedAudioInputQueue, PcmPlayback, decodeFloat32Base64, encodeFloat32Base64, resampleFloat32, resumeAudioContext };
});

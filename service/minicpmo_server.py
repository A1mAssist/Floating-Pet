"""Small mode-aware MiniCPM-o adapter.

The HTTP endpoint is intentionally boring.  Realtime is a narrow public
WebSocket protocol; the model-specific methods stay behind ``DuplexBackend``
so an unavailable Ascend image can fail as ``capability_missing`` instead of
looking like a successful fake response.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
from contextlib import asynccontextmanager
import io
import json
import logging
import math
import os
import struct
import threading
import time
import uuid
import wave
from dataclasses import dataclass
from typing import Any

try:
    from starlette.requests import Request as StarletteRequest
    from starlette.websockets import WebSocket as StarletteWebSocket
except ModuleNotFoundError:  # Pure protocol tests do not require FastAPI.
    StarletteRequest = Any
    StarletteWebSocket = Any


MODEL_NAME = os.environ.get("MINICPM_SERVED_MODEL_NAME", "cpmo")
LOGGER = logging.getLogger("minicpmo_server")
MODEL_DIR = os.environ.get(
    "MINICPM_MODEL_DIR",
    "/workspace/user_data/models/MiniCPMO45",
)
MAX_MESSAGES = 8
MAX_TEXT_CHARS = 4000
MAX_TOTAL_TEXT_CHARS = 8000
MAX_PARTS = 16
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_AUDIO_BYTES = 2 * 1024 * 1024
MAX_REQUEST_BYTES = 10 * 1024 * 1024
MAX_IMAGE_DIMENSION = 4096
MAX_IMAGE_PIXELS = 16_000_000
MAX_AUDIO_SECONDS = 15
MIN_PROMPT_AUDIO_SECONDS = 1
MAX_PROMPT_AUDIO_SECONDS = 30
MAX_PROMPT_WAV_BYTES = 24 * 1024 * 1024
REALTIME_AUDIO_SECONDS = 2
REALTIME_AUDIO_BYTES = 16_000 * REALTIME_AUDIO_SECONDS * 4
MAX_REALTIME_FRAME_BYTES = 1 * 1024 * 1024
MAX_REALTIME_FRAMES = 2
MAX_REALTIME_EVENT_BYTES = (
    ((REALTIME_AUDIO_BYTES + 2) // 3) * 4
    + MAX_REALTIME_FRAMES * (((MAX_REALTIME_FRAME_BYTES + 2) // 3) * 4)
    + 64 * 1024
)
MAX_REALTIME_INIT_BYTES = 64 * 1024
MAX_REALTIME_PENDING_EVENTS = 4
REALTIME_INIT_TIMEOUT_SECONDS = 10
REALTIME_PREPARE_TIMEOUT_SECONDS = 30
REALTIME_PROCESS_TIMEOUT_SECONDS = 120
REALTIME_PROCESS_STOP_TIMEOUT_SECONDS = 8
CHAT_INFERENCE_TIMEOUT_SECONDS = 120
MAX_SLICE_NUMS = 4


@dataclass(frozen=True)
class Part:
    kind: str
    value: str | bytes


class CapabilityMissing(RuntimeError):
    """Raised when the selected image cannot provide the requested mode."""


def selected_mode(value: str | None = None) -> str:
    mode = (value or os.environ.get("MINICPM_MODE", "chat")).strip().lower()
    if mode not in {"chat", "duplex"}:
        raise ValueError("MINICPM_MODE must be chat or duplex")
    return mode


def selected_device(value: str | None = None) -> str:
    device = (value or os.environ.get("MINICPM_DEVICE", "npu:0")).strip().lower()
    if device not in {"npu:0", "npu:1"}:
        raise ValueError("MINICPM_DEVICE must be npu:0 or npu:1")
    return device


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _validate_image_bytes(data: bytes, *, jpeg_only: bool = False) -> tuple[int, int]:
    if not data or len(data) > (MAX_REALTIME_FRAME_BYTES if jpeg_only else MAX_IMAGE_BYTES):
        raise ValueError("image is too large or empty")
    if not data.startswith(b"\xff\xd8\xff") and jpeg_only:
        raise ValueError("video frame must be JPEG")
    if not jpeg_only and not (data.startswith(b"\xff\xd8\xff") or data.startswith(b"\x89PNG\r\n\x1a\n")):
        raise ValueError("invalid image data")
    try:
        from PIL import Image, ImageFile

        ImageFile.LOAD_TRUNCATED_IMAGES = False
        with Image.open(io.BytesIO(data)) as image:
            width, height = image.size
            if not width or not height or width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
                raise ValueError("image dimensions are too large")
            if width * height > MAX_IMAGE_PIXELS:
                raise ValueError("image has too many pixels")
            if jpeg_only and image.format != "JPEG":
                raise ValueError("video frame must be JPEG")
            if not jpeg_only and image.format not in {"JPEG", "PNG"}:
                raise ValueError("image must be JPEG or PNG")
            image.verify()
            return width, height
    except ValueError:
        raise
    except Exception as exc:  # Pillow raises several format-specific errors.
        raise ValueError("invalid image data") from exc


def decode_data_image(value: Any) -> bytes:
    if not isinstance(value, str) or not value.startswith(("data:image/jpeg;base64,", "data:image/png;base64,")):
        raise ValueError("image must be a JPEG or PNG data URL")
    declared_mime, encoded = value.split(",", 1)
    if len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
        raise ValueError("image is too large")
    data = _decode_base64(encoded, "image")
    is_jpeg = data.startswith(b"\xff\xd8\xff")
    is_png = data.startswith(b"\x89PNG\r\n\x1a\n")
    if (declared_mime.endswith("jpeg;base64") and not is_jpeg) or (declared_mime.endswith("png;base64") and not is_png):
        raise ValueError("image MIME does not match image data")
    _validate_image_bytes(data)
    return data


def _validate_wav_header(data: bytes, *, max_seconds: int = MAX_AUDIO_SECONDS) -> tuple[int, int, int]:
    """Return (sample_rate, channels, frame_count) before any resampling."""
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("invalid WAV data")
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if wav.getcomptype() != "NONE":
                raise ValueError("compressed WAV is not supported")
            sample_rate = wav.getframerate()
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            frames = wav.getnframes()
            declared_length = struct.unpack_from("<I", data, 4)[0] + 8
            if declared_length > len(data):
                raise ValueError("WAV data is truncated")
            if declared_length != len(data):
                raise ValueError("invalid WAV data")
            if not 8_000 <= sample_rate <= 96_000:
                raise ValueError("WAV sample rate must be between 8000 and 96000 Hz")
            if channels not in {1, 2}:
                raise ValueError("WAV must be mono or stereo")
            if sample_width not in {2, 4}:
                raise ValueError("WAV sample width must be 16 or 32 bit")
            if frames <= 0 or frames > sample_rate * max_seconds:
                raise ValueError(f"audio duration must be between 0 and {max_seconds} seconds")
            expected_bytes = frames * channels * sample_width
            actual_bytes = len(wav.readframes(frames))
    except (wave.Error, EOFError, RuntimeError, ValueError) as exc:
        if isinstance(exc, ValueError):
            raise
        raise ValueError("invalid WAV data") from exc
    if actual_bytes != expected_bytes:
        raise ValueError("WAV data is truncated")
    return sample_rate, channels, frames


def decode_audio(value: Any) -> bytes:
    if not isinstance(value, dict) or value.get("format") != "wav" or not isinstance(value.get("data"), str):
        raise ValueError("audio must be base64 WAV")
    encoded = value["data"]
    if len(encoded) > ((MAX_AUDIO_BYTES + 2) // 3) * 4:
        raise ValueError("audio is too large")
    data = _decode_base64(encoded, "audio")
    if len(data) < 12 or len(data) > MAX_AUDIO_BYTES or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("invalid WAV data")
    _validate_wav_header(data)
    return data


def normalize_messages(payload: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        raise ValueError("request must be an object")
    messages = payload.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= MAX_MESSAGES:
        raise ValueError("messages must contain 1-8 items")

    normalized: list[dict[str, Any]] = []
    image_count = 0
    audio_count = 0
    part_count = 0
    total_text_chars = 0
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in {"system", "user", "assistant"}:
            raise ValueError("invalid message role")
        content = message.get("content")
        raw_parts = [{"type": "text", "text": content}] if isinstance(content, str) else content
        if not isinstance(raw_parts, list) or not raw_parts:
            raise ValueError("message content is empty")

        parts: list[Part] = []
        for raw in raw_parts:
            if not isinstance(raw, dict):
                raise ValueError("invalid content part")
            part_count += 1
            if part_count > MAX_PARTS:
                raise ValueError("too many content parts")
            if raw.get("type") == "text":
                text = raw.get("text")
                if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
                    raise ValueError("invalid text content")
                total_text_chars += len(text)
                if total_text_chars > MAX_TOTAL_TEXT_CHARS:
                    raise ValueError("total text content is too large")
                parts.append(Part("text", text.strip()))
                continue
            if raw.get("type") == "image_url":
                image_url = raw.get("image_url")
                if not isinstance(image_url, dict):
                    raise ValueError("invalid image URL")
                url = image_url.get("url")
                parts.append(Part("image", decode_data_image(url)))
                image_count += 1
                if image_count > 1:
                    raise ValueError("only one image is supported")
                continue
            if raw.get("type") == "input_audio":
                parts.append(Part("audio", decode_audio(raw.get("input_audio"))))
                audio_count += 1
                if audio_count > 1:
                    raise ValueError("only one audio input is supported")
                continue
            raise ValueError("unsupported content part")
        normalized.append({"role": message["role"], "parts": parts})

    first_user = next((index for index, item in enumerate(normalized) if item["role"] == "user"), None)
    if first_user is None:
        raise ValueError("a user message is required")
    leading_system = [item for item in normalized[:first_user] if item["role"] == "system"]
    return leading_system + normalized[first_user:]


def _decode_base64(value: str, label: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"invalid {label} encoding") from exc


def _decode_b64(value: Any, *, max_bytes: int, label: str) -> bytes:
    if not isinstance(value, str) or not value or len(value) > ((max_bytes + 2) // 3) * 4:
        raise ValueError(f"{label} is too large or invalid")
    data = _decode_base64(value, label)
    if not data or len(data) > max_bytes:
        raise ValueError(f"{label} is too large or empty")
    return data


def _validate_float32_samples(data: bytes, label: str) -> None:
    for (sample,) in struct.iter_unpack("<f", data):
        if not math.isfinite(sample):
            raise ValueError(f"{label} contains a non-finite sample")
        if abs(sample) > 1:
            raise ValueError(f"{label} samples must be between -1 and 1")


def validate_realtime_audio(value: Any) -> bytes:
    data = _decode_b64(value, max_bytes=REALTIME_AUDIO_BYTES, label="audio")
    if len(data) % 4:
        raise ValueError("audio must contain little-endian float32 samples")
    _validate_float32_samples(data, "audio")
    return data


def validate_realtime_input(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("input must be an object")
    audio = validate_realtime_audio(value.get("audio"))
    raw_frames = value.get("video_frames", [])
    if raw_frames is None:
        raw_frames = []
    if not isinstance(raw_frames, list) or len(raw_frames) > MAX_REALTIME_FRAMES:
        raise ValueError("video_frames must contain at most two JPEGs")
    frames: list[bytes] = []
    for raw_frame in raw_frames:
        frame = _decode_b64(raw_frame, max_bytes=MAX_REALTIME_FRAME_BYTES, label="video frame")
        _validate_image_bytes(frame, jpeg_only=True)
        frames.append(frame)
    hints = value.get("hints", {})
    if not isinstance(hints, dict):
        raise ValueError("hints must be an object")
    force_listen = value.get("force_listen", hints.get("force_listen", False))
    if not isinstance(force_listen, bool):
        raise ValueError("force_listen must be boolean")
    max_slice_nums = value.get("max_slice_nums", hints.get("max_slice_nums", 1))
    if isinstance(max_slice_nums, bool) or not isinstance(max_slice_nums, int) or not 1 <= max_slice_nums <= MAX_SLICE_NUMS:
        raise ValueError("max_slice_nums is out of range")
    return {
        "audio": audio,
        "video_frames": frames,
        "max_slice_nums": max_slice_nums,
    }


def validate_realtime_init(value: Any, session_mode: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise ValueError("session.init payload must be an object")
    if set(value) - {"mode", "system_prompt"}:
        raise ValueError("session.init payload contains unsupported fields")
    mode = value.get("mode", session_mode)
    if not isinstance(mode, str) or mode != session_mode:
        raise ValueError("session.init mode must match the WebSocket mode")
    system_prompt = value.get("system_prompt", "")
    if not isinstance(system_prompt, str) or len(system_prompt) > MAX_TEXT_CHARS:
        raise ValueError("system_prompt is invalid")
    if any((ord(character) < 32 and character not in "\t\r\n") or ord(character) == 127 for character in system_prompt):
        raise ValueError("system_prompt is invalid")
    return {"mode": session_mode, "system_prompt": system_prompt}


def _audio_to_array(data: bytes) -> Any:
    import numpy as np

    samples = np.frombuffer(data, dtype="<f4")
    if samples.ndim != 1 or samples.size == 0 or not np.isfinite(samples).all():
        raise ValueError("audio contains invalid samples")
    return samples.copy()


def _encode_output_audio(value: Any) -> str:
    import numpy as np

    samples = np.asarray(value, dtype=np.float32)
    if samples.ndim != 1 or samples.size == 0 or samples.size > 24_000 * REALTIME_AUDIO_SECONDS:
        raise ValueError("backend audio must be a bounded mono array")
    data = np.asarray(samples, dtype="<f4").tobytes()
    _validate_float32_samples(data, "backend audio")
    return base64.b64encode(data).decode("ascii")


class FakeDuplexBackend:
    """Deterministic backend used by local protocol tests and offline demos."""

    def __init__(self) -> None:
        self.prepared = False
        self.stopped = False

    def prepare(self, payload: dict[str, Any], mode: str = "audio") -> None:
        self.prepared = True
        self.stopped = False

    def process(self, request: dict[str, Any]) -> dict[str, Any]:
        if not self.prepared or self.stopped:
            raise RuntimeError("backend session is not prepared")
        # Ten milliseconds of deterministic silence is enough to exercise the
        # playback path without making fake tests needlessly large.
        audio = b"\x00" * (240 * 4)
        return {
            "text": "已收到实时输入。",
            "audio": audio,
            "is_listen": False,
            "end_of_turn": True,
        }

    def stop(self) -> None:
        self.stopped = True


class DuplexBackend:
    """Adapter for the verified MiniCPMODuplex methods only."""

    def __init__(self, model: Any, prompt_wav_path: str, device: str) -> None:
        self.model = model
        self.prompt_wav_path = prompt_wav_path
        self.device = selected_device(device)
        self.prepared = False

    def _activate_device(self) -> None:
        # asyncio.to_thread uses worker-local NPU defaults; third-party .cuda()
        # calls must follow the model loaded on this device.
        import torch

        torch.npu.set_device(self.device)

    def prepare(self, payload: dict[str, Any], mode: str = "audio") -> None:
        # These arguments are part of the inspected Ascend revision.  Do not
        # pass client-provided arbitrary kwargs into the model.
        system_prompt = payload.get("system_prompt", "")
        if not isinstance(system_prompt, str) or len(system_prompt) > MAX_TEXT_CHARS:
            raise ValueError("system_prompt is invalid")
        if mode not in {"audio", "video"}:
            raise ValueError("mode must be audio or video")
        system_prompt = system_prompt.strip() or "Streaming Duplex Conversation! You are a helpful assistant."
        self._activate_device()
        self.model.prepare(
            prefix_system_prompt=f"<|im_start|>system\n{system_prompt}",
            suffix_system_prompt="<|im_end|>",
            ref_audio=None,
            prompt_wav_path=self.prompt_wav_path,
            mode="omni" if mode == "video" else "audio",
        )
        self.prepared = True

    def process(self, request: dict[str, Any]) -> dict[str, Any]:
        if not self.prepared:
            raise RuntimeError("backend session is not prepared")
        self._activate_device()
        from PIL import Image

        frames = []
        for frame in request["video_frames"]:
            with Image.open(io.BytesIO(frame)) as image:
                frames.append(image.convert("RGB").copy())
        prefill = self.model.streaming_prefill(
            audio_waveform=_audio_to_array(request["audio"]),
            frame_list=frames,
            max_slice_nums=request["max_slice_nums"],
        )
        if isinstance(prefill, dict) and prefill.get("success") is False:
            raise RuntimeError(str(prefill.get("reason") or "duplex prefill failed"))
        result = self.model.streaming_generate(
            prompt_wav_path=self.prompt_wav_path,
            max_new_speak_tokens_per_chunk=20,
            decode_mode="sampling",
        )
        if not isinstance(result, dict):
            raise RuntimeError("backend returned an invalid result")
        return result

    def stop(self) -> None:
        stop = getattr(self.model, "set_session_stop", None)
        if not callable(stop):
            raise CapabilityMissing("MiniCPMODuplex.set_session_stop is unavailable")
        self._activate_device()
        stop()
        self.prepared = False


def _load_chat_model() -> Any:
    try:
        import torch
        import torch_npu  # noqa: F401
        from transformers import AutoModel

        device = selected_device()
        torch.npu.set_device(device)
        model = AutoModel.from_pretrained(
            MODEL_DIR,
            trust_remote_code=True,
            torch_dtype=torch.bfloat16,
            low_cpu_mem_usage=True,
            _attn_implementation=os.environ.get("MINICPM_ATTN", "eager"),
        )
        model.eval().to(device)
        torch.npu.synchronize()
        return model
    except Exception as exc:
        LOGGER.exception("MiniCPM chat backend failed to load")
        raise CapabilityMissing(f"chat backend unavailable: {exc}") from exc


def _validate_prompt_wav(path: str) -> tuple[int, int, int]:
    try:
        with open(path, "rb") as prompt:
            data = prompt.read(MAX_PROMPT_WAV_BYTES + 1)
    except OSError as exc:
        raise ValueError("prompt WAV is not readable") from exc
    if len(data) > MAX_PROMPT_WAV_BYTES:
        raise ValueError("prompt WAV is too large")
    try:
        sample_rate, channels, frames = _validate_wav_header(
            data,
            max_seconds=MAX_PROMPT_AUDIO_SECONDS,
        )
    except ValueError as exc:
        raise ValueError(f"prompt WAV is invalid: {exc}") from exc
    if sample_rate < 16_000:
        raise ValueError("prompt WAV sample rate must be at least 16000 Hz")
    if frames < sample_rate * MIN_PROMPT_AUDIO_SECONDS:
        raise ValueError(f"prompt WAV must be at least {MIN_PROMPT_AUDIO_SECONDS} second")
    return sample_rate, channels, frames


def _patch_npu_istft(torch_module: Any) -> None:
    original = torch_module.istft
    if getattr(original, "_minicpmo_npu_fallback", False):
        return

    def npu_safe_istft(input_tensor: Any, *args: Any, **kwargs: Any) -> Any:
        if getattr(getattr(input_tensor, "device", None), "type", None) != "npu":
            return original(input_tensor, *args, **kwargs)
        try:
            return original(input_tensor, *args, **kwargs)
        except RuntimeError as exc:
            message = str(exc)
            if "istft(" not in message or "window overlap add min" not in message:
                raise
        cpu_args = list(args)
        if len(cpu_args) > 3 and hasattr(cpu_args[3], "cpu"):
            cpu_args[3] = cpu_args[3].cpu()
        cpu_kwargs = dict(kwargs)
        if hasattr(cpu_kwargs.get("window"), "cpu"):
            cpu_kwargs["window"] = cpu_kwargs["window"].cpu()
        return original(input_tensor.cpu(), *cpu_args, **cpu_kwargs).to(input_tensor.device)

    npu_safe_istft._minicpmo_npu_fallback = True
    torch_module.istft = npu_safe_istft


def _patch_s3tokenizer_load_audio() -> None:
    """Keep prompt WAV loading independent of torchaudio's TorchCodec extra."""
    try:
        import s3tokenizer
    except ModuleNotFoundError:
        return
    if getattr(getattr(s3tokenizer, "load_audio", None), "_minicpmo_soundfile", False) is True:
        return

    def load_audio(file_path: str, sr: int = 16_000) -> Any:
        import numpy as np
        import soundfile as sf
        import torch

        audio, sample_rate = sf.read(file_path, dtype="float32", always_2d=False)
        if getattr(audio, "ndim", 0) > 1:
            audio = audio.mean(axis=1)
        if getattr(audio, "ndim", 0) != 1 or not len(audio):
            raise ValueError("prompt WAV contains no audio")
        if sample_rate != sr:
            import librosa

            audio = librosa.resample(y=audio, orig_sr=sample_rate, target_sr=sr)
        return torch.from_numpy(np.asarray(audio, dtype=np.float32).copy())

    load_audio._minicpmo_soundfile = True
    s3tokenizer.load_audio = load_audio


def _patch_torchaudio_load() -> None:
    """Keep the Duplex prompt cache independent of torchaudio's TorchCodec extra."""
    try:
        import torchaudio
    except ModuleNotFoundError:
        return
    if getattr(torchaudio.load, "_minicpmo_soundfile", False) is True:
        return

    def load(
        file_path: str,
        frame_offset: int = 0,
        num_frames: int = -1,
        normalize: bool = True,
        channels_first: bool = True,
        format: str | None = None,
        buffer_size: int = 4096,
        backend: str | None = None,
    ) -> tuple[Any, int]:
        del normalize, format, buffer_size, backend
        import soundfile as sf
        import torch

        audio, sample_rate = sf.read(
            file_path,
            dtype="float32",
            always_2d=True,
            start=frame_offset,
            frames=num_frames,
        )
        return torch.from_numpy((audio.T if channels_first else audio).copy()), sample_rate

    load._minicpmo_soundfile = True
    torchaudio.load = load


def _move_duplex_hift_to_cpu(model: Any) -> None:
    """Run the Ascend-incompatible HifiGAN stage on CPU, not a substitute TTS."""
    try:
        hift = model.model.tts.audio_tokenizer.hift
    except AttributeError as exc:
        raise CapabilityMissing("MiniCPMODuplex HifiGAN vocoder is unavailable") from exc
    if getattr(hift, "_minicpmo_cpu_hift", False) is True:
        return
    original_forward = hift.forward
    if not callable(original_forward) or not callable(getattr(hift, "cpu", None)):
        raise CapabilityMissing("MiniCPMODuplex HifiGAN vocoder is unavailable")
    hift.cpu().eval()

    def cpu_forward(speech_feat: Any, cache_source: Any = None) -> tuple[Any, Any]:
        if cache_source is None:
            speech, source = original_forward(speech_feat.cpu())
        else:
            speech, source = original_forward(speech_feat.cpu(), cache_source.cpu())
        return speech.to(speech_feat.device), source.to(speech_feat.device)

    hift.forward = cpu_forward
    hift._minicpmo_cpu_hift = True


def _load_duplex_backend() -> DuplexBackend:
    prompt_wav_path = os.environ.get("MINICPM_PROMPT_WAV", "").strip()
    if not prompt_wav_path or not os.path.isfile(prompt_wav_path):
        raise CapabilityMissing("MINICPM_PROMPT_WAV is required for duplex audio output")
    try:
        _validate_prompt_wav(prompt_wav_path)
    except (OSError, ValueError) as exc:
        raise CapabilityMissing(f"invalid MINICPM_PROMPT_WAV: {exc}") from exc
    try:
        import torch
        import torch_npu.contrib.transfer_to_npu  # noqa: F401
        from transformers.dynamic_module_utils import get_class_from_dynamic_module

        device = selected_device()
        torch.npu.set_device(device)
        _patch_npu_istft(torch)
        _patch_s3tokenizer_load_audio()
        _patch_torchaudio_load()
        duplex_class = get_class_from_dynamic_module(
            "modeling_minicpmo.MiniCPMODuplex",
            MODEL_DIR,
            trust_remote_code=True,
        )
        model = duplex_class.from_pretrained(
            MODEL_DIR,
            device=device,
            generate_audio=True,
            attn_implementation=os.environ.get("MINICPM_ATTN", "eager"),
        )
        _move_duplex_hift_to_cpu(model)
        for method in ("prepare", "streaming_prefill", "streaming_generate", "set_session_stop"):
            if not callable(getattr(model, method, None)):
                raise CapabilityMissing(f"MiniCPMODuplex.{method} is unavailable")
        torch.npu.synchronize()
        return DuplexBackend(model, prompt_wav_path, device)
    except CapabilityMissing:
        raise
    except Exception as exc:
        LOGGER.exception("MiniCPM duplex backend failed to load")
        raise CapabilityMissing(f"duplex backend unavailable: {exc}") from exc


def _error_detail(code: str, message: str) -> dict[str, Any]:
    return {"code": code, "message": message}


def _close_reason(value: Any, fallback: str = "user_stop") -> str:
    return value[:64] if isinstance(value, str) and value else fallback


async def _read_limited_body(request: Any, limit: int = MAX_REQUEST_BYTES) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared_length = int(content_length)
            if declared_length < 0:
                raise ValueError("invalid content length")
            if declared_length > limit:
                raise ValueError("request body is too large")
        except ValueError as exc:
            if str(exc) in {"request body is too large", "invalid content length"}:
                raise
            raise ValueError("invalid content length") from exc
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise ValueError("request body is too large")
        chunks.append(chunk)
    return b"".join(chunks)


async def _read_json_body(request: Any, limit: int = MAX_REQUEST_BYTES) -> dict[str, Any]:
    raw = await _read_limited_body(request, limit)
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("request body must be valid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError("request body must be an object")
    return value


def _public_delta_events(result: dict[str, Any], session_id: str, response_id: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    text = result.get("text")
    if text is not None:
        if not isinstance(text, str) or len(text) > MAX_TEXT_CHARS:
            raise ValueError("backend text is invalid")
        if text:
            events.append({
                "type": "response.output.delta",
                "kind": "text",
                "session_id": session_id,
                "response_id": response_id,
                "text": text,
            })
    is_listen = result.get("is_listen", False)
    end_of_turn = result.get("end_of_turn", False)
    if not isinstance(is_listen, bool) or not isinstance(end_of_turn, bool):
        raise ValueError("backend listen flags are invalid")
    audio = result.get("audio", result.get("audio_waveform"))
    if not is_listen and audio is not None:
        if isinstance(audio, str):
            # A test/fake may already provide base64; validate the decoded
            # bytes before forwarding it.
            audio_bytes = _decode_b64(audio, max_bytes=24_000 * REALTIME_AUDIO_SECONDS * 4, label="backend audio")
            if len(audio_bytes) % 4:
                raise ValueError("backend audio is not float32")
            _validate_float32_samples(audio_bytes, "backend audio")
            encoded = audio
        elif isinstance(audio, (bytes, bytearray, memoryview)):
            audio_bytes = bytes(audio)
            if not audio_bytes or len(audio_bytes) > 24_000 * REALTIME_AUDIO_SECONDS * 4 or len(audio_bytes) % 4:
                raise ValueError("backend audio is not bounded float32")
            _validate_float32_samples(audio_bytes, "backend audio")
            encoded = base64.b64encode(audio_bytes).decode("ascii")
        else:
            encoded = _encode_output_audio(audio)
        events.append({
            "type": "response.output.delta",
            "kind": "audio",
            "session_id": session_id,
            "response_id": response_id,
            "audio": encoded,
        })
    if is_listen or end_of_turn:
        events.append({
            "type": "response.output.delta",
            "kind": "listen",
            "session_id": session_id,
            "response_id": response_id,
        })
    if not events:
        raise ValueError("backend returned no output")
    return events


def create_app(
    *,
    mode: str | None = None,
    fake_duplex: bool | None = None,
    background_load: bool | None = None,
):
    """Build the FastAPI app without importing a model until startup.

    ``fake_duplex=True`` is intentionally injectable for local tests.  The
    process environment remains the normal deployment interface.
    """

    from fastapi import FastAPI, HTTPException, WebSocketDisconnect

    selected = selected_mode(mode)
    device = selected_device()
    use_fake_duplex = _env_flag("MINICPM_FAKE_DUPLEX") if fake_duplex is None else fake_duplex
    use_background_load = not _env_flag("MINICPM_PROTOCOL_TEST") if background_load is None else background_load
    state: dict[str, Any] = {
        "model": None,
        "backend": None,
        "loaded_at": None,
        "device": None,
        "error": None,
        "fake": bool(use_fake_duplex and selected == "duplex"),
    }
    chat_lock = asyncio.Lock()
    realtime_lock = asyncio.Lock()

    def quarantine_chat_model(message: str) -> None:
        state["model"] = None
        state["error"] = _error_detail("backend_stuck", message)

    def load_model() -> None:
        if state["fake"]:
            backend = FakeDuplexBackend()
            state["device"] = "fake"
            state["loaded_at"] = int(time.time())
            state["backend"] = backend
            return
        try:
            if selected == "chat":
                model = _load_chat_model()
                state["device"] = device
                state["loaded_at"] = int(time.time())
                state["model"] = model
            else:
                backend = _load_duplex_backend()
                state["device"] = device
                state["loaded_at"] = int(time.time())
                state["backend"] = backend
        except CapabilityMissing as exc:
            state["error"] = {"code": "capability_missing", "message": str(exc)}
        except Exception:
            LOGGER.exception("MiniCPM model failed to load")
            state["error"] = _error_detail("model_load_failed", "model failed to load")

    @asynccontextmanager
    async def lifespan(_app: Any):
        if use_background_load:
            threading.Thread(target=load_model, name="minicpm-model-loader", daemon=True).start()
        else:
            load_model()
        yield

    app = FastAPI(title="MiniCPM-o Ascend Adapter", docs_url=None, redoc_url=None, lifespan=lifespan)

    @app.get("/health")
    def health() -> dict[str, Any]:
        ready = state["model"] is not None or state["backend"] is not None
        return {
            "status": "ready" if ready else ("degraded" if state["error"] else "loading"),
            "model": MODEL_NAME,
            "mode": selected,
            "device": state["device"],
            "loaded_at": state["loaded_at"],
            "fake": state["fake"],
            "capabilities": {
                "chat_completions": bool(selected == "chat" and state["model"] is not None),
                "image_input": bool(selected == "chat" and state["model"] is not None),
                "audio_input_wav": bool(selected == "chat" and state["model"] is not None),
                "realtime": bool(selected == "duplex" and state["backend"] is not None),
                "audio_input_16k_f32": bool(selected == "duplex" and state["backend"] is not None),
                "video_jpeg": bool(selected == "duplex" and state["backend"] is not None),
                "audio_output_24k_f32": bool(selected == "duplex" and state["backend"] is not None),
            },
            "error": state["error"],
        }

    @app.get("/v1/models")
    def models() -> dict[str, Any]:
        return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model", "owned_by": "OpenBMB"}]}

    @app.post("/v1/chat/completions")
    async def chat(request: StarletteRequest) -> dict[str, Any]:
        if selected != "chat":
            raise HTTPException(status_code=409, detail=_error_detail("capability_missing", "chat mode is not active"))
        if state["model"] is None:
            raise HTTPException(status_code=503, detail=state["error"] or _error_detail("model_loading", "model is loading"))
        try:
            payload = await _read_json_body(request)
            normalized = normalize_messages(payload)
            from PIL import Image

            messages = []
            has_audio = False
            for message in normalized:
                content = []
                for part in message["parts"]:
                    if part.kind == "text":
                        content.append(part.value)
                    elif part.kind == "image":
                        with Image.open(io.BytesIO(part.value)) as image:
                            content.append(image.convert("RGB").copy())
                    else:
                        import librosa
                        import numpy as np
                        import soundfile as sf

                        audio, sample_rate = sf.read(io.BytesIO(part.value), dtype="float32", always_2d=False)
                        if audio.ndim > 1:
                            audio = audio.mean(axis=1)
                        # Header validation above happens before this call, so
                        # a low-rate file cannot expand during resampling.
                        if sample_rate != 16000:
                            audio = librosa.resample(y=audio, orig_sr=sample_rate, target_sr=16000)
                        if not 0 < len(audio) <= 16000 * MAX_AUDIO_SECONDS:
                            raise ValueError("audio duration must be 15 seconds or less")
                        content.append(np.asarray(audio, dtype=np.float32))
                        has_audio = True
                messages.append({"role": message["role"], "content": content})
            raw_max_tokens = payload.get("max_tokens", 256)
            if isinstance(raw_max_tokens, bool) or not isinstance(raw_max_tokens, int):
                raise ValueError("max_tokens must be an integer")
            max_tokens = min(max(raw_max_tokens, 1), 1024)
        except (TypeError, ValueError, OSError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        async with chat_lock:
            model = state["model"]
            if model is None:
                raise HTTPException(status_code=503, detail=state["error"] or _error_detail("model_loading", "model is loading"))

            def infer() -> Any:
                return model.chat(
                    image=None,
                    msgs=messages,
                    do_sample=False,
                    max_new_tokens=max_tokens,
                    max_inp_length=8192,
                    stream=False,
                    use_tts_template=False,
                    generate_audio=False,
                    omni_mode=has_audio,
                )

            infer_task = asyncio.create_task(asyncio.to_thread(infer))
            try:
                text = await asyncio.wait_for(
                    asyncio.shield(infer_task),
                    timeout=CHAT_INFERENCE_TIMEOUT_SECONDS,
                )
            except asyncio.CancelledError:
                infer_task.add_done_callback(lambda task: None if task.cancelled() else task.exception())
                quarantine_chat_model("chat request was cancelled during inference; restart the service")
                raise
            except TimeoutError as exc:
                infer_task.add_done_callback(lambda task: None if task.cancelled() else task.exception())
                quarantine_chat_model("chat inference timed out; restart the service")
                raise HTTPException(status_code=504, detail="model inference timed out") from exc
            except Exception as exc:
                LOGGER.exception("MiniCPM-o inference failed")
                quarantine_chat_model("chat inference failed; restart the service")
                raise HTTPException(status_code=500, detail="model inference failed") from exc
            if not isinstance(text, str) or not text.strip():
                quarantine_chat_model("chat inference returned invalid output; restart the service")
                raise HTTPException(status_code=500, detail="model returned no text")

        created = int(time.time())
        return {
            "id": f"chatcmpl-{uuid.uuid4().hex}",
            "object": "chat.completion",
            "created": created,
            "model": MODEL_NAME,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text.strip()}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

    @app.websocket("/v1/realtime")
    async def realtime(websocket: StarletteWebSocket) -> None:
        await websocket.accept()

        async def send_error(code: str, message: str) -> None:
            try:
                await websocket.send_json({"type": "error", "error": {"code": code, "message": message, "type": "server_error"}})
            except (WebSocketDisconnect, RuntimeError, OSError):
                return

        async def read_event() -> dict[str, Any]:
            try:
                message = await websocket.receive()
            except (RuntimeError, OSError) as exc:
                raise WebSocketDisconnect() from exc
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))
            raw = message.get("text")
            if not isinstance(raw, str):
                raise ValueError("realtime events must be text JSON")
            if len(raw.encode("utf-8")) > MAX_REALTIME_EVENT_BYTES:
                raise ValueError("realtime event is too large")
            try:
                event = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ValueError("realtime event must be valid JSON") from exc
            if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                raise ValueError("realtime event must be an object with a type")
            return event

        session_mode = str(websocket.query_params.get("mode", "audio")).strip().lower()
        if session_mode not in {"audio", "video"}:
            await send_error("invalid_request", "mode must be audio or video")
            await websocket.close(code=1008)
            return
        if selected != "duplex":
            await send_error("capability_missing", "duplex mode is not active")
            await websocket.close(code=1008)
            return
        if state["backend"] is None:
            detail = state["error"] or _error_detail("model_loading", "model is loading")
            await send_error(str(detail.get("code", "model_loading")), str(detail.get("message", "model is loading")))
            await websocket.close(code=1011)
            return
        if realtime_lock.locked():
            await send_error("session_busy", "only one duplex session is available")
            await websocket.close(code=1013)
            return
        session_id = f"rt-{uuid.uuid4().hex}"
        closed_reason = "peer_disconnect"
        backend = state["backend"]
        lock_acquired = False
        backend_started = False
        backend_stopped = False
        backend_quarantined = False
        backend_stop_timed_out = False
        phase_cleanup_pending = False
        backend_stop_task: asyncio.Task[Any] | None = None
        pending_events: list[dict[str, Any]] = []
        receive_task: asyncio.Task[dict[str, Any]] | None = None

        def consume_task_result(task: asyncio.Task[Any]) -> None:
            if not task.cancelled():
                task.exception()

        def quarantine_backend(message: str) -> None:
            nonlocal backend_quarantined
            state["backend"] = None
            state["error"] = _error_detail("backend_stuck", message)
            backend_quarantined = True

        async def drain_phase_task(task: asyncio.Task[Any], deadline: float, phase: str) -> bool:
            if backend_quarantined:
                return False
            done, _ = await asyncio.wait(
                {task},
                timeout=max(0, deadline - asyncio.get_running_loop().time()),
            )
            if not done:
                quarantine_backend(f"duplex backend {phase} did not stop; restart the service")
                return False
            try:
                await task
            except Exception:
                LOGGER.exception("duplex %s failed while stopping", phase)
                quarantine_backend(f"duplex backend {phase} failed while stopping; restart the service")
                return False
            return True

        async def next_event() -> dict[str, Any]:
            nonlocal receive_task
            if pending_events:
                return pending_events.pop(0)
            if receive_task is None:
                receive_task = asyncio.create_task(read_event())
            task = receive_task
            try:
                return await task
            finally:
                if receive_task is task:
                    receive_task = None

        async def stop_backend() -> bool:
            nonlocal backend_stopped, backend_stop_task, backend_stop_timed_out
            if backend_stopped:
                return True
            if backend_stop_timed_out:
                return False
            if backend_stop_task is None:
                backend_stop_task = asyncio.create_task(asyncio.to_thread(backend.stop))
                backend_stop_task.add_done_callback(consume_task_result)
            done, _ = await asyncio.wait(
                {backend_stop_task},
                timeout=REALTIME_PROCESS_STOP_TIMEOUT_SECONDS,
            )
            if not done:
                backend_stop_timed_out = True
                quarantine_backend("duplex backend stop did not return; restart the service")
                return False
            await backend_stop_task
            backend_stopped = True
            return True

        async def ensure_backend_stopped() -> None:
            try:
                await stop_backend()
            except Exception:
                LOGGER.exception("duplex backend stop failed")
                quarantine_backend("duplex backend stop failed; restart the service")

        async def finalize_backend_stop_after_drain() -> None:
            nonlocal backend_stopped, backend_stop_task
            if backend_quarantined or not backend_stopped:
                return
            backend_stopped = False
            backend_stop_task = None
            await ensure_backend_stopped()

        try:
            await websocket.send_json({"type": "session.queue_done"})
            try:
                event = await asyncio.wait_for(read_event(), REALTIME_INIT_TIMEOUT_SECONDS)
            except TimeoutError:
                await send_error("init_timeout", "session.init timed out")
                closed_reason = "init_timeout"
                return
            except ValueError as exc:
                await send_error("invalid_request", str(exc))
                closed_reason = "protocol_error"
                return

            event_type = event["type"]
            if event_type == "session.close":
                closed_reason = _close_reason(event.get("reason"))
                return
            if event_type != "session.init" or not isinstance(event.get("payload"), dict):
                await send_error("invalid_request", "session.init with an object payload is required")
                closed_reason = "protocol_error"
                return
            if len(json.dumps(event["payload"], ensure_ascii=False).encode("utf-8")) > MAX_REALTIME_INIT_BYTES:
                await send_error("invalid_request", "session.init payload is too large")
                closed_reason = "protocol_error"
                return
            try:
                init_payload = validate_realtime_init(event["payload"], session_mode)
            except (TypeError, ValueError) as exc:
                await send_error("invalid_request", str(exc))
                closed_reason = "protocol_error"
                return
            if realtime_lock.locked():
                await send_error("session_busy", "only one duplex session is available")
                closed_reason = "session_busy"
                return

            await realtime_lock.acquire()
            lock_acquired = True
            backend_started = True
            phase_cleanup_pending = True
            prepare_task = asyncio.create_task(asyncio.to_thread(backend.prepare, init_payload, session_mode))
            prepare_task.add_done_callback(consume_task_result)
            prepare_deadline = asyncio.get_running_loop().time() + REALTIME_PREPARE_TIMEOUT_SECONDS
            receive_task = asyncio.create_task(read_event())
            done, _ = await asyncio.wait(
                {prepare_task, receive_task},
                timeout=max(0, prepare_deadline - asyncio.get_running_loop().time()),
                return_when=asyncio.FIRST_COMPLETED,
            )
            stop_requested = False
            if not done:
                quarantine_backend("duplex backend prepare did not stop; restart the service")
                await send_error("prepare_timeout", "duplex backend prepare timed out")
                closed_reason = "prepare_timeout"
                stop_requested = True
            elif receive_task in done:
                task = receive_task
                receive_task = None
                try:
                    queued_event = task.result()
                except ValueError as exc:
                    await send_error("invalid_request", str(exc))
                    closed_reason = "protocol_error"
                except WebSocketDisconnect:
                    closed_reason = "peer_disconnect"
                else:
                    if queued_event["type"] == "session.close":
                        closed_reason = _close_reason(queued_event.get("reason"))
                    else:
                        await send_error("invalid_request", "session.created is required before further input")
                        closed_reason = "protocol_error"
                stop_requested = True

            if stop_requested:
                await ensure_backend_stopped()
                if await drain_phase_task(prepare_task, prepare_deadline, "prepare"):
                    await finalize_backend_stop_after_drain()
                    if not backend_quarantined:
                        phase_cleanup_pending = False
                return

            try:
                await prepare_task
                phase_cleanup_pending = False
            except Exception:
                LOGGER.exception("duplex prepare failed")
                quarantine_backend("duplex backend prepare failed; restart the service")
                await send_error("capability_missing", "duplex backend prepare failed")
                closed_reason = "backend_error"
                return

            await websocket.send_json({"type": "session.created", "session_id": session_id, "mode": session_mode})
            while True:
                try:
                    event = await next_event()
                except ValueError as exc:
                    await send_error("invalid_request", str(exc))
                    closed_reason = "protocol_error"
                    break
                event_type = event["type"]

                if event_type == "session.close":
                    closed_reason = _close_reason(event.get("reason"))
                    break
                if event_type != "input.append" or not isinstance(event.get("input"), dict):
                    await send_error("invalid_request", "input.append with an object input is required")
                    closed_reason = "protocol_error"
                    break
                try:
                    request = validate_realtime_input(event["input"])
                    if session_mode == "audio" and request["video_frames"]:
                        raise ValueError("video_frames require video mode")
                except (TypeError, ValueError, OSError) as exc:
                    await send_error("invalid_request", str(exc))
                    closed_reason = "protocol_error"
                    break
                try:
                    phase_cleanup_pending = True
                    process_task = asyncio.create_task(asyncio.to_thread(backend.process, request))
                    process_task.add_done_callback(consume_task_result)
                    process_deadline = asyncio.get_running_loop().time() + REALTIME_PROCESS_TIMEOUT_SECONDS
                    stop_requested = False
                    while not process_task.done():
                        if receive_task is None:
                            receive_task = asyncio.create_task(read_event())
                        done, _ = await asyncio.wait(
                            {process_task, receive_task},
                            timeout=max(0, process_deadline - asyncio.get_running_loop().time()),
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                        if not done:
                            quarantine_backend("duplex backend inference timed out; restart the service")
                            await send_error("inference_timeout", "duplex backend inference timed out")
                            closed_reason = "inference_timeout"
                            stop_requested = True
                            await ensure_backend_stopped()
                            break
                        if receive_task in done:
                            task = receive_task
                            receive_task = None
                            try:
                                queued_event = task.result()
                            except ValueError as exc:
                                await send_error("invalid_request", str(exc))
                                closed_reason = "protocol_error"
                                stop_requested = True
                            except WebSocketDisconnect:
                                closed_reason = "peer_disconnect"
                                stop_requested = True
                            else:
                                queued_type = queued_event["type"]
                                if queued_type == "session.close":
                                    closed_reason = _close_reason(queued_event.get("reason"))
                                    stop_requested = True
                                elif queued_type != "input.append" or not isinstance(queued_event.get("input"), dict):
                                    await send_error("invalid_request", "input.append with an object input is required")
                                    closed_reason = "protocol_error"
                                    stop_requested = True
                                elif len(pending_events) >= MAX_REALTIME_PENDING_EVENTS:
                                    await send_error("input_backlog", "realtime input queue is full")
                                    closed_reason = "input_backlog"
                                    stop_requested = True
                                else:
                                    pending_events.append(queued_event)
                        if stop_requested:
                            await ensure_backend_stopped()
                            break
                        if process_task in done:
                            break

                    if stop_requested:
                        if await drain_phase_task(process_task, process_deadline, "process"):
                            await finalize_backend_stop_after_drain()
                            if not backend_quarantined:
                                phase_cleanup_pending = False
                        break

                    result = await process_task
                    phase_cleanup_pending = False
                    if not isinstance(result, dict):
                        raise ValueError("backend returned an invalid result")
                    response_id = f"resp-{uuid.uuid4().hex}"
                    outputs = _public_delta_events(result, session_id, response_id)
                    try:
                        for output in outputs:
                            await websocket.send_json(output)
                        await websocket.send_json({
                            "type": "response.done",
                            "session_id": session_id,
                            "response_id": response_id,
                        })
                    except (WebSocketDisconnect, RuntimeError, OSError):
                        closed_reason = "peer_disconnect"
                        return
                except WebSocketDisconnect:
                    return
                except CapabilityMissing as exc:
                    quarantine_backend("duplex backend inference capability failed; restart the service")
                    await send_error("capability_missing", str(exc))
                    closed_reason = "backend_error"
                    break
                except (TypeError, ValueError, OSError) as exc:
                    quarantine_backend("duplex backend returned invalid output; restart the service")
                    await send_error("backend_error", str(exc))
                    closed_reason = "backend_error"
                    break
                except Exception:
                    LOGGER.exception("duplex inference failed")
                    quarantine_backend("duplex backend inference failed; restart the service")
                    await send_error("backend_error", "duplex inference failed")
                    closed_reason = "backend_error"
                    break
        except WebSocketDisconnect:
            return
        except asyncio.CancelledError:
            if phase_cleanup_pending:
                quarantine_backend("realtime handler was cancelled while backend work was active; restart the service")
            raise
        finally:
            if receive_task is not None:
                receive_task.cancel()
                try:
                    await receive_task
                except (asyncio.CancelledError, Exception):
                    pass
            if backend_started:
                await ensure_backend_stopped()
            try:
                await websocket.send_json({"type": "session.closed", "session_id": session_id, "reason": closed_reason})
            except Exception:
                pass
            # A quarantined worker may still mutate model state, so no later
            # session may acquire this backend lock before service restart.
            if lock_acquired and not backend_quarantined:
                realtime_lock.release()
            try:
                await websocket.close()
            except Exception:
                pass

    return app


app = None if os.environ.get("MINICPM_PROTOCOL_TEST") == "1" else create_app()

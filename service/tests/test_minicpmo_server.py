import asyncio
import base64
import gc
import json
import os
import struct
import sys
import tempfile
import threading
import time
import types
import unittest
import wave
from io import BytesIO
from unittest import mock

os.environ["MINICPM_PROTOCOL_TEST"] = "1"

try:
    import service.minicpmo_server as server
except ModuleNotFoundError:
    import minicpmo_server as server

try:
    from fastapi.testclient import TestClient
except ModuleNotFoundError:
    TestClient = None

try:
    from PIL import Image
except ModuleNotFoundError:
    Image = None


def make_wav(*, sample_rate=16000, channels=1, sample_width=2, frames=160):
    buffer = BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(sample_width)
        wav.setframerate(sample_rate)
        wav.writeframes(b"\x00" * (frames * channels * sample_width))
    return buffer.getvalue()


def make_jpeg(width=2, height=2):
    buffer = BytesIO()
    Image.new("RGB", (width, height), "red").save(buffer, format="JPEG")
    return buffer.getvalue()


class ProtocolTest(unittest.TestCase):
    def test_device_selection_is_bounded(self):
        self.assertEqual(server.selected_device("npu:0"), "npu:0")
        self.assertEqual(server.selected_device(" npu:1 "), "npu:1")
        with mock.patch.dict(os.environ, {"MINICPM_DEVICE": "npu:1"}):
            self.assertEqual(server.selected_device(), "npu:1")
        with self.assertRaisesRegex(ValueError, "MINICPM_DEVICE"):
            server.selected_device("cpu")

    def test_npu_istft_falls_back_only_for_verified_nola_error(self):
        class Tensor:
            def __init__(self, device):
                self.device = types.SimpleNamespace(type=device)

            def cpu(self):
                return Tensor("cpu")

            def to(self, device):
                return Tensor(device.type)

        calls = []

        def istft(input_tensor, *args, **kwargs):
            calls.append((input_tensor, args, kwargs))
            if input_tensor.device.type == "npu":
                raise RuntimeError("istft(npuComplexFloatType[1, 9, 6961]) window overlap add min: 1")
            return Tensor("cpu")

        torch_module = types.SimpleNamespace(istft=istft)
        server._patch_npu_istft(torch_module)
        patched = torch_module.istft
        server._patch_npu_istft(torch_module)
        window = Tensor("npu")
        output = torch_module.istft(Tensor("npu"), 16, 4, 16, window=window)

        self.assertIs(torch_module.istft, patched)
        self.assertEqual([call[0].device.type for call in calls], ["npu", "cpu"])
        self.assertEqual(calls[1][2]["window"].device.type, "cpu")
        self.assertEqual(output.device.type, "npu")

    def test_npu_istft_keeps_successful_calls_on_npu(self):
        input_tensor = mock.Mock()
        input_tensor.device.type = "npu"
        original = mock.Mock(return_value="npu-result")
        torch_module = types.SimpleNamespace(istft=original)
        server._patch_npu_istft(torch_module)

        self.assertEqual(torch_module.istft(input_tensor, 16), "npu-result")
        original.assert_called_once_with(input_tensor, 16)
        input_tensor.cpu.assert_not_called()

    def test_npu_istft_does_not_hide_unrelated_runtime_errors(self):
        input_tensor = mock.Mock()
        input_tensor.device.type = "npu"
        original = mock.Mock(side_effect=RuntimeError("NPU out of memory"))
        torch_module = types.SimpleNamespace(istft=original)
        server._patch_npu_istft(torch_module)

        with self.assertRaisesRegex(RuntimeError, "out of memory"):
            torch_module.istft(input_tensor, 16)
        input_tensor.cpu.assert_not_called()

    def test_s3tokenizer_prompt_loader_uses_soundfile(self):
        import numpy as np

        s3tokenizer = types.ModuleType("s3tokenizer")
        soundfile = types.ModuleType("soundfile")
        soundfile.read = mock.Mock(return_value=(np.asarray([0.25, -0.5], dtype=np.float32), 16_000))
        torch = types.ModuleType("torch")
        torch.from_numpy = mock.Mock(side_effect=lambda value: value)
        with mock.patch.dict(sys.modules, {
                "s3tokenizer": s3tokenizer,
                "soundfile": soundfile,
                "torch": torch,
            }):
            server._patch_s3tokenizer_load_audio()
            result = s3tokenizer.load_audio("prompt.wav")

        soundfile.read.assert_called_once_with("prompt.wav", dtype="float32", always_2d=False)
        self.assertEqual(result.tolist(), [0.25, -0.5])
        self.assertTrue(s3tokenizer.load_audio._minicpmo_soundfile)

    def test_torchaudio_prompt_loader_uses_soundfile(self):
        import numpy as np

        torchaudio = types.ModuleType("torchaudio")
        torchaudio.load = mock.Mock()
        soundfile = types.ModuleType("soundfile")
        soundfile.read = mock.Mock(return_value=(np.asarray([[0.25, -0.5]], dtype=np.float32), 16_000))
        torch = types.ModuleType("torch")
        torch.from_numpy = mock.Mock(side_effect=lambda value: value)
        with mock.patch.dict(sys.modules, {
                "torchaudio": torchaudio,
                "soundfile": soundfile,
                "torch": torch,
            }):
            server._patch_torchaudio_load()
            audio, sample_rate = torchaudio.load("prompt.wav", channels_first=False, backend="soundfile")

        soundfile.read.assert_called_once_with(
            "prompt.wav",
            dtype="float32",
            always_2d=True,
            start=0,
            frames=-1,
        )
        self.assertEqual(sample_rate, 16_000)
        self.assertEqual(audio.tolist(), [[0.25, -0.5]])
        self.assertTrue(torchaudio.load._minicpmo_soundfile)

    def test_duplex_hift_cpu_patch_keeps_stream_values_on_the_model_device(self):
        class Tensor:
            def __init__(self, device):
                self.device = types.SimpleNamespace(type=device)

            def cpu(self):
                return Tensor("cpu")

            def to(self, device):
                return Tensor(device.type)

        class Hift:
            def __init__(self):
                self.cpu_calls = 0
                self.forward_calls = []

            def cpu(self):
                self.cpu_calls += 1
                return self

            def eval(self):
                return self

            def forward(self, speech_feat, cache_source):
                self.forward_calls.append((speech_feat, cache_source))
                return Tensor("cpu"), Tensor("cpu")

        hift = Hift()
        model = types.SimpleNamespace(model=types.SimpleNamespace(
            tts=types.SimpleNamespace(audio_tokenizer=types.SimpleNamespace(hift=hift))
        ))
        server._move_duplex_hift_to_cpu(model)
        speech, source = hift.forward(Tensor("npu"), Tensor("npu"))
        server._move_duplex_hift_to_cpu(model)

        self.assertEqual(hift.cpu_calls, 1)
        self.assertEqual([tensor.device.type for tensor in hift.forward_calls[0]], ["cpu", "cpu"])
        self.assertEqual((speech.device.type, source.device.type), ("npu", "npu"))

    @unittest.skipIf(Image is None, "Pillow is not installed")
    def test_normalizes_text_and_one_image(self):
        image = make_jpeg()
        data_url = "data:image/jpeg;base64," + base64.b64encode(image).decode("ascii")
        messages = server.normalize_messages(
            {
                "messages": [
                    {"role": "assistant", "content": "local hint"},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "看看这里"},
                            {"type": "image_url", "image_url": {"url": data_url}},
                        ],
                    },
                ]
            }
        )
        self.assertEqual([message["role"] for message in messages], ["user"])
        self.assertEqual([part.kind for part in messages[0]["parts"]], ["text", "image"])
        self.assertEqual(messages[0]["parts"][1].value, image)

    def test_normalizes_wav_audio(self):
        encoded = base64.b64encode(make_wav()).decode("ascii")
        messages = server.normalize_messages(
            {"messages": [{"role": "user", "content": [
                {"type": "text", "text": "听一下"},
                {"type": "input_audio", "input_audio": {"format": "wav", "data": encoded}},
            ]}]}
        )
        self.assertEqual([part.kind for part in messages[0]["parts"]], ["text", "audio"])

    def test_rejects_wav_with_mismatched_riff_size(self):
        data = bytearray(make_wav())
        struct.pack_into("<I", data, 4, len(data) - 9)
        encoded = base64.b64encode(data).decode("ascii")
        with self.assertRaisesRegex(ValueError, "invalid WAV"):
            server.normalize_messages(
                {"messages": [{"role": "user", "content": [
                    {"type": "input_audio", "input_audio": {"format": "wav", "data": encoded}},
                ]}]}
            )

    def test_rejects_low_rate_wav_before_resampling(self):
        encoded = base64.b64encode(make_wav(sample_rate=1, frames=16)).decode("ascii")
        with self.assertRaisesRegex(ValueError, "sample rate"):
            server.normalize_messages(
                {"messages": [{"role": "user", "content": [
                    {"type": "input_audio", "input_audio": {"format": "wav", "data": encoded}},
                ]}]}
            )

    def test_rejects_unbounded_or_unsupported_input(self):
        with self.assertRaises(ValueError):
            server.normalize_messages({"messages": [{"role": "tool", "content": "x"}]})
        with self.assertRaises(ValueError):
            server.normalize_messages({"messages": [{"role": "user", "content": "x" * 4001}]})
        with self.assertRaisesRegex(ValueError, "total text"):
            server.normalize_messages({"messages": [
                {"role": "user", "content": "x" * 4000},
                {"role": "assistant", "content": "y" * 4000},
                {"role": "user", "content": "z"},
            ]})

    def test_realtime_audio_is_bounded_finite_float32(self):
        good = base64.b64encode(struct.pack("<2f", 0.0, 0.25)).decode("ascii")
        self.assertEqual(server.validate_realtime_audio(good), struct.pack("<2f", 0.0, 0.25))
        bad = base64.b64encode(struct.pack("<f", float("nan"))).decode("ascii")
        with self.assertRaisesRegex(ValueError, "non-finite"):
            server.validate_realtime_audio(bad)
        out_of_range = base64.b64encode(struct.pack("<f", 2.0)).decode("ascii")
        with self.assertRaisesRegex(ValueError, "between -1 and 1"):
            server.validate_realtime_audio(out_of_range)
        oversized = base64.b64encode(b"\0" * (server.REALTIME_AUDIO_BYTES + 4)).decode("ascii")
        with self.assertRaises(ValueError):
            server.validate_realtime_audio(oversized)

    def test_output_audio_is_bounded_normalized_float32(self):
        valid = server._public_delta_events(
            {"audio": struct.pack("<2f", -1.0, 1.0)},
            "session",
            "response",
        )
        self.assertEqual(valid[0]["kind"], "audio")
        invalid_values = (
            struct.pack("<f", 2.0),
            base64.b64encode(struct.pack("<f", float("nan"))).decode("ascii"),
            [float("inf")],
        )
        for value in invalid_values:
            with self.subTest(value_type=type(value).__name__):
                with self.assertRaisesRegex(ValueError, "non-finite|between -1 and 1"):
                    server._public_delta_events({"audio": value}, "session", "response")

    @unittest.skipIf(Image is None, "Pillow is not installed")
    def test_realtime_input_bounds_frames_and_slice_limit(self):
        audio = base64.b64encode(struct.pack("<f", 0.0)).decode("ascii")
        frame = base64.b64encode(make_jpeg()).decode("ascii")
        parsed = server.validate_realtime_input({
            "audio": audio,
            "video_frames": [frame],
            "max_slice_nums": 2,
        })
        self.assertNotIn("force_listen", parsed)
        self.assertEqual(parsed["max_slice_nums"], 2)
        legacy = server.validate_realtime_input({
            "audio": audio,
            "hints": {"force_listen": True, "max_slice_nums": 2},
        })
        self.assertNotIn("force_listen", legacy)
        self.assertEqual(legacy["max_slice_nums"], 2)
        with self.assertRaisesRegex(ValueError, "at most two"):
            server.validate_realtime_input({"audio": audio, "video_frames": [frame, frame, frame]})
        with self.assertRaisesRegex(ValueError, "dimensions"):
            server._validate_image_bytes(make_jpeg(server.MAX_IMAGE_DIMENSION + 1, 1), jpeg_only=True)

    def test_duplex_prepare_matches_target_revision_contract(self):
        class Model:
            def __init__(self):
                self.calls = []

            def prepare(self, **kwargs):
                self.calls.append(kwargs)

        model = Model()
        torch = types.ModuleType("torch")
        torch.npu = types.SimpleNamespace(set_device=mock.Mock())
        with mock.patch.dict(sys.modules, {"torch": torch}):
            backend = server.DuplexBackend(model, "prompt.wav", "npu:1")
            backend.prepare({"system_prompt": "  本地助手  "}, "video")
            self.assertEqual(model.calls[0], {
                "prefix_system_prompt": "<|im_start|>system\n本地助手",
                "suffix_system_prompt": "<|im_end|>",
                "ref_audio": None,
                "prompt_wav_path": "prompt.wav",
                "mode": "omni",
            })
            backend.prepare({}, "audio")
        self.assertEqual(model.calls[1]["mode"], "audio")
        self.assertTrue(model.calls[1]["prefix_system_prompt"].startswith("<|im_start|>system\n"))
        self.assertEqual(torch.npu.set_device.call_args_list, [mock.call("npu:1"), mock.call("npu:1")])

    def test_duplex_backend_reselects_device_for_every_worker_call(self):
        class Model:
            def prepare(self, **kwargs):
                return None

            def streaming_prefill(self, **kwargs):
                return None

            def streaming_generate(self, **kwargs):
                return {}

            def set_session_stop(self):
                return None

        torch = types.ModuleType("torch")
        torch.npu = types.SimpleNamespace(set_device=mock.Mock())
        with mock.patch.dict(sys.modules, {"torch": torch}):
            backend = server.DuplexBackend(Model(), "prompt.wav", "npu:1")
            backend._activate_device()
        torch.npu.set_device.assert_called_once_with("npu:1")

        with mock.patch.object(backend, "_activate_device") as activate_device:
            backend.prepare({}, "audio")
            backend.process({"audio": struct.pack("<f", 0.0), "video_frames": [], "max_slice_nums": 1})
            backend.stop()
        self.assertEqual(activate_device.call_count, 3)

    def test_duplex_loader_validates_prompt_wav_before_model_load(self):
        duplex_class = mock.Mock()
        get_class = mock.Mock(return_value=duplex_class)
        transformers = types.ModuleType("transformers")
        dynamic_utils = types.ModuleType("transformers.dynamic_module_utils")
        torch_npu = types.ModuleType("torch_npu")
        torch_npu_contrib = types.ModuleType("torch_npu.contrib")
        transfer_to_npu = types.ModuleType("torch_npu.contrib.transfer_to_npu")
        dynamic_utils.get_class_from_dynamic_module = get_class
        transformers.dynamic_module_utils = dynamic_utils
        torch_npu.contrib = torch_npu_contrib
        torch_npu_contrib.transfer_to_npu = transfer_to_npu
        invalid_prompts = (
            ("empty", b"", "invalid WAV"),
            ("malformed", b"not a WAV", "invalid WAV"),
            ("corrupt-chunk", bytes.fromhex("52494646ba56970d57415645813c84e386bb8fbc"), "invalid WAV"),
            ("low-rate", make_wav(sample_rate=12_000), "at least 16000"),
            ("too-short", make_wav(frames=1), "at least 1 second"),
            ("truncated", make_wav(frames=160)[:-2], "truncated"),
            ("too-long", make_wav(frames=16_000 * 30 + 1), "30 seconds"),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            for name, data, message in invalid_prompts:
                with self.subTest(name=name):
                    path = os.path.join(temp_dir, f"{name}.wav")
                    with open(path, "wb") as prompt:
                        prompt.write(data)
                    with mock.patch.dict(os.environ, {"MINICPM_PROMPT_WAV": path}), \
                            mock.patch.dict(sys.modules, {
                                "transformers": transformers,
                                "transformers.dynamic_module_utils": dynamic_utils,
                                "torch_npu": torch_npu,
                                "torch_npu.contrib": torch_npu_contrib,
                                "torch_npu.contrib.transfer_to_npu": transfer_to_npu,
                            }):
                        with self.assertRaisesRegex(server.CapabilityMissing, message):
                            server._load_duplex_backend()
                    get_class.assert_not_called()

    def test_prompt_wav_read_is_bounded(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = os.path.join(temp_dir, "oversized.wav")
            with open(path, "wb") as prompt:
                prompt.write(b"x" * 65)
            with mock.patch.object(server, "MAX_PROMPT_WAV_BYTES", 64):
                with self.assertRaisesRegex(ValueError, "too large"):
                    server._validate_prompt_wav(path)

    def test_duplex_loader_uses_ascend_safe_constructor(self):
        class LoadedModel:
            def prepare(self):
                return None

            def streaming_prefill(self):
                return None

            def streaming_generate(self):
                return None

            def set_session_stop(self):
                return None

        loaded = LoadedModel()
        loaded.model = types.SimpleNamespace(tts=types.SimpleNamespace(audio_tokenizer=types.SimpleNamespace(
            hift=types.SimpleNamespace(
                cpu=lambda: None,
                eval=lambda: None,
                forward=lambda speech_feat, cache_source=None: (speech_feat, cache_source),
            )
        )))
        loaded.model.tts.audio_tokenizer.hift.cpu = lambda: loaded.model.tts.audio_tokenizer.hift
        loaded.model.tts.audio_tokenizer.hift.eval = lambda: loaded.model.tts.audio_tokenizer.hift
        duplex_class = mock.Mock()
        duplex_class.from_pretrained.return_value = loaded
        get_class = mock.Mock(return_value=duplex_class)
        transformers = types.ModuleType("transformers")
        dynamic_utils = types.ModuleType("transformers.dynamic_module_utils")
        torch = types.ModuleType("torch")
        torch_npu = types.ModuleType("torch_npu")
        torch_npu_contrib = types.ModuleType("torch_npu.contrib")
        transfer_to_npu = types.ModuleType("torch_npu.contrib.transfer_to_npu")
        dynamic_utils.get_class_from_dynamic_module = get_class
        torch.istft = lambda input_tensor, *args, **kwargs: input_tensor
        torch.npu = types.SimpleNamespace(set_device=mock.Mock(), synchronize=mock.Mock())
        transformers.dynamic_module_utils = dynamic_utils
        torch_npu.contrib = torch_npu_contrib
        torch_npu_contrib.transfer_to_npu = transfer_to_npu
        with tempfile.TemporaryDirectory() as temp_dir:
            prompt_path = os.path.join(temp_dir, "prompt.wav")
            with open(prompt_path, "wb") as prompt:
                prompt.write(make_wav(sample_rate=22_050, channels=2, frames=22_050))
            with mock.patch.dict(os.environ, {
                    "MINICPM_PROMPT_WAV": prompt_path,
                    "MINICPM_ATTN": "eager",
                    "MINICPM_DEVICE": "npu:1",
                }), \
                    mock.patch.dict(sys.modules, {
                        "transformers": transformers,
                        "transformers.dynamic_module_utils": dynamic_utils,
                        "torch": torch,
                        "torch_npu": torch_npu,
                        "torch_npu.contrib": torch_npu_contrib,
                        "torch_npu.contrib.transfer_to_npu": transfer_to_npu,
                    }):
                backend = server._load_duplex_backend()
        get_class.assert_called_once_with(
            "modeling_minicpmo.MiniCPMODuplex",
            server.MODEL_DIR,
            trust_remote_code=True,
        )
        duplex_class.from_pretrained.assert_called_once_with(
            server.MODEL_DIR,
            device="npu:1",
            generate_audio=True,
            attn_implementation="eager",
        )
        self.assertIs(backend.model, loaded)
        self.assertEqual(backend.prompt_wav_path, prompt_path)
        self.assertEqual(backend.device, "npu:1")
        torch.npu.set_device.assert_called_once_with("npu:1")
        torch.npu.synchronize.assert_called_once_with()


@unittest.skipIf(TestClient is None, "FastAPI test dependencies are not installed")
class RealtimeAppTest(unittest.TestCase):
    def test_health_serves_loading_during_background_model_load(self):
        started = threading.Event()
        release = threading.Event()
        model = object()

        def blocking_load():
            started.set()
            release.wait(1)
            return model

        with mock.patch.object(server, "_load_chat_model", side_effect=blocking_load):
            app = server.create_app(mode="chat", background_load=True)
            with TestClient(app) as client:
                try:
                    self.assertTrue(started.wait(0.5))
                    health = client.get("/health").json()
                    self.assertEqual(health["status"], "loading")
                    self.assertEqual(client.post("/v1/chat/completions", json={"messages": []}).status_code, 503)
                    release.set()
                    deadline = time.monotonic() + 0.5
                    while time.monotonic() < deadline:
                        health = client.get("/health").json()
                        if health["status"] == "ready":
                            break
                        time.sleep(0.01)
                    self.assertEqual(health["status"], "ready")
                    self.assertTrue(health["capabilities"]["chat_completions"])
                finally:
                    release.set()

    def test_duplex_reports_model_loading_until_background_load_finishes(self):
        started = threading.Event()
        release = threading.Event()
        backend = server.FakeDuplexBackend()

        def blocking_load():
            started.set()
            release.wait(1)
            return backend

        with mock.patch.object(server, "_load_duplex_backend", side_effect=blocking_load):
            app = server.create_app(mode="duplex", fake_duplex=False, background_load=True)
            with TestClient(app) as client:
                try:
                    self.assertTrue(started.wait(0.5))
                    self.assertEqual(client.get("/health").json()["status"], "loading")
                    with client.websocket_connect("/v1/realtime") as websocket:
                        self.assertEqual(websocket.receive_json()["error"]["code"], "model_loading")

                    release.set()
                    deadline = time.monotonic() + 0.5
                    while time.monotonic() < deadline:
                        health = client.get("/health").json()
                        if health["status"] == "ready":
                            break
                        time.sleep(0.01)
                    self.assertEqual(health["status"], "ready")
                    with client.websocket_connect("/v1/realtime") as websocket:
                        websocket.receive_json()
                        websocket.send_json({"type": "session.init", "payload": {}})
                        self.assertEqual(websocket.receive_json()["type"], "session.created")
                        websocket.send_json({"type": "session.close", "reason": "loaded"})
                        self.assertEqual(websocket.receive_json()["reason"], "loaded")
                finally:
                    release.set()

    def test_chat_mode_keeps_http_contract(self):
        class ChatModel:
            def chat(self, **kwargs):
                self.kwargs = kwargs
                return "local chat"

        with mock.patch.object(server, "_load_chat_model", return_value=ChatModel()):
            app = server.create_app(mode="chat")
            with TestClient(app) as client:
                health = client.get("/health").json()
                self.assertTrue(health["capabilities"]["chat_completions"])
                self.assertTrue(health["capabilities"]["image_input"])
                self.assertTrue(health["capabilities"]["audio_input_wav"])
                self.assertFalse(health["capabilities"]["audio_input_16k_f32"])
                self.assertFalse(health["capabilities"]["realtime"])
                response = client.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "hello"}]})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["choices"][0]["message"]["content"], "local chat")

    def test_chat_timeout_quarantines_model_and_rejects_queued_work(self):
        class BlockingChatModel:
            def __init__(self):
                self.calls = 0
                self.started = threading.Event()
                self.release = threading.Event()

            def chat(self, **kwargs):
                self.calls += 1
                self.started.set()
                self.release.wait(2)
                return "late"

        model = BlockingChatModel()
        with mock.patch.object(server, "CHAT_INFERENCE_TIMEOUT_SECONDS", 0.05), \
                mock.patch.object(server, "_load_chat_model", return_value=model):
            app = server.create_app(mode="chat")
            with TestClient(app) as client:
                try:
                    started = time.monotonic()
                    response = client.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "hello"}]})
                    self.assertEqual(response.status_code, 504)
                    self.assertLess(time.monotonic() - started, 0.5)
                    self.assertTrue(model.started.is_set())
                    health = client.get("/health").json()
                    self.assertEqual(health["status"], "degraded")
                    self.assertEqual(health["error"]["code"], "backend_stuck")
                    self.assertFalse(health["capabilities"]["chat_completions"])
                    second = client.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "again"}]})
                    self.assertEqual(second.status_code, 503)
                    self.assertEqual(model.calls, 1)
                finally:
                    model.release.set()

    def test_cancelled_chat_request_quarantines_running_model(self):
        class BlockingChatModel:
            def __init__(self):
                self.calls = 0
                self.started = threading.Event()
                self.release = threading.Event()
                self.returned = threading.Event()

            def chat(self, **kwargs):
                self.calls += 1
                self.started.set()
                self.release.wait(2)
                self.returned.set()
                raise RuntimeError("late chat failure")

        model = BlockingChatModel()
        app = server.create_app(mode="chat", background_load=False)

        async def scenario():
            from httpx import ASGITransport, AsyncClient

            async with app.router.lifespan_context(app):
                unhandled = []
                asyncio.get_running_loop().set_exception_handler(
                    lambda _loop, context: unhandled.append(context)
                )
                async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                    request = asyncio.create_task(client.post(
                        "/v1/chat/completions",
                        json={"messages": [{"role": "user", "content": "hello"}]},
                    ))
                    self.assertTrue(await asyncio.to_thread(model.started.wait, 1))
                    request.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await request

                    health = (await client.get("/health")).json()
                    self.assertEqual(health["status"], "degraded")
                    self.assertEqual(health["error"]["code"], "backend_stuck")
                    second = await client.post(
                        "/v1/chat/completions",
                        json={"messages": [{"role": "user", "content": "again"}]},
                    )
                    self.assertEqual(second.status_code, 503)
                    self.assertEqual(model.calls, 1)
                    model.release.set()
                    self.assertTrue(await asyncio.to_thread(model.returned.wait, 1))
                    for _ in range(3):
                        gc.collect()
                        await asyncio.sleep(0)
                    self.assertEqual(unhandled, [])

        with mock.patch.object(server, "_load_chat_model", return_value=model):
            try:
                asyncio.run(scenario())
            finally:
                model.release.set()

    def test_fake_duplex_lifecycle_and_health(self):
        app = server.create_app(mode="duplex", fake_duplex=True)
        with TestClient(app) as client:
            health = client.get("/health").json()
            self.assertEqual(health["mode"], "duplex")
            self.assertTrue(health["fake"])
            self.assertFalse(health["capabilities"]["audio_input_wav"])
            self.assertTrue(health["capabilities"]["audio_output_24k_f32"])
            with client.websocket_connect("/v1/realtime") as websocket:
                self.assertEqual(websocket.receive_json()["type"], "session.queue_done")
                websocket.send_json({"type": "session.init", "payload": {}})
                created = websocket.receive_json()
                self.assertEqual(created["type"], "session.created")
                self.assertEqual(created["mode"], "audio")
                audio = base64.b64encode(struct.pack("<160f", *([0.0] * 160))).decode("ascii")
                websocket.send_json({"type": "input.append", "input": {"audio": audio}})
                events = [websocket.receive_json() for _ in range(3)]
                self.assertEqual([event["kind"] for event in events], ["text", "audio", "listen"])
                done = websocket.receive_json()
                self.assertEqual(done["type"], "response.done")
                self.assertEqual(done["response_id"], events[0]["response_id"])
                output = base64.b64decode(events[1]["audio"], validate=True)
                self.assertEqual(len(output) % 4, 0)
                websocket.send_json({"type": "session.close", "reason": "user_stop"})
                closed = websocket.receive_json()
                self.assertEqual(closed["type"], "session.closed")
                self.assertEqual(closed["reason"], "user_stop")

    def test_invalid_init_does_not_quarantine_backend(self):
        app = server.create_app(mode="duplex", fake_duplex=True)
        with TestClient(app) as client:
            invalid_payloads = (
                {"system_prompt": 123},
                {"system_prompt": "x" * (server.MAX_TEXT_CHARS + 1)},
                {"mode": "video"},
                {"unknown": True},
            )
            for payload in invalid_payloads:
                with self.subTest(payload=payload):
                    with client.websocket_connect("/v1/realtime?mode=audio") as websocket:
                        websocket.receive_json()
                        websocket.send_json({"type": "session.init", "payload": payload})
                        self.assertEqual(websocket.receive_json()["error"]["code"], "invalid_request")
                        self.assertEqual(websocket.receive_json()["reason"], "protocol_error")
                    self.assertEqual(client.get("/health").json()["status"], "ready")

            with client.websocket_connect("/v1/realtime?mode=audio") as websocket:
                websocket.receive_json()
                websocket.send_json({"type": "session.init", "payload": {"mode": "audio", "system_prompt": "ok"}})
                self.assertEqual(websocket.receive_json()["type"], "session.created")
                websocket.send_json({"type": "session.close", "reason": "valid_after_invalid"})
                self.assertEqual(websocket.receive_json()["reason"], "valid_after_invalid")

    def test_output_transport_failure_does_not_quarantine_backend(self):
        original_send_json = server.StarletteWebSocket.send_json
        for exception in (RuntimeError("not connected"), OSError("connection lost")):
            with self.subTest(exception=type(exception).__name__):
                failed = False

                async def fail_first_output(websocket, data, *args, **kwargs):
                    nonlocal failed
                    if not failed and isinstance(data, dict) and data.get("type") == "response.output.delta":
                        failed = True
                        raise exception
                    return await original_send_json(websocket, data, *args, **kwargs)

                app = server.create_app(mode="duplex", fake_duplex=True)
                with mock.patch.object(server.StarletteWebSocket, "send_json", new=fail_first_output):
                    with TestClient(app) as client:
                        with client.websocket_connect("/v1/realtime?mode=audio") as websocket:
                            websocket.receive_json()
                            websocket.send_json({"type": "session.init", "payload": {}})
                            websocket.receive_json()
                            audio = base64.b64encode(struct.pack("<f", 0.0)).decode("ascii")
                            websocket.send_json({"type": "input.append", "input": {"audio": audio}})
                            self.assertEqual(websocket.receive_json()["reason"], "peer_disconnect")
                        self.assertEqual(client.get("/health").json()["status"], "ready")
                        with client.websocket_connect("/v1/realtime?mode=audio") as second:
                            second.receive_json()
                            second.send_json({"type": "session.init", "payload": {}})
                            self.assertEqual(second.receive_json()["type"], "session.created")
                            second.send_json({"type": "session.close", "reason": "second_ok"})
                            self.assertEqual(second.receive_json()["reason"], "second_ok")

    def test_receive_transport_failures_during_active_backend_do_not_quarantine(self):
        original_receive = server.StarletteWebSocket.receive

        class InterruptibleBackend:
            def __init__(self, phase):
                self.phase = phase
                self.release = threading.Event()

            def prepare(self, payload, mode="audio"):
                if self.phase == "prepare":
                    self.release.wait(1)

            def process(self, request):
                self.release.wait(1)
                return {"text": "stopped", "is_listen": False, "end_of_turn": True}

            def stop(self):
                self.release.set()

        for phase in ("prepare", "process"):
            for exception_type in (RuntimeError, OSError):
                with self.subTest(phase=phase, exception=exception_type.__name__):
                    backend = InterruptibleBackend(phase)
                    receive_calls = 0
                    # Starlette's accept() performs the first receive before
                    # session.init and the phase-specific background receive.
                    fail_at = 3 if phase == "prepare" else 4

                    async def fail_active_receive(websocket, *args, **kwargs):
                        nonlocal receive_calls
                        receive_calls += 1
                        if receive_calls == fail_at:
                            raise exception_type("connection lost")
                        return await original_receive(websocket, *args, **kwargs)

                    with mock.patch.object(server, "_load_duplex_backend", return_value=backend), \
                            mock.patch.object(server.StarletteWebSocket, "receive", new=fail_active_receive):
                        app = server.create_app(mode="duplex", fake_duplex=False)
                        with TestClient(app) as client:
                            with client.websocket_connect("/v1/realtime?mode=audio") as websocket:
                                websocket.receive_json()
                                websocket.send_json({"type": "session.init", "payload": {}})
                                if phase == "process":
                                    websocket.receive_json()
                                    audio = base64.b64encode(struct.pack("<f", 0.0)).decode("ascii")
                                    websocket.send_json({"type": "input.append", "input": {"audio": audio}})
                                closed = websocket.receive_json()
                                self.assertEqual(closed["type"], "session.closed")
                                self.assertEqual(closed["reason"], "peer_disconnect")

                            self.assertEqual(client.get("/health").json()["status"], "ready")
                            with client.websocket_connect("/v1/realtime?mode=audio") as second:
                                second.receive_json()
                                second.send_json({"type": "session.init", "payload": {}})
                                self.assertEqual(second.receive_json()["type"], "session.created")
                                second.send_json({"type": "session.close", "reason": "second_ok"})
                                self.assertEqual(second.receive_json()["reason"], "second_ok")

    def test_worker_failure_after_stop_quarantines_backend(self):
        class FailingOnStopBackend:
            def __init__(self, phase):
                self.phase = phase
                self.started = threading.Event()
                self.release = threading.Event()

            def prepare(self, payload, mode="audio"):
                if self.phase == "prepare":
                    self.started.set()
                    self.release.wait(1)
                    raise RuntimeError("prepare failed during stop")

            def process(self, request):
                self.started.set()
                self.release.wait(1)
                raise RuntimeError("process failed during stop")

            def stop(self):
                self.release.set()

        for phase in ("prepare", "process"):
            with self.subTest(phase=phase):
                backend = FailingOnStopBackend(phase)
                with mock.patch.object(server, "_load_duplex_backend", return_value=backend):
                    app = server.create_app(mode="duplex", fake_duplex=False)
                    with TestClient(app) as client:
                        with client.websocket_connect("/v1/realtime?mode=audio") as websocket:
                            websocket.receive_json()
                            websocket.send_json({"type": "session.init", "payload": {}})
                            if phase == "process":
                                self.assertEqual(websocket.receive_json()["type"], "session.created")
                                audio = base64.b64encode(struct.pack("<f", 0.0)).decode("ascii")
                                websocket.send_json({"type": "input.append", "input": {"audio": audio}})
                            self.assertTrue(backend.started.wait(1))
                            websocket.send_json({"type": "session.close", "reason": "user_stop"})
                            self.assertEqual(websocket.receive_json()["reason"], "user_stop")

                        health = client.get("/health").json()
                        self.assertEqual(health["status"], "degraded")
                        self.assertEqual(health["error"]["code"], "backend_stuck")

    def test_cancelled_realtime_drain_never_reuses_active_backend(self):
        class BlockingBackend:
            def __init__(self, phase):
                self.phase = phase
                self.prepare_calls = 0
                self.stop_calls = 0
                self.started = threading.Event()
                self.stop_called = threading.Event()
                self.release = threading.Event()
                self.returned = threading.Event()

            def prepare(self, payload, mode="audio"):
                self.prepare_calls += 1
                if self.phase == "prepare":
                    self.started.set()
                    self.release.wait(2)
                    self.returned.set()

            def process(self, request):
                self.started.set()
                self.release.wait(2)
                self.returned.set()
                return {"text": "late", "is_listen": False, "end_of_turn": True}

            def stop(self):
                self.stop_calls += 1
                self.stop_called.set()

        def websocket_io():
            incoming = asyncio.Queue()
            outgoing = asyncio.Queue()
            scope = {
                "type": "websocket",
                "asgi": {"version": "3.0", "spec_version": "2.3"},
                "http_version": "1.1",
                "scheme": "ws",
                "path": "/v1/realtime",
                "raw_path": b"/v1/realtime",
                "query_string": b"mode=audio",
                "root_path": "",
                "headers": [],
                "client": ("test", 1234),
                "server": ("test", 80),
                "subprotocols": [],
                "state": {},
            }

            async def receive():
                return await incoming.get()

            async def send(message):
                await outgoing.put(message)

            return server.StarletteWebSocket(scope, receive, send), incoming, outgoing

        async def next_json(outgoing):
            message = await asyncio.wait_for(outgoing.get(), 1)
            self.assertEqual(message["type"], "websocket.send")
            return json.loads(message["text"])

        async def run_phase(phase, backend):
            app = server.create_app(mode="duplex", fake_duplex=False, background_load=False)
            endpoint = next(route.endpoint for route in app.routes if getattr(route, "path", None) == "/v1/realtime")

            async with app.router.lifespan_context(app):
                websocket, incoming, outgoing = websocket_io()
                await incoming.put({"type": "websocket.connect"})
                handler = asyncio.create_task(endpoint(websocket))
                self.assertEqual((await asyncio.wait_for(outgoing.get(), 1))["type"], "websocket.accept")
                self.assertEqual((await next_json(outgoing))["type"], "session.queue_done")
                await incoming.put({
                    "type": "websocket.receive",
                    "text": json.dumps({"type": "session.init", "payload": {}}),
                })
                if phase == "process":
                    self.assertEqual((await next_json(outgoing))["type"], "session.created")
                    audio = base64.b64encode(struct.pack("<f", 0.0)).decode("ascii")
                    await incoming.put({
                        "type": "websocket.receive",
                        "text": json.dumps({"type": "input.append", "input": {"audio": audio}}),
                    })
                self.assertTrue(await asyncio.to_thread(backend.started.wait, 1))
                original_wait = asyncio.wait
                drain_entered = asyncio.Event()
                singleton_waits = 0

                async def track_drain(awaitables, *args, **kwargs):
                    nonlocal singleton_waits
                    if len(awaitables) == 1:
                        singleton_waits += 1
                        if singleton_waits == 2:
                            drain_entered.set()
                    return await original_wait(awaitables, *args, **kwargs)

                with mock.patch.object(server.asyncio, "wait", new=track_drain):
                    await incoming.put({
                        "type": "websocket.receive",
                        "text": json.dumps({"type": "session.close", "reason": "cancel"}),
                    })
                    self.assertTrue(await asyncio.to_thread(backend.stop_called.wait, 1))
                    await asyncio.wait_for(drain_entered.wait(), 1)
                    handler.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await handler

                closure = dict(zip(
                    endpoint.__code__.co_freevars,
                    (cell.cell_contents for cell in endpoint.__closure__),
                ))
                self.assertTrue(closure["realtime_lock"].locked())

                second, second_incoming, second_outgoing = websocket_io()
                await second_incoming.put({"type": "websocket.connect"})
                second_handler = asyncio.create_task(endpoint(second))
                self.assertEqual((await asyncio.wait_for(second_outgoing.get(), 1))["type"], "websocket.accept")
                error = await next_json(second_outgoing)
                self.assertEqual(error["error"]["code"], "backend_stuck")
                self.assertEqual((await asyncio.wait_for(second_outgoing.get(), 1))["type"], "websocket.close")
                await second_handler
                self.assertEqual(backend.prepare_calls, 1)
                self.assertEqual(backend.stop_calls, 1)
                backend.release.set()
                self.assertTrue(await asyncio.to_thread(backend.returned.wait, 1))

        for phase in ("prepare", "process"):
            with self.subTest(phase=phase):
                backend = BlockingBackend(phase)
                with mock.patch.object(server, "_load_duplex_backend", return_value=backend):
                    asyncio.run(run_phase(phase, backend))

    @unittest.skipIf(Image is None, "Pillow is not installed")
    def test_audio_session_rejects_video_before_backend_process(self):
        class RecordingBackend:
            def __init__(self):
                self.process_calls = 0

            def prepare(self, payload, mode="audio"):
                return None

            def process(self, request):
                self.process_calls += 1
                raise AssertionError("audio-mode video must not reach the backend")

            def stop(self):
                return None

        backend = RecordingBackend()
        with mock.patch.object(server, "_load_duplex_backend", return_value=backend):
            app = server.create_app(mode="duplex", fake_duplex=False)
            with TestClient(app) as client:
                with client.websocket_connect("/v1/realtime?mode=audio") as websocket:
                    websocket.receive_json()
                    websocket.send_json({"type": "session.init", "payload": {}})
                    websocket.receive_json()
                    audio = base64.b64encode(struct.pack("<f", 0.0)).decode("ascii")
                    frame = base64.b64encode(make_jpeg()).decode("ascii")
                    websocket.send_json({
                        "type": "input.append",
                        "input": {"audio": audio, "video_frames": [frame]},
                    })
                    error = websocket.receive_json()
                    closed = websocket.receive_json()
                    self.assertEqual(error["error"]["code"], "invalid_request")
                    self.assertEqual(closed["reason"], "protocol_error")
                    self.assertEqual(backend.process_calls, 0)

    @unittest.skipIf(Image is None, "Pillow is not installed")
    def test_video_session_passes_jpeg_bytes_to_backend(self):
        class RecordingBackend:
            def __init__(self):
                self.prepare_modes = []
                self.requests = []

            def prepare(self, payload, mode="audio"):
                self.prepare_modes.append(mode)

            def process(self, request):
                self.requests.append(request)
                return {
                    "text": "video received",
                    "audio": struct.pack("<f", 0.0),
                    "is_listen": False,
                    "end_of_turn": True,
                }

            def stop(self):
                return None

        backend = RecordingBackend()
        frame = make_jpeg()
        with mock.patch.object(server, "_load_duplex_backend", return_value=backend):
            app = server.create_app(mode="duplex", fake_duplex=False)
            with TestClient(app) as client:
                with client.websocket_connect("/v1/realtime?mode=video") as websocket:
                    self.assertEqual(websocket.receive_json()["type"], "session.queue_done")
                    websocket.send_json({"type": "session.init", "payload": {}})
                    created = websocket.receive_json()
                    self.assertEqual(created["type"], "session.created")
                    self.assertEqual(created["mode"], "video")
                    audio = base64.b64encode(struct.pack("<f", 0.0)).decode("ascii")
                    encoded_frame = base64.b64encode(frame).decode("ascii")
                    websocket.send_json({
                        "type": "input.append",
                        "input": {"audio": audio, "video_frames": [encoded_frame]},
                    })
                    events = [websocket.receive_json() for _ in range(3)]
                    self.assertEqual([event["kind"] for event in events], ["text", "audio", "listen"])
                    done = websocket.receive_json()
                    self.assertEqual(done["type"], "response.done")
                    self.assertEqual(done["response_id"], events[0]["response_id"])
                    self.assertEqual(backend.prepare_modes, ["video"])
                    self.assertEqual(backend.requests[0]["video_frames"], [frame])
                    websocket.send_json({"type": "session.close", "reason": "video_done"})
                    closed = websocket.receive_json()
                    self.assertEqual(closed["type"], "session.closed")
                    self.assertEqual(closed["reason"], "video_done")

    def test_connection_waiting_for_init_does_not_own_backend_lock(self):
        app = server.create_app(mode="duplex", fake_duplex=True)
        with TestClient(app) as client:
            with client.websocket_connect("/v1/realtime") as idle:
                self.assertEqual(idle.receive_json()["type"], "session.queue_done")
                with client.websocket_connect("/v1/realtime") as active:
                    self.assertEqual(active.receive_json()["type"], "session.queue_done")
                    active.send_json({"type": "session.init", "payload": {}})
                    self.assertEqual(active.receive_json()["type"], "session.created")
                    active.send_json({"type": "session.close", "reason": "active_done"})
                    self.assertEqual(active.receive_json()["reason"], "active_done")
                idle.send_json({"type": "session.close", "reason": "idle_done"})
                self.assertEqual(idle.receive_json()["reason"], "idle_done")

    def test_init_timeout_fails_closed_without_owning_backend(self):
        with mock.patch.object(server, "REALTIME_INIT_TIMEOUT_SECONDS", 0.05):
            app = server.create_app(mode="duplex", fake_duplex=True)
            with TestClient(app) as client:
                with client.websocket_connect("/v1/realtime") as websocket:
                    self.assertEqual(websocket.receive_json()["type"], "session.queue_done")
                    error = websocket.receive_json()
                    self.assertEqual(error["error"]["code"], "init_timeout")
                    self.assertEqual(websocket.receive_json()["reason"], "init_timeout")

    def test_close_drains_prepare_and_finalizes_stop_before_reuse(self):
        class BlockingPrepareBackend:
            def __init__(self):
                self.started = threading.Event()
                self.release = threading.Event()
                self.returned = threading.Event()
                self.stopped = threading.Event()
                self.stop_calls = 0
                self.prepared = False

            def prepare(self, payload, mode="audio"):
                self.started.set()
                self.release.wait(0.1)
                self.prepared = True
                self.returned.set()

            def process(self, request):
                raise AssertionError("process must not run")

            def stop(self):
                self.stop_calls += 1
                self.prepared = False
                self.stopped.set()

        backend = BlockingPrepareBackend()
        with mock.patch.object(server, "REALTIME_PROCESS_STOP_TIMEOUT_SECONDS", 0.05), \
                mock.patch.object(server, "_load_duplex_backend", return_value=backend):
            app = server.create_app(mode="duplex", fake_duplex=False)
            with TestClient(app) as client:
                with client.websocket_connect("/v1/realtime") as websocket:
                    websocket.receive_json()
                    websocket.send_json({"type": "session.init", "payload": {}})
                    self.assertTrue(backend.started.wait(1))
                    close_started = time.monotonic()
                    websocket.send_json({"type": "session.close", "reason": "cancel_prepare"})
                    try:
                        closed = websocket.receive_json()
                        self.assertEqual(closed["type"], "session.closed")
                        self.assertEqual(closed["reason"], "cancel_prepare")
                        self.assertLess(time.monotonic() - close_started, 0.5)
                        self.assertTrue(backend.stopped.is_set())
                        self.assertTrue(backend.returned.is_set())
                        self.assertEqual(backend.stop_calls, 2)
                        self.assertFalse(backend.prepared)
                        health = client.get("/health").json()
                        self.assertEqual(health["status"], "ready")
                        with client.websocket_connect("/v1/realtime") as second:
                            second.receive_json()
                            second.send_json({"type": "session.init", "payload": {}})
                            self.assertEqual(second.receive_json()["type"], "session.created")
                            second.send_json({"type": "session.close", "reason": "second_ok"})
                            self.assertEqual(second.receive_json()["reason"], "second_ok")
                    finally:
                        backend.release.set()

    def test_close_quarantines_blocking_stop_without_calling_it_twice(self):
        class BlockingStopBackend:
            def __init__(self):
                self.started = threading.Event()
                self.release = threading.Event()
                self.returned = threading.Event()
                self.stop_calls = 0

            def prepare(self, payload, mode="audio"):
                return None

            def process(self, request):
                raise AssertionError("process must not run")

            def stop(self):
                self.stop_calls += 1
                self.started.set()
                self.release.wait(2)
                self.returned.set()

        backend = BlockingStopBackend()
        with mock.patch.object(server, "REALTIME_PROCESS_STOP_TIMEOUT_SECONDS", 0.05), \
                mock.patch.object(server, "_load_duplex_backend", return_value=backend):
            app = server.create_app(mode="duplex", fake_duplex=False)
            with TestClient(app) as client:
                with client.websocket_connect("/v1/realtime") as websocket:
                    websocket.receive_json()
                    websocket.send_json({"type": "session.init", "payload": {}})
                    websocket.receive_json()
                    close_started = time.monotonic()
                    websocket.send_json({"type": "session.close", "reason": "blocking_stop"})
                    try:
                        closed = websocket.receive_json()
                        self.assertEqual(closed["type"], "session.closed")
                        self.assertEqual(closed["reason"], "blocking_stop")
                        self.assertLess(time.monotonic() - close_started, 0.5)
                        self.assertTrue(backend.started.is_set())
                        self.assertFalse(backend.returned.is_set())
                        self.assertEqual(backend.stop_calls, 1)
                        health = client.get("/health").json()
                        self.assertEqual(health["status"], "degraded")
                        self.assertEqual(health["error"]["code"], "backend_stuck")
                        with client.websocket_connect("/v1/realtime") as second:
                            self.assertEqual(second.receive_json()["error"]["code"], "backend_stuck")
                    finally:
                        backend.release.set()

    def test_prepare_timeout_quarantines_backend_until_restart(self):
        class StuckPrepareBackend:
            def __init__(self):
                self.release = threading.Event()

            def prepare(self, payload, mode="audio"):
                self.release.wait(2)

            def process(self, request):
                raise AssertionError("process must not run")

            def stop(self):
                return None

        backend = StuckPrepareBackend()
        with mock.patch.object(server, "REALTIME_PREPARE_TIMEOUT_SECONDS", 0.05), \
                mock.patch.object(server, "REALTIME_PROCESS_STOP_TIMEOUT_SECONDS", 0.05), \
                mock.patch.object(server, "_load_duplex_backend", return_value=backend):
            app = server.create_app(mode="duplex", fake_duplex=False)
            with TestClient(app) as client:
                with client.websocket_connect("/v1/realtime") as websocket:
                    websocket.receive_json()
                    started = time.monotonic()
                    websocket.send_json({"type": "session.init", "payload": {}})
                    error = websocket.receive_json()
                    self.assertEqual(error["error"]["code"], "prepare_timeout")
                    closed = websocket.receive_json()
                    self.assertEqual(closed["type"], "session.closed")
                    self.assertEqual(closed["reason"], "prepare_timeout")
                    self.assertLess(time.monotonic() - started, 0.5)
                    health = client.get("/health").json()
                    self.assertEqual(health["status"], "degraded")
                    self.assertEqual(health["error"]["code"], "backend_stuck")
                    try:
                        with client.websocket_connect("/v1/realtime") as second:
                            self.assertEqual(second.receive_json()["error"]["code"], "backend_stuck")
                    finally:
                        backend.release.set()

    def test_prepare_failure_quarantines_backend_until_restart(self):
        class FailingPrepareBackend:
            def prepare(self, payload, mode="audio"):
                raise FileNotFoundError("prompt disappeared")

            def process(self, request):
                raise AssertionError("process must not run")

            def stop(self):
                return None

        backend = FailingPrepareBackend()
        with mock.patch.object(server, "_load_duplex_backend", return_value=backend):
            app = server.create_app(mode="duplex", fake_duplex=False)
            with TestClient(app) as client:
                with client.websocket_connect("/v1/realtime") as websocket:
                    websocket.receive_json()
                    websocket.send_json({"type": "session.init", "payload": {}})
                    error = websocket.receive_json()
                    closed = websocket.receive_json()
                    self.assertEqual(error["error"]["code"], "capability_missing")
                    self.assertEqual(closed["reason"], "backend_error")
                health = client.get("/health").json()
                self.assertEqual(health["status"], "degraded")
                self.assertFalse(health["capabilities"]["realtime"])
                self.assertEqual(health["error"]["code"], "backend_stuck")

    def test_inference_timeout_quarantines_backend_until_restart(self):
        class BlockingBackend:
            def __init__(self):
                self.release = threading.Event()
                self.stopped = threading.Event()

            def prepare(self, payload, mode="audio"):
                return None

            def process(self, request):
                self.release.wait(2)
                return {"text": "late", "is_listen": False, "end_of_turn": True}

            def stop(self):
                self.stopped.set()

        backend = BlockingBackend()
        with mock.patch.object(server, "REALTIME_PROCESS_TIMEOUT_SECONDS", 0.05), \
                mock.patch.object(server, "REALTIME_PROCESS_STOP_TIMEOUT_SECONDS", 0.05), \
                mock.patch.object(server, "_load_duplex_backend", return_value=backend):
            app = server.create_app(mode="duplex", fake_duplex=False)
            with TestClient(app) as client:
                try:
                    with client.websocket_connect("/v1/realtime?mode=audio") as websocket:
                        websocket.receive_json()
                        websocket.send_json({"type": "session.init", "payload": {}})
                        websocket.receive_json()
                        audio = base64.b64encode(struct.pack("<f", 0.0)).decode("ascii")
                        websocket.send_json({"type": "input.append", "input": {"audio": audio}})
                        error = websocket.receive_json()
                        closed = websocket.receive_json()
                        self.assertEqual(error["error"]["code"], "inference_timeout")
                        self.assertEqual(closed["reason"], "inference_timeout")
                        self.assertTrue(backend.stopped.is_set())
                    health = client.get("/health").json()
                    self.assertEqual(health["status"], "degraded")
                    self.assertEqual(health["error"]["code"], "backend_stuck")
                finally:
                    backend.release.set()

    def test_close_drains_process_before_reusing_backend(self):
        class BlockingBackend:
            def __init__(self):
                self.started = threading.Event()
                self.returned = threading.Event()
                self.stopped = threading.Event()
                self.process_calls = 0

            def prepare(self, payload, mode="audio"):
                return None

            def process(self, request):
                self.process_calls += 1
                self.started.set()
                time.sleep(0.1)
                self.returned.set()
                return {"text": "late", "audio": struct.pack("<f", 0.0), "is_listen": False, "end_of_turn": True}

            def stop(self):
                self.stopped.set()

        backend = BlockingBackend()
        with mock.patch.object(server, "REALTIME_PROCESS_STOP_TIMEOUT_SECONDS", 0.05), \
                mock.patch.object(server, "_load_duplex_backend", return_value=backend):
            app = server.create_app(mode="duplex", fake_duplex=False)
            with TestClient(app) as client:
                with client.websocket_connect("/v1/realtime?mode=audio") as websocket:
                    websocket.receive_json()
                    websocket.send_json({"type": "session.init", "payload": {}})
                    websocket.receive_json()
                    audio = base64.b64encode(struct.pack("<16000f", *([0.0] * 16000))).decode("ascii")
                    websocket.send_json({"type": "input.append", "input": {"audio": audio}})
                    self.assertTrue(backend.started.wait(1))
                    close_started = time.monotonic()
                    websocket.send_json({"type": "session.close", "reason": "user_stop"})
                    closed = websocket.receive_json()
                    self.assertEqual(closed["type"], "session.closed")
                    self.assertEqual(closed["reason"], "user_stop")
                    self.assertLess(time.monotonic() - close_started, 0.5)
                    self.assertTrue(backend.stopped.is_set())
                    self.assertTrue(backend.returned.is_set())
                    health = client.get("/health").json()
                    self.assertEqual(health["status"], "ready")
                    with client.websocket_connect("/v1/realtime?mode=audio") as second:
                        second.receive_json()
                        second.send_json({"type": "session.init", "payload": {}})
                        self.assertEqual(second.receive_json()["type"], "session.created")
                        second.send_json({"type": "session.close", "reason": "second_ok"})
                        self.assertEqual(second.receive_json()["reason"], "second_ok")
                    self.assertEqual(backend.process_calls, 1)

    def test_realtime_rejects_unknown_mode(self):
        app = server.create_app(mode="duplex", fake_duplex=True)
        with TestClient(app) as client:
            with client.websocket_connect("/v1/realtime?mode=unknown") as websocket:
                error = websocket.receive_json()
                self.assertEqual(error["type"], "error")
                self.assertEqual(error["error"]["code"], "invalid_request")

    def test_malformed_append_fails_closed(self):
        app = server.create_app(mode="duplex", fake_duplex=True)
        with TestClient(app) as client:
            with client.websocket_connect("/v1/realtime") as websocket:
                websocket.receive_json()
                websocket.send_json({"type": "session.init", "payload": {}})
                websocket.receive_json()
                websocket.send_json({"type": "input.append", "input": {"audio": "not-base64"}})
                error = websocket.receive_json()
                closed = websocket.receive_json()
                self.assertEqual(error["type"], "error")
                self.assertEqual(error["error"]["code"], "invalid_request")
                self.assertEqual(closed["type"], "session.closed")

    def test_binary_event_fails_closed(self):
        app = server.create_app(mode="duplex", fake_duplex=True)
        with TestClient(app) as client:
            with client.websocket_connect("/v1/realtime") as websocket:
                websocket.receive_json()
                websocket.send_bytes(b"{}")
                self.assertEqual(websocket.receive_json()["error"]["code"], "invalid_request")
                self.assertEqual(websocket.receive_json()["type"], "session.closed")

    def test_missing_real_duplex_capability_is_explicit(self):
        with mock.patch.dict(os.environ, {"MINICPM_PROMPT_WAV": ""}):
            app = server.create_app(mode="duplex", fake_duplex=False)
            with TestClient(app) as client:
                health = client.get("/health").json()
                self.assertEqual(health["status"], "degraded")
                self.assertEqual(health["error"]["code"], "capability_missing")
                self.assertFalse(health["capabilities"]["realtime"])

    def test_chat_mode_rejects_realtime(self):
        with mock.patch.object(server, "_load_chat_model", return_value=object()):
            app = server.create_app(mode="chat")
            with TestClient(app) as client:
                with client.websocket_connect("/v1/realtime") as websocket:
                    error = websocket.receive_json()
                    self.assertEqual(error["type"], "error")
                    self.assertEqual(error["error"]["code"], "capability_missing")


if __name__ == "__main__":
    unittest.main()

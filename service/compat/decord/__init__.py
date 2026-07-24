"""Import shim for MiniCPM-o still-image inference on ARM64."""


def cpu(index=0):
    return index


class VideoReader:
    # ponytail: still-image path only; replace with an ARM64 decord build for video-file ingestion.
    def __init__(self, *_args, **_kwargs):
        raise RuntimeError("video-file input requires an ARM64 decord build")

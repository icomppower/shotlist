#!/usr/bin/env python3
"""
voiceover.py — Generate narration with the ElevenLabs API and merge it onto a video.

Setup:
  pip install requests
  ffmpeg + ffprobe must be installed
  export ELEVENLABS_API_KEY="your_key"

Usage:
  python voiceover.py --list-voices
  python voiceover.py --text narration.txt --voice VOICE_ID --video demo.mp4 [--mix]
"""

import argparse
import json
import os
import subprocess
import sys

import requests

API = "https://api.elevenlabs.io/v1"
MAX_SECONDS = 60.0
MAX_SPEEDUP = 1.12


def api_key() -> str:
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        sys.exit("Set ELEVENLABS_API_KEY first.")
    return key


def list_voices() -> None:
    r = requests.get(f"{API}/voices", headers={"xi-api-key": api_key()}, timeout=30)
    r.raise_for_status()
    for v in r.json().get("voices", []):
        labels = ", ".join(f"{k}={val}" for k, val in (v.get("labels") or {}).items())
        print(f"{v['voice_id']}  {v['name']:<20} {labels}")


def tts(text: str, voice_id: str, model: str, out_path: str) -> None:
    r = requests.post(
        f"{API}/text-to-speech/{voice_id}",
        params={"output_format": "mp3_44100_128"},
        headers={"xi-api-key": api_key(), "Content-Type": "application/json"},
        json={"text": text, "model_id": model,
              "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}},
        timeout=120,
    )
    if r.status_code != 200:
        sys.exit(f"ElevenLabs error {r.status_code}: {r.text[:500]}")
    with open(out_path, "wb") as f:
        f.write(r.content)
    print(f"Narration saved: {out_path} ({len(text)} chars)")


def duration(path: str) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "json", path], capture_output=True, text=True, check=True).stdout
    return float(json.loads(out)["format"]["duration"])


def has_audio(path: str) -> bool:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a",
                          "-show_entries", "stream=index", "-of", "csv=p=0", path],
                         capture_output=True, text=True, check=True).stdout
    return bool(out.strip())


def fit_audio(audio: str, target: float) -> str:
    length = duration(audio)
    print(f"Narration length: {length:.1f}s (target <= {target:.1f}s)")
    if length <= target:
        return audio
    factor = length / target
    if factor > MAX_SPEEDUP:
        sys.exit(f"Narration is {length:.1f}s - too long for {target:.1f}s (needs {factor:.2f}x). "
                 f"Cut about {int((1 - target / length) * 100)}% of the words.")
    fitted = audio.replace(".mp3", "_fit.mp3")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", audio,
                    "-filter:a", f"atempo={factor:.4f}", fitted], check=True)
    print(f"Sped up {factor:.2f}x -> {fitted} ({duration(fitted):.1f}s)")
    return fitted


def merge(video: str, audio: str, out: str, mix: bool) -> None:
    if mix and has_audio(video):
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", video, "-i", audio, "-filter_complex",
               "[0:a]volume=0.25[bg];[bg][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]",
               "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", out]
    else:
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", video, "-i", audio,
               "-filter_complex", "[1:a]apad[a]", "-map", "0:v", "-map", "[a]",
               "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", out]
    subprocess.run(cmd, check=True)
    print(f"Final video: {out} ({duration(out):.1f}s)")


def main() -> None:
    p = argparse.ArgumentParser(description="ElevenLabs voiceover for a short video")
    p.add_argument("--list-voices", action="store_true")
    p.add_argument("--text")
    p.add_argument("--voice")
    p.add_argument("--video")
    p.add_argument("--model", default="eleven_multilingual_v2")
    p.add_argument("--mix", action="store_true")
    p.add_argument("--out", default="final_with_voiceover.mp4")
    args = p.parse_args()

    if args.list_voices:
        list_voices()
        return
    if not args.text or not args.voice:
        p.error("--text and --voice are required")

    with open(args.text, encoding="utf-8") as f:
        text = f.read().strip()

    narration = "narration.mp3"
    tts(text, args.voice, args.model, narration)

    target = MAX_SECONDS
    if args.video:
        vlen = duration(args.video)
        print(f"Video length: {vlen:.1f}s")
        target = min(MAX_SECONDS, vlen)

    narration = fit_audio(narration, target)
    if args.video:
        merge(args.video, narration, args.out, args.mix)


if __name__ == "__main__":
    main()

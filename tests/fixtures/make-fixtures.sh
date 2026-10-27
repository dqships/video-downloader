#!/usr/bin/env bash
# Generates test media into tests/fixtures/media/ (git-ignored). Needs ffmpeg.
set -euo pipefail
out="$(dirname "$0")/media"
mkdir -p "$out/hls"
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }

# A 6 s H.264/AAC clip, about 2 MB: big enough to pass the 500 KB threshold.
ff -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -t 6 -c:v libx264 -preset veryfast -b:v 2500k -g 60 -keyint_min 60 -sc_threshold 0 -pix_fmt yuv420p -c:a aac -b:a 128k \
  -movflags +faststart "$out/clip.mp4"

# A small HLS stream (VOD) for detection tests.
ff -i "$out/clip.mp4" -c copy -f hls -hls_time 2 -hls_playlist_type vod \
  -hls_segment_filename "$out/hls/seg%03d.ts" "$out/hls/index.m3u8"
printf '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2700000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"\nindex.m3u8\n' \
  > "$out/hls/master.m3u8"
echo "fixtures written to $out"

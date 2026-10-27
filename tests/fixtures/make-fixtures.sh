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

# HLS with AES-128 encryption (a fetchable key: transport encryption, not DRM).
mkdir -p "$out/hls-aes"
printf '0123456789abcdef' > "$out/hls-aes/key.bin"
printf 'key.bin\n%s\n0011223344556677889900aabbccddeeff\n' "$out/hls-aes/key.bin" > "$out/hls-aes/keyinfo"
ff -i "$out/clip.mp4" -c copy -f hls -hls_time 2 -hls_playlist_type vod -hls_key_info_file "$out/hls-aes/keyinfo" \
  -hls_segment_filename "$out/hls-aes/seg%03d.ts" "$out/hls-aes/index.m3u8"
rm "$out/hls-aes/keyinfo"

# HLS with fMP4 (CMAF) segments and an init segment (EXT-X-MAP).
mkdir -p "$out/hls-fmp4"
ff -i "$out/clip.mp4" -c copy -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 \
  -hls_fmp4_init_filename init.mp4 -hls_segment_filename "$out/hls-fmp4/seg%03d.m4s" "$out/hls-fmp4/index.m3u8"

# A master playlist with two video qualities and one separate audio rendition.
mkdir -p "$out/hls-multi"
ff -i "$out/clip.mp4" -filter_complex "[0:v]split=2[a][b];[b]scale=320:180[small]" \
  -map "[a]" -map "[small]" -map 0:a \
  -c:v libx264 -preset veryfast -g 60 -keyint_min 60 -sc_threshold 0 -b:v:0 1500k -b:v:1 400k -c:a copy \
  -f hls -hls_time 2 -hls_playlist_type vod \
  -var_stream_map "v:0,agroup:aud,name:360p v:1,agroup:aud,name:180p a:0,agroup:aud,language:en,name:audio,default:yes" \
  -master_pl_name master.m3u8 -hls_segment_filename "$out/hls-multi/%v_%03d.ts" "$out/hls-multi/%v.m3u8"

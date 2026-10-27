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

rm -rf "$out/dash" "$out/dash-timeline" "$out/dash-single" "$out/dash-base"

# DASH, two video qualities and one audio track, numbered segments
# (SegmentTemplate with $Number$, no timeline).
mkdir -p "$out/dash"
ff -i "$out/clip.mp4" -filter_complex "[0:v]split=2[a][b];[b]scale=320:180[small]" \
  -map "[a]" -map "[small]" -map 0:a \
  -c:v libx264 -preset veryfast -g 60 -keyint_min 60 -sc_threshold 0 -b:v:0 1500k -b:v:1 400k -c:a copy \
  -f dash -seg_duration 2 -use_timeline 0 -use_template 1 -adaptation_sets "id=0,streams=v id=1,streams=a" \
  -init_seg_name 'init-$RepresentationID$.m4s' -media_seg_name 'chunk-$RepresentationID$-$Number%05d$.m4s' \
  "$out/dash/manifest.mpd"

# DASH with a SegmentTimeline ($Time$ addressing).
mkdir -p "$out/dash-timeline"
ff -i "$out/clip.mp4" -map 0:v -map 0:a -c copy -avoid_negative_ts make_zero \
  -f dash -seg_duration 2 -use_timeline 1 -use_template 1 -adaptation_sets "id=0,streams=v id=1,streams=a" \
  -init_seg_name 'init-$RepresentationID$.m4s' -media_seg_name 'chunk-$RepresentationID$-$Time$.m4s' \
  "$out/dash-timeline/manifest.mpd"

# DASH with one file per track (SegmentBase with an index range).
mkdir -p "$out/dash-single"
ff -i "$out/clip.mp4" -map 0:v -map 0:a -c copy \
  -f dash -seg_duration 2 -single_file 1 -single_file_name 'track-$RepresentationID$.mp4' \
  -adaptation_sets "id=0,streams=v id=1,streams=a" "$out/dash-single/manifest.mpd"

# One fragmented file per track with a single segment index (sidx), described
# by SegmentBase, the way Facebook and Vimeo serve DASH.
mkdir -p "$out/dash-base"
ff -i "$out/clip.mp4" -map 0:v -c copy -movflags +frag_keyframe+empty_moov+default_base_moof+global_sidx "$out/dash-base/video.mp4"
ff -i "$out/clip.mp4" -map 0:a -c copy -frag_duration 2000000 -movflags +empty_moov+default_base_moof+global_sidx "$out/dash-base/audio.mp4"
python3 - "$out/dash-base" <<'PY'
import struct, sys
folder = sys.argv[1]

def ranges(path):
    data = open(path, "rb").read()
    pos, found = 0, {}
    while pos < len(data):
        size, kind = struct.unpack(">I4s", data[pos:pos + 8])
        found.setdefault(kind.decode(), (pos, pos + size - 1))
        pos += size
    return found["moov"][1], found["sidx"]

rep = """      <Representation id="{id}" mimeType="{mime}" codecs="{codecs}" bandwidth="{bw}"{extra}>
        <BaseURL>{file}</BaseURL>
        <SegmentBase indexRange="{i0}-{i1}"><Initialization range="0-{init}" /></SegmentBase>
      </Representation>"""
v_init, (v0, v1) = ranges(f"{folder}/video.mp4")
a_init, (a0, a1) = ranges(f"{folder}/audio.mp4")
mpd = f"""<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT6.0S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
{rep.format(id="v", mime="video/mp4", codecs="avc1.64001e", bw=2500000, extra=' width="640" height="360"', file="video.mp4", i0=v0, i1=v1, init=v_init)}
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
{rep.format(id="a", mime="audio/mp4", codecs="mp4a.40.2", bw=128000, extra="", file="audio.mp4", i0=a0, i1=a1, init=a_init)}
    </AdaptationSet>
  </Period>
</MPD>
"""
open(f"{folder}/manifest.mpd", "w").write(mpd)
PY

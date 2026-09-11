#!/bin/sh
# Regenerates the fixtures for the subtitles a video carries inside it (N116): media whose own
# subtitle streams are known, so what the grid fills with can be asserted against a text instead of
# against itself. Generated, never committed, the way sample.mkv is (docs/open-from-video-tasks.md,
# CONTRIBUTING.md section 8, .gitignore).
#
# Usage: sh fixtures/video/make-subtitle-track-fixtures.sh
#
# Video is testsrc2 at 320x180 and 30 fps, three seconds, in every file: nothing here needs a
# picture, only streams.
#
# What a test may assert about each file:
#
# carries-two-subs.mkv   3 s, two SubRip streams. The first has two cues reading "first track one"
#                        and "first track two"; the second has one reading "second track only". A
#                        check that opens it and finds one cue has taken the wrong stream.
# carries-ass.mkv        3 s, one ASS stream carrying a style named Voice and an override tag, so a
#                        check can tell an extraction that kept the format from one that went
#                        through SubRip and lost both.
# carries-no-subs.mkv    3 s, video and audio and no subtitle stream at all.
#
# A third file, one bitmap subtitle stream and no text one, is not here and cannot be: ffmpeg
# refuses to encode a text subtitle into a picture one ("Subtitle encoding currently only possible
# from text to text or bitmap to bitmap"), and there is no bitmap source to start from. The codec
# list that keeps a picture track out is covered by a Rust unit test instead.
#
# Reruns overwrite without prompting and produce the same stream counts and cue texts.
set -e

cd "$(dirname "$0")"

for tool in ffmpeg ffprobe; do
	command -v "$tool" >/dev/null 2>&1 || {
		echo "make-subtitle-track-fixtures: $tool not found (see README.md)" >&2
		exit 1
	}
done

video='testsrc2=size=320x180:rate=30:duration=3'
audio='sine=frequency=440:duration=3:sample_rate=48000'

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

cat > "$work/first.srt" <<'SRT'
1
00:00:00,500 --> 00:00:01,200
first track one

2
00:00:01,500 --> 00:00:02,200
first track two
SRT

cat > "$work/second.srt" <<'SRT'
1
00:00:00,500 --> 00:00:02,200
second track only
SRT

ffmpeg -y -hide_banner -loglevel error \
	-f lavfi -i "$video" -f lavfi -i "$audio" \
	-i "$work/first.srt" -i "$work/second.srt" \
	-map 0:v -map 1:a -map 2:s -map 3:s \
	-c:v libx264 -preset fast -crf 30 -pix_fmt yuv420p -c:a flac -c:s srt \
	carries-two-subs.mkv

cat > "$work/styled.ass" <<'ASS'
[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Voice,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:01.20,Voice,Speaker,0,0,0,,{\i1}styled one{\i0}
Dialogue: 0,0:00:01.50,0:00:02.20,Voice,Speaker,0,0,0,,styled two
ASS

# The stream is copied rather than re-encoded, which is what keeps the style block and the override
# tags byte for byte: an ASS re-encode would rewrite both.
ffmpeg -y -hide_banner -loglevel error \
	-f lavfi -i "$video" -f lavfi -i "$audio" \
	-i "$work/styled.ass" \
	-map 0:v -map 1:a -map 2:s \
	-c:v libx264 -preset fast -crf 30 -pix_fmt yuv420p -c:a flac -c:s copy \
	carries-ass.mkv

ffmpeg -y -hide_banner -loglevel error \
	-f lavfi -i "$video" -f lavfi -i "$audio" \
	-map 0:v -map 1:a \
	-c:v libx264 -preset fast -crf 30 -pix_fmt yuv420p -c:a flac \
	carries-no-subs.mkv

for file in carries-two-subs.mkv carries-ass.mkv carries-no-subs.mkv; do
	echo "make-subtitle-track-fixtures: wrote fixtures/video/$file"
	ffprobe -hide_banner -loglevel error \
		-show_entries stream=index,codec_type,codec_name \
		-of default=noprint_wrappers=1 "$file"
done

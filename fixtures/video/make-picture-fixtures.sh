#!/bin/sh
# Regenerates the fixtures for the picture's own shape: media whose drawn box is known, so the size
# read out of one can be asserted against a number instead of against itself. Generated, never
# committed, the way sample.mkv is (docs/video-aspect-tasks.md, CONTRIBUTING.md section 8,
# .gitignore).
#
# Usage: sh fixtures/video/make-picture-fixtures.sh
#
# Video is testsrc2 at 640x360 and 30 fps, the picture make-sample.sh already writes, and every file
# is three seconds long: nothing here needs duration, only shape.
#
# What a test may assert about each file:
#
# picture-anamorphic.mkv  3 s, 640x360 stored with a pixel aspect of 2:1, so mpv draws it 1280x360.
#                         The factor is two rather than a television aspect, so the assertion is an
#                         exact integer and not a rounding. A reader of the storage size answers
#                         640x360 here and is wrong by a factor of two.
# picture-rotated.mkv     3 s, 640x360 stored with 90 degrees of rotation metadata, so mpv draws it
#                         360x640. mpv applies container rotation by default, and this is the file
#                         that separates `dwidth` from `video-params/dw`.
# picture-none.mkv        3 s of FLAC audio with no video stream and no attached cover image, so
#                         mpv draws nothing at all. ffprobe reports zero video streams.
#
# Reruns overwrite without prompting and produce the same durations, stream counts and dimensions.
set -e

cd "$(dirname "$0")"

for tool in ffmpeg ffprobe; do
	command -v "$tool" >/dev/null 2>&1 || {
		echo "make-picture-fixtures: $tool not found (see README.md)" >&2
		exit 1
	}
done

video='testsrc2=size=640x360:rate=30:duration=3'

ffmpeg -y -hide_banner -loglevel error \
	-f lavfi -i "$video" \
	-vf setsar=2/1 \
	-an -c:v libx264 -preset fast -crf 28 -pix_fmt yuv420p \
	picture-anamorphic.mkv

# Two passes, and it has to be two: `-display_rotation` on the lavfi input turns the frames
# themselves, which stores 360x640 and leaves no rotation to apply. Encoding square first and
# stamping the rotation onto the copy is what keeps the storage 640x360.
upright="$(mktemp -d)/upright.mkv"
trap 'rm -rf "$(dirname "$upright")"' EXIT INT TERM

ffmpeg -y -hide_banner -loglevel error \
	-f lavfi -i "$video" \
	-an -c:v libx264 -preset fast -crf 28 -pix_fmt yuv420p \
	"$upright"

ffmpeg -y -hide_banner -loglevel error \
	-display_rotation 90 -i "$upright" \
	-an -c:v copy \
	picture-rotated.mkv

ffmpeg -y -hide_banner -loglevel error \
	-f lavfi -i "sine=frequency=440:duration=3:sample_rate=48000" \
	-vn -c:a flac -sample_fmt s16 \
	picture-none.mkv

for file in picture-anamorphic.mkv picture-rotated.mkv picture-none.mkv; do
	echo "make-picture-fixtures: wrote fixtures/video/$file"
	ffprobe -hide_banner -loglevel error \
		-show_entries format=duration \
		-show_entries stream=index,codec_type,codec_name,width,height,sample_aspect_ratio,display_aspect_ratio \
		-show_entries stream_side_data=rotation \
		-of default=noprint_wrappers=1 "$file"
done

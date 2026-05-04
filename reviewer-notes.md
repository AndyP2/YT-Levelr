# Reviewer notes

YT Levelr uses the Web Audio API to intercept the audio output of YouTube's video element via createMediaElementSource, applies a dynamics compressor and gain correction node, and measures RMS amplitude via an AnalyserNode to normalise loudness between videos. All processing is local. No data is collected or transmitted.
The extension listens for YouTube's yt-navigate-finish event to detect SPA navigation between videos, and resets its measurement state on each new video.
The source submitted is the complete, unminified source -- there is no build step beyond packaging into a zip.

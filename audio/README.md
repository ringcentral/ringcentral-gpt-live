To convert wav to pcmu:

ffmpeg -i hello_tell_me_a_joke.wav -ar 8000 -ac 1 -f mulaw hello_tell_me_a_joke.ul

To convert pcmu to wav:

ffmpeg -f mulaw -ar 8000 -ac 1 -i output/recording-2026-10-05T23-14-22-063Z.ul recording-2026-10-05T23-14-22-063Z.wav

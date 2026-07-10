# Local speech-to-text models for Clicky

Research date: 2026-07-10

## Recommendation

Run a small, local bake-off before replacing Apple Speech, with this order:

1. **FluidAudio + Parakeet TDT-CTC 110M** is the best first prototype. It is native Swift/Core ML, macOS 14+, roughly 110M parameters, reports 3.01% WER on LibriSpeech test-clean and 96.5x real-time on an M2, and is much smaller than the 0.6B Parakeet pipeline. It is the best balance of likely dictation quality, Apple Silicon efficiency, and integration effort. FluidAudio also has a separate custom-vocabulary path, which is directly relevant to Clicky's topic names and technical terms.
2. If the 110M model loses too much accuracy on real Clicky recordings, try **FluidAudio + Parakeet TDT v2** for English-only or **v3** for 25 European languages. These are stronger quality candidates but have a materially larger download/runtime footprint.
3. Keep **Moonshine Small Streaming** as the latency-first alternative. Its API and cached streaming architecture fit Clicky's current `appendAudioBuffer`/partial-result session model better than batch-oriented Parakeet, but it is English-only and its published quality comparison is vendor-run rather than an independent Clicky-domain test.

Do not start with MLX Whisper. For this native Swift app it adds a Python/sidecar packaging boundary without a demonstrated quality advantage over the native Core ML choices. If Whisper compatibility is important, use WhisperKit or whisper.cpp instead.

The minimum-risk product shape is **download on first use and cache locally**, not bundling hundreds of megabytes in the app. Keep Apple Speech as an instant fallback while the model downloads or fails to initialize.

## Why this is a good fit for the current app

Clicky already isolates transcription behind `BuddyTranscriptionProvider` and `BuddyStreamingTranscriptionSession`. A new provider can therefore be added without changing the dictation state machine. The important contract details are:

- live PCM arrives through `appendAudioBuffer`;
- the UI expects partial transcript updates;
- key-up calls `requestFinalTranscript`;
- existing domain keyterms should continue to influence recognition;
- the provider must cancel cleanly and must never block the main actor.

FluidAudio has direct `AVAudioPCMBuffer` support and native async Swift APIs. Its regular Parakeet TDT path is described as batch/sliding-window rather than truly cache-aware streaming, so the quickest reliable prototype is to buffer one push-to-talk utterance and transcribe on key-up. That improves final-text quality quickly but gives up Apple Speech's live partial text until a sliding-window adapter is added. FluidAudio's separate Parakeet EOU and Nemotron models are true streaming options, but they add another evaluation branch and should not be the first quality bake-off.

Moonshine's streaming models incrementally accept audio and cache encoder/decoder state. That maps more naturally to Clicky's existing session protocol and should preserve partial results with less adapter design.

## Comparison

| Option | Quality evidence | Apple Silicon/runtime | Streaming and latency | Size | License | Clicky integration |
|---|---|---|---|---|---|---|
| **FluidAudio / Parakeet TDT-CTC 110M** | FluidAudio reports 3.01% WER on LibriSpeech test-clean. This is promising but not directly comparable with every number below because datasets and normalization differ. | Native Swift + Core ML; reported 96.5x real-time on M2; macOS 14+/iOS 17+. | Batch/sliding-window final transcription; not the library's true-streaming family. | 110M parameters; the converted Core ML model card totals about 436 MB. | Split licensing: upstream `nvidia/parakeet-tdt_ctc-110m` is CC BY 4.0, while the FluidInference-converted Core ML artifact's README states Apache-2.0 (FluidAudio code is also Apache-2.0). Verify both before shipping. | **Low-medium.** SPM, PCM-buffer API, natural fit for final transcription. Partial UI requires sliding windows or delayed final-only mode. |
| **FluidAudio / Parakeet TDT v2** | FluidAudio calls v2 English-only and highest-recall. NVIDIA's related v3 card reports 4.85% English FLEURS WER. | Native Swift + Core ML/ANE. FluidAudio reports about 190x real-time on M4 Pro for its Parakeet path. | Near-real-time sliding windows; final push-to-talk is straightforward. | 0.6B parameters. The full v2 Hugging Face repository is about 1.8 GB (the similarly sized INT8-encoder figure in FluidAudio's docs belongs to a different model), so this is a substantial download. | FluidAudio Apache-2.0; model terms must be checked per model card. | **Medium.** Easy Swift dependency, but download size and partial-result behavior need product work. |
| **FluidAudio / Parakeet TDT v3** | NVIDIA reports 4.85% English FLEURS WER and 11.97% average over 25 FLEURS languages; automatic punctuation/capitalization. FluidAudio measured 5.4% English FLEURS WER on its conversion. | Native Swift + Core ML; optimized for Apple hardware. | Sliding-window near-real-time, not cache-aware true streaming. | 0.6B parameters; exact converted download total varies by artifacts. | NVIDIA model CC BY 4.0, commercial use allowed; FluidAudio Apache-2.0. Attribution is required. | **Medium.** Best choice here if Clicky needs Ukrainian/European multilingual support, but heavier than an English-first quick win. |
| **Moonshine Small Streaming** | Moonshine reports 7.84% WER versus Whisper Small's 8.59% in its benchmark. Medium Streaming reports 6.65%, below Whisper Large v3's 7.44%. Treat as vendor-reported until tested on Clicky audio. | Portable C++/ONNX Runtime with a Swift package and macOS example. Published MacBook Pro latency: 73 ms for Small, 107 ms for Medium in its benchmark. | **True incremental streaming** with cached encoder/decoder state; strongest protocol match. | Small checkpoint is 123M parameters; Hugging Face safetensors repository is about 562 MB. Tiny models go down to 26–34M parameters. | Code and English models MIT. Non-English models use a non-commercial Moonshine Community License, so do not assume they can ship commercially. | **Low-medium.** SPM wrapper and reference macOS project; model files must be shipped or downloaded. Best path for low-latency partials. |
| **WhisperKit** | Uses OpenAI Whisper. The project recommends large-v3 (626 MB Core ML conversion) for maximum multilingual accuracy. No single official benchmark proves it beats Parakeet on Clicky's short dictation. | Native Swift/Core ML for Apple Silicon; macOS/iOS package. | Microphone streaming is supported; Whisper still works in windowed decoding rather than being a purpose-built streaming transducer. | Recommended large-v3 conversion 626 MB; other model variants available. | SDK MIT; OpenAI Whisper weights/code MIT. | **Medium.** Mature native Whisper route and simpler than a C bridge, but heavier decoding and no obvious quick quality/latency win over Parakeet. |
| **whisper.cpp** | Same Whisper model family; broad adoption and quantization choices. | First-class Apple Silicon support via ARM NEON, Accelerate, Metal, and optional Core ML. | Includes real-time examples, but Whisper's 30-second-window design needs chunking and transcript stabilization. | tiny 75 MiB; base 142 MiB; small 466 MiB; large-v3-turbo q5 547 MiB; unquantized turbo 1.5 GiB. | MIT. | **Medium-high.** Reliable and portable, but requires a C/C++/Swift bridge and more streaming glue than native Swift packages. |
| **MLX Whisper** | Same Whisper checkpoints, with optional 4-bit conversion; no model-quality gain merely from changing runtime. | MLX is optimized for Apple Silicon GPU/unified memory. Official implementation is Python. | File/stdin transcription; not a native live Swift API. | Depends on checkpoint and quantization. | MLX examples and Whisper are MIT; converted model terms follow source weights. | **High.** Would mean embedding Python or adding another local process to a sidecar that currently owns AI reasoning, not audio capture. Poor quick-win choice. |
| **sherpa-onnx** | Supports many streaming and offline ASR families, including Parakeet; quality depends entirely on the chosen model. | macOS arm64 and Swift are officially supported; ONNX Runtime portability is excellent. | Strong true-streaming support and VAD ecosystem. | Model-dependent. | sherpa-onnx Apache-2.0; model licenses vary. | **Medium-high.** Flexible long-term abstraction, but more knobs and model-selection work than FluidAudio/Moonshine for a fast improvement. |

## Fast implementation path (no code changes made in this research)

1. Add a hidden experimental provider rather than changing the default.
2. Download the selected model on demand into Application Support, verify a pinned checksum/version, and expose download progress in the existing provider availability state.
3. For the first FluidAudio prototype, collect the existing PCM buffers during push-to-talk, resample to the model's expected 16 kHz mono format, and run one final transcription after `requestFinalTranscript()`.
4. Keep the model loaded between turns. Cold-loading per hotkey press would erase most of the latency benefit.
5. Preserve Apple Speech fallback if model preparation fails, disk space is insufficient, or the Mac is unsupported.
6. Before choosing a default, record a small private test set from the actual app: 30–50 utterances covering quiet speech, MacBook microphone distance, AirPods, technical vocabulary, topic names, accents, and background noise. Compare normalized WER, exact keyterm success, key-up-to-final latency, peak memory, and model download size.
7. Only add real-time partials after the final-only quality test passes. For FluidAudio that means evaluating its sliding-window manager or true-streaming Parakeet EOU/Nemotron path; for Moonshine, use the incremental streaming API from the start.

## Decision rules

- Choose **Parakeet TDT-CTC 110M** if final accuracy and a small native footprint matter most.
- Choose **Parakeet v2** if Clicky is English-first and real recordings show a meaningful quality gain worth the large download.
- Choose **Parakeet v3** if multilingual European speech, including Ukrainian, is a product requirement.
- Choose **Moonshine Small Streaming** if the live partial transcript and lowest interaction latency are non-negotiable.
- Choose **WhisperKit** if broad Whisper language coverage and ecosystem familiarity matter more than the best native quick win.
- Choose **sherpa-onnx** only if Clicky wants a durable multi-model ONNX layer rather than the shortest route to one better model.

## Caveats

- Published WER values are not directly comparable unless dataset, language, text normalization, decoding, and hardware match. The only trustworthy product decision is a bake-off on Clicky's recordings.
- “On-device” does not mean “small.” A 0.6B Core ML pipeline can add well over a gigabyte and significant first-run compilation time.
- Parakeet v3 supports 25 European languages but not arbitrary worldwide language coverage. Whisper remains safer for a broad language promise.
- Clicky's keyterm boosting is valuable. A model that wins generic WER but loses product names may feel worse. FluidAudio's CTC keyword-boosting path deserves a second-stage test.
- Model download, cache migration, checksum pinning, and deletion controls are part of the feature, not incidental packaging work.

## Primary sources

- FluidInference, [FluidAudio repository and ASR quick start](https://github.com/FluidInference/FluidAudio)
- FluidInference, [FluidAudio model guide](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Models.md)
- FluidInference, [FluidAudio API documentation](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/API.md)
- FluidInference, [FluidAudio benchmarks](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Benchmarks.md)
- NVIDIA, [Parakeet TDT 0.6B v3 model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- Moonshine AI, [Moonshine repository, benchmark, models, Swift integration, and licenses](https://github.com/moonshine-ai/moonshine)
- Useful Sensors, [Moonshine Small Streaming model repository](https://huggingface.co/UsefulSensors/moonshine-streaming-small/tree/main)
- ggml-org, [whisper.cpp repository](https://github.com/ggml-org/whisper.cpp)
- ggml-org, [whisper.cpp model sizes](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md)
- Apple ML Explore, [MLX Whisper implementation](https://github.com/ml-explore/mlx-examples/blob/main/whisper/README.md)
- Argmax, [WhisperKit / Argmax OSS Swift](https://github.com/argmaxinc/argmax-oss-swift)
- k2-fsa, [sherpa-onnx repository](https://github.com/k2-fsa/sherpa-onnx)


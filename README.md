# Tella - Audio Transcription for Obsidian

Tella is an Obsidian plugin that seamlessly transcribes audio notes into text using the power of Google's Gemini API. Capture your thoughts on the go, and let Tella handle the note-taking.

---

## ✨ Features (v0.1.0)

- **One-Click Transcription**: Transcribe all audio files in the current note with a single command.
- **Powered by Gemini**: Leverages the Google Gemini API for fast and accurate transcriptions.
- **Concurrent Processing**: Transcribes multiple audio files simultaneously, saving you valuable time.
- **Instant Feedback**: Provides immediate visual feedback by replacing audio links with a "transcribing..." status, which is then updated with the final text.
- **Formatted Output**: Inserts transcriptions neatly into your notes using Obsidian's Callout blocks, preserving the original audio link.
- **Broad Format Support**: Supports a wide range of audio formats, including `mp3`, `wav`, `m4a`, `flac`, `ogg`, `aac`, and `webm`.
- **Customizable Settings**:
  - Configure your Gemini API Key.
  - Customize the model used for transcription (e.g., `gemini-2.5-flash`).
  - Tailor the transcription prompt to fit your needs.
  - Validate your API key and model directly from the settings page.

## 🚀 Getting Started

### 1. Installation

- After running `npm run build`, the compiled plugin files will be located in the `.obsidian/plugins/tella` directory in the project root.
- Copy this entire `tella` folder into your Obsidian vault's plugin folder: `<YourVault>/.obsidian/plugins/`.
- Reload Obsidian or enable the plugin in the "Community Plugins" settings.

### 2. Configuration

- Go to `Settings` -> `Tella`.
- Enter your Google Gemini API Key.
- (Optional) Customize the transcription model and prompt.
- Click the "Validate" button to ensure your API key and model are working correctly.

### 3. Usage

- Open a note containing one or more embedded audio files.
- Open the command palette (Cmd/Ctrl + P).
- Run the command: `Tella: Transcribe audio in note`.
- Watch as Tella gets to work, providing real-time updates directly in your note!

## 🛣️ Roadmap

This is just the beginning. Future versions may include:

- Real-time (streaming) transcription updates.
- Support for more AI providers.
- Batch processing across multiple notes.


